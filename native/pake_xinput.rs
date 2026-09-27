// Xbox / XInput controller support for the YouTube TV window.
//
// The leanback UI (youtube.com/tv) is fully keyboard-driven, so a controller is
// bridged by polling it on a background thread and synthesizing keyboard input
// for the app window. Keys are only injected while this app owns the
// foreground window so a paired controller never types into another program.
//
// Two input sources are merged into one logical pad:
// - The page's Gamepad API (native/tv-gamepad.js -> `page_gamepad`). Once the
//   GameInput v2+ runtime is installed (games ship it), Windows gives live
//   controller data only to the process it considers focused, and for this app
//   that is the WebView2 process owning the page: native XInput/GameInput reads
//   in the app process return neutral state, while the page keeps working.
// - XInput, which works whenever the app process itself holds focus, and on
//   systems without that runtime.
//
// A controller-only user cannot click the page, so the bridge also takes care
// of focus: it moves keyboard focus into the WebView2 whenever the app gains
// the foreground, and a button press while the app is not foreground activates
// the window during the startup grace period or when the Windows shell
// (desktop, taskbar, Start) is in front. It never steals from another app.
//
// Set YTTV_XINPUT_DEBUG=1 to append a trace to %APPDATA%\YouTubeTV\xinput.log.
use std::{io::Write, sync::Mutex, thread, time::{Duration, Instant}};
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
use windows::Win32::{
    Foundation::HWND,
    System::Threading::GetCurrentProcessId,
    UI::{
        Input::KeyboardAndMouse::{
            MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
            KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VIRTUAL_KEY, VK_DOWN, VK_ESCAPE,
            VK_LEFT, VK_NEXT, VK_OEM_2, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SPACE, VK_UP,
        },
        Input::XboxController::{XInputGetState, XINPUT_STATE},
        WindowsAndMessaging::{GetAncestor, GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId, GA_ROOT},
    },
};

const POLL_INTERVAL: Duration = Duration::from_millis(16);
// XInput docs: probing an empty slot enumerates devices and is slow; do it rarely.
const EMPTY_SLOT_PROBE: Duration = Duration::from_secs(1);
const AXIS_THRESHOLD: f32 = 0.5;
const PRESS_COOLDOWN: Duration = Duration::from_millis(80);
const REPEAT_DELAY: Duration = Duration::from_millis(350);
const REPEAT_RATE: Duration = Duration::from_millis(110);
// After launch, any controller press may activate the window even if another
// app is in front (e.g. the launcher that started us).
const STARTUP_WAKE_GRACE: Duration = Duration::from_secs(45);
const WAKE_RETRY: Duration = Duration::from_millis(750);
const MAX_CONTROLLERS: u32 = 4;
// Page-reported pad state. The page sends a heartbeat every 100 ms while input
// is held; older state is ignored so a reload or a closed page can never leave
// a key held down.
const PAGE_PAD_FRESH: Duration = Duration::from_millis(300);
static PAGE_PAD: Mutex<Option<(PadState, Instant)>> = Mutex::new(None);

// XINPUT_GAMEPAD_* button masks; also the layout of the merged pad state.
const D_UP: u16 = 0x0001;
const D_DOWN: u16 = 0x0002;
const D_LEFT: u16 = 0x0004;
const D_RIGHT: u16 = 0x0008;
const START: u16 = 0x0010;
const BACK: u16 = 0x0020;
const L_THUMB: u16 = 0x0040;
const R_THUMB: u16 = 0x0080;
const L_SHOULDER: u16 = 0x0100;
const R_SHOULDER: u16 = 0x0200;
const BTN_A: u16 = 0x1000;
const BTN_B: u16 = 0x2000;
const BTN_X: u16 = 0x4000;
const BTN_Y: u16 = 0x8000;

#[derive(Clone, Copy)]
struct KeyMapping { flag: u16, vk: VIRTUAL_KEY, repeat: bool }

