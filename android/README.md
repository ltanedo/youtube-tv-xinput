# Android TV port (experimental)

This is an Android shell for the same `youtube.com/tv` client used by the
desktop app. It does not patch Google's APK or implement the paid YouTube TV
live-channel service. Android TV / Google TV is the primary target; ordinary
Android devices can launch it in landscape for testing.

## Build

Requires JDK 17, Node (for the repository tests), Rust, Android SDK platform 35,
build tools 35.0.0, and NDK 28.0.13004108. Set `JAVA_HOME` to your JDK and
`ANDROID_HOME` to your SDK directory. On a Homebrew installation these are
typically `/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home` and
`/opt/homebrew/share/android-commandlinetools`.

```sh
sdkmanager 'platforms;android-35' 'build-tools;35.0.0' 'ndk;28.0.13004108' 'platform-tools'
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
cargo install cargo-ndk --locked --version 4.1.2
./android/gradlew -p android assembleDebug lintDebug
```

Gradle builds the JNI library and copies the shared scripts and license notices
automatically. The debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`.
It includes ARM64, ARMv7 (needed by some Chromecast operating systems), and x86_64.
For a faster ARM64 emulator build add `-PandroidAbis=arm64-v8a`.
The first build downloads Gradle and dependencies. APK signing for public releases
is not configured; debug builds are for sideloading and evaluation.

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.github.ltanedo.youtubetv/.MainActivity
```

## Codemagic cloud build

