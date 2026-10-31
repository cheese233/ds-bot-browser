// Host half of the ds-bot Web browser bridge (video mode).
//
// ds-bot's client builds a Bot's browser panel only when an Electron main
// process supplies `globalThis.dsBotApp.browser`; in dsh Web there is none.
// This package supplies it without touching ds-bot:
//
//   * one headed Chromium per Bot under its own Xvfb display, so the page gets
//     real GPU rasterization (llvmpipe/ANGLE) and each Bot's screen is private;
//   * a persistent profile per Bot (`state/browser/<botId>`), so cookies and
//     localStorage are per Bot and survive restarts;
//   * the page's pixels leave the browser as a real video stream: inside the
//     page, getDisplayMedia -> MediaRecorder -> WebSocket, relayed here to the
//     panel, which plays it with MSE;
//   * the Bot's read_browser still reads the SAME page's DOM over CDP.
//
// `mode: 'canvas'` (JPEG screencast) and `mode: 'iframe'` remain as fallbacks.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

export const name = 'ds-bot-web-browser'
export const inject = ['connection']

const ROUTE = '/api/ds-bot-web-browser'
const WS_PATH = '/api/ds-bot-web-browser-ws'
const BRIDGES = { video: 'bridge-video.js', canvas: 'bridge-canvas.js', iframe: 'bridge.js' }
const SCRIPT_MAX = 400_000
const DEFAULT_CHROME = '/usr/bin/google-chrome-stable'
const METADATA_HOST = /^(169\.254\.\d+\.\d+|\[fd00:ec2::254\]|metadata\.google\.internal)$/i
const TICKET_MS = 60_000

// Headed Chromium on our own Xvfb display: headless can only ever give
// SwiftShader for WebGL, and its UA says HeadlessChrome. xvfb is therefore a
// required dependency (apt install xvfb).
// Chromium flags, the extension and the capture pipeline live in browser.js.

const here = dirname(fileURLToPath(import.meta.url))

/** The page's address, refused unless it is http(s) and not a cloud metadata host. */
export function targetOf(input) {
  const text = String(input ?? '').trim()
  if (text === '') throw new Error('No page is open in this browser tab.')
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('Only http and https addresses open here.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https addresses open here.')
  if (METADATA_HOST.test(url.hostname)) throw new Error('Cloud metadata addresses do not open here.')
  return url.href
}

export function viewportOf(value, fallback = { width: 1280, height: 800 }) {
  const width = Math.round(Number(value?.width))
  const height = Math.round(Number(value?.height))
  return {
    width: Number.isFinite(width) ? Math.min(1920, Math.max(320, width)) : fallback.width,
    height: Number.isFinite(height) ? Math.min(1600, Math.max(240, height)) : fallback.height,
  }
}

/** Length-prefixed framing for the canvas (JPEG) fallback. */
export function frameOf(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const header = Buffer.allocUnsafe(5)
  header.writeUInt8(type, 0)
  header.writeUInt32BE(body.byteLength, 1)
  return Buffer.concat([header, body])
}

export function apply(ctx, config = {}) {
  return start(ctx, config)
}

