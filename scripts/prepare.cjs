// Reproducible, version/anchor-checked edits to the project-local Pake runtime.
// Adds: native ad blocker (WebView2 request interception on Windows, WKContentRuleList
// on macOS, WebKitUserContentFilterStore on Linux, plus shared scriptlets), the
// controller bridge (XInput on Windows, in-page Gamepad API on macOS, gilrs/evdev
// on Linux), TV navigator spoof, background playback, player shortcuts
// (ultrawide fill, subtitles, frame step), windowed-menu / fullscreen-playback switching, and the
// black-background startup patch.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const mac = process.platform === 'darwin';
const win = process.platform === 'win32';
const linux = process.platform === 'linux';
if (!mac && !win && !linux) throw Error('YouTube TV supports Windows, macOS and Linux only.');
const pake = path.join(root, 'node_modules/pake-cli');
if (JSON.parse(fs.readFileSync(path.join(pake, 'package.json'))).version !== '3.15.7') throw Error('Expected Pake 3.15.7');
const runtime = path.join(pake, 'src-tauri');
function replace(file, old, updated) {
  const p = path.join(runtime, file);
  const s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  if (s.includes(updated)) return;
  if (s.split(old).length !== 2) throw Error(`Unexpected source anchor: ${file}: ${old}`);
  fs.writeFileSync(p, s.replace(old, updated));
}
// Insert `block` into Cargo.toml after `anchor`, between markers derived from the
// anchor, replacing any earlier copy so re-runs never duplicate dependencies.
function markerBlock(anchor, block) {
  const cargo = path.join(runtime, 'Cargo.toml');
  const tag = anchor.split(/\s|=/)[0];
  const begin = `# --- youtube-tv-xinput deps (${tag}) begin ---\n`, finish = `# --- youtube-tv-xinput deps (${tag}) end ---\n`;
  let s = fs.readFileSync(cargo, 'utf8').replace(/\r\n/g, '\n');
  // Also drop the untagged markers that releases before 2.2.0-beta.5 wrote around the Windows block.
  for (const [b0, e0] of [[begin, finish], ['# --- youtube-tv-xinput deps begin ---\n', '# --- youtube-tv-xinput deps end ---\n']]) {
    const b = s.indexOf(b0), e = s.indexOf(e0);
    if (b !== -1 && e !== -1) s = s.slice(0, b) + s.slice(e + e0.length);
  }
  if (s.split(anchor).length !== 2) throw Error('Unexpected source anchor: Cargo.toml: ' + anchor.trim());
  fs.writeFileSync(cargo, s.replace(anchor, anchor + begin + block + finish));
}
// Apply from an LF-normalized copy so a CRLF checkout (core.autocrlf) cannot break the hunks.
const patchFile = path.join(require('node:os').tmpdir(), 'pake-native-black-background.patch');
fs.writeFileSync(patchFile, fs.readFileSync('pake-native-black-background.patch', 'utf8').replace(/\r\n/g, '\n'));
const patchArgs = ['apply', '--directory=node_modules/pake-cli', '--whitespace=nowarn'];
try { execFileSync('git', [...patchArgs, '--reverse', '--check', patchFile], {stdio:'pipe'}); }
catch { execFileSync('git', [...patchArgs, '--check', patchFile]); execFileSync('git', [...patchArgs, patchFile]); }

// The ad blocker builds on every desktop platform (platform adapter chosen
// below). The XInput bridge is Windows-only; on Linux native/pake_gamepad_linux.rs
// reads pads with gilrs (WebKitGTK has no Gamepad API on Debian/Ubuntu); on
// macOS the controller is read by the page (native/tv-gamepad.js) and needs no
// native code.
const DESKTOP = 'any(target_os = "windows", target_os = "macos", target_os = "linux")';

