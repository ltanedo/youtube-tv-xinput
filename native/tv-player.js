// Runs as a WebView2 initialization script (top frame only).
// Player shortcuts the leanback UI lacks, active while a video plays:
//
// - Ultrawide fill (D, or right trigger via tv-gamepad.js). The leanback player
//   sizes the <video> to the stream's aspect ratio, so a 16:9 video on a 21:9
//   screen gets black bars left and right. On screens wider than 16:9 this marks
//   <html data-pake-fill> while a landscape video would be pillarboxed;
//   inject/yttv.css then scales the video to cover the screen, cropping top and
//   bottom instead.
// - Subtitles on/off (C, or left trigger). Switches the player's caption track,
//   the same state the on-screen CC button shows, and turns back on the last
//   language used. The choice is re-applied to every video, and changes made
//   with the CC button are adopted as the new choice.
// - Frame step (< / >, also , / .). The first tap pauses; each further tap
//   (or holding the key) moves one frame back or forward. Play resumes as usual.
//
// The fill and subtitle choices live in localStorage, which is kept in the app profile
// (%APPDATA%\YouTubeTV), so they survive restarts.
(() => {
  if (window !== window.top || window.__pakePlayerKeys) return;
  window.__pakePlayerKeys = true;

  const ASPECT_KEY = "pake-aspect-mode";
  const CAPTIONS_KEY = "pake-captions"; // "on" | "off"; unset until first chosen
  const LANGUAGE_KEY = "pake-captions-language";
  const load = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; } };
  const save = (key, value) => { try { localStorage.setItem(key, value); } catch (_) {} };
  let mode = load(ASPECT_KEY, "fill");

  const watching = () => document.body?.classList.contains("WEB_PAGE_TYPE_WATCH");
  const player = () => document.querySelector(".html5-video-player");

  const updateAspect = () => {
    const root = document.documentElement;
    if (!root) return;
    const screen = innerWidth / innerHeight;
    const video = document.querySelector("video.html5-main-video");
    const ratio = video && video.videoHeight ? video.videoWidth / video.videoHeight : 0;
    // Only landscape video that would be pillarboxed: skip Shorts, 4:3, and
    // streams already as wide as the screen (cover would crop their sides).
    const fill = mode === "fill" && screen > (16 / 9) * 1.05 && ratio >= 1.5 && ratio < screen * 0.98;
    root.toggleAttribute("data-pake-fill", fill);
  };

  let toastTimer = 0;
  const toast = (text) => {
    let el = document.getElementById("pake-player-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "pake-player-toast";
      el.style.cssText = "position:fixed;top:4vh;left:50%;transform:translateX(-50%);z-index:2147483647;" +
        "padding:.6em 1.2em;border-radius:.5em;background:rgba(0,0,0,.75);color:#fff;" +
        "font:500 2.2vh Roboto,Arial,sans-serif;pointer-events:none;transition:opacity .3s";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = "0"; }, 1500);
  };

  const toggleAspect = () => {
    if (!watching()) return;
    mode = mode === "fill" ? "fit" : "fill";
    save(ASPECT_KEY, mode);
    updateAspect();
    toast(mode === "fill" ? "Aspect: Fill screen" : "Aspect: Original (fit)");
  };

  // toggleSubtitlesOn() only hides the captions and leaves the CC button
  // pressed, so switch the caption track itself instead.
  const tracksOf = (p) => p.getOption("captions", "tracklist") || [];
  const currentTrack = (p) => {
    const track = p.isSubtitlesOn() && p.getOption("captions", "track");
    return track?.languageCode ? track : null;
  };
  const pickTrack = (tracks) => {
    const wanted = [load(LANGUAGE_KEY, ""), navigator.language, navigator.language.split("-")[0]];
    return wanted.map((code) => code && tracks.find((t) => t.languageCode === code)).find(Boolean) ||
      tracks.find((t) => t.is_default) || tracks[0];
  };
  // Returns the track now showing, or null when captions are off.
  const setCaptions = (p, on) => {
    const current = currentTrack(p);
    if (!on) {
      if (current) { save(LANGUAGE_KEY, current.languageCode); p.setOption("captions", "track", {}); }
      return null;
    }
    if (current) return current;
    const track = pickTrack(tracksOf(p));
    if (track) p.setOption("captions", "track", track);
    return track || null;
  };

  const toggleCaptions = () => {
    const p = watching() && player();
    if (!p?.setOption) return;
    const on = !currentTrack(p);
    const track = setCaptions(p, on);
    if (on && !track) { toast("No subtitles for this video"); return; }
    save(CAPTIONS_KEY, on ? "on" : "off");
    toast(on ? `Subtitles: ${track.displayName || track.languageName || track.languageCode}` : "Subtitles off");
  };

  // Keep the saved choice across videos and restarts. For the first few
  // seconds of each video the saved choice is enforced (the player loads its
  // caption state asynchronously); after that, whatever the player shows,
  // e.g. after using the on-screen CC button, becomes the saved choice.
  let videoId = "";
  let enforceUntil = 0;
  setInterval(() => {
    const p = watching() && player();
    const id = p?.getVideoData?.()?.video_id;
    if (!id || !tracksOf(p).length) return;
    const now = Date.now();
    if (id !== videoId) { videoId = id; enforceUntil = now + 3000; }
    const saved = load(CAPTIONS_KEY, "");
    if (now < enforceUntil) {
      if (saved) setCaptions(p, saved === "on");
      return;
    }
    const current = currentTrack(p);
    if (current) save(LANGUAGE_KEY, current.languageCode);
    if (saved !== (current ? "on" : "off")) save(CAPTIONS_KEY, current ? "on" : "off");
  }, 500);

  // Media events don't bubble; capture them at the document.
  for (const type of ["loadedmetadata", "resize", "emptied"]) document.addEventListener(type, updateAspect, true);
  window.addEventListener("resize", updateAspect);
  window.addEventListener("pake:aspect-toggle", toggleAspect);
  window.addEventListener("pake:captions-toggle", toggleCaptions);

  // Frame rate from the player's stats ("1920x1080@24 / ..."); 30 if unknown.
  const frameRate = (p) => {
    try { return +(p.getStatsForNerds().resolution.match(/@(\d+)/) || [])[1] || 30; } catch (_) { return 30; }
  };
  let stepTarget = 0;
  const stepFrame = (direction) => {
    const p = watching() && player();
    const video = document.querySelector("video.html5-main-video");
    if (!p?.seekTo || !video) return;
    // Hide the paused overlay (title, controls, related videos) so the frame
    // is visible; showOverlay() brings it back. Stepping again while a resume
    // is pending cancels it, so the pause below doesn't show the overlay.
    stopOverlayTimers();
    document.documentElement.setAttribute("data-pake-stepping", "");
    if (!video.paused) { p.pauseVideo(); toast("Paused: frame step"); return; }
    // Step relative to the current position (frame timestamps needn't be
    // multiples of 1/fps); chain from the last target while a seek is pending
    // so fast taps aren't lost.
    const base = video.seeking ? stepTarget : video.currentTime;
    stepTarget = Math.min(Math.max(base + direction / frameRate(p), 0), video.duration || Infinity);
    p.seekTo(stepTarget, true);
  };
  const stepBack = () => stepFrame(-1);
  const stepForward = () => stepFrame(1);

  // Overlay around frame step. Resuming playback from step mode keeps the
  // overlay hidden until YouTube's own controls have auto-hidden, then drops
  // data-pake-stepping so nothing flashes up. Other input shows it right away.
  const stepping = () => document.documentElement.hasAttribute("data-pake-stepping");
  let resumeTimer = 0;
  let enterTimer = 0;
  function stopOverlayTimers() {
    clearInterval(resumeTimer);
    clearTimeout(enterTimer);
    resumeTimer = enterTimer = 0;
  }
  const showOverlay = () => {
    stopOverlayTimers();
    document.documentElement.removeAttribute("data-pake-stepping");
  };
  // YouTube's controls are up while its progress bar is displayed (a tag
  // name, not an obfuscated class, so it survives YouTube deploys).
  const controlsShowing = () => {
    const bar = document.querySelector("ytlr-watch-default ytlr-progress-bar");
    return !!bar && getComputedStyle(bar).display !== "none";
  };
  const resumeHidden = () => {
    clearTimeout(enterTimer);
    enterTimer = 0;
    if (resumeTimer) return;
    const started = Date.now();
    let hiddenSince = 0;
    resumeTimer = setInterval(() => {
      const now = Date.now();
      if (controlsShowing()) hiddenSince = 0;
      else hiddenSince ||= now;
      // Controls settled hidden (not a transient between states); if that is
      // never seen, give the overlay back after 8 s rather than keep it hidden.
      if ((hiddenSince && now - hiddenSince >= 600 && now - started >= 500) || now - started > 8000) showOverlay();
    }, 150);
  };
  document.addEventListener("play", () => { if (stepping()) resumeHidden(); }, true);
  document.addEventListener("pause", () => { if (resumeTimer) showOverlay(); }, true);
  for (const type of ["loadedmetadata", "emptied"]) document.addEventListener(type, showOverlay, true);
  window.addEventListener("pointerdown", showOverlay, true);

  // A key pressed in step mode that isn't one of our shortcuts. Space / X
  // (play-pause) resumes with the overlay still hidden. Enter / A does too when
  // it starts playback (the focused play button); otherwise it may activate
  // something else, so the overlay is shown. Anything else shows it now.
  // Controller buttons arrive here as keys from the native bridge.
  const MODIFIERS = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);
  const stepModeKey = (event) => {
    if (!stepping() || MODIFIERS.has(event.code)) return;
    const video = document.querySelector("video.html5-main-video");
    const paused = video?.paused && !resumeTimer;
    if (paused && (event.code === "Space" || event.key === "MediaPlayPause")) return;
    if (paused && (event.code === "Enter" || event.code === "NumpadEnter")) {
      clearTimeout(enterTimer);
      enterTimer = setTimeout(() => { if (!resumeTimer) showOverlay(); }, 400);
      return;
    }
    showOverlay();
  };

  // Plain keys act only while watching and outside text fields, so they
  // never swallow typing on the search page. Shift is allowed: < and > are
  // Shift+Comma / Shift+Period.
  const KEYS = { KeyD: toggleAspect, KeyC: toggleCaptions, Comma: stepBack, Period: stepForward };
  const REPEATS = new Set([stepBack, stepForward]);
  const shortcut = (event) => {
    const action = KEYS[event.code];
    if (event.type === "keydown" && !action) stepModeKey(event);
    if (!action || event.ctrlKey || event.altKey || event.metaKey || !watching()) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "keydown" && (!event.repeat || REPEATS.has(action))) action();
  };
  window.addEventListener("keydown", shortcut, true);
  window.addEventListener("keyup", shortcut, true);
  document.addEventListener("DOMContentLoaded", updateAspect);
})();