const MAPPINGS: [KeyMapping; 14] = [
    KeyMapping { flag: D_UP, vk: VK_UP, repeat: true },
    KeyMapping { flag: D_DOWN, vk: VK_DOWN, repeat: true },
    KeyMapping { flag: D_LEFT, vk: VK_LEFT, repeat: true },
    KeyMapping { flag: D_RIGHT, vk: VK_RIGHT, repeat: true },
    KeyMapping { flag: BTN_A, vk: VK_RETURN, repeat: false },     // select
    KeyMapping { flag: BTN_B, vk: VK_ESCAPE, repeat: false },     // back
    KeyMapping { flag: BTN_X, vk: VK_SPACE, repeat: false },      // play / pause
    KeyMapping { flag: BTN_Y, vk: VK_OEM_2, repeat: false },      // slash: search
    KeyMapping { flag: START, vk: VK_RETURN, repeat: false },
    KeyMapping { flag: BACK, vk: VK_ESCAPE, repeat: false },
    KeyMapping { flag: L_SHOULDER, vk: VK_PRIOR, repeat: false }, // PageUp
    KeyMapping { flag: R_SHOULDER, vk: VK_NEXT, repeat: false },  // PageDown
    KeyMapping { flag: L_THUMB, vk: VK_RETURN, repeat: false },
    KeyMapping { flag: R_THUMB, vk: VK_ESCAPE, repeat: false },
];

// Left stick directions reuse the D-pad repeat logic: (positive key, negative key).
const AXES: [(VIRTUAL_KEY, VIRTUAL_KEY); 2] = [(VK_RIGHT, VK_LEFT), (VK_UP, VK_DOWN)];

// Top-level window classes owned by the Windows shell: desktop, taskbar, Start
// menu / search flyouts. A controller press with one of these in front should
// bring the app forward; nothing else is "using" the controller.
const SHELL_CLASSES: [&str; 6] = [
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "Windows.UI.Core.CoreWindow",
    "XamlExplorerHostIslandWindow",
];

/// Standard-mapping Gamepad API buttons (bit n = buttons[n].pressed) -> XInput masks.
/// Triggers (6, 7) and the guide button (16) are not mapped.
fn standard_buttons(bits: u32) -> u16 {
    const MAP: [(u32, u16); 14] = [
        (0, BTN_A), (1, BTN_B), (2, BTN_X), (3, BTN_Y), (4, L_SHOULDER), (5, R_SHOULDER),
        (8, BACK), (9, START), (10, L_THUMB), (11, R_THUMB),
        (12, D_UP), (13, D_DOWN), (14, D_LEFT), (15, D_RIGHT),
    ];
    MAP.iter().filter(|(bit, _)| bits & (1 << bit) != 0).fold(0, |mask, (_, xi)| mask | xi)
}

/// Controller state read by the page's Gamepad API (native/tv-gamepad.js).
/// Keys are still sent natively, and only while this app is in the foreground.
#[tauri::command]
pub fn page_gamepad(window: WebviewWindow, buttons: u32, x: f32, y: f32) {
    if window.label() != "pake" { return; }
    let pad = PadState {
        buttons: standard_buttons(buttons),
        x: if x.is_finite() { x.clamp(-1.0, 1.0) } else { 0.0 },
        y: if y.is_finite() { y.clamp(-1.0, 1.0) } else { 0.0 },
    };
    if let Ok(mut slot) = PAGE_PAD.lock() { *slot = Some((pad, Instant::now())); }
}

/// Fresh page-reported state, if any.
fn page_pad(now: Instant) -> Option<PadState> {
    let slot = PAGE_PAD.lock().ok()?;
    let (pad, at) = (*slot)?;
    (now.saturating_duration_since(at) < PAGE_PAD_FRESH).then_some(pad)
}

/// One logical pad: buttons ORed across sources, sticks from whichever source
/// deflects furthest, so a pad visible to both sources never fires twice.
#[derive(Default, Clone, Copy, Debug)]
struct PadState { buttons: u16, x: f32, y: f32 }

impl PadState {
    fn merge(&mut self, buttons: u16, x: f32, y: f32) {
        self.buttons |= buttons;
        if x.abs() > self.x.abs() { self.x = x; }
        if y.abs() > self.y.abs() { self.y = y; }
    }
    fn merge_xinput(&mut self, state: &XINPUT_STATE) {
        let pad = &state.Gamepad;
        self.merge(pad.wButtons.0, pad.sThumbLX as f32 / 32768.0, pad.sThumbLY as f32 / 32768.0);
    }
    /// Any button or stick deflection: used only to decide whether to wake the window.
    fn active(&self) -> bool {
        self.buttons != 0 || self.x.abs() > AXIS_THRESHOLD || self.y.abs() > AXIS_THRESHOLD
    }
}