// --- Modules ---
replace('src/lib.rs', 'mod util;', `mod util;\n#[cfg(${DESKTOP})]\nmod pake_adblock;\n#[cfg(target_os = "windows")]\nmod pake_xinput;\n#[cfg(target_os = "linux")]\nmod pake_gamepad;`);
replace('src/lib.rs', '            webview_navigate,', '            webview_navigate,\n            pake_adblock::blocker_status,\n            pake_adblock::blocker_set_enabled,\n            pake_adblock::blocker_update,');
replace('src/lib.rs', '            pake_adblock::blocker_update,',
  '            pake_adblock::blocker_update,\n' + (win ? '            pake_xinput::page_gamepad,' : '            pake_adblock::blocker_focus_webview,'));
replace('src/lib.rs', '            let window = set_window(app.app_handle(), &pake_config, &tauri_config)?;',
  `            #[cfg(${DESKTOP})]\n            pake_adblock::initialize(app.app_handle())?;\n            let window = set_window(app.app_handle(), &pake_config, &tauri_config)?;\n            #[cfg(target_os = "windows")]\n            pake_xinput::start(&window);\n            #[cfg(target_os = "linux")]\n            pake_gamepad::start(&window);`);

// --- Startup focus: Pake only show()s the window on Windows. A controller-only user cannot click,
// so after the reveal (and the startup repaint that toggles the WebView2's visibility) bring the
// window to the foreground and move keyboard focus into the page. ---
// Anchored on the tail of the reveal block, outside the black-background patch's hunk context,
// so `git apply --reverse --check` still recognizes that patch as applied.
replace('src/lib.rs', '        #[cfg(not(target_os = "linux"))]\n        let _ = init_fullscreen;\n    });\n}',
  '        #[cfg(target_os = "windows")]\n        crate::pake_xinput::activate(&window);\n\n        #[cfg(not(target_os = "linux"))]\n        let _ = init_fullscreen;\n    });\n}');

// --- Ad blocker: start on about:blank, register interception, then navigate ---
// WebView2 registers document-created scripts at runtime; WKWebView and WebKitGTK
// get the blocker's document-start script as an initialization script instead.
const WEBKIT = 'any(target_os = "macos", target_os = "linux")';
replace('src/app/window.rs', '    let user_agent = config.user_agent.get();', `    #[cfg(${DESKTOP})]
    let blocker_target = if label == "pake" && pake_blocker_core::is_youtube(&window_config.url) {
        Some(window_config.url.clone())
    } else { None };
    #[cfg(${DESKTOP})]
    let url = if blocker_target.is_some() {
        WebviewUrl::CustomProtocol(Url::parse("about:blank").unwrap())
    } else { url };

    #[cfg(${WEBKIT})]
    let blocker_script = blocker_target.as_ref().and_then(|_| crate::pake_adblock::document_script(app));

    let user_agent = config.user_agent.get();`);
replace('src/app/window.rs', '    window_builder = window_builder.initialization_script(&config_script);', `    window_builder = window_builder.initialization_script(&config_script);

    #[cfg(${WEBKIT})]
    if let Some(script) = blocker_script {
        window_builder = window_builder.initialization_script(&script);
    }`);
replace('src/app/window.rs', '    let window = window_builder.build()?;', `    let window = window_builder.build()?;
    #[cfg(${DESKTOP})]
    if let Some(target) = blocker_target { crate::pake_adblock::install(&window, target)?; }`);

// --- TV user agent (Windows): hide Chromium client hints so the header and navigator agree ---
// Also disable Chromium backgrounding so covered/minimized windows keep rendering and playing media.
// (WKWebView has no client hints and no such flags; the user agent alone is enough there.)
replace('src/app/window.rs',
  '"--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-blink-features=AutomationControlled"',
  '"--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,UserAgentClientHint --disable-blink-features=AutomationControlled --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-background-media-suspend"');

