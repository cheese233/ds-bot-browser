/*
 * ds-bot Web browser bridge — canvas mode.
 *
 * Injected into every dsh Web page as an inline <head> script by
 * @local/ds-bot-web-browser, before the app shell and every client plugin
 * module, so ds-bot's client finds `globalThis.dsBotApp.browser` and builds its
 * Bot browser panel.
 *
 * Each panel is a <canvas> fed by the host Chromium's own pixels: the page runs
 * on the host (`Page.startScreencast`), the user's mouse, keyboard and IME input
 * go there through CDP, and the Bot's read is answered from that same page. The
 * price, which the panel states: the page has no dsh-site login state of yours.
 */
(() => {
  if (globalThis.dsBotApp !== undefined && globalThis.dsBotApp.browser !== undefined) return

  // dsh Web is served over plain HTTP on a non-localhost address, where
  // crypto.randomUUID is not available (secure-context only). ds-bot's client
  // seeds its browser channel client id with it, so without this shim
  // serveBrowserReads throws and read_browser can never be answered.
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
  const READ_TIMEOUT_MS = 12_000
  const HEADER_BYTES = 5

  /** tabId -> view */
  const views = new Map()
  const listeners = new Set()
  let layer = null

  const warn = (error) => console.warn('[ds-bot-web-browser]', error)

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

  /** Opt-in tracing (globalThis.__dsBotWebDebug = true) for field diagnosis. */
  const trace = (dir, op, value) => {
    if (globalThis.__dsBotWebDebug === true) console.log('[dsb-web]', dir, op, String(value ?? '').slice(0, 160))
  }

  /** One POST to the host route; rejects on a refused op. */
  const call = async (payload) => {
    trace('->', payload.op, `${payload.url ?? ''} ${JSON.stringify(payload.viewport ?? null)}`)
    const response = await fetch(ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const result = await response.json()
    trace('<-', payload.op, JSON.stringify(result).slice(0, 160))
    if (result?.ok !== true) throw new Error(String(result?.error ?? 'The browser request failed'))
    return result
  }

  const viewportOf = (view) => ({
    width: Math.max(240, Math.round(view.box?.width ?? 800)),
    height: Math.max(200, Math.round(view.box?.height ?? 600)),
    dpr: Math.min(2, Math.max(1, Number(globalThis.devicePixelRatio) || 1)),
  })

  // ---- input ------------------------------------------------------------
  // A hidden textarea owns focus so the browser's own IME works against the
  // streamed page: composition events feed imeSetComposition (live preedit) and
  // the committed text goes in with Input.insertText.
  const HARD_KEYS = {
    Enter: 13, Backspace: 8, Delete: 46, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Home: 36, End: 35, PageUp: 33, PageDown: 34, Shift: 16, Control: 17, Alt: 18, Meta: 91,
  }

  const mouseEvent = (view, type, event, extra = {}) => {
    const rect = view.canvas.getBoundingClientRect()
    return {
      op: 'mouse',
      type,
      x: Math.round(((event.clientX - rect.left) / Math.max(1, rect.width)) * (view.box?.width ?? rect.width)),
      y: Math.round(((event.clientY - rect.top) / Math.max(1, rect.height)) * (view.box?.height ?? rect.height)),
      button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
      buttons: event.buttons,
      modifiers: modifiersOf(event),
      ...extra,
    }
  }
  const modifiersOf = (event) => (event.shiftKey ? 8 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 1 : 0) | (event.metaKey ? 4 : 0)

  const sendInput = (view, events) => {
    if (events.length === 0) return
    view.pending.push(...events)
    if (view.inputTimer !== 0) return
    view.inputTimer = setTimeout(() => {
      view.inputTimer = 0
      const batch = view.pending.splice(0, view.pending.length)
      void call({ op: 'input', botId: view.botId, events: batch }).catch((error) => warn(error))
    }, 12)
  }

  const attachInput = (view) => {
    const canvas = view.canvas
    const sink = view.sink
    Object.assign(sink.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      opacity: '0', border: '0', resize: 'none', background: 'transparent',
      color: 'transparent', caretColor: 'transparent', outline: 'none',
      overflow: 'hidden', pointerEvents: 'none', zIndex: '1',
    })
    sink.setAttribute('autocapitalize', 'off')
    sink.setAttribute('autocomplete', 'off')
    sink.setAttribute('autocorrect', 'off')
    sink.setAttribute('spellcheck', 'false')

    // Mouse: the canvas takes the pointer, the sink keeps the keyboard focus.
    const down = (event) => {
      sink.focus({ preventScroll: true })
      view.dragging = true
      sendInput(view, [mouseEvent(view, 'down', event)])
      event.preventDefault()
    }
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', (event) => {
      sendInput(view, [mouseEvent(view, view.dragging ? 'move' : 'move', event)])
    })
    canvas.addEventListener('pointerup', (event) => {
      view.dragging = false
      sendInput(view, [mouseEvent(view, 'up', event)])
    })
    canvas.addEventListener('pointerleave', () => {
      view.dragging = false
    })
    canvas.addEventListener('wheel', (event) => {
      const rect = view.canvas.getBoundingClientRect()
      sendInput(view, [{
        op: 'wheel',
        x: Math.round(((event.clientX - rect.left) / Math.max(1, rect.width)) * (view.box?.width ?? rect.width)),
        y: Math.round(((event.clientY - rect.top) / Math.max(1, rect.height)) * (view.box?.height ?? rect.height)),
        deltaX: Math.round(event.deltaX),
        deltaY: Math.round(event.deltaY),
        modifiers: modifiersOf(event),
      }])
      event.preventDefault()
    }, { passive: false })
    canvas.addEventListener('contextmenu', (event) => event.preventDefault())

    // Keyboard: control keys go through dispatchKeyEvent; printable text and
    // IME commits go through insertText, which is what makes Chinese work.
    sink.addEventListener('keydown', (event) => {
      if (event.isComposing) return
      const code = HARD_KEYS[event.key]
      if (code === undefined) {
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
          sendInput(view, [{ op: 'insertText', text: event.key }])
          event.preventDefault()
        }
        return
      }
      sendInput(view, [{
        op: 'key',
        type: 'down',
        key: event.key,
        code: event.code,
        keyCode: code,
        modifiers: modifiersOf(event),
      }])
      event.preventDefault()
    })
    sink.addEventListener('keyup', (event) => {
      const code = HARD_KEYS[event.key]
      if (code === undefined) return
      sendInput(view, [{ op: 'key', type: 'up', key: event.key, code: event.code, keyCode: code, modifiers: modifiersOf(event) }])
    })
    // IME: live preedit in the page, committed text as a single insertion.
    sink.addEventListener('compositionstart', () => {
      view.composing = true
    })
    sink.addEventListener('compositionupdate', (event) => {
      if (event.data !== '') sendInput(view, [{ op: 'compose', text: event.data }])
    })
    sink.addEventListener('compositionend', (event) => {
      view.composing = false
      sink.value = ''
      if (event.data !== '') sendInput(view, [{ op: 'insertText', text: event.data }])
    })
    sink.addEventListener('input', (event) => {
      if (view.composing) return
      const text = String(sink.value ?? '')
      sink.value = ''
      if (text !== '') sendInput(view, [{ op: 'insertText', text }])
      event.preventDefault()
    })
    sink.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text !== '') sendInput(view, [{ op: 'insertText', text }])
      event.preventDefault()
    })
  }

  // ---- frame stream -----------------------------------------------------
  const startStream = async (view) => {
    if (view.streaming) return
    view.streaming = true
    const controller = new AbortController()
    view.streamAbort = controller
    try {
      // The host page is the single source of truth. `ensure` only creates it at
      // the panel's size: navigating here too would race ds-bot's own navigate
      // and abort the load.
      const ensured = await call({ op: 'ensure', botId: view.botId, url: view.url, viewport: viewportOf(view) })
      if (typeof ensured.url === 'string' && ensured.url !== '') view.url = ensured.url
      if (typeof ensured.title === 'string' && ensured.title !== '') view.title = ensured.title
      changed(view)
      const response = await fetch(ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'stream', botId: view.botId, viewport: viewportOf(view) }),
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
      const reader = response.body.getReader()
      let buffer = new Uint8Array(0)
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value === undefined) continue
        const merged = new Uint8Array(buffer.byteLength + value.byteLength)
        merged.set(buffer, 0)
        merged.set(value, buffer.byteLength)
        buffer = merged
        while (buffer.byteLength >= HEADER_BYTES) {
          const type = buffer[0]
          const length = (buffer[1] << 24 | buffer[2] << 16 | buffer[3] << 8 | buffer[4]) >>> 0
          if (buffer.byteLength < HEADER_BYTES + length) break
          const payload = buffer.subarray(HEADER_BYTES, HEADER_BYTES + length)
          buffer = buffer.subarray(HEADER_BYTES + length)
          if (type === 1) {
            let message = {}
            try {
              message = JSON.parse(new TextDecoder().decode(payload))
            } catch (error) {
              warn(error)
            }
            if (typeof message.url === 'string') view.url = message.url
            if (typeof message.title === 'string') view.title = message.title
            if (typeof message.error === 'string') view.error = message.error
            if (message.closed === true) view.closed = true
            changed(view)
          } else if (type === 2) {
            view.frames += 1
            view.bytes += payload.byteLength
            void drawFrame(view, payload)
          }
        }
      }
    } catch (error) {
      if (error?.name !== 'AbortError') warn(error)
    } finally {
      view.streaming = false
    }
  }

  const drawFrame = async (view, bytes) => {
    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
      const canvas = view.canvas
      const ratio = Math.min(2, Math.max(1, Number(globalThis.devicePixelRatio) || 1))
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      const context = view.context
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      bitmap.close?.()
    } catch (error) {
      warn(error)
    } finally {
      // Ack after drawing: the host only acks Chromium afterwards, so a slow
      // viewer throttles the page instead of piling frames up.
      void call({ op: 'ack', botId: view.botId }).catch(() => {})
    }
  }

  const restartStream = (view) => {
    if (view.streamAbort !== undefined) {
      view.streamAbort.abort()
      view.streamAbort = undefined
      view.streaming = false
    }
    setTimeout(() => void startStream(view), 30)
  }

  // ---- placement --------------------------------------------------------
  const applyPlacement = (view, visible) => {
    const box = view.box
    const shown = visible === true && box !== null && box !== undefined
    Object.assign(view.wrap.style, {
      display: shown ? 'block' : 'none',
      left: `${Math.round(box?.left ?? 0)}px`,
      top: `${Math.round(box?.top ?? 0)}px`,
      width: `${Math.round(box?.width ?? 0)}px`,
      height: `${Math.round(box?.height ?? 0)}px`,
    })
    if (!shown) {
      // A hidden panel must not keep pulling pixels: drop the stream shortly
      // after it goes away, and let the host sweep the page once it is idle.
      if (view.streaming && view.hideTimer === 0) {
        view.hideTimer = setTimeout(() => {
          view.hideTimer = 0
          view.streamAbort?.abort()
          view.streamAbort = undefined
          view.streaming = false
        }, 8000)
      }
      return
    }
    if (view.hideTimer !== 0) {
      clearTimeout(view.hideTimer)
      view.hideTimer = 0
    }
    const ratio = Math.min(2, Math.max(1, Number(globalThis.devicePixelRatio) || 1))
    const width = Math.max(1, Math.round((box?.width ?? 0) * ratio))
    const height = Math.max(1, Math.round((box?.height ?? 0) * ratio))
    if (view.canvas.width !== width || view.canvas.height !== height) {
      view.canvas.width = width
      view.canvas.height = height
      view.canvas.style.width = '100%'
      view.canvas.style.height = '100%'
    }
    const viewport = viewportOf(view)
    if (view.viewport === undefined || view.viewport.width !== viewport.width || view.viewport.height !== viewport.height) {
      view.viewport = viewport
      if (view.streaming) void call({ op: 'resize', botId: view.botId, viewport }).catch((error) => warn(error))
    }
  }

  const mount = (view) => {
    view.wrap = document.createElement('div')
    view.wrap.className = 'ds-bot-web-browser-canvas-wrap'
    Object.assign(view.wrap.style, {
      position: 'fixed', left: '0px', top: '0px', width: '0px', height: '0px',
      display: 'none', pointerEvents: 'auto', background: '#fff', overflow: 'hidden',
    })
    view.canvas = document.createElement('canvas')
    view.canvas.className = 'ds-bot-web-browser-canvas'
    Object.assign(view.canvas.style, { display: 'block', width: '100%', height: '100%', cursor: 'default' })
    view.context = view.canvas.getContext('2d', { alpha: false })
    view.sink = document.createElement('textarea')
    // The price of this mode, stated on the panel itself: the page is painted by
    // the host's Chromium, so it carries none of the user's own logins.
    view.badge = document.createElement('div')
    view.badge.className = 'ds-bot-web-browser-cost'
    view.badge.textContent = '宿主 Chromium 渲染 · 不含你的登录态'
    view.badge.title = '这个页面的像素来自宿主上的 Chromium；它和你自己浏览器里的登录状态是分开的。'
    Object.assign(view.badge.style, {
      position: 'absolute', left: '8px', bottom: '8px', zIndex: '2', pointerEvents: 'none',
      padding: '2px 8px', borderRadius: '999px', maxWidth: 'calc(100% - 16px)',
      font: '12px/18px system-ui, -apple-system, "Noto Sans CJK SC", sans-serif',
      background: 'rgba(20,20,22,.62)', color: '#fff', whiteSpace: 'nowrap',
      overflow: 'hidden', textOverflow: 'ellipsis',
    })
    view.wrap.append(view.canvas, view.sink, view.badge)
    ensureLayer().append(view.wrap)
    attachInput(view)
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
      // A navigation superseded by a newer one is not a failed page.
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
          box: null, history: [], index: -1, pending: [], inputTimer: 0, frames: 0, bytes: 0,
          streaming: false, closed: false, dragging: false, composing: false, hideTimer: 0,
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
        if (visible === true && view.url !== '' && !view.streaming) void startStream(view)
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
            if (name === 'reload') {
              const result = await call({ op: 'reload', botId: view.botId })
              view.url = result.url ?? view.url
              view.title = result.title ?? ''
              restartStream(view)
            } else if (name === 'back' || name === 'forward') {
              const result = await call({ op: name, botId: view.botId })
              view.url = result.url ?? view.url
              view.title = result.title ?? ''
            } else return
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
        view.streamAbort?.abort()
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
        view.streamAbort?.abort()
        view.wrap?.remove()
      }
      return Promise.resolve()
    },

    /** Test hook: what the panel has drawn so far. */
    stats() {
      return [...views.values()].map((view) => ({
        tabId: view.tabId, botId: view.botId, url: view.url, title: view.title,
        frames: view.frames, bytes: view.bytes, streaming: view.streaming,
      }))
    },
  }

  globalThis.dsBotApp = { browser: bridge }
  globalThis.__dsBotWebBridge = bridge
})()
