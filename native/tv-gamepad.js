// Runs as an initialization script (top frame only) on Windows and macOS.
// Reads the controller through the page's Gamepad API every 16 ms and turns it
// into keyboard input for the leanback UI, which is fully keyboard-driven.
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
//
// prepare.cjs injects `window.__pakeHost` ("windows" | "macos") just before
// this script.
(() => {
  if (window !== window.top || window.__pakeGamepadBridge) return;
  window.__pakeGamepadBridge = true;

  const IN_PAGE_KEYS = window.__pakeHost === "macos";

  // Standard-mapping button indices (bit n = buttons[n].pressed).
  const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, LT = 6, RT = 7, BACK = 8, START = 9,
    L3 = 10, R3 = 11, D_UP = 12, D_DOWN = 13, D_LEFT = 14, D_RIGHT = 15;

  // Triggers are unmapped as keys; they drive the player shortcuts in tv-player.js.
  const TRIGGER_EVENTS = [[1 << LT, "pake:captions-toggle"], [1 << RT, "pake:aspect-toggle"]];

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
    PageUp: { key: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", keyCode: 34 },
  };
  // [button, key code name, auto-repeat]
  const MAPPINGS = [
    [D_UP, "ArrowUp", true], [D_DOWN, "ArrowDown", true], [D_LEFT, "ArrowLeft", true], [D_RIGHT, "ArrowRight", true],
    [A, "Enter", false],      // select
    [B, "Escape", false],     // back
    [X, "Space", false],      // play / pause
    [Y, "Slash", false],      // search
    [START, "Enter", false], [BACK, "Escape", false],
    [LB, "PageUp", false], [RB, "PageDown", false],
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

  let lastButtons = 0;
  const poll = () => {
    if (!navigator.getGamepads) return;
    let buttons = 0;
    let x = 0;
    let y = 0;
    for (const pad of navigator.getGamepads()) {
      if (!pad || !pad.connected || pad.mapping !== "standard") continue;
      pad.buttons.forEach((button, index) => {
        if (button.pressed && index < 32) buttons |= 1 << index;
      });
      const [ax = 0, ay = 0] = pad.axes;
      if (Math.abs(ax) > Math.abs(x)) x = ax;
      if (Math.abs(ay) > Math.abs(y)) y = -ay; // Gamepad API is +down; the mapping uses +up
    }
    buttons >>>= 0;
    for (const [bit, type] of TRIGGER_EVENTS) {
      if (buttons & bit && !(lastButtons & bit)) window.dispatchEvent(new Event(type));
    }
    lastButtons = buttons;
    const now = performance.now();
    if (IN_PAGE_KEYS) synthesize(buttons, x, y, now);
    else forward(buttons, x, y, now);
  };
  setInterval(poll, 16);
})();
