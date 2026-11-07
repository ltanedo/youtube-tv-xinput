// Runs as a WebView2 / WKWebView initialization script (top frame only).
// Windowed menu, fullscreen playback.
//
// The app no longer starts fullscreen. The browse UI (home, search, settings)
// runs in a normal window with the native title bar, so it can be moved between
// monitors and resized like any other app. The window goes fullscreen, on the
// monitor it is currently on, only once a video actually starts playing on the
// watch page, and leaves fullscreen again when the watch page is left (Back,
// end of a playlist, opening search from the player, ...).
//
// Fullscreen is the native window state (Tauri's setFullscreen; the Rust side
// exposes window.__TAURI__ to the page), not the HTML Fullscreen API: the
// leanback page never requests the latter, and the native state is what
// decides which monitor the app covers. F11 (Windows, a Pake default) still
// toggles it by hand; the next video that starts playing re-applies it.
//
// Watch-page detection is the same body class tv-player.js keys off
// (WEB_PAGE_TYPE_WATCH). Home-screen previews also fire `playing`, but they
// happen outside the watch page, so they never trigger fullscreen.
(() => {
  if (window !== window.top || window.__pakeAutoFullscreen) return;
  window.__pakeAutoFullscreen = true;

  // The body class is swapped during page transitions; waiting a little before
  // leaving fullscreen avoids a windowed flash between two watch pages (for
  // example autoplaying the next video), which re-adds the class right away.
  const EXIT_DELAY_MS = 400;

  const watching = () => !!document.body?.classList.contains("WEB_PAGE_TYPE_WATCH");
  const appWindow = () => {
    try { return window.__TAURI__?.window?.getCurrentWindow?.() || null; } catch (_) { return null; }
  };

  // Last state requested from the native window, so repeated `playing` events
  // (every seek, buffer stall, play after pause) don't flood the IPC bridge.
  // It's re-read from the window before each change so a manual F11 toggle is
  // respected rather than fought.
  let pending = Promise.resolve();
  const setFullscreen = (on) => {
    const w = appWindow();
    if (!w) return; // Tauri bridge not injected yet; the next event tries again.
    pending = pending
      .then(() => w.isFullscreen())
      .then((is) => (is === on ? undefined : w.setFullscreen(on)))
      .catch((error) => { console.warn("[Pake] fullscreen change failed:", error); });
  };

  let exitTimer = 0;
  const cancelExit = () => { if (exitTimer) { clearTimeout(exitTimer); exitTimer = 0; } };
  const scheduleExit = () => {
    if (exitTimer) return;
    exitTimer = setTimeout(() => {
      exitTimer = 0;
      if (!watching()) setFullscreen(false);
    }, EXIT_DELAY_MS);
  };

  // Media events don't bubble; capture them at the document. Only the main
  // player's video counts, not ad or thumbnail previews.
  document.addEventListener("playing", (event) => {
    const video = event.target;
    if (!video?.classList?.contains?.("html5-main-video")) return;
    if (!watching()) return;
    cancelExit();
    setFullscreen(true);
  }, true);

  const onPageTypeChange = () => {
    if (watching()) cancelExit();
    else scheduleExit();
  };
  const observeBody = () => {
    const body = document.body;
    if (!body || typeof MutationObserver === "undefined") return false;
    new MutationObserver(onPageTypeChange).observe(body, { attributes: true, attributeFilter: ["class"] });
    onPageTypeChange();
    return true;
  };
  if (!observeBody()) document.addEventListener("DOMContentLoaded", observeBody, { once: true });
})();
