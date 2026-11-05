// Watch only foreground playback. Flush a stuck decoder with a tiny buffered seek;
// never reload the page, change quality, or resume something the user paused.
(() => {
  const state = window.__yttvRecovery = { attempts: 0, reason: '', lastAt: 0 };
  let previous = null;
  let badWindows = 0;
  let since = 0;
  let identity = '';
  let element = null;
  const resetSamples = () => { previous = null; badWindows = 0; };
  setInterval(() => {
    const video = document.querySelector('video.html5-main-video');
    const player = document.querySelector('.html5-video-player');
    const now = performance.now();
    const id = player?.getVideoData?.()?.video_id || video?.currentSrc || '';
    if (video !== element || id !== identity) {
      element = video; identity = id; since = now;
      state.attempts = 0; state.lastAt = 0; state.reason = '';
      resetSamples();
    }
    // Keep the element separately from samples, so pause/seek doesn't reset the budget.
    if (!video || window.__yttvForeground === false || !document.body?.classList.contains('WEB_PAGE_TYPE_WATCH') ||
        video.paused || video.ended || video.seeking || video.error || video.playbackRate === 0 ||
        player?.classList.contains('ad-showing')) {
      resetSamples(); return;
    }
    const quality = video.getVideoPlaybackQuality?.();
    const sample = { video, time: video.currentTime, at: now,
      total: quality?.totalVideoFrames || 0, dropped: quality?.droppedVideoFrames || 0 };
    const old = previous;
    previous = sample;
    if (!old || now - old.at > 5000 || sample.time < old.time || now - since < 10000) { badWindows = 0; return; }
    let bufferEnd = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= sample.time && video.buffered.end(i) > sample.time) bufferEnd = video.buffered.end(i);
    }
    // An empty buffer is a network wait, not a decoder failure. Don't seek into it.
    if (bufferEnd - sample.time < 2) { badWindows = 0; return; }
    const frames = sample.total - old.total;
    const dropped = sample.dropped - old.dropped;
    const stalled = sample.time - old.time < .1;
    const stuttering = frames >= 15 && dropped >= 0 && dropped / frames >= .35;
    badWindows = stalled || stuttering ? badWindows + 1 : 0;
    if (badWindows < 3 || state.attempts >= 2 || (state.lastAt && now - state.lastAt < 30000)) return;
    const target = sample.time + .05;
    let seekable = false;
    for (let i = 0; i < video.seekable.length; i++) {
      if (video.seekable.start(i) <= target && video.seekable.end(i) > target) seekable = true;
    }
    if (!seekable) return;
    try {
      video.currentTime = target;
      state.attempts++;
      state.lastAt = now;
      state.reason = stalled ? 'buffered-stall' : 'dropped-frames';
      badWindows = 0;
    } catch (_) { badWindows = 0; }
  }, 2000);
})();
