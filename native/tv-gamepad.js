// Runs as an initialization script (top frame only) on Windows, macOS and
// Linux. Reads the controller every 16 ms and turns it into keyboard input for
// the leanback UI, which is fully keyboard-driven.
//
// - Windows: the state is forwarded to the native bridge (pake_xinput.rs),
//   which merges it with XInput and synthesizes real key presses for the window.
//   Why read it here at all: with the GameInput v2+ runtime installed, Windows
//   only gives live controller data to the process it considers focused. For
//   this app that is the WebView2 process that owns the page, so native
//   XInput/GameInput reads in the app process return neutral state while this
//   API keeps working.
// - macOS: there is no native bridge. WKWebView exposes controllers paired
//   with macOS (Xbox, PlayStation, MFi) through the same API, and the leanback
//   UI handles plain DOM key events, so the same mapping as pake_xinput.rs
//   (`MAPPINGS`, debounce and auto-repeat) is applied here and dispatched as
//   KeyboardEvents straight into the page. No OS-level input is injected and
//   no accessibility permission is needed.
// - Linux: same in-page key synthesis as macOS, but the state comes from the
//   native bridge (pake_gamepad.rs, gilrs over evdev) as a `pake:gamepad`
//   Tauri event: Debian/Ubuntu build WebKitGTK without the Gamepad API. If the
//   WebKit in use does expose it, both sources are merged so a pad seen by
//   both never fires twice.
//
// prepare.cjs injects `window.__pakeHost` ("windows" | "macos" | "linux") just
// before this script.
(() => {
  if (window !== window.top || window.__pakeGamepadBridge) return;
  window.__pakeGamepadBridge = true;

  const IN_PAGE_KEYS = ["macos", "linux"].includes(window.__pakeHost);

  // Standard-mapping button indices (bit n = buttons[n].pressed).
  const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, LT = 6, RT = 7, BACK = 8, START = 9,
    L3 = 10, R3 = 11, D_UP = 12, D_DOWN = 13, D_LEFT = 14, D_RIGHT = 15;


  // --- In-page key synthesis (macOS): same mapping and timing as pake_xinput.rs ---
  const KEYS = {
    ArrowUp: { key: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", keyCode: 39 },
    Enter: { key: "Enter", keyCode: 13 },
    Escape: { key: "Escape", keyCode: 27 },
    Space: { key: " ", keyCode: 32 },
    Slash: { key: "/", keyCode: 191 },
    Comma: { key: ",", keyCode: 188 },
    Period: { key: ".", keyCode: 190 },
    F7: { key: "F7", keyCode: 118 },
    F8: { key: "F8", keyCode: 119 },
  };
  // [button, key code name, auto-repeat]
  const MAPPINGS = [
    [D_UP, "ArrowUp", true], [D_DOWN, "ArrowDown", true], [D_LEFT, "ArrowLeft", true], [D_RIGHT, "ArrowRight", true],
    [A, "Enter", false],      // select
    [B, "Escape", false],     // back
    [X, "Space", false],      // play / pause
    [Y, "Slash", false],      // search
    [START, "Enter", false], [BACK, "Escape", false],
    [LB, "Comma", true], [RB, "Period", true],   // frame step; hold: keeps stepping
    [LT, "F7", false], [RT, "F8", false],
    [L3, "Enter", false], [R3, "Escape", false],
  ];
  // Left stick directions reuse the D-pad repeat logic: (positive key, negative key).
  const AXES = [["ArrowRight", "ArrowLeft"], ["ArrowUp", "ArrowDown"]];
  const AXIS_THRESHOLD = 0.5;
  const PRESS_COOLDOWN = 80;
  const REPEAT_DELAY = 350;
  const REPEAT_RATE = 110;

  // Edge/repeat tracker for one digital input (button or stick direction).
  class Digital {
    constructor() { this.held = false; this.pressedAt = -Infinity; this.repeatedAt = 0; }
    update(active, repeat, now) {
      if (!active) { this.held = false; return false; }
      if (!this.held) {
        // Debounce chattering contacts without swallowing deliberate double taps.
        if (now - this.pressedAt < PRESS_COOLDOWN) return false;
        this.held = true; this.pressedAt = now; this.repeatedAt = now;
        return true;
      }
      if (repeat && now - this.pressedAt >= REPEAT_DELAY && now - this.repeatedAt >= REPEAT_RATE) {
        this.repeatedAt = now;
        return true;
      }
      return false;
    }
  }
  const trackers = { buttons: MAPPINGS.map(() => new Digital()), axes: AXES.map(() => [new Digital(), new Digital()]) };

  const tap = (name) => {
    const { key, keyCode } = KEYS[name];
    // Dispatch on the focused element so the event bubbles through the page's
    // handlers (document/window) exactly like a physical key press would.
    const target = document.activeElement || document.body || document;
    for (const type of ["keydown", "keyup"]) {
      const event = new KeyboardEvent(type, { key, code: name, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true });
      // The leanback UI reads the legacy keyCode; make sure it is set even where
      // the KeyboardEventInit members above are ignored.
      if (event.keyCode !== keyCode) {
        for (const property of ["keyCode", "which"]) Object.defineProperty(event, property, { get: () => keyCode });
      }
      target.dispatchEvent(event);
    }
  };

  const synthesize = (buttons, x, y, now) => {
    MAPPINGS.forEach(([bit, name, repeat], index) => {
      if (trackers.buttons[index].update((buttons & (1 << bit)) !== 0, repeat, now)) tap(name);
    });
    [x, y].forEach((value, index) => {
      const [positive, negative] = AXES[index];
      const [up, down] = trackers.axes[index];
      if (up.update(value > AXIS_THRESHOLD, true, now)) tap(positive);
      if (down.update(value < -AXIS_THRESHOLD, true, now)) tap(negative);
    });
  };

  // --- Native bridge (Windows) ---
  let last = "";
  let lastSent = 0;
  const forward = (buttons, x, y, now) => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;
    const active = buttons !== 0 || Math.abs(x) > 0.3 || Math.abs(y) > 0.3;
    const state = `${buttons}|${x.toFixed(2)}|${y.toFixed(2)}`;
    // Send every change, plus a heartbeat while input is held so native
    // auto-repeat keeps running (the bridge drops state older than 300 ms).
    if (state !== last || (active && now - lastSent > 100)) {
      last = state;
      lastSent = now;
      invoke("page_gamepad", { buttons, x, y }).catch(() => {});
    }
  };

  // --- Native source (Linux) ---
  // pake_gamepad.rs sends the merged state of all pads in this same bit layout
  // (left stick +y up), on every change plus a 100 ms heartbeat while held.
  // State older than 300 ms is dropped so a stalled bridge never leaves a key held.
  const NATIVE_FRESH = 300;
  let native = null; // { buttons, x, y, at }
  if (window.__pakeHost === "linux") {
    const listen = window.__TAURI__?.event?.listen;
    if (listen) {
      listen("pake:gamepad", ({ payload }) => {
        if (!payload) return;
        native = { buttons: payload.buttons >>> 0, x: +payload.x || 0, y: +payload.y || 0, at: performance.now() };
      }).catch(() => {});
    }
  }

  const poll = () => {
    const now = performance.now();
    let buttons = 0;
    let x = 0;
    let y = 0;
    // Native state first, then whatever the Gamepad API can see. A pad visible
    // to both is merged (buttons ORed, strongest stick wins) so it never fires twice.
    if (native && now - native.at < NATIVE_FRESH) ({ buttons, x, y } = native);
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad || !pad.connected || pad.mapping !== "standard") continue;
      pad.buttons.forEach((button, index) => {
        if (button.pressed && index < 32) buttons |= 1 << index;
      });
      const [ax = 0, ay = 0] = pad.axes;
      if (Math.abs(ax) > Math.abs(x)) x = ax;
      if (Math.abs(ay) > Math.abs(y)) y = -ay; // Gamepad API is +down; the mapping uses +up
    }
    buttons >>>= 0;
    if (IN_PAGE_KEYS) synthesize(buttons, x, y, now);
    else forward(buttons, x, y, now);
  };
  setInterval(poll, 16);
})();
