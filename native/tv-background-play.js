// Runs as a WebView2 initialization script (before any page script).
// YouTube's player pauses when the document reports itself hidden (window
// covered, minimized, or alt-tabbed away). Keep the page convinced it is
// visible and focused so playback continues in the background. The native
// side pairs this with --disable-backgrounding-occluded-windows so Chromium
// keeps rendering and does not throttle timers while another app is in front.
(() => {
  const define = (target, property, value) => {
    try {
      Object.defineProperty(target, property, { get: () => value, configurable: true });
    } catch (_) {}
  };
  for (const target of [Document.prototype, document]) {
    define(target, "hidden", false);
    define(target, "visibilityState", "visible");
    define(target, "webkitHidden", false);
    define(target, "webkitVisibilityState", "visible");
  }
  try { Document.prototype.hasFocus = () => true; } catch (_) {}

  // Swallow the events the player reacts to, before any page listener sees them.
  const swallow = (event) => { event.stopImmediatePropagation(); };
  for (const type of ["visibilitychange", "webkitvisibilitychange"]) {
    document.addEventListener(type, swallow, true);
    window.addEventListener(type, swallow, true);
  }
  window.addEventListener("blur", (event) => {
    // Only window-level blur (focus leaving the app); element blur must still work.
    if (event.target === window) swallow(event);
  }, true);
  window.addEventListener("pagehide", (event) => {
    // Chromium can fire pagehide when a window is hidden; a real navigation is not persisted.
    if (event.persisted) swallow(event);
  }, true);
})();
