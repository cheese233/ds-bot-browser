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
export const CHROME_FLAGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--disable-blink-features=AutomationControlled',
]

/** Extra flags that only matter on a real X display (llvmpipe over ANGLE/GL). */
export const HEADED_FLAGS = [
  '--use-gl=angle',
  '--use-angle=gl',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
]

// --headless=new inside Xvfb keeps the EGL display (so llvmpipe) while running
// without a visible window. Its UA still says HeadlessChrome, so the context
// overrides the UA — and only the UA, never locale.
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

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
  const capture = viewportOf(config.capture, { width: 1280, height: 800 })
  const screen = viewportOf(config.screen, { width: 1920, height: 1080 })
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

  /** botId -> live browser entry */
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

  // ---- Xvfb per Bot ------------------------------------------------------
  const displays = new Map()
  let displaySerial = 0
  const waitFor = async (probe, timeoutMs) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (probe()) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  }
  async function displayFor(botId) {
    const existing = displays.get(botId)
    if (existing !== undefined) return existing
    let number = 0
    for (let attempt = 0; attempt < 40; attempt += 1) {
      number = 90 + (displaySerial++ % 60)
      if (!existsSync(`/tmp/.X11-unix/X${number}`)) break
    }
    // The display is a normal 1920x1080 screen; the window inside it is the
    // capture size. Keeping them different is what makes `screen` believable.
    const proc = spawn('Xvfb', [`:${number}`, '-screen', '0', `${screen.width}x${screen.height}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' })
    proc.on('exit', () => ctx.logger?.warn?.('ds-bot-web-browser: Xvfb :%s exited', number))
    if (!await waitFor(() => existsSync(`/tmp/.X11-unix/X${number}`), 5000)) {
      proc.kill('SIGKILL')
      throw new Error(`Xvfb :${number} did not start`)
    }
    const entry = { proc, number }
    displays.set(botId, entry)
    return entry
  }
  function stopDisplay(botId) {
    const entry = displays.get(botId)
    if (entry === undefined) return
    displays.delete(botId)
    entry.proc.kill('SIGTERM')
  }

  // ---- capture agent page (127.0.0.1 is a secure context) ----------------
  const agentHtml = await readFile(join(here, 'agent.html'), 'utf8')
  const agentServer = createServer((request, response) => {
    let path = '/'
    try {
      path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    } catch {}
    if (path !== '/agent.html') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(agentHtml)
  })
  await new Promise((resolve, reject) => {
    agentServer.once('error', reject)
    agentServer.listen(0, '127.0.0.1', resolve)
  })
  const agentPort = agentServer.address().port
  const agentUrl = (botId, wsUrl) => `http://127.0.0.1:${agentPort}/agent.html`
    + `?bot=${encodeURIComponent(botId)}&token=${encodeURIComponent(channelOf(botId).agentToken)}`
    + `&ws=${encodeURIComponent(wsUrl)}&w=${capture.width}&h=${capture.height}`

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

  // ---- Chromium per Bot --------------------------------------------------
  let chromiumModule
  const chromiumOf = async () => {
    if (chromiumModule === undefined) {
      const loaded = await import('rebrowser-playwright-core')
      chromiumModule = loaded.chromium ?? loaded.default?.chromium
      if (chromiumModule === undefined) throw new Error('rebrowser-playwright-core has no chromium export')
    }
    return chromiumModule
  }

  // Shipped default: headed on our own Xvfb (llvmpipe + honest UA).
  // DS_BOT_WEB_HEADLESS=1 exists only to measure the headless/SwiftShader row.
  // Shipped default is headed on Xvfb (llvmpipe + honest UA). Set
  // DS_BOT_WEB_HEADLESS=1 for the pure-headless comparison row: it needs no
  // Xvfb but WebGL falls back to SwiftShader and the UA must be overridden.
  const headedMode = () => process.env.DS_BOT_WEB_HEADLESS !== '1'

  /** A persistent profile blocks a second launch until the old lock is gone. */
  async function launchProfile(chromium, userDataDir, options) {
    try {
      return await chromium.launchPersistentContext(userDataDir, options)
    } catch (error) {
      const message = String(error?.message ?? error)
      if (!/existing browser session|SingletonLock|ProcessSingleton|Failed to create/i.test(message)) throw error
      ctx.logger?.warn?.('ds-bot-web-browser: clearing a stale profile lock for %s', userDataDir)
      for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
        await rm(join(userDataDir, name), { force: true }).catch(() => {})
      }
      await killByProfile(userDataDir)
      return await chromium.launchPersistentContext(userDataDir, options)
    }
  }

  /** Last resort: kill a Chromium still holding this profile (a killed process). */
  async function killByProfile(userDataDir) {
    try {
      const { execFile } = await import('node:child_process')
      const listing = await new Promise((resolve) => {
        execFile('ps', ['-eo', 'pid,args'], (error, stdout) => resolve(error === null ? stdout : ''))
      })
      for (const line of listing.split('\n')) {
        if (!line.includes(userDataDir)) continue
        const pid = Number(line.trim().split(/\s+/)[0])
        if (Number.isInteger(pid) && pid > 1) {
          try { process.kill(pid, 'SIGTERM') } catch {}
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 800))
    } catch (error) {
      ctx.logger?.warn?.('ds-bot-web-browser: profile cleanup failed: %s', error?.message ?? error)
    }
  }

  async function botFor(botId, size) {
    const existing = bots.get(botId)
    if (existing !== undefined) {
      existing.lastUsed = Date.now()
      return existing
    }
    const view = viewportOf(size ?? capture, capture)
    const headed = headedMode()
    const display = headed ? await displayFor(botId) : undefined
    const chromium = await chromiumOf()
    const userDataDir = join(stateRoot, botId)
    await mkdir(userDataDir, { recursive: true })
    const context = await launchProfile(chromium, userDataDir, {
      executablePath,
      headless: false,
      // --headless=new still says HeadlessChrome; override the UA (and only the
      // UA: a locale override makes page and worker languages disagree).
      userAgent: UA,
      chromiumSandbox: false,
      // A context viewport would shrink `screen` to the window size, which is a
      // fingerprint of its own: let --window-size size the window instead.
      viewport: null,
      ...headed ? { env: { ...process.env, DISPLAY: `:${display.number}` } } : {},
      args: [...CHROME_FLAGS, ...HEADED_FLAGS, '--headless=new', `--window-size=${view.width},${view.height}`, '--window-position=0,0'],
      acceptDownloads: false,
    })
    const pages = context.pages()
    const page = pages[0] ?? await context.newPage()
    // The persisted profile restores its own window bounds, which would ignore
    // --window-size (and with it the capture resolution).
    try {
      const session = await context.newCDPSession(page)
      const { windowId } = await session.send('Browser.getWindowForTarget')
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width: view.width, height: view.height, windowState: 'normal' },
      })
      const check = await session.send('Browser.getWindowBounds', { windowId })
      ctx.logger?.info?.('ds-bot-web-browser: window pinned to %dx%d (was %s)', view.width, view.height, JSON.stringify(check.bounds))
    } catch (error) {
      ctx.logger?.warn?.('ds-bot-web-browser: could not pin the window size: %s', error?.message ?? error)
    }
    const cdp = await context.newCDPSession(page)
    await cdp.send('Page.enable').catch(() => {})
    const entry = {
      context, page, cdp, display, headed, userDataDir,
      url: 'about:blank', title: '', lastUsed: Date.now(), navigating: undefined,
      capturePage: undefined, view,
    }
    bots.set(botId, entry)
    return entry
  }

  async function startCapture(botId, entry, wsUrl) {
    if (wsUrl === undefined || wsUrl === '') throw new Error('The panel did not name its WebSocket origin.')
    const channel = channelOf(botId)
    if (channel.agent !== undefined) return
    const capturePage = entry.capturePage ?? await entry.context.newPage()
    entry.capturePage = capturePage
    await capturePage.goto(agentUrl(botId, wsUrl), { waitUntil: 'domcontentloaded', timeout: 15_000 })
    // Keep the Bot's page in front: the capture is of this Bot's display, and
    // whatever is visible there is what the panel must show.
    await entry.page.bringToFront().catch(() => {})
  }

  async function navigate(entry, url) {
    const target = targetOf(url)
    if (entry.navigating !== undefined) await entry.navigating.catch(() => {})
    const current = entry.page.url()
    if (current === target) {
      entry.url = current
      entry.title = await entry.page.title().catch(() => '')
      return { url: entry.url, title: entry.title }
    }
    const job = entry.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25_000 })
    entry.navigating = job
    try {
      await job
    } catch (error) {
      const message = String(error?.message ?? error)
      if (!/ERR_ABORTED|Target (page, context or browser )?closed|has been closed/i.test(message)) throw error
    } finally {
      if (entry.navigating === job) entry.navigating = undefined
    }
    if (entry.page.url() === 'about:blank' && target !== 'about:blank') {
      await entry.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {})
    }
    entry.url = entry.page.url() || target
    entry.title = await entry.page.title().catch(() => '')
    entry.lastUsed = Date.now()
    return { url: entry.url, title: entry.title }
  }

  async function closeBot(botId, { removeProfile = false } = {}) {
    const entry = bots.get(botId)
    const channel = channels.get(botId)
    for (const viewer of channel?.viewers ?? []) {
      try {
        viewer.send(JSON.stringify({ type: 'closed', message: removeProfile ? 'This Bot browser was reset.' : 'This browser closed.' }))
      } catch {}
    }
    if (channel?.agent !== undefined) {
      try { channel.agent.close() } catch {}
      channel.agent = undefined
    }
    bots.delete(botId)
    if (entry !== undefined) await entry.context.close().catch(() => {})
    stopDisplay(botId)
    if (removeProfile) await rm(join(stateRoot, botId), { recursive: true, force: true }).catch(() => {})
  }

  // ---- input -------------------------------------------------------------
  async function applyInput(botId, events) {
    const entry = bots.get(botId)
    if (entry === undefined) return
    for (const event of Array.isArray(events) ? events.slice(0, 200) : []) {
      const kind = String(event?.op ?? '')
      try {
        if (kind === 'mouse') {
          const type = event.type === 'down' ? 'mousePressed' : event.type === 'up' ? 'mouseReleased' : 'mouseMoved'
          await entry.cdp.send('Input.dispatchMouseEvent', {
            type,
            x: Number(event.x) || 0,
            y: Number(event.y) || 0,
            button: event.button === 'right' ? 'right' : event.button === 'middle' ? 'middle' : type === 'mouseMoved' ? 'none' : 'left',
            buttons: Number(event.buttons ?? (type === 'mouseMoved' ? 0 : 1)),
            clickCount: type === 'mouseMoved' ? 0 : 1,
            modifiers: Number(event.modifiers ?? 0),
          })
        } else if (kind === 'wheel') {
          await entry.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: Number(event.x) || 0,
            y: Number(event.y) || 0,
            deltaX: Number(event.deltaX) || 0,
            deltaY: Number(event.deltaY) || 0,
            modifiers: Number(event.modifiers ?? 0),
          })
        } else if (kind === 'key') {
          const keyCode = Number(event.keyCode) || 0
          const text = typeof event.text === 'string' && event.text !== '' ? event.text : undefined
          await entry.cdp.send('Input.dispatchKeyEvent', {
            type: event.type === 'up' ? 'keyUp' : text === undefined ? 'rawKeyDown' : 'keyDown',
            key: String(event.key ?? ''),
            code: String(event.code ?? ''),
            ...keyCode > 0 ? { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode } : {},
            modifiers: Number(event.modifiers ?? 0),
            ...text === undefined ? {} : { text, unmodifiedText: text },
          })
        } else if (kind === 'insertText') {
          const text = String(event.text ?? '')
          if (text !== '') await entry.cdp.send('Input.insertText', { text })
        } else if (kind === 'compose') {
          const text = String(event.text ?? '')
          await entry.cdp.send('Input.imeSetComposition', {
            text,
            selectionStart: Number(event.selectionStart ?? text.length),
            selectionEnd: Number(event.selectionEnd ?? text.length),
          })
        }
      } catch (error) {
        ctx.logger?.warn?.('ds-bot-web-browser: input failed: %s', error?.message ?? error)
      }
    }
    entry.lastUsed = Date.now()
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
        bots: [...bots.keys()],
        headed: headedMode(),
        displays: [...displays.entries()].map(([id, entry]) => [id, entry.number]),
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
    const entry = CREATES.has(op) ? await botFor(botId, body?.viewport) : bots.get(botId)
    if (entry === undefined) return respond({ ok: false, error: 'This Bot has no browser open. Load a page in its panel first.' })
    entry.lastUsed = Date.now()

    if (op === 'open') {
      const state = typeof body?.url === 'string' && body.url !== '' && body.url !== 'about:blank'
        ? await navigate(entry, body.url)
        : { url: entry.page.url(), title: await entry.page.title().catch(() => '') }
      await startCapture(botId, entry, String(body?.wsUrl ?? '')).catch((error) => {
        ctx.logger?.warn?.('ds-bot-web-browser: capture did not start: %s', error?.message ?? error)
      })
      return respond({ ok: true, ...state, live: true, window: { width: entry.view.width, height: entry.view.height } })
    }
    if (op === 'ensure') {
      const wanted = typeof body?.url === 'string' ? body.url : ''
      const blank = entry.page.url() === 'about:blank'
      const state = blank && wanted !== '' && wanted !== 'about:blank'
        ? await navigate(entry, wanted)
        : { url: entry.page.url(), title: await entry.page.title().catch(() => '') }
      await startCapture(botId, entry, String(body?.wsUrl ?? '')).catch((error) => {
        ctx.logger?.warn?.('ds-bot-web-browser: capture did not start: %s', error?.message ?? error)
      })
      return respond({ ok: true, ...state, window: { width: entry.view.width, height: entry.view.height } })
    }
    if (op === 'navigate') return respond({ ok: true, ...await navigate(entry, body?.url) })
    if (op === 'state') return respond({ ok: true, url: entry.page.url(), title: await entry.page.title().catch(() => ''), live: true })
    if (op === 'read') {
      if (!/^https?:/i.test(entry.url)) return respond({ ok: false, error: 'No page is open in this browser tab.' })
      const script = String(body?.script ?? '')
      if (script === '' || script.length > SCRIPT_MAX) return respond({ ok: false, error: 'The page script is missing or too large.' })
      const result = await entry.cdp.send('Runtime.evaluate', { expression: script, returnByValue: true, awaitPromise: true, timeout: 10_000 })
      if (result.exceptionDetails !== undefined) {
        const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'The page script failed.'
        return respond({ ok: false, error: String(text).slice(0, 300) })
      }
      return respond({ ok: true, page: result.result?.value })
    }
    if (op === 'input') {
      await applyInput(botId, body?.events)
      return respond({ ok: true })
    }
    if (op === 'reload') {
      await entry.page.reload({ waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {})
      return respond({ ok: true, url: entry.page.url(), title: await entry.page.title().catch(() => '') })
    }
    if (op === 'back' || op === 'forward') {
      await (op === 'back' ? entry.page.goBack({ timeout: 20_000 }) : entry.page.goForward({ timeout: 20_000 })).catch(() => {})
      return respond({ ok: true, url: entry.page.url(), title: await entry.page.title().catch(() => '') })
    }
    if (op === 'capture') {
      await startCapture(botId, entry, String(body?.wsUrl ?? ''))
      return respond({ ok: true, capture: channelOf(botId).agent !== undefined, format: channelOf(botId).format ?? null })
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
      for (const botId of [...displays.keys()]) {
        if (!bots.has(botId)) stopDisplay(botId)
      }
      for (const [botId, entry] of [...bots]) {
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
      for (const botId of [...bots.keys()]) await closeBot(botId)
      for (const botId of [...displays.keys()]) stopDisplay(botId)
      for (const channel of channels.values()) {
        try { channel.agent?.close() } catch {}
      }
      channels.clear()
      tickets.clear()
      wss.close()
      await new Promise((resolve) => agentServer.close(() => resolve(undefined)))
    })()
  }, 'ds-bot-web-browser: browsers')

  ctx.logger?.info?.('ds-bot-web-browser: mode=%s bridge=%s chrome=%s capture=%dx%d quality=%d', mode, bridgeFile, executablePath, capture.width, capture.height, quality)
}
