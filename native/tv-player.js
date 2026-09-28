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
//
// Both choices live in localStorage, which is kept in the app profile
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

  // Plain letter keys act only while watching and outside text fields, so they
  // never swallow typing on the search page.
  const KEYS = { KeyD: toggleAspect, KeyC: toggleCaptions };
  const shortcut = (event) => {
    const action = KEYS[event.code];
    if (!action || event.ctrlKey || event.altKey || event.metaKey || !watching()) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "keydown" && !event.repeat) action();
  };
  window.addEventListener("keydown", shortcut, true);
  window.addEventListener("keyup", shortcut, true);
  document.addEventListener("DOMContentLoaded", updateAspect);
})();
