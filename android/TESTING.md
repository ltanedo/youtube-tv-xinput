# Android port validation

## Video transition and background default — 2026-11-04 (0.3.2 / code 5)

Replaced WebView's stock video poster with a cached opaque black bitmap via
`WebChromeClient.getDefaultVideoPoster()`. A full-screen, source-less video in the
actual Android WebView rendered black instead of the stretched bright play badge.
The native poster is replaced naturally by the first decoded frame; no timed
cover, playback delay, or forced reload is introduced. Explicit HTML video posters
are unaffected.

Background play now defaults to **off** if its preference is absent. Explicitly
saved choices remain authoritative. The package ID and persistent signing key
remain unchanged for updates from 0.3.0 and 0.3.1.

Validation: all **13 existing instrumentation tests passed on both emulators**
([TV](evidence/v032-tv.txt), [phone](evidence/v032-phone.txt));
[live YouTube playback](evidence/v032-live.txt), including remote pause/resume and
background/screen-off playback after enabling it, also passed. APK assembly and
Android lint passed. The isolated update emulator accepted 0.3.2 over 0.3.1 with
`adb install -r`; its app-private marker survived. With no stored background-play
preference, the native settings menu displayed **Background play: off**.
The signing certificate remains `d5d6188f79287c15b1609d9bb4efd76ba823d8ce97a9ef9485a311effc2319a0`.

## Launcher icon and playback recovery — 2026-11-04 (0.3.1 / code 4)

The launcher now uses an adaptive icon with an opaque red background and a white
play symbol. Visually verified the full circular tile after updating an Android 15
installation: [launcher screenshot](evidence/v031-launcher.png).

Verified **in-place update from the original Codemagic 0.3.0 APK to 0.3.1** on an
isolated Android 15 ARM64 emulator. Both have signing certificate SHA-256
`d5d6188f79287c15b1609d9bb4efd76ba823d8ce97a9ef9485a311effc2319a0`.
An app-private data marker survived `adb install -r`, with versionCode increasing
from 3 to 4. [Upgrade record](evidence/v031-upgrade.txt).

The background media service now survives temporary buffering. A bounded foreground
watchdog makes a tiny seek within buffered/seekable media after sustained clock stalls
or heavy frame loss. Deterministic JS tests cover both triggers, startup grace,
cooldown/budget, new-video reset, healthy playback, pauses, seeking, ads, background,
network buffering, and unseekable media. A WebView test injects a frozen media clock
on a seekable Blob and verifies automatic recovery followed by advancing playback;
it also verifies buffering does not stop the media service.

All **13 controlled instrumentation tests passed on both Android TV and the
Fold-shaped Android 15 emulator**, in separate input/filter and playback runs:
[TV input/filter](evidence/v031-tv-port.txt), [TV playback](evidence/v031-tv-playback.txt),
[phone input/filter](evidence/v031-phone-port.txt), [phone playback](evidence/v031-phone-playback.txt).
[Live YouTube playback](evidence/v031-live.txt) also passed on the phone, including
remote pause/resume, background and screen-off playback. Local APK assembly,
Android lint (0 errors), and `npm test` including recovery cases passed.

The exact rare physical-device stutter has not been reproduced. These tests establish
recovery behavior, not universal prevention of hardware or network-related stutter.

## Zoom, background playback, and touch lock — 2026-10-29 (0.3.0 / code 3)

All **12 controlled tests passed** on Android 14 ARM64 TV (1920×1080) and Android
15 ARM64 phone resized to **2176×1812 landscape** to exercise a Fold-shaped inner
display. [TV output](evidence/v030-tv.txt) · [Fold-shaped emulator output](evidence/v030-fold.txt).
Tests cover zoom fit/fill and viewport bounds, preference reapplication after reload,
Android fit overriding desktop CSS, menu toggles, touch lock with hold-to-unlock,
remote input while locked, and every previous gesture/filter/controller regression.
A generated H.264/AAC fixture verified advancing video behind Home and for four
seconds with the screen off, notification Pause, pause-on-leave when disabled, and
foreground-service cleanup on exit.

**Live YouTube playback also passed** on the Fold-shaped emulator at 1920×1080:
clock advanced from 2.16 to 7.38 seconds, remote pause/resume worked, then playback
continued behind Home and with the screen off (five seconds each).
[Live test](evidence/v030-live.txt) · [Telemetry](evidence/v030-live-report.json).
This session counted four blocked requests and zero interception errors.