async function start(ctx, config) {
  const mode = ['canvas', 'iframe'].includes(config.mode) ? config.mode : 'video'
  const executablePath = config.executablePath ?? process.env.DS_BOT_WEB_CHROME ?? DEFAULT_CHROME
  const idleMs = Number.isFinite(config.idleMinutes) ? Math.max(1, config.idleMinutes) * 60_000 : 5 * 60_000
  const quality = Number.isFinite(config.quality) ? Math.min(95, Math.max(20, config.quality)) : 72
  const captureSize = viewportOf(config.capture, { width: 800, height: 600 })
  const stateRoot = config.profileRoot ?? join(process.env.DSH_HOME ?? '/root/.dsh', 'bot', 'state', 'browser')

  const bridgeFile = BRIDGES[mode]
  const source = await readFile(join(here, bridgeFile), 'utf8')
  if (source.includes('</script') || source.includes('<!--')) {
    ctx.logger?.warn?.('ds-bot-web-browser: %s cannot be inlined; the panel stays off', bridgeFile)
    return
  }
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script', placement: 'head', text: source })
  })

  // Xvfb children of an earlier plugin instance outlive a hot reload, so reap
  // any display in our range that this instance does not own.
  async function reapOrphanDisplays() {
    try {
      const { execFile } = await import('node:child_process')
      const listing = await new Promise((resolve) => {
        execFile('ps', ['-eo', 'pid,args'], (error, stdout) => resolve(error === null ? stdout : ''))
      })
      for (const line of listing.split('\n')) {
        if (!/Xvfb :9\d /.test(line)) continue
        const pid = Number(line.trim().split(/\s+/)[0])
        if (Number.isInteger(pid) && pid > 1) {
          try { process.kill(pid, 'SIGTERM') } catch {}
        }
      }
    } catch (error) {
      ctx.logger?.warn?.('ds-bot-web-browser: orphan Xvfb cleanup failed: %s', error?.message ?? error)
    }
  }
  await reapOrphanDisplays()

  /** botId -> { lastUsed } bookkeeping; the browser lives in BrowserHost */
  const bots = new Map()
  const tickets = new Map()
  /** botId -> { viewers:Set<ws>, agent, agentToken, format } */
  const channels = new Map()

  const channelOf = (botId) => {
    let channel = channels.get(botId)
    if (channel === undefined) {
      channel = { viewers: new Set(), agent: undefined, agentToken: randomUUID(), format: undefined }
      channels.set(botId, channel)
    }
    return channel
  }

  // ---- browsers: one shared Xvfb, one headed Chromium per Bot ------------
  const { BrowserHost } = await import('./browser.js')
  const host = new BrowserHost({
    chromePath: executablePath,
    stateRoot,
    extensionDir: join(here, 'extension'),
    capture: captureSize,
    log: (message) => ctx.logger?.info?.('ds-bot-web-browser: %s', message),
  })
  let hostStarted
  const ensureHost = async () => {
    if (hostStarted === undefined) hostStarted = host.start()
    await hostStarted
    return host
  }
  const botFor = async (botId) => {
    await ensureHost()
    return await host.bot(botId)
  }

  async function navigate(botId, url) {
    const target = targetOf(url)
    await botFor(botId)
    const state = await host.navigate(botId, target)
    bots.set(botId, { lastUsed: Date.now() })
    return state
  }

  async function startCapture(botId, wsUrl) {
    await botFor(botId)
    const channel = channelOf(botId)
    if (channel.agent !== undefined) return
    await host.capture(botId, {
      wsUrl,
      token: channel.agentToken,
      mimeTypes: ['video/webm;codecs=vp8', 'video/webm;codecs=vp9'],
    })
  }

  async function closeBot(botId, { removeProfile = false } = {}) {
    const channel = channels.get(botId)
    for (const viewer of channel?.viewers ?? []) {
      try {
        viewer.send(JSON.stringify({ type: 'closed', message: removeProfile ? 'This Bot browser was reset.' : 'This browser closed.' }))
      } catch {}
    }
    bots.delete(botId)
    await host.closeBot(botId, { removeProfile })
  }

  // ---- WebSocket hub -----------------------------------------------------
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws, request, meta) => {
    const channel = channelOf(meta.botId)
    if (meta.role === 'agent') {
      channel.agent = ws
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          try {
            const message = JSON.parse(String(data))
            if (message.type === 'format') {
              channel.format = message
              for (const viewer of channel.viewers) viewer.send(JSON.stringify(message))
            } else if (message.type === 'error') {
              for (const viewer of channel.viewers) viewer.send(JSON.stringify(message))
            } else if (message.type === 'stats') {
              channel.stats = message
            }
          } catch {}
          return
        }
        for (const viewer of channel.viewers) {
          if (viewer.readyState === 1) viewer.send(data, { binary: true })
        }
      })
      ws.on('close', () => {
        if (channel.agent === ws) channel.agent = undefined
      })
      ctx.logger?.info?.('ds-bot-web-browser: capture agent attached for %s', meta.botId)
      return
    }
    channel.viewers.add(ws)
    ws.send(JSON.stringify({ type: 'format', ...(channel.format ?? { mimeType: 'video/webm;codecs=vp8' }) }))
    if (channel.stats !== undefined) ws.send(JSON.stringify({ type: 'stats', ...channel.stats }))
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      let message
      try {
        message = JSON.parse(String(data))
      } catch {
        return
      }
      if (message.type === 'input') void applyInput(meta.botId, message.events)
      else if (['pause', 'resume', 'stop'].includes(message.type)) {
        try {
          channel.agent?.send(JSON.stringify({ type: message.type }))
        } catch {}
      }
    })
    ws.on('close', () => channel.viewers.delete(ws))
    ctx.logger?.info?.('ds-bot-web-browser: viewer attached for %s', meta.botId)
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.registerUpgrade({
      path: WS_PATH,
      handler: (request, socket, head) => {
        let target
        try {
          target = new URL(request.url ?? '/', 'http://x')
        } catch {
          socket.destroy()
          return
        }
        const token = target.searchParams.get('token')
        const ticket = target.searchParams.get('ticket')
        let meta
        if (token !== null) {
          for (const [botId, channel] of channels) {
            if (channel.agentToken === token) {
              meta = { role: 'agent', botId }
              break
            }
          }
        } else if (ticket !== null) {
          const found = tickets.get(ticket)
          if (found !== undefined && found.expires > Date.now()) {
            tickets.delete(ticket)
            meta = { role: 'viewer', botId: found.botId }
          }
        }
        if (meta === undefined) {
          socket.destroy()
          return
        }
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, meta))
      },
    }), 'ds-bot-web-browser: capture socket')
  })

  // ---- input -------------------------------------------------------------
  async function applyInput(botId, events) {
    await host.input(botId, events)
  }

  // ---- HTTP ops ----------------------------------------------------------
  const respond = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

  async function handle(body) {
    const op = String(body?.op ?? '')
    const botId = String(body?.botId ?? '')
    if (op === 'ping') {
      return respond({
        ok: true,
        mode,
        build: 'video-1',
        chrome: executablePath,
        capture,
        stateRoot,
        bots: host.list(),
        display: host.display === undefined ? null : `:${host.display.number}`,
        headed: true,
        channels: [...channels.entries()].map(([id, channel]) => [id, {
          agent: channel.agent !== undefined,
          viewers: channel.viewers.size,
          format: channel.format?.mimeType ?? null,
          stats: channel.stats ?? null,
        }]),
      })
    }
    if (op === 'close-all') {
      for (const id of [...bots.keys()]) await closeBot(id)
      for (const channel of channels.values()) {
        if (channel.agent !== undefined) {
          try { channel.agent.close() } catch {}
        }
      }
      return respond({ ok: true })
    }
    if (botId === '') return respond({ ok: false, error: 'No Bot was named.' })
    if (op === 'close') {
      await closeBot(botId)
      return respond({ ok: true })
    }
    if (op === 'reset') {
      await closeBot(botId, { removeProfile: true })
      channels.delete(botId)
      return respond({ ok: true, reset: true, profile: join(stateRoot, botId) })
    }
    if (op === 'ticket') {
      const ticket = randomUUID()
      tickets.set(ticket, { botId, expires: Date.now() + TICKET_MS })
      for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key)
      return respond({ ok: true, ticket, ws: WS_PATH })
    }

    const CREATES = new Set(['open', 'ensure', 'navigate', 'input', 'reload', 'back', 'forward', 'capture'])
    if (CREATES.has(op)) {
      await botFor(botId)
      bots.set(botId, { lastUsed: Date.now() })
    } else if (!bots.has(botId)) {
      return respond({ ok: false, error: 'This Bot has no browser open. Load a page in its panel first.' })
    }
    const entry = bots.get(botId)
    entry.lastUsed = Date.now()

    if (op === 'open') {
      const state = typeof body?.url === 'string' && body.url !== '' && body.url !== 'about:blank'
        ? await navigate(botId, body.url)
        : { url: await host.read(botId, 'location.href').catch(() => 'about:blank'), title: '' }
      let captureError
      await startCapture(botId, String(body?.wsUrl ?? '')).catch((error) => {
        captureError = String(error?.message ?? error)
        ctx.logger?.warn?.('ds-bot-web-browser: capture did not start: %s', captureError)
      })
      return respond({ ok: true, ...state, live: true, captureError, window: captureSize })
    }
    if (op === 'ensure') {
      const wanted = typeof body?.url === 'string' ? body.url : ''
      const current = await host.read(botId, 'location.href').catch(() => 'about:blank')
      const state = current === 'about:blank' && wanted !== '' && wanted !== 'about:blank'
        ? await navigate(botId, wanted)
        : { url: current, title: await host.read(botId, 'document.title').catch(() => '') }
      let captureError
      await startCapture(botId, String(body?.wsUrl ?? '')).catch((error) => {
        captureError = String(error?.message ?? error)
        ctx.logger?.warn?.('ds-bot-web-browser: capture did not start: %s', captureError)
      })
      return respond({ ok: true, ...state, captureError, window: captureSize })
    }
    if (op === 'navigate') return respond({ ok: true, ...await navigate(botId, body?.url) })
    if (op === 'state') return respond({ ok: true, url: await host.read(botId, 'location.href').catch(() => ''), title: await host.read(botId, 'document.title').catch(() => ''), live: true })
    if (op === 'read') {
      const url = await host.read(botId, 'location.href').catch(() => '')
      if (!/^https?:/i.test(url)) return respond({ ok: false, error: 'No page is open in this browser tab.' })
      const script = String(body?.script ?? '')
      if (script === '' || script.length > SCRIPT_MAX) return respond({ ok: false, error: 'The page script is missing or too large.' })
      try {
        return respond({ ok: true, page: await host.read(botId, script) })
      } catch (error) {
        return respond({ ok: false, error: String(error?.message ?? error).slice(0, 300) })
      }
    }
    if (op === 'input') {
      await applyInput(botId, body?.events)
      return respond({ ok: true })
    }
    if (op === 'reload') {
      await host.read(botId, 'location.reload()').catch(() => {})
      return respond({ ok: true, url: await host.read(botId, 'location.href').catch(() => ''), title: await host.read(botId, 'document.title').catch(() => '') })
    }
    if (op === 'back' || op === 'forward') {
      await host.read(botId, `history.${op}()`).catch(() => {})
      return respond({ ok: true, url: await host.read(botId, 'location.href').catch(() => ''), title: await host.read(botId, 'document.title').catch(() => '') })
    }
    if (op === 'capture') {
      let captureError
      await startCapture(botId, String(body?.wsUrl ?? '')).catch((error) => { captureError = String(error?.message ?? error) })
      return respond({ ok: true, capture: channelOf(botId).agent !== undefined, captureError, format: channelOf(botId).format ?? null })
    }
    return respond({ ok: false, error: `Unknown op "${op}".` })
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        body = {}
      }
      try {
        return await handle(body)
      } catch (error) {
        const message = error?.message ?? String(error)
        ctx.logger?.warn?.('ds-bot-web-browser: %s failed: %s', String(body?.op ?? 'request'), message)
        return respond({ ok: false, error: message })
      }
    },
  }), 'ds-bot-web-browser: page route')

  // Idle sweep: a Bot browser nobody watches costs a few hundred megabytes.
  const sweeper = setInterval(async () => {
    try {
      const now = Date.now()
      // A display whose Bot is gone must not outlive it.
      for (const botId of [...bots.keys()]) {
        const entry = bots.get(botId)
        const channel = channels.get(botId)
        if (channel !== undefined && channel.viewers.size > 0) continue
        if (now - entry.lastUsed < idleMs) continue
        await closeBot(botId)
        ctx.logger?.info?.('ds-bot-web-browser: closed idle browser for %s', botId)
      }
    } catch (error) {
      ctx.logger?.warn?.('ds-bot-web-browser: idle sweep failed: %s', error?.message ?? error)
    }
  }, 60_000)
  sweeper.unref?.()

  ctx.effect(() => () => {
    clearInterval(sweeper)
    return (async () => {
      await host.stop()
      for (const channel of channels.values()) {
        try { channel.agent?.close() } catch {}
      }
      channels.clear()
      tickets.clear()
      wss.close()
    })()
  }, 'ds-bot-web-browser: browsers')

  ctx.logger?.info?.('ds-bot-web-browser: mode=%s bridge=%s chrome=%s capture=%dx%d quality=%d', mode, bridgeFile, executablePath, capture.width, capture.height, quality)
}