// --- TV scripts, run before any page script (in this order) ---
// __pakeHost         "windows" | "macos" | "linux": platform switch for the scripts below
// navigator.js       spoof navigator.* to match the console user agent (Linux variant)
// background-play.js keep the page "visible" so the player never pauses on alt-tab/minimize
// gamepad.js         read the pad through the page's Gamepad API; on Windows forward it to
//                    pake_xinput (the WebView2 process sees the pad when the app process does
//                    not), on macOS turn it into key events in the page, on Linux do the same
//                    with state sent by pake_gamepad (see native/tv-gamepad.js)
// player.js          ultrawide fill, subtitles and frame-step shortcuts (CSS in inject/yttv.css)
// fullscreen.js      windowed browse UI; native fullscreen only while a video plays on the watch page
replace('src/app/window.rs', '        .initialization_script(include_str!("../inject/auth.js"))',
  `        .initialization_script(include_str!("../inject/auth.js"))
        .initialization_script(if cfg!(target_os = "macos") { "window.__pakeHost = 'macos';" } else if cfg!(target_os = "linux") { "window.__pakeHost = 'linux';" } else { "window.__pakeHost = 'windows';" })
        .initialization_script(include_str!("../../pake-tv/navigator.js"))
        .initialization_script(include_str!("../../pake-tv/background-play.js"))
        .initialization_script(include_str!("../../pake-tv/gamepad.js"))
        .initialization_script(include_str!("../../pake-tv/player.js"))
        .initialization_script(include_str!("../../pake-tv/fullscreen.js"))`);

// --- Cargo dependencies ---
// Shared blocker core (both platforms): next to the other general dependencies.
replace('Cargo.toml', 'serde = { version = "1.0.228", features = ["derive"] }',
  'serde = { version = "1.0.228", features = ["derive"] }\npake-blocker-core = { path = "pake-adblock/core" }');
// macOS adapter: WebKit classes beyond the ones Pake already enables.
replace('Cargo.toml', '  "WKWebViewConfiguration",', '  "WKWebViewConfiguration",\n  "WKWebView",\n  "WKContentRuleList",\n  "WKContentRuleListStore",');
// Linux: gtk for widget focus (same version wry resolves, so the WebView is the
// same crate instance) and gilrs for the native controller reader (its default
// `wgi` feature is Windows-only but gilrs-core 0.6 refuses to build without it).
// Marker-delimited like the Windows block below, so re-runs replace it.
markerBlock('webkit2gtk = { version = "=2.0.2", features = ["v2_38"] }\n', `gtk = "0.18"
gilrs = "0.11"
`);

// --- Capabilities: the page listens for the Linux controller bridge's `pake:gamepad` event ---
replace('capabilities/default.json', '    "core:path:default"\n', '    "core:path:default",\n    "core:event:allow-listen",\n    "core:event:allow-unlisten"\n');

// --- Linux bundles: ship GStreamer (codecs) inside the AppImage so playback does not
// depend on the host's plugin ABI matching the bundled WebKitGTK ---
replace('tauri.linux.conf.json', '    "linux": {\n      "deb": {', '    "linux": {\n      "appimage": { "bundleMediaFramework": true },\n      "deb": {');
// Windows adapters: marker-delimited so feature changes replace, never duplicate, the block.
markerBlock('webview2-com = "0.38"\n', `windows = { version = "=0.61.3", features = [
  "Win32_System_Com",
  "Win32_UI_Shell",
  "Win32_UI_Input_KeyboardAndMouse",
  "Win32_UI_Input_XboxController",
  "Win32_UI_WindowsAndMessaging",
  "Win32_System_Threading",
] }
`);

// --- Pake CLI: Windows ARM64 installer lookup ---
// Tauri names the MSI `<name>_<version>_arm64_<lang>.msi`, but Pake 3.15.7 looks for
// `_aarch64_` (its macOS display name) and fails to copy the finished installer.
{
  const cli = path.join(pake, 'dist/cli.js');
  const old = '        const targetArch = this.getArchDisplayName(this.buildArch);\n';
  const updated = '        const targetArch = this.buildArch === \'arm64\' ? \'arm64\' : this.getArchDisplayName(this.buildArch); // youtube-tv-xinput: Tauri MSI naming\n';
  const s = fs.readFileSync(cli, 'utf8');
  if (!s.includes(updated)) {
    if (s.split(old).length !== 2) throw Error('Unexpected source anchor: dist/cli.js: ' + old.trim());
    fs.writeFileSync(cli, s.replace(old, updated));
  }
}

