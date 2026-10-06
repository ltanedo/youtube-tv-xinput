# Native adapters (Windows and macOS)

`core/` is a reusable Rust library with no Tauri/WebView2/WKWebView dependency,
using `adblock = 0.13.3` with the thread-safe engine configuration.
`pake_adblock.rs` is the Windows WebView2 adapter and `pake_adblock_macos.rs`
the macOS WKWebView adapter; `ui.js` provides the Shield panel and the
Ctrl+Alt+B / Cmd+Option+B shortcut; `pake_xinput.rs` is the Windows XInput
controller bridge; `tv-gamepad.js` reads the controller through the page's
Gamepad API (forwarded to the bridge on Windows, turned into key events in the
page on macOS); `tv-navigator.js` is the document-start navigator spoof. All
are copied into `node_modules/pake-cli/src-tauri` by `scripts/prepare.cjs`,
which picks the platform adapter.

The blocker is taken from
[youtube-desktop-lite](https://github.com/ltanedo/youtube-desktop-lite)
(Windows adapter from 0.1.16, macOS adapter unchanged from 0.2.1) with two
changes for the leanback target: the Windows fail-open path navigates to the
configured URL (`youtube.com/tv`) instead of the desktop site, and the Shield
button stays hidden until the mouse moves.

## Ad blocker

The app starts on about:blank, registers the platform's request filtering and
document-start scripts, then navigates to YouTube TV after registration.
Filtering is enabled by default. Changing it persists a native setting, replaces
the document-start script (Windows) or the native rule list (macOS), and
reloads the page. Browser profiles are not cleared. Cookies and settings live in
the `%APPDATA%/YouTubeTV` (Windows) or `~/Library/Application Support/YouTubeTV`
(macOS) profile; blocker files are in its `pake-adblock` subdirectory. Login is
still subject to Google's session expiry.

### macOS

WKWebView cannot intercept individual requests, so the macOS adapter compiles a
deliberately narrow `WKContentRuleList` for known ad hosts and endpoints
(doubleclick, googlesyndication, googleadservices, `youtube.com/pagead`,
`api/stats/ads`, `ptracking`, `get_midroll_info`) and attaches it before the
first navigation. It never blocks `googlevideo.com` media or `youtubei` player
responses. The shared adblock-rust scriptlets, late-response pruning and
cosmetic rules are injected as an initialization script. WebKit does not
expose per-rule match counters, so the Shield panel labels them unavailable
instead of showing zeros.

### Late-ad response fix

`core/src/youtube-late-ads.txt` supplements the upstream lists with narrowly
scoped fetch/XHR scriptlets for `youtubei/v1/player`, `next`, `get_watch`, and
`player/ad_break`, with or without query strings. They remove only `playerAds`,
`adPlacements`, and `adSlots` at supported response/wrapper paths; they do not
seek/skip videos or remove media, captions, end screens or recommendations.
The leanback client fetches the same `youtubei/v1` endpoints, so the rules
apply unchanged. The diagnostic filter version ends in `+pake-late-ads-1`, and
the bundle fingerprint also includes the local rules.

### Scope and limitations

- Document-start filtering is restricted to HTTPS youtube.com,
  www/m/music.youtube.com and youtube-nocookie.com/www.youtube-nocookie.com;
  other origins and document navigations are allowed, including Google sign-in
  documents.
- On Windows, network type/method, Referer (or top document URL fallback),
  exceptions and base64 resource redirects are supported. Blocked requests
  receive 403. Newer WebView2 APIs include worker/frame sources; older runtimes
  use the legacy filter. Referrer-less nested-frame attribution is approximate.
- On macOS, network blocking is limited to the fixed rule list above; the
  downloaded filter lists only feed the scriptlets and cosmetic rules.
- Main-world, document-start scriptlets and domain-specific CSS are applied.
  Only procedural actions convertible to ordinary CSS are supported; there is no
  full uBO procedural DOM engine, response-body rewriting, CSP/header
  manipulation or Brave Shields parity.
- Server-stitched ads are not guaranteed to be removed. Never infer success just
  from a session where no ad was served.
- Linux is not supported. No Skip-button clicking loop on either platform.
- Stats contain counts, bundle fingerprint, runtime/version and a hashed rule ID;
  no request URLs, cookies, authorization headers or browsing history are logged.

### Filter bundles and recovery

Bundled snapshot: 2026-09-17. EasyList from easylist.to; combined uBlock filters
from the official uAssets `filters.min.txt` (includes already expanded), and
quick-fixes/unbreak from uAssets commit
`57a5c31d49185869078326a61449234e8f937886`.
The complete uBlock/Brave resource library is the engine project's test snapshot
at adblock-rust commit `1c0740d27d531a2389c808212a8702592bb74138`.

The Shield panel's Update filters button fetches HTTPS upstream lists plus the
complete resource bundle. Updates are bounded by time/size, validate schema,
list names, preprocessor conditions, base64 resources and YouTube scriptlet output,
then atomically replace one combined cache file. They apply after restart so
network rules and early scripts use the same bundle. Failed downloads/validation
leave existing filters intact; an invalid cache falls back to the shipped snapshot.

## Controller bridge

On Windows, `pake_xinput.rs` spawns one thread that polls `XInputGetState` for
slots 0–3 every 16 ms and merges in the state the page reports through the
`page_gamepad` command. Each mapped button (and each left-stick direction,
thresholded at 50 %) is tracked by a small edge/repeat state machine: one key
tap on press, 80 ms debounce, and for navigation inputs a 350 ms repeat delay
followed by 110 ms repeats. Key taps are synthesized with `SendInput`, but only
while `GetForegroundWindow()` is the app window; on focus loss or disconnect the
held state is cleared so nothing fires when focus returns.

On macOS, `tv-gamepad.js` runs the same mapping and state machine in the page
and dispatches `keydown`/`keyup` `KeyboardEvent`s (key, code and legacy
`keyCode`) to the focused element. WKWebView exposes any controller macOS
recognizes through the Gamepad API, so no native code, OS input injection or
accessibility permission is involved. Triggers raise the `pake:captions-toggle`
/ `pake:aspect-toggle` events for `tv-player.js` on both platforms.

The Windows state machine has unit tests (`cargo test --lib pake_xinput`
inside the patched runtime); the page script is tested by
`scripts/test-gamepad.cjs` (part of `npm test`), which runs it in a fake page
with a scripted gamepad on both platform paths.

## Build and test

From the project root with Node 22+ and Rust 1.95 or newer, with Visual Studio
C++ build tools and WebView2 on Windows or Xcode Command Line Tools on macOS:

```sh
npm ci --ignore-scripts
npm run build
npm test
```

On Windows, set `CARGO_TARGET_DIR` to `.build-target` before `npm test`. The
build produces `YouTubeTV.exe`/`YouTubeTV.msi` on Windows or an Apple-silicon
`YouTubeTV.dmg` on macOS. Local macOS builds are ad-hoc signed; public
distribution still requires a Developer ID signature and Apple notarization.

`scripts/prepare.cjs` checks Pake 3.15.7, applies the native background/startup
patch and explicit anchor-checked edits, copies the checked-in sources, and
restores `runtime-Cargo.lock` and `runtime-package-lock.json`. It is idempotent
and fails on unexpected source.

## Licenses

Keep bundled list headers and `licenses/` with source distributions. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Adding the blocker does not
relicense third-party resources under this repository's MIT license.
