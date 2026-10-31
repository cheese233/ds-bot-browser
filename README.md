# ds-bot Web browser panel (ds-bot-web-browser)

Gives ds-bot's Bot browser panel — the globe button in a Bot's chat that only
DSH Desktop and the DeepSeek Bot app had — to the **dsh Web GUI**.

It does not modify ds-bot. ds-bot's client builds the panel only when it finds
`window.dshDesktop.browser` or `globalThis.dsBotApp.browser`, a bridge that an
Electron main process normally supplies. This package injects that bridge into
every Web page, before the app shell, and backs it on the host.

## What the panel is

* **One real Chromium per Bot**, headed, on its own Xvfb display. Each Bot has
  a private screen, its own profile directory (`state/browser/<botId>`), so
  cookies/localStorage are per Bot and survive restarts.
* **Real video, not JPEG polling.** Inside that browser the page captures its
  own display (`getDisplayMedia` -> `MediaRecorder`) and pushes encoded chunks
  over one WebSocket; the panel plays them with MSE. The same socket carries
  mouse, wheel, keyboard and IME input back.
* **The Bot reads the same page.** `read_browser` is answered with
  `Runtime.evaluate` over CDP on that very page, so what the Bot reads is what
  the user sees.
* **Idle recycling.** A Bot's browser is closed after `idleMinutes` with no
  viewer (the profile directory is kept). Orphaned Xvfb displays from an
  earlier plugin instance are reaped at startup.

## Requirements

* `dsh` with a Web profile.
* **`xvfb`** (`apt install xvfb`) — required for the shipped configuration:
  without an X display, Chromium's ANGLE/GL backend cannot start and WebGL
  falls back to SwiftShader. `DS_BOT_WEB_HEADLESS=1` runs without Xvfb for
  comparison; that row is SwiftShader and its UA needs the override.
* **Chromium/Chrome** (`google-chrome-stable` or set `executablePath`).
* Node.js 22+.

## Install into a dsh profile

1. Put this package where the profile can resolve it, e.g.
   `/root/.dsh/bot/workspace/ds-bot-web-browser`, and link it:
   ```sh
   ln -s /root/.dsh/bot/workspace/ds-bot-web-browser \
     /root/.dsh/profiles/web/node_modules/@local/ds-bot-web-browser
   npm install --prefix /root/.dsh/bot/workspace/ds-bot-web-browser
   ```
2. Add these entries to `profiles/web/cordis.patch.yml` (see
   `cordis-entry.example.yml`): the plugin row, and ds-bot's own browser
   channel switched on:
   ```yaml
   - insert:
       - id: ds-bot-web-browser
         name: "@local/ds-bot-web-browser"
         config:
           mode: video          # video | canvas | iframe
           quality: 81          # canvas fallback only
           idleMinutes: 5
           capture:
             width: 800
             height: 600
   - id: bot
     config:
       browser: true
   ```
   The profile patch is hot-reloaded by dsh-hmr; no restart is needed for
   configuration changes. Changing this package's code needs
   `systemctl restart dsh-web`.

## Measured numbers (this machine)

| item | value |
|---|---|
| WebGL renderer (shipped: Xvfb + `--headless=new` + GL flags) | `ANGLE (Mesa, llvmpipe (LLVM 21.1.8 256 bits), OpenGL 4.5)` |
| WebGL renderer with `DS_BOT_WEB_HEADLESS=1` (no Xvfb) | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)` |
| `navigator.webdriver` | `false` (rebrowser `AutomationControlled` patch) |
| User agent | `Chrome/156.0.0.0`, no `HeadlessChrome` |
| Capture / encoded video | 800×600 display, 800×450 encoded @30 fps |
| Codec chosen | `video/webm;codecs=vp8` (MSE-safe); MP4/H.264 is offered but MediaRecorder's MP4 did not demux in MSE in testing |
| Bitrate under motion | 234–288 kbps (~3.5 chunks/s) — compared with CDP JPEG at several MB/s |
| Panel render rate | ~10–30 fps (only when the page changes; a static page holds its last frame) |
| Memory, two Bots open | Chromium ≈ 728 MiB PSS, Xvfb ≈ 48 MiB PSS |

## Text input

Mouse, wheel, keyboard and IME all go over the panel's WebSocket. Composition
(`compositionupdate`) is sent as `Input.imeSetComposition` and the committed
text (`compositionend`) as `Input.insertText`, so Chinese typed with an IME
lands in the page as one piece.

## Known limitations

* **No dsh-site login state.** The page runs in the host Chromium, not the
  user's browser. This is stated on the panel ("宿主 Chromium 渲染 · 不含你的登录态").
* **Two residual fingerprint tells**, by design of this setup:
  1. `screen.width === outerWidth === 800×600`; a real browser usually has a
     screen larger than its window.
  2. WebGL is still software rendering (llvmpipe) — it just no longer reports
     `SwiftShader`.
* A static page produces few frames; the panel shows the last frame until the
  page changes.
* The video is a fixed capture size; the panel scales it to fit.

## Fallbacks

`mode` switches the transport without touching ds-bot:

* `video` (default) — MediaRecorder stream over WebSocket.
* `canvas` — `Page.startScreencast` JPEG frames (`bridge-canvas.js`).
* `iframe` — the earliest bridge, an iframe in the panel (`bridge.js`).

One line in `cordis.patch.yml` changes it, hot-reloaded.

## Layout

```
index.js            host half: Xvfb, per-Bot Chromium, CDP, WebSocket hub, routes
agent.html          in-browser capture agent (getDisplayMedia -> MediaRecorder -> WS)
bridge-video.js     injected bridge: MSE player + input over WebSocket
bridge-canvas.js    canvas fallback bridge
bridge.js           iframe fallback bridge
cordis-entry.example.yml  the profile patch snippet
```

No secrets, tokens or cookies are stored in this package.