/// Keys on the extended keypad block must carry KEYEVENTF_EXTENDEDKEY so the
/// scan code maps to the navigation key rather than the numeric keypad.
fn is_extended(vk: VIRTUAL_KEY) -> bool {
    matches!(vk, VK_UP | VK_DOWN | VK_LEFT | VK_RIGHT | VK_PRIOR | VK_NEXT)
}

fn key_input(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    let mut flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
    if is_extended(vk) { flags |= KEYEVENTF_EXTENDEDKEY; }
    // A real scan code lets Chromium derive KeyboardEvent.code like a physical key.
    let scan = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) } as u16;
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn tap_key(vk: VIRTUAL_KEY, log: &mut Log) {
    let inputs = [key_input(vk, false), key_input(vk, true)];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    log.line(&format!("tap vk=0x{:02X} sent={sent}", vk.0));
}

fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, &mut buffer) } as usize;
    String::from_utf16_lossy(&buffer[..len.min(buffer.len())])
}

/// Who owns the foreground right now, as seen from this app.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Foreground { Ours, Shell, Other }

fn foreground(hwnd: isize) -> Foreground {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() { return Foreground::Shell; }
        if fg.0 as isize == hwnd { return Foreground::Ours; }
        // WebView2 hosts its own child HWNDs inside the Tauri window.
        let root = GetAncestor(fg, GA_ROOT);
        if root.0 as isize == hwnd { return Foreground::Ours; }
        let mut pid = 0u32;
        GetWindowThreadProcessId(root, Some(&mut pid));
        if pid == GetCurrentProcessId() { return Foreground::Ours; }
        let class = class_name(root);
        if SHELL_CLASSES.contains(&class.as_str()) { Foreground::Shell } else { Foreground::Other }
    }
}

/// Bring the window to the front and put keyboard focus inside the WebView2.
/// Safe to call from any thread; Tauri marshals both calls to the main thread.
pub fn activate(window: &WebviewWindow) {
    if window.is_minimized().unwrap_or(false) { let _ = window.unminimize(); }
    let _ = window.set_focus();
    focus_webview(window);
}

/// Keyboard focus can sit on the empty Tauri window (for example after the
/// startup repaint toggles the WebView2's visibility); move it to the page.
pub fn focus_webview(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        let _ = webview.controller().MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    });
}

/// Optional trace to %APPDATA%\YouTubeTV\xinput.log (YTTV_XINPUT_DEBUG=1).
struct Log(Option<std::fs::File>);

impl Log {
    fn open() -> Self {
        let enabled = matches!(std::env::var("YTTV_XINPUT_DEBUG").as_deref(), Ok("1") | Ok("true"));
        let file = enabled.then(|| std::env::var_os("APPDATA")).flatten().and_then(|appdata| {
            let dir = std::path::PathBuf::from(appdata).join("YouTubeTV");
            std::fs::create_dir_all(&dir).ok()?;
            std::fs::OpenOptions::new().create(true).append(true).open(dir.join("xinput.log")).ok()
        });
        Self(file)
    }
    fn line(&mut self, message: &str) {
        if let Some(file) = self.0.as_mut() {
            let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let _ = writeln!(file, "{ms} {message}");
        }
    }
}

/// Edge/repeat tracker for one digital input (button or stick direction).
#[derive(Clone, Copy)]
struct Digital { held: bool, pressed_at: Instant, repeated_at: Instant }

impl Digital {
    fn new() -> Self { let now = Instant::now(); Self { held: false, pressed_at: now, repeated_at: now } }

    fn update(&mut self, active: bool, repeat: bool, now: Instant) -> bool {
        if !active { self.held = false; return false; }
        if !self.held {
            // Debounce chattering contacts without swallowing deliberate double taps.
            if now.duration_since(self.pressed_at) < PRESS_COOLDOWN { return false; }
            self.held = true; self.pressed_at = now; self.repeated_at = now;
            return true;
        }
        if repeat && now.duration_since(self.pressed_at) >= REPEAT_DELAY && now.duration_since(self.repeated_at) >= REPEAT_RATE {
            self.repeated_at = now;
            return true;
        }
        false
    }
}