The [Codemagic project](https://codemagic.io/app/6ae16c0cf2ec2b2a22c3fee2/settings)
uses the root `codemagic.yaml` workflow **android-tv-debug**. Select the branch
containing the Android port (currently `feature/android-tv-port`) and start that
workflow from Codemagic, or use the API helper from a clean, pushed checkout:

```sh
# Supply an existing token through the environment or a private file, never Git.
export CODEMAGIC_TOKEN_FILE="$HOME/.config/codemagic/api-token"
python3 scripts/codemagic.py
python3 scripts/codemagic.py --status BUILD_ID
```

The workflow installs the pinned Rust/NDK toolchain, runs `npm test`, builds the
universal debug APK and instrumentation APK, and runs Android lint. It publishes
`YouTubeTV-android-debug.apk`, the test APK, lint reports, source commit, and
SHA-256 checksum on the build page. Emulator tests remain a separate local step.
It has no automatic triggers or store publishing. Starting with 0.3.0, cloud builds
use a persistent sideload signing key from the app-scoped **yttv_signing** encrypted
variable group (`YTTV_KEYSTORE_BASE64`, `YTTV_KEYSTORE_PASSWORD`). The workflow fails
if these secrets are missing rather than silently creating another identity.
Private key material is never committed or included in published artifacts.

**Updating an existing installation:** 0.3.0 uses Android version code **3**. Older
cloud builds used temporary signing keys; Android cannot update those installations
with this key. A one-time uninstall/reinstall is required when coming from an older
cloud APK, which removes that installation's app data/sign-in. Subsequent cloud
builds using this persistent key and increasing version codes can update in place.
Local builds still use the local debug key unless `YTTV_KEYSTORE_PATH` and
`YTTV_KEYSTORE_PASSWORD` are explicitly provided. Back up the sideload key securely.

## Controls

On a touchscreen, the YouTube page acts as a remote touchpad:

- **Swipe up/down/left/right:** move focus one step in that direction (48dp minimum).
- **Tap:** select the focused item. Selection waits briefly to distinguish a double tap.
- **Double-tap:** back, without also selecting the item.
- **Touch and hold:** open the native settings menu.

Swipes move focus in the direction of your finger, rather than scrolling the
page. Short drags, canceled gestures, and multi-finger gestures do not navigate.
Touch does not generate a second browser click. Google sign-in/consent pages
and native settings dialogs keep normal touchscreen behavior. Remotes,
keyboards, mouse input, and game controllers continue to work alongside touch.

Use the remote's D-pad and center button to browse. Back goes back inside
YouTube. **Hold Back for 700 ms**, or press Menu/F1, to open the native settings
menu: toggle blocking, zoom, background play, or touch lock; reload, go home, inspect counters, or exit.

Game controllers map A/Start/L3 to select, B/View/R3 to back, X to play/pause,
Y to search, LB/RB to PageUp/PageDown, and digital LT/RT to captions/fill.
The left stick and hat axes navigate with 350 ms initial delay and 110 ms repeat.
Controllers that report triggers only as analog axes do not yet provide the
caption/fill shortcuts. Keyboard captions/frame-step shortcuts are retained from the shared
player script; Android zoom is controlled by the native menu or right trigger. Android handles controller input natively; the desktop gamepad
poller is not injected, avoiding duplicate key delivery.

## Zoom, background play, and touch lock

Hold the screen (or hold Back / press Menu) to open settings.

- **Zoom:** choose **fill screen (crop)** to cover the unfolded display, including
  near-square screens such as the Z Fold inner display. Fill preserves proportions
  and crops the edges; **fit entire video** keeps the whole picture with black bars.
  The setting applies immediately without reloading and persists across launches.
  The gamepad right trigger toggles the same setting.
- **Background play:** enabled by default. Start a video, then press Home or turn
  off the screen to continue audio. An Android media foreground service displays a
  playback notification with **Pause** and a shortcut back to the app. Pausing,
  exiting, or removing the app from Recents stops the service. Turning this setting
  off restores pause-on-leave behavior. The preference persists across launches.
  This keeps the existing WebView session alive; it does not restore playback after
  process death, force-stop, or device restart. Samsung battery restrictions and
  long screen-off sessions still need physical-device validation.
- **Lock touch controls:** blocks taps, double taps, and swipes while watching.
  **Hold the screen again, then choose Unlock touch controls** to unlock. Native
  settings, consent/sign-in touch, and remote/gamepad controls remain available.
  Touch lock resets when the activity is recreated to avoid leaving the app locked.

## Shared implementation and boundaries

- `blocker/` is a JNI adapter around `native/core`, with one process-owned,
  mutex-protected Rust engine. It uses the same bundled EasyList/uAssets resources
  and local late-ad rules. No fork of the filter engine or lists is maintained.
- The app registers AndroidX WebKit document-start injection **before** loading
  YouTube. The shared navigator spoof, ad scriptlets, player shortcuts, and CSS
  run only on the explicit HTTPS YouTube origins, in the top frame.
- Request interception uses the same engine, including exceptions and resource
  redirects. Main documents and non-YouTube source origins are allowed.
  Android exposes no reliable resource type: the adapter uses Fetch Metadata
  when present, then URL inference. Referrer-less requests fall back to the top
  document. Redirect follow-ups, `blob:` URLs, service-worker traffic, and response
  bodies are not intercepted by this adapter. Fetch/XHR scriptlets handle late
  JSON ad metadata separately.
- Blocking settings persist natively and replace the document-start script on
  reload. Diagnostics report blocked requests and interception errors without
  logging request URLs, cookies, or credentials. Filter updates currently require
  an app rebuild; the desktop Shield panel and updater are not included.
- No `addJavascriptInterface` bridge is exposed. Top-level navigation is limited
  to YouTube and Google's sign-in/consent origins. File/content access, cleartext,
  mixed content, backups, and third-party cookies are disabled. Debug builds allow
  WebView debugging; release builds do not enable it.
- A WebView with `DOCUMENT_START_SCRIPT` support is required. The app displays an
  update instruction when unavailable instead of silently injecting too late.
- Android background play uses a `mediaPlayback` foreground service, a media-session
  notification, and YouTube-scoped visibility handling. The WebView retains audio
  focus management. See Android's [media service requirements](https://developer.android.com/develop/background-work/services/fgs/service-types#media).
  Voice search, casting, picture-in-picture, and native Android TV recommendations
  are not implemented.

WebView codec support, YouTube's console-client support, sign-in restrictions,
and available video resolutions depend on the device and service. Emulator
success does not establish Chromecast 4K/HDR support. Server-stitched ads are not
guaranteed to be removed.

## Emulator tests

On Apple silicon, use the ARM Android TV image:

```sh
sdkmanager 'emulator' 'system-images;android-34;android-tv;arm64-v8a'
avdmanager create avd -n yttv-port-tv34 -k 'system-images;android-34;android-tv;arm64-v8a' -d tv_1080p
emulator -avd yttv-port-tv34 -no-audio -gpu swiftshader_indirect
./android/gradlew -p android -PandroidAbis=arm64-v8a connectedDebugAndroidTest
npm test
```

`PortTest` runs JNI decisions and controlled HTML/JSON fixtures inside the real
WebView. It checks document-start spoofing, fetch and XHR ad-field pruning,
preservation of video metadata/media, native network blocking, blocking toggle,
navigation boundaries, and remote/controller key delivery. These fixtures do not
depend on real ads being served. `PlaybackSettingsTest` uses generated video/audio
in the test APK to verify zoom, Home/screen-off playback, notification pause,
disabling background play, and service cleanup. Live playback is checked separately.

The opt-in `LivePlaybackTest` opens a public Big Buck Bunny video, checks that the
video clock advances, and tests remote pause/resume. It saves screenshots and a
JSON report in the app's external files directory. Run it with:

```sh
./android/gradlew -p android -PandroidAbis=arm64-v8a assembleDebug assembleDebugAndroidTest
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w -e livePlayback true \
  io.github.ltanedo.youtubetv.test/androidx.test.runner.AndroidJUnitRunner
adb pull /sdcard/Android/data/io.github.ltanedo.youtubetv/files/ android/test-results/
```

Use `-e videoId XXXXXXXXXXX` to select another public video. You can also use
`connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.livePlayback=true`,
but Gradle uninstalls the app afterward, deleting its screenshots. Network/service
availability can fail this opt-in test; the default fixture tests run without
that dependency.

Keep `native/THIRD-PARTY-NOTICES.md` and `native/licenses/` with distributions;
Gradle includes them in the APK assets. Shared Rust code and bundled resources
retain their existing licenses.
