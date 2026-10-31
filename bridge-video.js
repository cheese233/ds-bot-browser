/*
 * ds-bot Web browser bridge — video mode.
 *
 * Injected into every dsh Web page as an inline <head> script by
 * @local/ds-bot-web-browser, before the app shell and before every client
 * plugin module, so ds-bot's client finds `globalThis.dsBotApp.browser` and
 * builds its Bot browser panel.
 *
 * The panel plays the host Chromium's own video stream (getDisplayMedia ->
 * MediaRecorder inside that browser, relayed over one WebSocket) with MSE, and
 * sends mouse/keyboard/IME input back over the same socket. The price, stated
 * on the panel: the page runs on the host, without your dsh-site logins.
 */
(() => {
  if (globalThis.dsBotApp !== undefined && globalThis.dsBotApp.browser !== undefined) return

  // dsh Web is served over plain HTTP on a non-localhost address, where
  // crypto.randomUUID is missing (secure-context only). ds-bot seeds its
  // browser channel client id with it, so without this shim serveBrowserReads
  // throws and read_browser can never be answered.
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    const uuid = () => {
      const bytes = new Uint8Array(16)
      if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes)
      else for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256)
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }
    try {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: uuid, configurable: true, writable: true })
    } catch (error) {
      console.warn('[ds-bot-web-browser] randomUUID shim failed', error)
    }
  }

  const ROUTE = '/api/ds-bot-web-browser'
  const READ_TIMEOUT_MS = 15_000
  const MOVE_HZ = 60

  /** tabId -> view */
  const views = new Map()
  const listeners = new Set()
  let layer = null

  const warn = (error) => console.warn('[ds-bot-web-browser]', error)
  const trace = (dir, value) => {
    if (globalThis.__dsBotWebDebug === true) console.log('[dsb-web]', dir, String(value ?? '').slice(0, 160))
  }

  const notify = (change) => {
    for (const listener of [...listeners]) {
      try {
        listener(change)
      } catch (error) {
        warn(error)
      }
    }
  }

  const stateOf = (view) => ({
    botId: view.botId,
    tabId: view.tabId,
    url: view.url,
    title: view.title,
    loading: view.loading === true,
    canGoBack: view.history.length > 1 && view.index > 0,
    canGoForward: view.index < view.history.length - 1,
    botAttached: false,
    error: view.error ?? null,
  })

  const changed = (view, type = 'updated') => {
    const change = { type, ...stateOf(view) }
    queueMicrotask(() => notify(change))
  }

  const ensureLayer = () => {
    if (layer !== null && layer.isConnected) return layer
    layer = document.createElement('div')
    layer.className = 'ds-bot-web-browser-layer'
    Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: '41', pointerEvents: 'none' })
    document.body.append(layer)
    return layer
  }

  const call = async (payload) => {
    trace('->', `${payload.op} ${payload.url ?? ''}`)
    const response = await fetch(ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const result = await response.json()
    trace('<-', `${payload.op} ${JSON.stringify(result).slice(0, 120)}`)
    if (result?.ok !== true) throw new Error(String(result?.error ?? 'The browser request failed'))
    return result
  }

  const wsBase = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`

  // ---- media playback ---------------------------------------------------
  const attachMedia = (view, mimeType) => {
    if (view.mediaSource !== undefined && view.mimeType === mimeType) return
    view.mimeType = mimeType
    const video = view.video
    const source = new MediaSource()
    view.mediaSource = source
    view.queue = []
    view.sourceBuffer = undefined
    video.src = URL.createObjectURL(source)
    source.addEventListener('sourceopen', () => {
      try {
        const buffer = source.addSourceBuffer(mimeType)
        buffer.mode = 'segments'
        buffer.addEventListener('updateend', () => {
          view.appending = false
          // Keep only the last couple of seconds buffered: an unbounded buffer
          // is what makes MSE feel laggy.
          try {
            if (buffer.buffered.length > 0) {
              const end = buffer.buffered.end(buffer.buffered.length - 1)
              const start = buffer.buffered.start(0)
              if (end - start > 4 && !buffer.updating) buffer.remove(start, end - 2)
            }
          } catch {}
          void drain(view)
        })
        view.sourceBuffer = buffer
        void drain(view)
      } catch (error) {
        warn(error)
      }
    })
    void video.play().catch(() => {})
  }

  const drain = async (view) => {
    const buffer = view.sourceBuffer
    if (buffer === undefined || buffer.updating) return
    const next = view.queue?.shift()
    if (next === undefined) {
      // Never call endOfStream() here: it ends the MediaSource for good and
      // every later appendBuffer throws InvalidStateError.
      return
    }
    view.appending = true
    try {
      buffer.appendBuffer(next)
      if (view.video.paused) void view.video.play().catch(() => {})
    } catch (error) {
      warn(error)
      view.appending = false
    }
  }

  // ---- websocket ---------------------------------------------------------
  const connect = async (view) => {
    if (view.socket !== undefined && view.socket.readyState <= 1) return
    const { ticket, ws } = await call({ op: 'ticket', botId: view.botId })
    const socket = new WebSocket(`${wsBase()}${ws}?ticket=${encodeURIComponent(ticket)}`)
    socket.binaryType = 'arraybuffer'
    view.socket = socket
    socket.addEventListener('open', () => {
      view.connected = true
      changed(view)
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        // A frame with no MediaSource yet: build it from whatever the host told
        // us, or from WebM/VP8, which MSE always demuxes.
        if (view.sourceBuffer === undefined) attachMedia(view, view.mimeType ?? view.pendingMime ?? 'video/webm;codecs=vp8')
        view.chunks += 1
        view.bytes += event.data.byteLength
        view.lastChunkAt = Date.now()
        if (view.queue === undefined) view.queue = []
        view.queue.push(new Uint8Array(event.data))
        void drain(view)
        return
      }
      let message = {}
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.type === 'format' && typeof message.mimeType === 'string') {
        view.pendingMime = message.mimeType
        attachMedia(view, message.mimeType)
        // Capability probe: if this codec never decodes, ask for the next one.
        clearTimeout(view.probeTimer)
        const renderedAtFormat = view.rendered
        view.probeTimer = setTimeout(() => {
          if (view.rendered > renderedAtFormat) return
          if ((view.retries ?? 0) >= 2) return
          if (view.wrap?.style.visibility === 'hidden') return
          // Only MP4 is doubtful for MSE; rotating a working WebM stream would
          // throw away the buffer that is already decoding.
          if (!String(view.mimeType ?? '').includes('mp4')) return
          view.retries = (view.retries ?? 0) + 1
          send(view, { type: 'retry' })
        }, 5000)
        if (typeof message.width === 'number') view.captureSize = [message.width, message.height]
      } else if (message.type === 'stats') {
        view.hostStats = message
      } else if (message.type === 'closed') {
        view.error = String(message.message ?? 'This browser closed.')
        changed(view)
      } else if (message.type === 'error') {
        view.error = String(message.error ?? 'The capture failed.')
        changed(view)
      }
    })
    socket.addEventListener('close', () => {
      view.connected = false
      changed(view)
    })
  }

  const send = (view, payload) => {
    try {
      if (view.socket?.readyState === 1) view.socket.send(JSON.stringify(payload))
    } catch (error) {
      warn(error)
    }
  }

  // ---- input ------------------------------------------------------------
  const HARD_KEYS = {
    Enter: 13, Backspace: 8, Delete: 46, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Home: 36, End: 35, PageUp: 33, PageDown: 34, Shift: 16, Control: 17, Alt: 18, Meta: 91,
  }
  const modifiersOf = (event) => (event.shiftKey ? 8 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 1 : 0) | (event.metaKey ? 4 : 0)

  /** Client pixels -> page pixels, undoing the letterboxing of object-fit: contain. */
  const toPage = (view, event) => {
    const rect = view.video.getBoundingClientRect()
    const [captureWidth, captureHeight] = view.captureSize ?? [rect.width, rect.height]
    const scale = Math.min(rect.width / captureWidth, rect.height / captureHeight)
    const offsetX = (rect.width - captureWidth * scale) / 2
    const offsetY = (rect.height - captureHeight * scale) / 2
    return {
      x: Math.round((event.clientX - rect.left - offsetX) / scale),
      y: Math.round((event.clientY - rect.top - offsetY) / scale),
    }
  }

  const flushMoves = (view) => {
    view.moveTimer = 0
    const pending = view.pendingMoves
    view.pendingMoves = []
    if (pending.length === 0) return
    // Coalesce: only the newest position matters between two frames.
    send(view, { type: 'input', events: pending.slice(-2) })
  }

  const attachInput = (view) => {
    const video = view.video
    const sink = view.sink
    Object.assign(sink.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      opacity: '0', border: '0', resize: 'none', background: 'transparent',
      color: 'transparent', caretColor: 'transparent', outline: 'none', zIndex: '2',
      pointerEvents: 'none',
    })
    sink.setAttribute('autocomplete', 'off')
    sink.setAttribute('spellcheck', 'false')

    video.addEventListener('pointerdown', (event) => {
      sink.focus({ preventScroll: true })
      view.dragging = true
      const { x, y } = toPage(view, event)
      send(view, { type: 'input', events: [{ op: 'mouse', type: 'down', x, y, button: event.button === 2 ? 'right' : 'left', buttons: event.buttons, modifiers: modifiersOf(event) }] })
      event.preventDefault()
    })
    video.addEventListener('pointermove', (event) => {
      const { x, y } = toPage(view, event)
      view.pendingMoves.push({ op: 'mouse', type: 'move', x, y, buttons: event.buttons, modifiers: modifiersOf(event) })
      if (view.pendingMoves.length > 4) view.pendingMoves.splice(0, view.pendingMoves.length - 2)
      if (view.moveTimer === 0) view.moveTimer = setTimeout(() => flushMoves(view), Math.round(1000 / MOVE_HZ))
    })
    video.addEventListener('pointerup', (event) => {
      view.dragging = false
      const { x, y } = toPage(view, event)
      send(view, { type: 'input', events: [{ op: 'mouse', type: 'up', x, y, button: event.button === 2 ? 'right' : 'left', buttons: 0, modifiers: modifiersOf(event) }] })
    })
    video.addEventListener('wheel', (event) => {
      const { x, y } = toPage(view, event)
      send(view, { type: 'input', events: [{ op: 'wheel', x, y, deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY), modifiers: modifiersOf(event) }] })
      event.preventDefault()
    }, { passive: false })
    video.addEventListener('contextmenu', (event) => event.preventDefault())

    sink.addEventListener('keydown', (event) => {
      if (event.isComposing) return
      const code = HARD_KEYS[event.key]
      if (code === undefined) {
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
          send(view, { type: 'input', events: [{ op: 'insertText', text: event.key }] })
          event.preventDefault()
        }
        return
      }
      send(view, { type: 'input', events: [{ op: 'key', type: 'down', key: event.key, code: event.code, keyCode: code, modifiers: modifiersOf(event) }] })
      event.preventDefault()
    })
    sink.addEventListener('keyup', (event) => {
      const code = HARD_KEYS[event.key]
      if (code === undefined) return
      send(view, { type: 'input', events: [{ op: 'key', type: 'up', key: event.key, code: event.code, keyCode: code, modifiers: modifiersOf(event) }] })
    })
    // IME: preedit goes in live, the committed text goes in as one insertion.
    sink.addEventListener('compositionstart', () => { view.composing = true })
    sink.addEventListener('compositionupdate', (event) => {
      if (event.data !== '') send(view, { type: 'input', events: [{ op: 'compose', text: event.data }] })
    })
    sink.addEventListener('compositionend', (event) => {
      view.composing = false
      sink.value = ''
      if (event.data !== '') send(view, { type: 'input', events: [{ op: 'insertText', text: event.data }] })
    })
    sink.addEventListener('input', (event) => {
      if (view.composing) return
      const text = String(sink.value ?? '')
      sink.value = ''
      if (text !== '') send(view, { type: 'input', events: [{ op: 'insertText', text }] })
      event.preventDefault()
    })
    sink.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text !== '') send(view, { type: 'input', events: [{ op: 'insertText', text }] })
      event.preventDefault()
    })
  }

  // ---- placement --------------------------------------------------------
  const applyPlacement = (view, visible) => {
    const box = view.box
    const shown = visible === true && box !== null && box !== undefined
    Object.assign(view.wrap.style, {
      // visibility, not display: a display:none <video> stops decoding, and the
      // panel hides its guest on every re-measure.
      display: 'block',
      visibility: shown ? 'visible' : 'hidden',
      pointerEvents: shown ? 'auto' : 'none',
      left: `${Math.round(box?.left ?? 0)}px`,
      top: `${Math.round(box?.top ?? 0)}px`,
      width: `${Math.round(box?.width ?? 0)}px`,
      height: `${Math.round(box?.height ?? 0)}px`,
    })
    if (!shown) {
      // Stop pulling a video nobody is looking at.
      if (view.connected === true && view.pausedByPanel !== true) {
        view.pausedByPanel = true
        send(view, { type: 'pause' })
      }
      return
    }
    if (view.pausedByPanel === true) {
      view.pausedByPanel = false
      send(view, { type: 'resume' })
      void view.video.play().catch(() => {})
    }
  }

  const mount = (view) => {
    view.wrap = document.createElement('div')
    view.wrap.className = 'ds-bot-web-browser-video-wrap'
    Object.assign(view.wrap.style, {
      position: 'fixed', left: '0px', top: '0px', width: '0px', height: '0px',
      display: 'none', pointerEvents: 'auto', background: '#111', overflow: 'hidden',
    })
    view.video = document.createElement('video')
    view.video.className = 'ds-bot-web-browser-video'
    view.video.muted = true
    view.video.autoplay = true
    view.video.playsInline = true
    Object.assign(view.video.style, { display: 'block', width: '100%', height: '100%', objectFit: 'contain', background: '#111' })
    view.sink = document.createElement('textarea')
    view.badge = document.createElement('div')
    view.badge.className = 'ds-bot-web-browser-cost'
    view.badge.textContent = '宿主 Chromium 渲染 · 不含你的登录态'
    view.badge.title = '这个页面的像素来自宿主上的 Chromium；它和你自己浏览器里的登录状态是分开的。'
    Object.assign(view.badge.style, {
      position: 'absolute', left: '8px', bottom: '8px', zIndex: '3', pointerEvents: 'none',
      padding: '2px 8px', borderRadius: '999px', maxWidth: 'calc(100% - 16px)',
      font: '12px/18px system-ui, -apple-system, "Noto Sans CJK SC", sans-serif',
      background: 'rgba(20,20,22,.62)', color: '#fff', whiteSpace: 'nowrap',
      overflow: 'hidden', textOverflow: 'ellipsis',
    })
    view.wrap.append(view.video, view.sink, view.badge)
    ensureLayer().append(view.wrap)
    attachInput(view)
    // Measure what the panel really renders, for the field diagnostics.
    const count = () => {
      view.rendered += 1
      view.videoFrame = view.video.requestVideoFrameCallback(count)
    }
    if (typeof view.video.requestVideoFrameCallback === 'function') view.videoFrame = view.video.requestVideoFrameCallback(count)
  }

  const historyPush = (view, url) => {
    view.history = view.history.slice(0, view.index + 1)
    view.history.push(url)
    view.index = view.history.length - 1
  }

  const goTo = async (view, url) => {
    view.url = url
    view.title = ''
    view.loading = true
    view.error = null
    historyPush(view, url)
    changed(view)
    try {
      const result = await call({ op: 'navigate', botId: view.botId, url })
      view.url = result.url ?? url
      view.title = result.title ?? ''
      view.error = null
    } catch (error) {
      const message = String(error?.message ?? error)
      view.error = /ERR_ABORTED|aborted|Target closed/i.test(message) ? null : message
    }
    view.loading = false
    changed(view)
  }

  const bridge = {
    views: {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },

      create(botId, tabId, url = '') {
        if (views.has(tabId)) return Promise.resolve()
        const view = {
          botId, tabId, url: typeof url === 'string' ? url : '', title: '', loading: false,
          box: null, history: [], index: -1, chunks: 0, bytes: 0, rendered: 0,
          pendingMoves: [], moveTimer: 0, queue: [], captureSize: undefined,
        }
        views.set(tabId, view)
        mount(view)
        if (view.url !== '') historyPush(view, view.url)
        changed(view, 'created')
        return Promise.resolve()
      },

      sync(botId) {
        return Promise.resolve([...views.values()].filter((view) => view.botId === botId).map(stateOf))
      },

      place(tabId, box, visible) {
        const view = views.get(tabId)
        if (view === undefined) return Promise.resolve()
        if (box !== null && typeof box === 'object') view.box = box
        applyPlacement(view, visible === true)
        if (visible === true && view.url !== '' && view.socket === undefined) {
          void (async () => {
            try {
              await call({ op: 'ensure', botId: view.botId, url: view.url, wsUrl: `${wsBase()}/api/ds-bot-web-browser-ws` })
              await connect(view)
            } catch (error) {
              warn(error)
            }
          })()
        }
        return Promise.resolve()
      },

      navigate(botId, tabId, url) {
        const view = views.get(tabId)
        if (view === undefined) return Promise.resolve(false)
        void goTo(view, String(url ?? ''))
        return Promise.resolve(true)
      },

      read(botId, tabId, script) {
        const view = views.get(tabId)
        if (view === undefined) throw new Error('This Bot has no browser page open.')
        if (!/^https?:/i.test(view.url)) throw new Error('No page is open in this browser tab.')
        return call({ op: 'read', botId: view.botId, script: String(script ?? '') }).then((result) => result.page)
      },

      command(botId, tabId, name) {
        const view = views.get(tabId)
        if (view === undefined) return
        void (async () => {
          try {
            if (name === 'stop') return
            const op = name === 'reload' ? 'reload' : name === 'back' ? 'back' : name === 'forward' ? 'forward' : undefined
            if (op === undefined) return
            const result = await call({ op, botId: view.botId })
            view.url = result.url ?? view.url
            view.title = result.title ?? ''
            changed(view)
          } catch (error) {
            warn(error)
          }
        })()
      },

      focus(botId, tabId) {
        try {
          views.get(tabId)?.sink.focus({ preventScroll: true })
        } catch (error) {
          warn(error)
        }
      },

      hold() {
        return Promise.resolve()
      },

      close(botId, tabId) {
        const view = views.get(tabId)
        if (view === undefined) return Promise.resolve()
        views.delete(tabId)
        try { view.socket?.close() } catch {}
        view.wrap?.remove()
        void call({ op: 'close', botId: view.botId }).catch(() => {})
        queueMicrotask(() => notify({ type: 'closed', botId: view.botId, tabId }))
        return Promise.resolve()
      },
    },

    forget(key) {
      const botId = String(key ?? '').replace(/^bot:/, '')
      for (const [tabId, view] of [...views]) {
        if (view.botId !== botId) continue
        views.delete(tabId)
        try { view.socket?.close() } catch {}
        view.wrap?.remove()
      }
      return Promise.resolve()
    },

    /** Field diagnostics: what the panel has received and rendered. */
    stats() {
      const now = Date.now()
      return [...views.values()].map((view) => ({
        tabId: view.tabId, botId: view.botId, url: view.url, title: view.title,
        connected: view.connected === true, mimeType: view.mimeType ?? null,
        chunks: view.chunks, bytes: view.bytes, renderedFrames: view.rendered,
        videoSize: [view.video.videoWidth, view.video.videoHeight],
        lastChunkAgoMs: view.lastChunkAt === undefined ? null : now - view.lastChunkAt,
        hostStats: view.hostStats ?? null,
      }))
    },
  }

  globalThis.dsBotApp = { browser: bridge }
  globalThis.__dsBotWebBridge = bridge
})()
