/*
 * ds-bot Web browser bridge — injected into every dsh Web page as an inline
 * <head> script by @local/ds-bot-web-browser, before the app shell and before
 * any client plugin module runs.
 *
 * ds-bot's client builds a Bot's browser panel only when it finds a bridge at
 * `window.dshDesktop.browser` (DSH Desktop) or `globalThis.dsBotApp.browser`
 * (the DeepSeek Bot app); both are supplied by an Electron main process that
 * owns real <webview> guests. This file supplies the same object for the Web
 * GUI, backed by sandboxed <iframe> guests, so the panel, its tabs, its
 * navigation bar and the Bot's browser channel work in a plain browser.
 *
 * Reading: an iframe cannot read a cross-origin page's DOM. When the guest is
 * not same-origin, read() is answered by the host's own Chromium through
 * POST api/ds-bot-web-browser (see index.js), which runs the same script
 * ds-bot sent and returns its page object.
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

  const SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'
  const READ_ROUTE = 'api/ds-bot-web-browser'
  const READ_TIMEOUT_MS = 9000

  /** tabId -> { botId, tabId, frame, url, title, loading, box, history, index } */
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
    canGoBack: view.index > 0,
    canGoForward: view.index < view.history.length - 1,
    botAttached: false,
  })

  const changed = (view, type = 'updated') => {
    const change = { type, ...stateOf(view) }
    // Run after the caller finishes its own bookkeeping: ds-bot's change handler
    // opens or closes its tab records, and must see them already in place.
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

  const titleOf = (view) => {
    try {
      return String(view.frame.contentDocument?.title ?? '')
    } catch {
      return ''
    }
  }

  const sameOrigin = (view) => {
    try {
      const location_ = view.frame.contentWindow?.location
      return location_ !== undefined && location_ !== null && location_.origin === location.origin
    } catch {
      return false
    }
  }

  const applyPlacement = (view, visible) => {
    const box = view.box
    const shown = visible === true && box !== null && box !== undefined && view.url !== ''
    Object.assign(view.frame.style, {
      display: shown ? 'block' : 'none',
      left: `${Math.round(box?.left ?? 0)}px`,
      top: `${Math.round(box?.top ?? 0)}px`,
      width: `${Math.round(box?.width ?? 0)}px`,
      height: `${Math.round(box?.height ?? 0)}px`,
    })
  }

  /** Attach (or re-attach after a reload) the guest frame of one view. */
  const mountFrame = (view) => {
    const frame = view.frame
    frame.className = 'ds-bot-web-browser-frame'
    frame.setAttribute('sandbox', SANDBOX)
    frame.setAttribute('referrerpolicy', 'no-referrer')
    Object.assign(frame.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '0px',
      height: '0px',
      border: '0',
      background: '#fff',
      display: 'none',
      pointerEvents: 'auto',
    })
    frame.addEventListener('load', () => {
      if (views.get(view.tabId) !== view) return
      view.loading = false
      view.title = titleOf(view)
      changed(view)
    })
    ensureLayer().append(frame)
    if (view.url !== '') frame.setAttribute('src', view.url)
    applyPlacement(view, false)
  }

  const freshFrame = (view) => {
    const frame = view.frame
    if (frame !== undefined && frame !== null) frame.remove()
    view.frame = document.createElement('iframe')
    mountFrame(view)
  }

  const historyPush = (view, url) => {
    view.history = view.history.slice(0, view.index + 1)
    view.history.push(url)
    view.index = view.history.length - 1
  }

  const goTo = (view, url, { push = true } = {}) => {
    if (url !== view.url) view.url = url
    view.title = ''
    view.loading = true
    if (push) historyPush(view, url)
    try {
      view.frame.setAttribute('src', url)
    } catch (error) {
      warn(error)
    }
    changed(view)
  }

  /** Ask the host's Chromium for the page, since the guest frame is cross-origin. */
  const readFromHost = async (view, script) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS)
    try {
      const response = await fetch(READ_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: view.url, script }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = await response.json()
      if (result?.ok !== true) throw new Error(String(result?.error ?? 'The page could not be read'))
      return result.page
    } finally {
      clearTimeout(timer)
    }
  }

  const readView = async (view, script) => {
    if (sameOrigin(view)) {
      try {
        return await view.frame.contentWindow.eval(script)
      } catch (error) {
        warn(error)
      }
    }
    return readFromHost(view, script)
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
          botId,
          tabId,
          url: typeof url === 'string' ? url : '',
          title: '',
          loading: false,
          box: null,
          history: [],
          index: -1,
        }
        if (view.url !== '') historyPush(view, view.url)
        views.set(tabId, view)
        freshFrame(view)
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
        return Promise.resolve()
      },

      navigate(botId, tabId, url) {
        const view = views.get(tabId)
        if (view === undefined) return Promise.resolve(false)
        goTo(view, String(url ?? ''))
        return Promise.resolve(true)
      },

      read(botId, tabId, script) {
        const view = views.get(tabId)
        if (view === undefined) throw new Error('This Bot has no browser page open.')
        if (!/^https?:/i.test(view.url)) throw new Error('No page is open in this browser tab.')
        return readView(view, String(script ?? ''))
      },

      command(botId, tabId, name) {
        const view = views.get(tabId)
        if (view === undefined) return
        if (name === 'reload') {
          // An iframe does not reload when its src attribute is set to its
          // current value, so reload mounts a fresh guest for the same view.
          view.loading = true
          freshFrame(view)
          changed(view)
          return
        }
        if (name === 'stop') return
        if (name === 'back' && view.index > 0) {
          view.index -= 1
          goTo(view, view.history[view.index] ?? view.url, { push: false })
          return
        }
        if (name === 'forward' && view.index < view.history.length - 1) {
          view.index += 1
          goTo(view, view.history[view.index] ?? view.url, { push: false })
        }
      },

      focus(botId, tabId) {
        try {
          views.get(tabId)?.frame.focus()
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
        view.frame.remove()
        queueMicrotask(() => notify({ type: 'closed', botId: view.botId, tabId }))
        return Promise.resolve()
      },
    },

    forget(key) {
      const botId = String(key ?? '').replace(/^bot:/, '')
      for (const [tabId, view] of [...views]) {
        if (view.botId !== botId) continue
        views.delete(tabId)
        view.frame.remove()
      }
      return Promise.resolve()
    },
  }

  globalThis.dsBotApp = { browser: bridge }
  globalThis.__dsBotWebBridge = bridge
})()
