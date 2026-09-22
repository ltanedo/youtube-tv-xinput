// Reproducible, version/anchor-checked edits to the project-local Pake runtime.
// Adds: native ad blocker (WebView2 request interception + scriptlets), XInput
// controller bridge, TV navigator spoof, background playback, and the black-background startup patch.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
process.chdir(root);
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
// Apply from an LF-normalized copy so a CRLF checkout (core.autocrlf) cannot break the hunks.
const patchFile = path.join(require('node:os').tmpdir(), 'pake-native-black-background.patch');
fs.writeFileSync(patchFile, fs.readFileSync('pake-native-black-background.patch', 'utf8').replace(/\r\n/g, '\n'));
const patchArgs = ['apply', '--directory=node_modules/pake-cli', '--whitespace=nowarn'];
try { execFileSync('git', [...patchArgs, '--reverse', '--check', patchFile], {stdio:'pipe'}); }
catch { execFileSync('git', [...patchArgs, '--check', patchFile]); execFileSync('git', [...patchArgs, patchFile]); }

// --- Modules ---
replace('src/lib.rs', 'mod util;', 'mod util;\n#[cfg(target_os = "windows")]\nmod pake_adblock;\n#[cfg(target_os = "windows")]\nmod pake_xinput;');
replace('src/lib.rs', '            webview_navigate,', '            webview_navigate,\n            pake_adblock::blocker_status,\n            pake_adblock::blocker_set_enabled,\n            pake_adblock::blocker_update,');
replace('src/lib.rs', '            let window = set_window(app.app_handle(), &pake_config, &tauri_config)?;', '            #[cfg(target_os = "windows")]\n            pake_adblock::initialize(app.app_handle())?;\n            let window = set_window(app.app_handle(), &pake_config, &tauri_config)?;\n            #[cfg(target_os = "windows")]\n            pake_xinput::start(&window);');

// --- Ad blocker: start on about:blank, register interception, then navigate ---
replace('src/app/window.rs', '    let user_agent = config.user_agent.get();', `    #[cfg(target_os = "windows")]
    let blocker_target = if label == "pake" && pake_blocker_core::is_youtube(&window_config.url) {
        Some(window_config.url.clone())
    } else { None };
    #[cfg(target_os = "windows")]
    let url = if blocker_target.is_some() {
        WebviewUrl::CustomProtocol(Url::parse("about:blank").unwrap())
    } else { url };

    let user_agent = config.user_agent.get();`);
replace('src/app/window.rs', '    let window = window_builder.build()?;', `    let window = window_builder.build()?;
    #[cfg(target_os = "windows")]
    if let Some(target) = blocker_target { crate::pake_adblock::install(&window, target)?; }`);

// --- TV user agent: hide Chromium client hints and spoof navigator before page scripts ---
// Also disable Chromium backgrounding so covered/minimized windows keep rendering and playing media.
replace('src/app/window.rs',
  '"--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-blink-features=AutomationControlled"',
  '"--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,UserAgentClientHint --disable-blink-features=AutomationControlled --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-background-media-suspend"');
replace('src/app/window.rs', '        .initialization_script(include_str!("../inject/auth.js"))',
  '        .initialization_script(include_str!("../inject/auth.js"))\n        .initialization_script(include_str!("../../pake-tv/navigator.js"))');

// --- Background playback: keep the page "visible" so the player never pauses on alt-tab/minimize ---
replace('src/app/window.rs', '        .initialization_script(include_str!("../../pake-tv/navigator.js"))',
  '        .initialization_script(include_str!("../../pake-tv/navigator.js"))\n        .initialization_script(include_str!("../../pake-tv/background-play.js"))');

// --- Cargo dependencies ---
replace('Cargo.toml', 'webview2-com = "0.38"', `webview2-com = "0.38"
pake-blocker-core = { path = "pake-adblock/core" }
windows = { version = "=0.61.3", features = [
  "Win32_System_Com",
  "Win32_UI_Shell",
  "Win32_UI_Input_KeyboardAndMouse",
  "Win32_UI_Input_XboxController",
  "Win32_UI_WindowsAndMessaging",
] }`);

// --- Copy checked-in sources into the runtime ---
fs.copyFileSync('native/pake_adblock.rs', path.join(runtime, 'src/pake_adblock.rs'));
fs.copyFileSync('native/pake_xinput.rs', path.join(runtime, 'src/pake_xinput.rs'));
fs.mkdirSync(path.join(runtime, 'pake-adblock'), {recursive:true});
fs.mkdirSync(path.join(runtime, 'pake-tv'), {recursive:true});
fs.copyFileSync('native/ui.js', path.join(runtime, 'pake-adblock/ui.js'));
fs.copyFileSync('native/tv-navigator.js', path.join(runtime, 'pake-tv/navigator.js'));
fs.copyFileSync('native/tv-background-play.js', path.join(runtime, 'pake-tv/background-play.js'));
fs.cpSync('native/core', path.join(runtime, 'pake-adblock/core'), {recursive:true, filter: p => !p.split(path.sep).includes('target')});
if (fs.existsSync('native/runtime-Cargo.lock')) fs.copyFileSync('native/runtime-Cargo.lock', path.join(runtime, 'Cargo.lock'));
if (fs.existsSync('native/runtime-package-lock.json')) fs.copyFileSync('native/runtime-package-lock.json', path.join(pake, 'package-lock.json'));
console.log('Prepared local Pake with native ad blocker, XInput bridge, TV navigator spoof, and background playback.');
