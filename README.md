# YouTube TV (Pake) — with Xbox controller support and ad blocking

A lightweight Windows desktop client for the **YouTube TV / leanback interface**
(`youtube.com/tv`, the same UI as Android TV and consoles), built with
**Rust**, **Tauri**, and **Pake**. It uses the system WebView2 runtime rather
than bundling a browser.

## Features

- **YouTube TV interface** — spoofs a console user agent (header, client hints
  and `navigator.*`) so YouTube serves the 10-foot leanback UI. Starts fullscreen;
  press **F11** to toggle.
- **Xbox / XInput controllers** — any XInput-compatible controller (Xbox One/Series,
  Xbox 360, or third-party pads in XInput mode) drives the UI natively. Up to
  four controllers are polled; input is only injected while this window is in
  the foreground.
- **Integrated ad blocker** — the native `adblock-rust` blocker from
  [youtube-desktop-lite](https://github.com/ltanedo/youtube-desktop-lite):
  WebView2 request interception with EasyList + uBlock Origin filters, uBO
  scriptlets that strip `playerAds` / `adPlacements` / `adSlots` from late
  `youtubei/v1/player|next|get_watch` responses, and cosmetic rules. Enabled by
  default. Press **Ctrl+Alt+B** (or move the mouse and click **Shield**) for the
  toggle, diagnostics and filter updates. See [native/README.md](native/README.md)
  for coverage, limitations and provenance.
- **Background playback** — video keeps playing when you Alt-Tab to another
  app, cover the window, or minimize it. Chromium backgrounding is disabled and
  a document-start script keeps the page reporting `visible`, so YouTube's
  player never receives the pause trigger.
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

The mapping lives in [`native/pake_xinput.rs`](native/pake_xinput.rs) (`MAPPINGS`).

## Prerequisites (build from source, Windows)

1. **Node.js** 22 or newer
2. **Rust** toolchain (1.95 tested) — [rustup.rs](https://rustup.rs/)
3. **Visual Studio C++ Build Tools** — "Desktop development with C++" workload
4. **WebView2 Runtime** (preinstalled on Windows 10/11)

## Build

```powershell
npm ci --ignore-scripts
npm run build
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) '.build-target'
npm test
```

`npm run build` installs project-local **Pake 3.15.7**, applies the checked-in
patches ([`scripts/prepare.cjs`](scripts/prepare.cjs), anchor-checked and
idempotent), copies the blocker core, XInput bridge and navigator spoof into
Pake's runtime, and produces `YouTubeTV.exe` (portable) and `YouTubeTV.msi`.

Extra arguments are forwarded to the Pake CLI, e.g. `npm run build -- --debug`.

Do not build with an unpatched global Pake: the CSS injection alone contains
neither the ad blocker nor the controller bridge.

## How it works

```
scripts/build.cjs  ──►  scripts/prepare.cjs  ──►  node_modules/pake-cli/src-tauri (patched)
                                                    ├─ src/pake_adblock.rs   WebView2 request filter + scriptlets
                                                    ├─ src/pake_xinput.rs    XInput poll → SendInput to this window
                                                    ├─ pake-adblock/core     adblock-rust engine + bundled lists
                                                    ├─ pake-adblock/ui.js    Shield panel (Ctrl+Alt+B)
                                                    ├─ pake-tv/navigator.js  navigator.userAgent/platform spoof
                                                    └─ pake-tv/background-play.js  visibility spoof for background playback
```

- The window starts on `about:blank`, registers `WebResourceRequested`
  interception and document-created scripts, then navigates to
  `https://www.youtube.com/tv`. Filtering is scoped to HTTPS YouTube origins;
  Google sign-in documents are never blocked.
- The controller thread polls two sources every 16 ms and merges them into one
  logical pad (buttons ORed, strongest stick wins, so a press seen by both
  never fires twice): **GameInput** (the in-box `GameInput.dll`, loaded from
  System32, with `GameInputEnableBackgroundInput`) and **XInput** (empty slots
  probed once a second). GameInput matters because once the GameInput v2+
  runtime is installed — many games ship it — both XInput and GameInput hand
  *neutral* state to any process the runtime doesn't consider focused, and
  YouTubeTV often isn't: its keyboard focus lives in the WebView2 child window,
  which belongs to `msedgewebview2.exe`. Opting into background input sidesteps
  that; the bridge's own foreground gate still decides whether keys are sent.
  Key taps are synthesized with `SendInput`. D-pad and stick directions
  repeat after 350 ms at ~9 Hz; buttons fire once per press. State is dropped
  when the window loses focus or a pad disconnects so nothing fires on return.
- Focus is handled for controller-only use: Pake's reveal is patched to bring
  the window to the foreground and move keyboard focus into the WebView2; the
  bridge re-focuses the WebView2 whenever the app gains the foreground; and a
  controller press while the app is *not* foreground activates it during the
  first 45 s after launch or whenever the Windows shell (desktop, taskbar,
  Start) is in front. It never takes focus from another app or game.
- Background playback: WebView2 is launched with
  `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
  --disable-background-timer-throttling --disable-background-media-suspend`,
  and `native/tv-background-play.js` pins `document.hidden` / `visibilityState`
  to visible and swallows `visibilitychange` and window `blur` before page
  listeners see them.
- Profile data (cookies, blocker cache, settings) lives in `%APPDATA%\YouTubeTV`.

## Troubleshooting

- **Desktop YouTube shows instead of the TV UI** — the user agent was not
  applied. Rebuild via `npm run build` (not a global `pake`), and clear
  `%APPDATA%\YouTubeTV` if an old profile persists.
- **Controller does nothing** — make sure the app window has focus and the pad
  is in XInput mode (DirectInput-only pads are not supported). Check
  *Settings → Bluetooth & devices → Game controllers* in Windows. To trace the
  bridge, launch with `YTTV_XINPUT_DEBUG=1` set and read
  `%APPDATA%\YouTubeTV\xinput.log` — it records controller connect/disconnect,
  foreground changes, and every key tap sent.
- **Ads still appear** — open the Shield panel, confirm "Blocking is on" and
  the counters increase, then try **Update filters** and restart. Server-side
  stitched ads are not guaranteed to be removed.

## License

The wrapper customizations are MIT-licensed. Pake, the Rust blocker, filter
lists and scriptlet resources retain their own licenses; see
[third-party notices](native/THIRD-PARTY-NOTICES.md).

Icon: https://www.flaticon.com/free-icons/youtube