// --- Pake CLI: Arch package (zst) ---
// pacman rejects hyphens in pkgver, while Tauri insists on a semver version, so the
// Arch packager alone turns `2.2.0-beta.5` into `2.2.0beta5` (which still sorts
// before `2.2.0`). Its metadata also names this app instead of the Pake template.
{
  const cli = path.join(pake, 'dist/cli.js');
  const edits = [
    ["        const version = tauriConfig.version;\n        const arch = this.buildArch === 'arm64' ? 'aarch64' : 'x86_64';\n",
     "        const version = tauriConfig.version.replace(/-([a-z]+)\\.?(\\d*)/gi, '$1$2'); // youtube-tv-xinput: pacman forbids hyphens in pkgver\n        const arch = this.buildArch === 'arm64' ? 'aarch64' : 'x86_64';\n"],
    ['pkgdesc = ${name} Pake app\n', 'pkgdesc = YouTube TV (leanback) client with game controller support and ad blocking\n'],
    ['url = https://github.com/tw93/Pake\n', 'url = https://github.com/ltanedo/youtube-tv-xinput\n'],
  ];
  let s = fs.readFileSync(cli, 'utf8');
  for (const [old, updated] of edits) {
    if (s.includes(updated)) continue;
    if (s.split(old).length !== 2) throw Error('Unexpected source anchor: dist/cli.js: ' + old.trim());
    s = s.replace(old, updated);
  }
  fs.writeFileSync(cli, s);
}

// --- Copy checked-in sources into the runtime ---
fs.copyFileSync(mac ? 'native/pake_adblock_macos.rs' : linux ? 'native/pake_adblock_linux.rs' : 'native/pake_adblock.rs', path.join(runtime, 'src/pake_adblock.rs'));
if (win) fs.copyFileSync('native/pake_xinput.rs', path.join(runtime, 'src/pake_xinput.rs'));
if (linux) fs.copyFileSync('native/pake_gamepad_linux.rs', path.join(runtime, 'src/pake_gamepad.rs'));
fs.mkdirSync(path.join(runtime, 'pake-adblock'), {recursive:true});
fs.mkdirSync(path.join(runtime, 'pake-tv'), {recursive:true});
fs.copyFileSync('native/ui.js', path.join(runtime, 'pake-adblock/ui.js'));
fs.copyFileSync('native/tv-navigator.js', path.join(runtime, 'pake-tv/navigator.js'));
fs.copyFileSync('native/tv-background-play.js', path.join(runtime, 'pake-tv/background-play.js'));
fs.copyFileSync('native/tv-gamepad.js', path.join(runtime, 'pake-tv/gamepad.js'));
fs.copyFileSync('native/tv-player.js', path.join(runtime, 'pake-tv/player.js'));
fs.copyFileSync('native/tv-fullscreen.js', path.join(runtime, 'pake-tv/fullscreen.js'));
fs.cpSync('native/core', path.join(runtime, 'pake-adblock/core'), {recursive:true, filter: p => !p.split(path.sep).includes('target')});
if (fs.existsSync('native/runtime-Cargo.lock')) fs.copyFileSync('native/runtime-Cargo.lock', path.join(runtime, 'Cargo.lock'));
if (fs.existsSync('native/runtime-package-lock.json')) fs.copyFileSync('native/runtime-package-lock.json', path.join(pake, 'package-lock.json'));
console.log(`Prepared local Pake (${mac ? 'macOS' : linux ? 'Linux' : 'Windows'}) with native ad blocker, controller bridge, TV navigator spoof, background playback, and player shortcuts.`);
