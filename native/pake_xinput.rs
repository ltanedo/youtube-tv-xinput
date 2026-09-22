// Xbox / XInput controller support for the YouTube TV window.
//
// The leanback UI (youtube.com/tv) is fully keyboard-driven, so a controller is
// bridged by polling XInput on a background thread and synthesizing keyboard
// input for the app window. Keys are only injected while this app owns the
// foreground window so a paired controller never types into another program.
//
// Set YTTV_XINPUT_DEBUG=1 to append a trace to %APPDATA%\YouTubeTV\xinput.log.
use std::{io::Write, thread, time::{Duration, Instant}};
use tauri::WebviewWindow;
use windows::Win32::{
    System::Threading::GetCurrentProcessId,
    UI::{
        Input::KeyboardAndMouse::{
            MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
            KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VIRTUAL_KEY, VK_DOWN, VK_ESCAPE,
            VK_LEFT, VK_NEXT, VK_OEM_2, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SPACE, VK_UP,
        },
        Input::XboxController::{XInputGetState, XINPUT_STATE},
        WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GetWindowThreadProcessId, GA_ROOT},
    },
};

const POLL_INTERVAL: Duration = Duration::from_millis(16);
const AXIS_THRESHOLD: f32 = 0.5;
const PRESS_COOLDOWN: Duration = Duration::from_millis(80);
const REPEAT_DELAY: Duration = Duration::from_millis(350);
const REPEAT_RATE: Duration = Duration::from_millis(110);
const MAX_CONTROLLERS: u32 = 4;

// XINPUT_GAMEPAD_* button masks.
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

/// True while the foreground window is this app: the Tauri window itself, or
/// any window whose top-level ancestor is ours or belongs to this process
/// (WebView2 hosts its own child HWNDs inside the Tauri window).
fn app_is_foreground(hwnd: isize) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() { return false; }
        if fg.0 as isize == hwnd { return true; }
        let root = GetAncestor(fg, GA_ROOT);
        if root.0 as isize == hwnd { return true; }
        let mut pid = 0u32;
        GetWindowThreadProcessId(root, Some(&mut pid));
        pid == GetCurrentProcessId()
    }
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

struct Controller { buttons: [Digital; MAPPINGS.len()], axes: [[Digital; 2]; AXES.len()] }

impl Controller {
    fn new() -> Self { Self { buttons: [Digital::new(); MAPPINGS.len()], axes: [[Digital::new(); 2]; AXES.len()] } }

    fn poll(&mut self, state: &XINPUT_STATE, now: Instant, log: &mut Log) {
        let buttons = state.Gamepad.wButtons.0;
        for (map, digital) in MAPPINGS.iter().zip(self.buttons.iter_mut()) {
            if digital.update(buttons & map.flag != 0, map.repeat, now) { tap_key(map.vk, log); }
        }
        let sticks = [state.Gamepad.sThumbLX, state.Gamepad.sThumbLY];
        for ((keys, tracker), raw) in AXES.iter().zip(self.axes.iter_mut()).zip(sticks) {
            let value = raw as f32 / 32768.0;
            if tracker[0].update(value > AXIS_THRESHOLD, true, now) { tap_key(keys.0, log); }
            if tracker[1].update(value < -AXIS_THRESHOLD, true, now) { tap_key(keys.1, log); }
        }
    }

    fn release_all(&mut self) {
        for digital in self.buttons.iter_mut().chain(self.axes.iter_mut().flatten()) { digital.held = false; }
    }
}

/// Start polling all XInput slots and drive the given window with keyboard input.
pub fn start(window: &WebviewWindow) {
    let hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd.0 as isize,
        Err(error) => { eprintln!("[Pake] XInput disabled; window handle unavailable: {error}"); return; }
    };
    thread::Builder::new().name("xinput-poll".into()).spawn(move || {
        let mut log = Log::open();
        log.line(&format!("xinput bridge started hwnd=0x{hwnd:X} pid={}", unsafe { GetCurrentProcessId() }));
        let mut controllers: Vec<Controller> = (0..MAX_CONTROLLERS).map(|_| Controller::new()).collect();
        let mut was_connected = [false; MAX_CONTROLLERS as usize];
        let mut was_focused = false;
        loop {
            let now = Instant::now();
            let focused = app_is_foreground(hwnd);
            if focused != was_focused {
                log.line(&format!("foreground={focused} fg=0x{:X}", unsafe { GetForegroundWindow() }.0 as isize));
                was_focused = focused;
            }
            for (index, controller) in controllers.iter_mut().enumerate() {
                let mut state = XINPUT_STATE::default();
                let connected = unsafe { XInputGetState(index as u32, &mut state) } == 0;
                if connected != was_connected[index] {
                    log.line(&format!("controller {index} connected={connected}"));
                    was_connected[index] = connected;
                }
                if !connected || !focused {
                    // Disconnected or unfocused: forget held state so nothing fires on return.
                    controller.release_all();
                    continue;
                }
                controller.poll(&state, now, &mut log);
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
}
