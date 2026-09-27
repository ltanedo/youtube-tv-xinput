// Runs as a WebView2 initialization script (top frame only).
// Reads the controller through the page's Gamepad API and forwards its state to
// the native bridge (pake_xinput.rs), which turns it into real key presses.
// Why here: with the GameInput v2+ runtime installed, Windows only gives live
// controller data to the process it considers focused. For this app that is the
// WebView2 process that owns the page, so native XInput/GameInput reads in the
// app process return neutral state while this API keeps working.
(() => {
  if (window !== window.top || window.__pakeGamepadBridge) return;
  window.__pakeGamepadBridge = true;

  let last = "";
  let lastSent = 0;
  const poll = () => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke || !navigator.getGamepads) return;
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
      if (Math.abs(ay) > Math.abs(y)) y = -ay; // Gamepad API is +down; the bridge uses +up
    }
    buttons >>>= 0;
    const active = buttons !== 0 || Math.abs(x) > 0.3 || Math.abs(y) > 0.3;
    const state = `${buttons}|${x.toFixed(2)}|${y.toFixed(2)}`;
    const now = performance.now();
    // Send every change, plus a heartbeat while input is held so native
    // auto-repeat keeps running (the bridge drops state older than 300 ms).
    if (state !== last || (active && now - lastSent > 100)) {
      last = state;
      lastSent = now;
      invoke("page_gamepad", { buttons, x, y }).catch(() => {});
    }
  };
  setInterval(poll, 16);
})();