/// Edge/repeat state for the merged pad; returns the keys to tap this frame.
struct Controller { buttons: [Digital; MAPPINGS.len()], axes: [[Digital; 2]; AXES.len()] }

impl Controller {
    fn new() -> Self { Self { buttons: [Digital::new(); MAPPINGS.len()], axes: [[Digital::new(); 2]; AXES.len()] } }

    fn poll(&mut self, pad: &PadState, now: Instant) -> Vec<VIRTUAL_KEY> {
        let mut keys = Vec::new();
        for (map, digital) in MAPPINGS.iter().zip(self.buttons.iter_mut()) {
            if digital.update(pad.buttons & map.flag != 0, map.repeat, now) { keys.push(map.vk); }
        }
        for ((pair, tracker), value) in AXES.iter().zip(self.axes.iter_mut()).zip([pad.x, pad.y]) {
            if tracker[0].update(value > AXIS_THRESHOLD, true, now) { keys.push(pair.0); }
            if tracker[1].update(value < -AXIS_THRESHOLD, true, now) { keys.push(pair.1); }
        }
        keys
    }

    fn release_all(&mut self) {
        for digital in self.buttons.iter_mut().chain(self.axes.iter_mut().flatten()) { digital.held = false; }
    }
}

struct XInputSlot { connected: bool, next_probe: Instant }

