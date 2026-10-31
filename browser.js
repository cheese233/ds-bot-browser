// Browser manager: one shared Xvfb display, one headed Chromium per Bot driven
// over raw CDP, and the tabCapture pipeline (extension -> offscreen document)
// that streams the Bot's tab as video.
import { spawn, execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const here = dirname(fileURLToPath(import.meta.url))

export const CHROME_FLAGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--use-gl=angle',
  '--use-angle=gl',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--disable-blink-features=AutomationControlled',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
]

/** Minimal CDP client with sessionId support (Playwright cannot route child sessions). */
export class CDP {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Set()
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error !== undefined) reject(new Error(message.error.message ?? String(message.error)))
        else resolve(message.result)
        return
      }
      for (const listener of this.listeners) listener(message)
    })
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => resolve(new CDP(socket)), { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...sessionId === undefined ? {} : { sessionId } }))
    })
  }

  on(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async evaluate(sessionId, expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed')
    }
    return result.result?.value
  }

  close() {
    try { this.socket.close() } catch {}
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

export class BrowserHost {
  /**
   * @param {{ chromePath: string, stateRoot: string, extensionDir?: string,
   *   capture?: {width:number,height:number}, screen?: {width:number,height:number},
   *   log?: (message: string) => void }} options
   */
  constructor(options) {
    this.chromePath = options.chromePath
    this.stateRoot = options.stateRoot
    this.extensionDir = options.extensionDir ?? join(here, 'extension')
    // NOT this.capture: that would shadow the capture() method.
    this.captureSize = options.capture ?? { width: 800, height: 600 }
    this.screen = options.screen ?? { width: 1920, height: 1080 }
    this.log = options.log ?? (() => {})
    this.display = undefined
    /** botId -> { proc, cdp, pageSession, url, lastUsed, captureTarget } */
    this.bots = new Map()
  }

  /** One shared Xvfb for every Bot. */
  async start() {
    await this.reapOrphans()
    const number = 99
    const proc = spawn('Xvfb', [`:${number}`, '-screen', '0', `${this.screen.width}x${this.screen.height}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' })
    proc.on('exit', () => this.log(`Xvfb :${number} exited`))
    const started = Date.now()
    while (Date.now() - started < 8000) {
      if (await this.socketReady(number)) break
      await sleep(120)
    }
    this.display = { proc, number }
    this.log(`shared Xvfb on :${number} (${this.screen.width}x${this.screen.height})`)
    return this.display
  }

  async socketReady(number) {
    const { existsSync } = await import('node:fs')
    return existsSync(`/tmp/.X11-unix/X${number}`)
  }

  /** Xvfb children from an earlier instance would keep the display name busy. */
  async reapOrphans() {
    try {
      const listing = await new Promise((resolve) => {
        execFile('ps', ['-eo', 'pid,args'], (error, stdout) => resolve(error === null ? stdout : ''))
      })
      for (const line of listing.split('\n')) {
        if (!/Xvfb :9[0-9] /.test(line)) continue
        const pid = Number(line.trim().split(/\s+/)[0])
        if (Number.isInteger(pid) && pid > 1) {
          try { process.kill(pid, 'SIGTERM') } catch {}
        }
      }
      await sleep(300)
    } catch (error) {
      this.log(`orphan Xvfb cleanup failed: ${error?.message ?? error}`)
    }
  }

  async stop() {
    for (const botId of [...this.bots.keys()]) await this.closeBot(botId)
    if (this.display !== undefined) {
      try { this.display.proc.kill('SIGTERM') } catch {}
      this.display = undefined
    }
  }

  async bot(botId) {
    const existing = this.bots.get(botId)
    if (existing !== undefined) {
      existing.lastUsed = Date.now()
      return existing
    }
    if (this.display === undefined) await this.start()
    const userDataDir = join(this.stateRoot, botId)
    await mkdir(userDataDir, { recursive: true })
    const port = await freePort()
    await this.clearProfileLock(userDataDir)
    const proc = spawn(this.chromePath, [
      ...CHROME_FLAGS,
      '--headless=new',
      `--window-size=${this.captureSize.width},${this.captureSize.height}`,
      '--window-position=0,0',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ], { stdio: 'ignore', env: { ...process.env, DISPLAY: `:${this.display.number}` } })
    const started = Date.now()
    let version
    while (Date.now() - started < 20_000) {
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
        break
      } catch {
        await sleep(200)
      }
    }
    if (version === undefined) {
      try { proc.kill('SIGKILL') } catch {}
      throw new Error('Chromium did not open its debugging port')
    }
    const cdp = await CDP.connect(version.webSocketDebuggerUrl)
    const entry = { proc, cdp, port, userDataDir, pageSession: undefined, url: 'about:blank', lastUsed: Date.now(), extensionId: undefined, capture: undefined }
    this.bots.set(botId, entry)
    await this.loadExtension(entry)
    await this.openPage(entry, 'about:blank')
    return entry
  }

  /** A killed Chromium leaves a singleton lock that blocks the next launch. */
  async clearProfileLock(userDataDir) {
    const { existsSync } = await import('node:fs')
    if (!existsSync(join(userDataDir, 'SingletonLock'))) return
    try {
      const listing = await new Promise((resolve) => {
        execFile('ps', ['-eo', 'pid,args'], (error, stdout) => resolve(error === null ? stdout : ''))
      })
      for (const line of listing.split('\n')) {
        if (!line.includes(userDataDir)) continue
        const pid = Number(line.trim().split(/\s+/)[0])
        if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
          try { process.kill(pid, 'SIGTERM') } catch {}
        }
      }
      await sleep(500)
      for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        await rm(join(userDataDir, name), { force: true }).catch(() => {})
      }
      this.log(`cleared a stale profile lock in ${userDataDir}`)
    } catch (error) {
      this.log(`profile cleanup failed: ${error?.message ?? error}`)
    }
  }

  async loadExtension(entry) {
    const { id } = await entry.cdp.send('Extensions.loadUnpacked', { path: this.extensionDir })
    entry.extensionId = id
    this.log(`extension loaded ${id}`)
  }

  async openPage(entry, url) {
    const { targetId } = await entry.cdp.send('Target.createTarget', { url })
    const attached = await entry.cdp.send('Target.attachToTarget', { targetId, flatten: true })
    entry.pageSession = attached.sessionId
    entry.pageTargetId = targetId
    await entry.cdp.send('Page.enable', {}, entry.pageSession).catch(() => {})
    entry.url = url
  }

  /** Wait until the page reports a loaded document (best effort). */
  async settle(entry, timeoutMs = 20_000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const state = await entry.cdp.evaluate(entry.pageSession, 'document.readyState').catch(() => 'loading')
      if (state === 'complete' || state === 'interactive') return true
      await sleep(200)
    }
    return false
  }

  async navigate(botId, url) {
    const entry = await this.bot(botId)
    if (entry.pageSession === undefined) await this.openPage(entry, url)
    else await entry.cdp.send('Page.navigate', { url }, entry.pageSession)
    await this.settle(entry)
    entry.url = await entry.cdp.evaluate(entry.pageSession, 'location.href').catch(() => url)
    entry.lastUsed = Date.now()
    return { url: entry.url, title: await this.title(entry) }
  }

  async title(entry) {
    return await entry.cdp.evaluate(entry.pageSession, 'document.title').catch(() => '')
  }

  async read(botId, script) {
    const entry = this.bots.get(botId)
    if (entry === undefined || entry.pageSession === undefined) throw new Error('This Bot has no browser page open.')
    return await entry.cdp.evaluate(entry.pageSession, script)
  }

  async input(botId, events) {
    const entry = this.bots.get(botId)
    if (entry === undefined || entry.pageSession === undefined) return
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
          }, entry.pageSession)
        } else if (kind === 'wheel') {
          await entry.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: Number(event.x) || 0,
            y: Number(event.y) || 0,
            deltaX: Number(event.deltaX) || 0,
            deltaY: Number(event.deltaY) || 0,
            modifiers: Number(event.modifiers ?? 0),
          }, entry.pageSession)
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
          }, entry.pageSession)
        } else if (kind === 'insertText') {
          const text = String(event.text ?? '')
          if (text !== '') await entry.cdp.send('Input.insertText', { text }, entry.pageSession)
        } else if (kind === 'compose') {
          const text = String(event.text ?? '')
          await entry.cdp.send('Input.imeSetComposition', {
            text,
            selectionStart: Number(event.selectionStart ?? text.length),
            selectionEnd: Number(event.selectionEnd ?? text.length),
          }, entry.pageSession)
        }
      } catch (error) {
        this.log(`input failed: ${error?.message ?? error}`)
      }
    }
    entry.lastUsed = Date.now()
  }

  /**
   * Start the tabCapture stream for this Bot and hand every chunk to `onChunk`.
   * The extension supplies the stream id; the recorder lives in its offscreen
   * document and pushes WebM chunks to `wsUrl` with `token`.
   */
  async capture(botId, { wsUrl, token, mimeTypes, onChunk } = {}) {
    const entry = this.bots.get(botId)
    if (entry === undefined) throw new Error('This Bot has no browser open.')
    if (entry.capture !== undefined) return entry.capture

    const tabs = await entry.cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] })
    const mine = tabs.targetInfos.find((info) => String(info.url).startsWith('http')) ?? tabs.targetInfos[0]
    if (mine === undefined) throw new Error('This Bot has no tab to capture.')
    await entry.cdp.send('Extensions.triggerAction', { id: entry.extensionId, targetId: mine.targetId })

    const all = await entry.cdp.send('Target.getTargets', {})
    const sw = all.targetInfos.find((info) => info.type === 'service_worker' && String(info.url).includes(entry.extensionId))
    if (sw === undefined) throw new Error('The capture extension has no service worker.')
    const { sessionId: swSession } = await entry.cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })

    const tabId = await entry.cdp.evaluate(swSession, `chrome.tabs.query({}).then((ts) => (ts.find((t) => String(t.url).startsWith('http')) ?? ts[0]).id)`)
    const streamId = await entry.cdp.evaluate(swSession, `new Promise((resolve) => chrome.tabCapture.getMediaStreamId({ targetTabId: ${Number(tabId)} }, (id) => resolve(id ?? ('ERR ' + (chrome.runtime.lastError?.message ?? '?')))))`)
    if (typeof streamId !== 'string' || streamId.startsWith('ERR ')) throw new Error(`tabCapture refused: ${streamId}`)
    await entry.cdp.evaluate(swSession, `chrome.offscreen.hasDocument().then((has) => has ? 'existing' : chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'capture this Bot tab' }).then(() => 'created'))`)

    const withOffscreen = await entry.cdp.send('Target.getTargets', {})
    const offscreen = withOffscreen.targetInfos.find((info) => String(info.url).includes('offscreen.html'))
    if (offscreen === undefined) throw new Error('The offscreen capture document did not open.')
    const { sessionId: offSession } = await entry.cdp.send('Target.attachToTarget', { targetId: offscreen.targetId, flatten: true })

    const candidates = mimeTypes ?? ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm;codecs=h264']
    const result = await entry.cdp.evaluate(offSession, `(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: ${JSON.stringify(streamId)} } } })
      const settings = stream.getVideoTracks()[0].getSettings()
      const candidates = ${JSON.stringify(candidates)}
      const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? 'video/webm'
      const socket = new WebSocket(${JSON.stringify(`${wsUrl}?token=${encodeURIComponent(token ?? '')}`)})
      socket.binaryType = 'arraybuffer'
      const opened = await new Promise((resolve) => {
        socket.onopen = () => resolve(true)
        socket.onerror = () => resolve(false)
        setTimeout(() => resolve(socket.readyState === 1), 8000)
      })
      if (opened !== true || socket.readyState !== 1) {
        throw new Error('capture stream could not reach the panel socket (readyState ' + socket.readyState + ')')
      }
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_200_000 })
      window.__dsb = { chunks: 0, bytes: 0, socket, recorder }
      recorder.ondataavailable = async (event) => {
        if (event.data.size === 0 || socket.readyState !== 1) return
        window.__dsb.chunks += 1
        window.__dsb.bytes += event.data.size
        socket.send(await event.data.arrayBuffer())
      }
      recorder.start(250)
      socket.send(JSON.stringify({ type: 'format', mimeType, width: settings.width, height: settings.height }))
      setInterval(() => {
        if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'stats', chunks: window.__dsb.chunks, bytes: window.__dsb.bytes }))
      }, 2000)
      return { mimeType, width: settings.width, height: settings.height }
    })()`)
    entry.capture = { streamId: `${String(streamId).slice(0, 10)}…`, ...result, offSession }
    this.log(`capture started for ${botId}: ${JSON.stringify(result)}`)
    return entry.capture
  }

  async stopCapture(botId) {
    const entry = this.bots.get(botId)
    if (entry?.capture === undefined) return
    try {
      await entry.cdp.evaluate(entry.capture.offSession, `(() => { try { window.__dsb?.recorder?.stop() } catch {} try { window.__dsb?.socket?.close() } catch {} return true })()`)
    } catch {}
    entry.capture = undefined
  }

  async closeBot(botId, { removeProfile = false } = {}) {
    const entry = this.bots.get(botId)
    if (entry === undefined) return
    this.bots.delete(botId)
    await this.stopCapture(botId)
    try { entry.cdp.close() } catch {}
    try { entry.proc.kill('SIGTERM') } catch {}
    if (removeProfile) await rm(entry.userDataDir, { recursive: true, force: true }).catch(() => {})
  }

  list() {
    return [...this.bots.keys()]
  }
}
