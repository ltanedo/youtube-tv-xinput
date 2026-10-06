# YouTube TV (Pake) — with Xbox controller support and ad blocking

A lightweight desktop client for the **YouTube TV / leanback interface**
(`youtube.com/tv`, the same UI as Android TV and consoles) for **Windows and
macOS**, built with **Rust**, **Tauri**, and **Pake**. It uses the operating
system's web runtime — WebView2 on Windows, WKWebView on macOS — rather than
bundling a browser.

## Features

- **YouTube TV interface** — spoofs a console user agent (header, client hints
  and `navigator.*`) so YouTube serves the 10-foot leanback UI. Starts fullscreen;
  press **F11** (Windows) or **Ctrl+Cmd+F** (macOS) to toggle.
- **Xbox / game controllers** — on Windows any XInput-compatible controller
  (Xbox One/Series, Xbox 360, or third-party pads in XInput mode) drives the UI
  natively; up to four controllers are polled and input is only injected while
  this window is in the foreground. On macOS any controller the system
  recognizes (Xbox, PlayStation, MFi — over Bluetooth or USB) is read through
  the page's Gamepad API and turned into the same key presses inside the page;
  no accessibility permission is needed.
- **Integrated ad blocker** — the native `adblock-rust` blocker from
  [youtube-desktop-lite](https://github.com/ltanedo/youtube-desktop-lite):
  EasyList + uBlock Origin filters, uBO scriptlets that strip `playerAds` /
  `adPlacements` / `adSlots` from late `youtubei/v1/player|next|get_watch`
  responses, and cosmetic rules. Windows adds WebView2 request interception;
  macOS adds a WKContentRuleList for known ad endpoints. Enabled by default.
  Press **Ctrl+Alt+B** (Windows) or **Cmd+Option+B** (macOS), or move the
  mouse and click **Shield**, for the toggle, diagnostics and filter updates.
  See [native/README.md](native/README.md) for coverage, limitations and
  provenance.
- **Background playback** — video keeps playing when you switch to another
  app, cover the window, or minimize it. A document-start script keeps the page
  reporting `visible`, so YouTube's player never receives the pause trigger;
  on Windows, Chromium backgrounding is disabled as well.
- **Ultrawide fill** — on screens wider than 16:9 (e.g. 3440×1440), 16:9 videos
  are scaled to cover the whole screen instead of showing black bars left and
  right; the top and bottom are cropped. It applies only to landscape video that
  would otherwise be pillarboxed (Shorts, 4:3 and native 21:9 are left alone).
  Press **D** while a video plays, or **RT** on the controller, to switch
  between Fill and Fit; the choice is kept across restarts. The browse UI stays
  16:9 — YouTube lays it out on a fixed 1280×720 grid.
- **Subtitles shortcut** — press **C** while a video plays, or **LT** on the
  controller, to turn subtitles on or off. It switches the same setting as the
  on-screen CC button and turns back on the last language you used. The choice
  is applied to every video and kept across restarts; using the CC button
  updates it too.
- **Frame-by-frame stepping** — while a video plays, tap **<** or **>** (also
  **,** / **.**) to pause, then keep tapping (or hold) to step one frame back or
  forward. The paused overlay is hidden while stepping so the frame is visible,
  and subtitles stay at their normal position near the bottom.
  Play (Space / X, or Enter / A on the play button) resumes straight into
  playback without the overlay popping up; any other key brings it back.
- **Black startup / transition surfaces** — the window, WebView and page are
  black so fullscreen and startup never flash white.

## Controller mapping

| Controller               | Key           | YouTube TV action        |
|--------------------------|---------------|--------------------------|
| D-pad / Left stick       | Arrow keys    | Navigate (auto-repeats)  |
| A / Start / L3           | Enter         | Select                   |
| B / Back (View) / R3     | Escape        | Back                     |
| X                        | Space         | Play / pause             |
| Y                        | `/`           | Search                   |
| LB / RB                  | PageUp / Down | Seek / scroll            |
| LT                       | —             | Subtitles on / off       |
| RT                       | —             | Toggle ultrawide Fill / Fit |

The mapping lives in [`native/pake_xinput.rs`](native/pake_xinput.rs)
(`MAPPINGS`, Windows) and [`native/tv-gamepad.js`](native/tv-gamepad.js)
(macOS); the two are kept identical, including debounce and auto-repeat timing.

## Install (macOS)

Download `YouTubeTV-<version>-macOS-Apple-Silicon.dmg` from the releases page,
open it and drag **YouTubeTV** to Applications. The build is ad-hoc signed, not
notarized: if Gatekeeper blocks the first launch, right-click the app and
choose **Open**, or allow it under **System Settings → Privacy & Security**.
Apple silicon only. Pair the controller in **System Settings → Bluetooth** (or
plug it in) and press any button once the app is open.

## Prerequisites (build from source)

1. **Node.js** 22 or newer
2. **Rust** toolchain (1.95 tested) — [rustup.rs](https://rustup.rs/)
3. Platform build tools:
   - **Windows:** Visual Studio C++ Build Tools ("Desktop development with C++")
     and the WebView2 Runtime (preinstalled on Windows 10/11)
   - **macOS:** Xcode Command Line Tools (`xcode-select --install`); builds an
     Apple-silicon app on Apple-silicon hosts

## Build

```sh
npm ci --ignore-scripts
npm run build
npm test
```

`npm run build` installs project-local **Pake 3.15.7**, applies the checked-in
patches ([`scripts/prepare.cjs`](scripts/prepare.cjs), anchor-checked and
idempotent), copies the blocker core, controller bridge and navigator spoof into
Pake's runtime, and produces `YouTubeTV.exe` (portable) and `YouTubeTV.msi` on
Windows, or `YouTubeTV.dmg` (plus the raw `YouTubeTV-binary`) on macOS. Pass
`--targets app` on macOS to get `YouTubeTV.app` instead of the DMG. On Windows,
set `CARGO_TARGET_DIR` to `.build-target` before `npm test` to keep the test
build out of the Pake runtime.

Extra arguments are forwarded to the Pake CLI, e.g. `npm run build -- --debug`.

Do not build with an unpatched global Pake: the CSS injection alone contains
neither the ad blocker nor the controller bridge.

## How it works

```
scripts/build.cjs  ──►  scripts/prepare.cjs  ──►  node_modules/pake-cli/src-tauri (patched)
                                                    ├─ src/pake_adblock.rs   Windows: WebView2 request filter + scriptlets
                                                    │                        macOS: WKContentRuleList + scriptlets (native/pake_adblock_macos.rs)
                                                    ├─ src/pake_xinput.rs    Windows only: XInput poll → SendInput to this window
                                                    ├─ pake-adblock/core     adblock-rust engine + bundled lists
                                                    ├─ pake-adblock/ui.js    Shield panel (Ctrl+Alt+B / Cmd+Option+B)
                                                    ├─ pake-tv/navigator.js  navigator.userAgent/platform spoof
                                                    ├─ pake-tv/background-play.js  visibility spoof for background playback
                                                    ├─ pake-tv/gamepad.js    Gamepad API poll → page_gamepad (Windows) or key events (macOS)
                                                    └─ pake-tv/player.js     D / C / < > shortcuts: ultrawide fill, subtitles, frame step
```

- The window starts on `about:blank`, registers the platform's request
  filtering (WebView2 `WebResourceRequested` interception on Windows, a
  compiled `WKContentRuleList` on macOS) and the document-start scripts, then
  navigates to `https://www.youtube.com/tv`. Filtering is scoped to HTTPS
  YouTube origins; Google sign-in documents are never blocked.
- On macOS the controller is handled entirely in the page:
  `native/tv-gamepad.js` polls the Gamepad API every 16 ms and dispatches
  `keydown`/`keyup` `KeyboardEvent`s (with the legacy `keyCode` the leanback UI
  reads) to the focused element, using the same mapping, 80 ms debounce and
  350 ms / 110 ms auto-repeat as the Windows bridge. Nothing is injected at the
  OS level, so it needs no permissions and cannot type into other apps.
- On Windows, the controller thread merges two sources every 16 ms into one logical pad
  (buttons ORed, strongest stick wins, so a press seen by both never fires
  twice): the **page's Gamepad API** (`native/tv-gamepad.js` forwards state to
  the `page_gamepad` command) and **XInput** (empty slots probed once a second).
  The page source matters because once the GameInput v2+ runtime is installed —
  many games ship it — Windows gives live controller data only to the process it
  considers focused. For YouTubeTV that is the WebView2 process owning the page
  (`msedgewebview2.exe`), so XInput, GameInput and raw HID reads in the app
  process all return neutral state while the page keeps receiving input. Page
  state older than 300 ms is ignored, so a reload can't leave a key held. Keys
  are still synthesized natively with `SendInput`, gated on YouTubeTV being in
  the foreground. D-pad and stick directions
  repeat after 350 ms at ~9 Hz; buttons fire once per press. State is dropped
  when the window loses focus or a pad disconnects so nothing fires on return.
- Focus is handled for controller-only use: Pake's reveal is patched to bring
  the window to the foreground and move keyboard focus into the WebView2; the
  bridge re-focuses the WebView2 whenever the app gains the foreground; and a
  controller press while the app is *not* foreground activates it during the
  first 45 s after launch or whenever the Windows shell (desktop, taskbar,
  Start) is in front. It never takes focus from another app or game.
- Background playback: `native/tv-background-play.js` pins `document.hidden` /
  `visibilityState` to visible and swallows `visibilitychange` and window
  `blur` before page listeners see them. On Windows, WebView2 is additionally
  launched with `--disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding --disable-background-timer-throttling
  --disable-background-media-suspend`.
- Ultrawide fill: the leanback player sizes the `<video>` to the stream's aspect
  ratio inside a full-window player. `native/tv-player.js` compares that ratio
  with the window's and sets `data-pake-fill` on `<html>`; a rule in
  `inject/yttv.css`, scoped to `body.WEB_PAGE_TYPE_WATCH`, then sizes the video
  to the viewport with `object-fit: cover`.
- Subtitles: C switches the player's caption track (`setOption("captions",
  "track", …)`), not `toggleSubtitlesOn()`, which only hides the captions and
  leaves the CC button showing them as on. The on/off choice is saved and
  enforced for the first 3 s of each video (the player loads caption state
  asynchronously); after that, the player's state is adopted as the saved
  choice. Both choices live in the page's `localStorage`, stored in the app
  profile.
- Frame step: the first tap calls the player's `pauseVideo()`; each further
  tap calls `seekTo(currentTime ± 1/fps)`, with the frame rate read from the
  player's stats (`1920x1080@24`, default 30). Steps are relative, since frame
  timestamps needn't be multiples of 1/fps, and chain from the last target while
  a seek is pending. `data-pake-stepping` on `<html>` hides `ytlr-watch-default`
  (the paused overlay). Resuming from step mode keeps it set until YouTube's
  controls have auto-hidden (its `ytlr-progress-bar` stays `display: none` for
  600 ms; 8 s fallback), so the overlay never flashes up. Any other key, a
  click, pausing again or the next video shows the overlay right away; modifier
  keys (Shift for < and >) and the D / C shortcuts leave it as is. In step mode
  a CSS rule also pins captions at `bottom: 5%`; YouTube otherwise lifts them to
  `bottom: 19rem` above its (now hidden) control bar.
- LT and RT are read from the page Gamepad API in `native/tv-gamepad.js`; they
  are not mapped to keys natively.
- Profile data (cookies, blocker cache, settings) lives in `%APPDATA%\YouTubeTV`
  on Windows and `~/Library/Application Support/YouTubeTV` on macOS.

## Troubleshooting

- **Desktop YouTube shows instead of the TV UI** — the user agent was not
  applied. Rebuild via `npm run build` (not a global `pake`), and clear the
  profile directory above if an old profile persists.
- **Controller does nothing (Windows)** — make sure the app window has focus and the pad
  is in XInput mode (DirectInput-only pads are not supported). Check
  *Settings → Bluetooth & devices → Game controllers* in Windows. To trace the
  bridge, launch with `YTTV_XINPUT_DEBUG=1` set and read
  `%APPDATA%\YouTubeTV\xinput.log` — it records controller connect/disconnect,
  foreground changes, and every key tap sent.
- **Controller does nothing (macOS)** — the pad must be paired or plugged in
  and show up in **System Settings → Game Controllers**; press a button after
  the app is in front (the Gamepad API only exposes a pad once it has been
  used), and keep the app in the foreground.
- **Ads still appear** — open the Shield panel, confirm "Blocking is on" (on
  Windows the counters also increase; WebKit does not expose per-rule counts),
  then try **Update filters** and restart. Server-side stitched ads are not
  guaranteed to be removed.
- **"YouTubeTV can't be opened" on macOS** — the app is ad-hoc signed, not
  notarized. Right-click it and choose **Open**, or allow it under
  **System Settings → Privacy & Security**.

## License

The wrapper customizations are MIT-licensed. Pake, the Rust blocker, filter
lists and scriptlet resources retain their own licenses; see
[third-party notices](native/THIRD-PARTY-NOTICES.md).

Icon: https://www.flaticon.com/free-icons/youtube
