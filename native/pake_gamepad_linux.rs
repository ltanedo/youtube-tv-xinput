// Game controller support for the YouTube TV window on Linux.
//
// Debian and Ubuntu build WebKitGTK without the Gamepad API (no libmanette), so
// unlike macOS the page cannot see controllers itself. This module reads them
// natively with gilrs (evdev/udev, SDL-style standard layout, hot-plug) on one
// background thread and forwards the merged state of all connected pads to the
// page as a `pake:gamepad` Tauri event, in the standard-mapping bit layout the
// page's own Gamepad API poll produces (bit n = buttons[n], left stick x/y with
// +y up). The page (native/tv-gamepad.js, host "linux") turns it into key
// events with the shared mapping, 80 ms debounce and 350 ms / 110 ms
// auto-repeat, so nothing is injected at the OS level and nothing can type
// into other apps.
//
// State is sent on every change and, while any input is held, re-sent every
// 100 ms as a heartbeat; the page drops state older than 300 ms so a stalled
// bridge never leaves a key held.
use gilrs::{Axis, Button, Gilrs};
use serde::Serialize;
use std::{
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, WebviewWindow};

pub const EVENT: &str = "pake:gamepad";
const POLL_INTERVAL: Duration = Duration::from_millis(16);
const HEARTBEAT: Duration = Duration::from_millis(100);
/// Analog triggers and hat axes count as pressed past this deflection.
const DIGITAL_THRESHOLD: f32 = 0.5;
/// Stick deflection that counts as "input held" for the heartbeat.
const ACTIVE_THRESHOLD: f32 = 0.3;

/// gilrs buttons -> standard-mapping bit (Gamepad API `buttons[n]`).
/// The guide button (Mode, 16) is deliberately not mapped.
const BUTTONS: [(Button, u32); 16] = [
    (Button::South, 0),         // A
    (Button::East, 1),          // B
    (Button::West, 2),          // X
    (Button::North, 3),         // Y
    (Button::LeftTrigger, 4),   // LB
    (Button::RightTrigger, 5),  // RB
    (Button::LeftTrigger2, 6),  // LT
    (Button::RightTrigger2, 7), // RT
    (Button::Select, 8),        // Back / View
    (Button::Start, 9),
    (Button::LeftThumb, 10),
    (Button::RightThumb, 11),
    (Button::DPadUp, 12),
    (Button::DPadDown, 13),
    (Button::DPadLeft, 14),
    (Button::DPadRight, 15),
];
const LT: u32 = 1 << 6;
const RT: u32 = 1 << 7;
const D_UP: u32 = 1 << 12;
const D_DOWN: u32 = 1 << 13;
const D_LEFT: u32 = 1 << 14;
const D_RIGHT: u32 = 1 << 15;

/// One logical pad, as sent to the page.
#[derive(Serialize, Clone, Copy, PartialEq, Default, Debug)]
pub struct PadState {
    pub buttons: u32,
    pub x: f32,
    pub y: f32,
}

impl PadState {
    /// Buttons ORed across pads, sticks from whichever deflects furthest.
    fn merge(&mut self, buttons: u32, x: f32, y: f32) {
        self.buttons |= buttons;
        if x.abs() > self.x.abs() {
            self.x = x;
        }
        if y.abs() > self.y.abs() {
            self.y = y;
        }
    }

    fn active(&self) -> bool {
        self.buttons != 0 || self.x.abs() > ACTIVE_THRESHOLD || self.y.abs() > ACTIVE_THRESHOLD
    }
}

/// Clamp, drop NaN and quantize to 1/100 so stick noise does not flood the page.
fn quantize(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    (value.clamp(-1.0, 1.0) * 100.0).round() / 100.0
}

/// Standard-mapping bits and left stick for one gilrs pad. Analog triggers and
/// hat-style D-pads are folded in as well, so a pad whose mapping exposes them
/// only as axes still works.
fn read_pad(pad: &gilrs::Gamepad<'_>) -> (u32, f32, f32) {
    let mut buttons = 0;
    for (button, bit) in BUTTONS {
        if pad.is_pressed(button) {
            buttons |= 1 << bit;
        }
    }
    buttons |= axis_bits(
        pad.value(Axis::LeftZ),
        pad.value(Axis::RightZ),
        pad.value(Axis::DPadX),
        pad.value(Axis::DPadY),
    );
    (
        buttons,
        quantize(pad.value(Axis::LeftStickX)),
        quantize(pad.value(Axis::LeftStickY)),
    )
}