/// Start polling the controller sources and drive the given window with keyboard input.
pub fn start(window: &WebviewWindow) {
    let hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd.0 as isize,
        Err(error) => { eprintln!("[Pake] XInput disabled; window handle unavailable: {error}"); return; }
    };
    let window = window.clone();
    thread::Builder::new().name("xinput-poll".into()).spawn(move || {
        let mut log = Log::open();
        let started = Instant::now();
        log.line(&format!("xinput bridge started hwnd=0x{hwnd:X} pid={}", unsafe { GetCurrentProcessId() }));
        let mut slots: Vec<XInputSlot> = (0..MAX_CONTROLLERS).map(|_| XInputSlot { connected: false, next_probe: started }).collect();
        let mut controller = Controller::new();
        let mut page_live = false;
        let mut was_foreground = Foreground::Other;
        let mut last_wake = started - WAKE_RETRY;
        loop {
            let now = Instant::now();
            let fg = foreground(hwnd);
            if fg != was_foreground {
                log.line(&format!("foreground={fg:?} fg=0x{:X}", unsafe { GetForegroundWindow() }.0 as isize));
                // Gained the foreground (launch, alt-tab back, wake): make sure the
                // page, not the bare Tauri window, receives our key taps.
                if fg == Foreground::Ours { focus_webview(&window); }
                was_foreground = fg;
            }

            let mut pad = PadState::default();
            for (index, slot) in slots.iter_mut().enumerate() {
                if !slot.connected && now < slot.next_probe { continue; }
                let mut state = XINPUT_STATE::default();
                let connected = unsafe { XInputGetState(index as u32, &mut state) } == 0;
                if connected != slot.connected {
                    log.line(&format!("xinput slot {index} connected={connected}"));
                    slot.connected = connected;
                }
                if connected { pad.merge_xinput(&state); } else { slot.next_probe = now + EMPTY_SLOT_PROBE; }
            }
            let page = page_pad(now);
            if page.is_some() != page_live {
                page_live = page.is_some();
                log.line(&format!("page gamepad live={page_live}"));
            }
            if let Some(state) = page { pad.merge(state.buttons, state.x, state.y); }

            if fg == Foreground::Ours {
                for vk in controller.poll(&pad, now) { tap_key(vk, &mut log); }
            } else {
                // Unfocused: forget held state so nothing fires on return, and let a
                // press bring the app forward when nothing else is using the pad.
                controller.release_all();
                let may_wake = fg == Foreground::Shell || now.duration_since(started) < STARTUP_WAKE_GRACE;
                if may_wake && pad.active() && now.duration_since(last_wake) >= WAKE_RETRY {
                    log.line(&format!("wake: activating window (foreground={fg:?})"));
                    activate(&window);
                    last_wake = now;
                }
            }
            thread::sleep(POLL_INTERVAL);
        }
    }).expect("spawn XInput polling thread");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn press_release_press_fires_twice() {
        let mut d = Digital::new();
        let t0 = Instant::now() + PRESS_COOLDOWN;
        assert!(d.update(true, false, t0));
        assert!(!d.update(true, false, t0 + Duration::from_millis(10)));
        assert!(!d.update(false, false, t0 + Duration::from_millis(20)));
        assert!(d.update(true, false, t0 + PRESS_COOLDOWN + Duration::from_millis(30)));
    }

    #[test]
    fn repeat_only_after_delay_and_at_rate() {
        let mut d = Digital::new();
        let t0 = Instant::now() + PRESS_COOLDOWN;
        assert!(d.update(true, true, t0));
        assert!(!d.update(true, true, t0 + REPEAT_DELAY - Duration::from_millis(1)));
        assert!(d.update(true, true, t0 + REPEAT_DELAY));
        assert!(!d.update(true, true, t0 + REPEAT_DELAY + Duration::from_millis(1)));
        assert!(d.update(true, true, t0 + REPEAT_DELAY + REPEAT_RATE));
    }

    #[test]
    fn non_repeating_button_fires_once_while_held() {
        let mut d = Digital::new();
        let t0 = Instant::now() + PRESS_COOLDOWN;
        assert!(d.update(true, false, t0));
        assert!(!d.update(true, false, t0 + Duration::from_secs(5)));
    }

    #[test]
    fn navigation_keys_are_extended_and_have_scan_codes() {
        assert!(is_extended(VK_UP) && is_extended(VK_NEXT));
        assert!(!is_extended(VK_RETURN) && !is_extended(VK_SPACE));
        let ki = unsafe { key_input(VK_UP, false).Anonymous.ki };
        assert_ne!(ki.wScan, 0);
        assert_eq!(ki.dwFlags, KEYEVENTF_EXTENDEDKEY);
        let up = unsafe { key_input(VK_RETURN, true).Anonymous.ki };
        assert_eq!(up.dwFlags, KEYEVENTF_KEYUP);
    }

    #[test]
    fn standard_gamepad_buttons_map_to_xinput_masks() {
        assert_eq!(standard_buttons(1 << 0), BTN_A);
        assert_eq!(standard_buttons((1 << 1) | (1 << 12)), BTN_B | D_UP);
        assert_eq!(standard_buttons((1 << 8) | (1 << 9)), BACK | START);
        assert_eq!(standard_buttons((1 << 14) | (1 << 15)), D_LEFT | D_RIGHT);
        assert_eq!(standard_buttons((1 << 6) | (1 << 7) | (1 << 16)), 0); // triggers + guide
    }

    #[test]
    fn page_state_expires() {
        let now = Instant::now();
        *PAGE_PAD.lock().unwrap() = Some((PadState { buttons: BTN_A, x: 0.0, y: 0.0 }, now));
        assert_eq!(page_pad(now).map(|p| p.buttons), Some(BTN_A));
        assert!(page_pad(now + PAGE_PAD_FRESH).is_none());
        *PAGE_PAD.lock().unwrap() = None;
    }

    #[test]
    fn merged_sources_fire_once_and_keep_strongest_stick() {
        let mut pad = PadState::default();
        pad.merge(BTN_A, 0.1, -0.2);
        pad.merge(BTN_A | D_DOWN, -0.8, 0.1);
        assert_eq!(pad.buttons, BTN_A | D_DOWN);
        assert_eq!((pad.x, pad.y), (-0.8, -0.2));
        assert!(pad.active());

        // The same A press seen by both sources produces a single Enter.
        let mut controller = Controller::new();
        let t0 = Instant::now() + PRESS_COOLDOWN;
        let keys = controller.poll(&PadState { buttons: BTN_A, x: 0.0, y: 0.0 }, t0);
        assert_eq!(keys.iter().filter(|vk| **vk == VK_RETURN).count(), 1);
        assert!(controller.poll(&PadState { buttons: BTN_A, x: 0.0, y: 0.0 }, t0 + Duration::from_millis(16)).is_empty());
        assert!(!PadState::default().active());
    }

    #[test]
    fn shell_classes_cover_desktop_taskbar_and_start() {
        for class in ["Progman", "Shell_TrayWnd", "XamlExplorerHostIslandWindow"] {
            assert!(SHELL_CLASSES.contains(&class));
        }
        assert!(!SHELL_CLASSES.contains(&"Chrome_WidgetWin_1"));
    }
}