Universal debug/test APK builds, Android lint (0 errors, 22 warnings), and `npm test`
passed. No physical Samsung Fold or Chromecast was connected. Long screen-off
sessions, Samsung battery policies, folding between displays on real hardware, and
playback recovery after process death are not established by these short tests.

## Touch navigation update — 2026-10-28 (0.2.0)

All **8 controlled instrumentation tests passed on both** the Android 14 ARM64
TV emulator (1920×1080) and an Android 15 ARM64 Pixel 5 emulator in landscape.
See [TV output](evidence/gesture-tv.txt) and [phone output](evidence/gesture-phone.txt).
Coverage includes four swipe directions, tap/select, double-tap/back, hold/settings,
no duplicate DOM clicks, cancellation/multitouch, switching from touch to remote,
ordinary Google consent touch, remote/gamepad buttons, captions/aspect shortcuts,
stick repeat/disconnect, JNI filtering, fetch/XHR pruning, and blocker toggling.
The phone's first-use Android immersive-mode hint must be dismissed before testing.

The debug and instrumentation APKs built, Android lint passed, and `npm test`
passed. A live phone playback/pause-resume run succeeded earlier in this session;
a repeat timed out before playback started. The current TV live check encountered
YouTube's account/bot-confirmation screen; saved accounts were left untouched.
These network-dependent results do not establish reliable playback on every session
or physical Chromecast compatibility. The historical live evidence below is from
the previous version, not a new successful TV playback run.

Tested on 2026-10-27 on an Apple-silicon Mac using an Android 14 (API 34)
Android TV ARM64 emulator, `tv_1080p` profile (1920×1080 display), with the image's
bundled Google WebView 113.0.5672.136. The emulator used SwiftShader rendering.
No Google account was signed in.

## Results

- Universal debug APK and unsigned release APK built for ARM64, ARMv7, and
  x86_64. The universal debug APK is approximately 26 MB.
- Six instrumented tests passed, both through Gradle and via direct `adb am
  instrument` on the final universal debug APK. See [test output](evidence/instrumentation.txt).
- Real `youtube.com/tv` loaded the leanback UI and played the public Big Buck
  Bunny video `aqz-KE-bpKQ` at **1280×720**. Its clock advanced from 2.12 to
  7.17 seconds over a five-second interval. Remote play/pause paused and resumed
  the video. See [telemetry](evidence/live-report.json).
- The live session counted **5 blocked network requests, 0 interception
  errors**. This is evidence of network interception, not a claim that every
  kind of YouTube ad has been eliminated.
- Controlled WebView fixtures verified early navigator spoofing, fetch/XHR
  removal of `playerAds`/`adPlacements`/`adSlots`, preservation of content video
  metadata and streaming data, network blocking, and disabling/re-enabling the
  blocker. JNI checks preserved ordinary media and Google sign-in sources.
- Remote D-pad/select and gamepad B/X/LT delivery passed; stick auto-repeat
  stopped on controller disconnect. The native settings menu was also opened
  and visually inspected on the emulator.
- `npm test` passed (4 shared Rust tests plus the desktop gamepad suite).
  `cargo clippy --locked --manifest-path android/blocker/Cargo.toml -- -D warnings`
  passed. Android lint completed with 0 errors and 19 warnings, including newer
  dependency versions, untranslated strings, intentional landscape orientation,
  and conservative feature/ABI detection warnings.

![Real YouTube playback on Android TV](evidence/live-playing.png)

![Native remote-friendly settings](evidence/settings.png)

## Remaining device validation

Physical Chromecast hardware, account sign-in/session retention, Bluetooth
controller models, 4K/HDR, and long sessions with mid-roll/post-roll ads have not
been verified. The emulator does not establish those capabilities. The port
currently ships bundled filters rather than the desktop filter updater.

## Host tooling notes

The newest installed Mac ADB binary crashed with
`libunwind: stepWithCompactEncoding - invalid compact unwind encoding`.
Using Google's platform-tools 35.0.2 ADB resolved the connection loss. The
emulator image's missing optional `devices.xml` warning did not prevent creation
or startup. The live test posts bounded main-thread operations because waiting
for ActivityScenario's UI-idle synchronization can hang during video playback.

See [README.md](README.md#emulator-tests) for build and reproduction commands.