/// Trigger and hat axes as standard-mapping bits (gilrs axes are +right / +up).
fn axis_bits(left_trigger: f32, right_trigger: f32, hat_x: f32, hat_y: f32) -> u32 {
    let mut bits = 0;
    if left_trigger > DIGITAL_THRESHOLD {
        bits |= LT;
    }
    if right_trigger > DIGITAL_THRESHOLD {
        bits |= RT;
    }
    if hat_x > DIGITAL_THRESHOLD {
        bits |= D_RIGHT;
    } else if hat_x < -DIGITAL_THRESHOLD {
        bits |= D_LEFT;
    }
    if hat_y > DIGITAL_THRESHOLD {
        bits |= D_UP;
    } else if hat_y < -DIGITAL_THRESHOLD {
        bits |= D_DOWN;
    }
    bits
}

/// Whether `pad` must be sent now: on change, or as a heartbeat while held.
fn should_send(pad: &PadState, last: &PadState, since_last_send: Duration) -> bool {
    pad != last || (pad.active() && since_last_send >= HEARTBEAT)
}

/// Starts the controller thread for the YouTube window. Failure to open the
/// input subsystem (no udev, no permission) only disables controller input.
pub fn start(window: &WebviewWindow) {
    let window = window.clone();
    let spawned = thread::Builder::new()
        .name("pake-gamepad".into())
        .spawn(move || {
            let mut gilrs = match Gilrs::new() {
                Ok(gilrs) => gilrs,
                Err(gilrs::Error::NotImplemented(gilrs)) => gilrs,
                Err(error) => {
                    eprintln!("[YouTubeTV] Controller support unavailable: {error}");
                    return;
                }
            };
            let mut last = PadState::default();
            let mut last_sent = Instant::now();
            loop {
                // Draining the event queue is what updates the cached pad state.
                while gilrs.next_event().is_some() {}
                let mut pad = PadState::default();
                for (_, gamepad) in gilrs.gamepads() {
                    if gamepad.is_connected() {
                        let (buttons, x, y) = read_pad(&gamepad);
                        pad.merge(buttons, x, y);
                    }
                }
                let now = Instant::now();
                if should_send(&pad, &last, now.saturating_duration_since(last_sent)) {
                    last = pad;
                    last_sent = now;
                    if window.emit(EVENT, pad).is_err() {
                        return;
                    }
                }
                thread::sleep(POLL_INTERVAL);
            }
        });
    if let Err(error) = spawned {
        eprintln!("[YouTubeTV] Controller thread failed to start: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_standard_button_has_one_bit() {
        let mut seen = 0u32;
        for (_, bit) in BUTTONS {
            assert!(bit < 16);
            assert_eq!(seen & (1 << bit), 0, "bit {bit} mapped twice");
            seen |= 1 << bit;
        }
        assert_eq!(seen, 0xFFFF, "all 16 standard buttons mapped; guide (16) excluded");
    }

    #[test]
    fn axes_fold_into_trigger_and_dpad_bits() {
        assert_eq!(axis_bits(0.0, 0.0, 0.0, 0.0), 0);
        assert_eq!(axis_bits(0.9, 0.0, 0.0, 0.0), LT);
        assert_eq!(axis_bits(0.0, 0.9, 0.0, 0.0), RT);
        assert_eq!(axis_bits(0.4, 0.4, 0.0, 0.0), 0, "below threshold");
        assert_eq!(axis_bits(0.0, 0.0, 1.0, 0.0), D_RIGHT);
        assert_eq!(axis_bits(0.0, 0.0, -1.0, 0.0), D_LEFT);
        assert_eq!(axis_bits(0.0, 0.0, 0.0, 1.0), D_UP, "gilrs hat y is +up");
        assert_eq!(axis_bits(0.0, 0.0, 0.0, -1.0), D_DOWN);
    }

    #[test]
    fn pads_merge_without_double_counting() {
        let mut pad = PadState::default();
        pad.merge(1 << 0, 0.2, 0.0);
        pad.merge(1 << 0 | 1 << 12, -0.8, 0.1);
        assert_eq!(pad, PadState { buttons: 1 << 0 | 1 << 12, x: -0.8, y: 0.1 });
    }

    #[test]
    fn sends_on_change_and_heartbeats_only_while_held() {
        let idle = PadState::default();
        let held = PadState { buttons: 1 << 0, x: 0.0, y: 0.0 };
        let tilted = PadState { buttons: 0, x: 0.0, y: 0.5 };
        assert!(should_send(&held, &idle, Duration::ZERO), "change");
        assert!(!should_send(&held, &held, Duration::from_millis(50)), "held, too soon");
        assert!(should_send(&held, &held, Duration::from_millis(100)), "held: heartbeat");
        assert!(should_send(&tilted, &tilted, Duration::from_millis(100)), "stick counts as held");
        assert!(!should_send(&idle, &idle, Duration::from_secs(5)), "idle never heartbeats");
    }

    #[test]
    fn stick_values_are_clamped_and_quantized() {
        assert_eq!(quantize(0.123456), 0.12);
        assert_eq!(quantize(-1.5), -1.0);
        assert_eq!(quantize(f32::NAN), 0.0);
    }
}
