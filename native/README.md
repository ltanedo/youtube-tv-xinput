# Native Windows adapters

`core/` is a reusable Rust library with no Tauri/WebView2 dependency, using
`adblock = 0.13.3` with the thread-safe engine configuration. `pake_adblock.rs`
is the Windows WebView2 adapter, `ui.js` provides the Shield panel and
Ctrl+Alt+B shortcut, `pake_xinput.rs` is the XInput controller bridge and
`tv-navigator.js` is the document-start navigator spoof. All are copied into
`node_modules/pake-cli/src-tauri` by `scripts/prepare.cjs`.

The blocker is taken from
[youtube-desktop-lite 0.1.16](https://github.com/ltanedo/youtube-desktop-lite)
with two changes for the leanback target: the fail-open path navigates to the
configured URL (`youtube.com/tv`) instead of the desktop site, and the Shield
button stays hidden until the mouse moves.

## Ad blocker

The app starts on about:blank, registers WebResourceRequested interception and
document-created scripts, then navigates to YouTube TV after script registration.
Filtering is enabled by default. Changing it persists a native setting, replaces
the document-created script, and reloads the page. Browser profiles are not cleared.
Cookies and settings live in the `%APPDATA%/YouTubeTV` profile; blocker files
are in its `pake-adblock` subdirectory. Login is still subject to Google's
session expiry.

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

- Requests originating from HTTPS youtube.com, www/m/music.youtube.com and
  youtube-nocookie.com/www.youtube-nocookie.com are checked; other origins and
  document navigations are allowed, including Google sign-in documents.
- Network type/method, Referer (or top document URL fallback), exceptions and
  base64 resource redirects are supported. Blocked requests receive 403.
  Newer WebView2 APIs include worker/frame sources; older runtimes use the legacy
  filter. Referrer-less nested-frame attribution is approximate.
- Main-world, document-start scriptlets and domain-specific CSS are applied.
  Only procedural actions convertible to ordinary CSS are supported; there is no
  full uBO procedural DOM engine, response-body rewriting, CSP/header
  manipulation or Brave Shields parity.
- Server-stitched ads are not guaranteed to be removed. Never infer success just
  from a session where no ad was served.
- Linux/macOS are not supported by this adapter. No Skip-button clicking loop.
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

## XInput controller bridge

`pake_xinput.rs` spawns one thread that polls `XInputGetState` for slots 0–3
every 16 ms. Each mapped button (and each left-stick direction, thresholded at
50 %) is tracked by a small edge/repeat state machine: one key tap on press,
80 ms debounce, and for navigation inputs a 350 ms repeat delay followed by
110 ms repeats. Key taps are synthesized with `SendInput`, but only while
`GetForegroundWindow()` is the app window; on focus loss or disconnect the
held state is cleared so nothing fires when focus returns.

The state machine has unit tests (`cargo test --lib pake_xinput` inside the
patched runtime).

## Build and test

From the project root on Windows with Node 22+, Rust 1.95 (tested), Visual Studio
C++ build tools and WebView2:

```powershell
npm ci --ignore-scripts
npm run build
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) '.build-target'
npm test
```

`scripts/prepare.cjs` checks Pake 3.15.7, applies the native background/startup
patch and explicit anchor-checked edits, copies the checked-in sources, and
restores `runtime-Cargo.lock` and `runtime-package-lock.json`. It is idempotent
and fails on unexpected source.

## Licenses

Keep bundled list headers and `licenses/` with source distributions. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Adding the blocker does not
relicense third-party resources under this repository's MIT license.
