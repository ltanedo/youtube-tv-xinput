// Unit tests for native/tv-fullscreen.js: runs the initialization script in a
// minimal fake page (no browser needed) with a scripted Tauri window bridge,
// and drives the body-class mutations, media events, Shield-panel toggle
// events, manual F11 toggles and timers by hand.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../native/tv-fullscreen.js'), 'utf8');

function page({ tauri = true, bodyAtStart = true } = {}) {
  const calls = [];        // setFullscreen(bool) calls that reached the bridge
  const states = [];       // pake:fullscreen-state announcements seen by the page (ui.js)
  const listeners = {};    // document capture listeners by type
  const winListeners = {}; // window listeners by type
  const timers = new Map();
  let nextTimer = 1;
  let fullscreen = false;  // the native window state
  let observer = null;     // MutationObserver callback on <body class>
  const classes = new Set();
  const body = { classList: { contains: (c) => classes.has(c) } };
  const document = {
    body: bodyAtStart ? body : null,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  };
  class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
  const window = {
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of winListeners[event.type] || []) fn(event); return true; },
  };
  window.top = window;
  window.addEventListener('pake:fullscreen-state', (e) => states.push(e.detail.fullscreen));
  const bridge = {
    isFullscreen: () => Promise.resolve(fullscreen),
    setFullscreen: (on) => { calls.push(on); fullscreen = on; return Promise.resolve(); },
  };
  if (tauri) window.__TAURI__ = { window: { getCurrentWindow: () => bridge } };
  class MutationObserver {
    constructor(fn) { this.fn = fn; }
    observe(target, options) {
      assert.equal(target, body);
      assert.equal(JSON.stringify(options), JSON.stringify({ attributes: true, attributeFilter: ['class'] }));
      observer = this.fn;
    }
  }
  const context = vm.createContext({
    window, document, MutationObserver, CustomEvent, console: { warn() {} },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  vm.runInContext(source, context);
  const flush = () => new Promise((r) => setImmediate(r)); // let the isFullscreen/setFullscreen promise chain settle
  const video = (main = true) => ({ classList: { contains: (c) => main && c === 'html5-main-video' } });
  return {
    calls, states, timers,
    get fullscreen() { return fullscreen; },
    attachTauri() { window.__TAURI__ = { window: { getCurrentWindow: () => bridge } }; },
    domReady() { document.body = body; for (const fn of listeners.DOMContentLoaded || []) fn(); },
    setWatch(on) { if (on) classes.add('WEB_PAGE_TYPE_WATCH'); else classes.delete('WEB_PAGE_TYPE_WATCH'); observer?.(); },
    // Some other body class changed (player state, overlays, browse-to-browse navigation).
    touchClass() { observer?.(); },
    playing: async (main = true) => { for (const fn of listeners.playing || []) fn({ target: video(main) }); await flush(); },
    // The Shield panel's Go windowed / Go fullscreen button.
    toggle: async () => { window.dispatchEvent(new CustomEvent('pake:fullscreen-toggle')); await flush(); },
    // Same click, but without letting the bridge answer yet.
    click: () => { window.dispatchEvent(new CustomEvent('pake:fullscreen-toggle')); },
    flush,
    // Fire every pending timer whose delay has elapsed.
    elapse: async (ms) => {
      for (const [id, t] of [...timers]) if (t.ms <= ms) { timers.delete(id); t.fn(); }
      await flush();
    },
    f11: async () => { fullscreen = !fullscreen; await flush(); }, // user toggles the native state by hand
  };
}

(async () => {
  // Startup: windowed, the browse UI never asks for fullscreen.
  {
    const p = page();
    await p.elapse(1000);
    assert.deepEqual(p.calls, [], 'no native call while windowed on the browse page');
    await p.playing();                      // home-screen preview autoplay
    assert.deepEqual(p.calls, [], 'a preview playing outside the watch page stays windowed');
  }

  // A video starting on the watch page goes fullscreen, once.
  {
    const p = page();
    p.setWatch(true);
    await p.elapse(1000);
    assert.deepEqual(p.calls, [], 'opening the watch page alone does not go fullscreen');
    await p.playing();
    assert.deepEqual(p.calls, [true]);
    assert.deepEqual(p.states, [true], 'the change is announced to the page');
    await p.playing(); await p.playing();   // seeks / buffer resumes fire `playing` again
    assert.deepEqual(p.calls, [true], 'repeated playing events do not re-send setFullscreen');
    await p.playing(false);                 // some other <video> (ad preview, thumbnail)
    assert.deepEqual(p.calls, [true], 'only the main player video counts');
  }

  // Leaving the watch page exits fullscreen after the transition delay.
  {
    const p = page();
    p.setWatch(true); await p.playing();
    p.setWatch(false);
    assert.deepEqual(p.calls, [true], 'exit is delayed, not immediate');
    await p.elapse(399);
    assert.deepEqual(p.calls, [true]);
    await p.elapse(400);
    assert.deepEqual(p.calls, [true, false]);
    assert.equal(p.fullscreen, false);
    assert.deepEqual(p.states, [true, false]);
    assert.equal(p.timers.size, 0, 'no timers left behind');
  }

  // Watch -> watch transitions (autoplay next, playlist) never flash windowed.
  {
    const p = page();
    p.setWatch(true); await p.playing();
    p.setWatch(false);
    p.setWatch(true);                       // class comes back within the delay
    await p.elapse(1000);
    assert.deepEqual(p.calls, [true], 'brief class swap between two watch pages is ignored');
    p.setWatch(false);
    await p.playing();                      // a playing event while the exit is pending but not watching
    await p.elapse(1000);
    assert.deepEqual(p.calls, [true, false], 'exit still happens when the page really left watch');
  }
  {
    const p = page();
    p.setWatch(true); await p.playing();
    p.setWatch(false);
    p.setWatch(true); await p.playing();    // next video starts before the delay elapses
    await p.elapse(1000);
    assert.deepEqual(p.calls, [true], 'playing on the next watch page cancels the pending exit');
  }

  // A manual F11 toggle is respected: the state is re-read, never assumed.
  {
    const p = page();
    p.setWatch(true); await p.playing();
    await p.f11();                          // user leaves fullscreen by hand while watching
    assert.equal(p.fullscreen, false);
    await p.playing();
    assert.deepEqual(p.calls, [true, true], 'next playing event re-enters fullscreen');
    await p.f11();                          // user leaves again, then exits the watch page
    p.setWatch(false); await p.elapse(1000);
    assert.deepEqual(p.calls, [true, true], 'already windowed: no redundant setFullscreen(false)');
  }

  // Shield panel toggle while watching: windowed sticks for this video so the
  // window can be dragged to another monitor; the button, or the next video,
  // goes fullscreen again.
  {
    const p = page();
    p.setWatch(true); await p.playing();
    await p.toggle();                       // Go windowed
    assert.deepEqual(p.calls, [true, false]);
    assert.deepEqual(p.states, [true, false], 'button label follows the window');
    await p.playing(); await p.playing();   // buffering / seeking on the same video
    assert.deepEqual(p.calls, [true, false], 'playback does not snap the window back to fullscreen');
    await p.toggle();                       // Go fullscreen (now on the other monitor)
    assert.deepEqual(p.calls, [true, false, true]);
    await p.toggle(); await p.playing();    // windowed again, still sticks
    assert.deepEqual(p.calls, [true, false, true, false]);
    p.setWatch(false); await p.elapse(1000);
    assert.deepEqual(p.calls, [true, false, true, false], 'already windowed when leaving the watch page');
    p.setWatch(true); await p.playing();
    assert.deepEqual(p.calls, [true, false, true, false, true], 'the next video goes fullscreen again');
  }
  {
    // Race: a `playing` event lands between the Go windowed click and the bridge's answer.
    const p = page();
    p.setWatch(true); await p.playing();
    p.click();                              // Go windowed, bridge not answered yet
    await p.playing();                      // buffering resumes in the same tick
    await p.flush();
    assert.deepEqual(p.calls, [true, false], 'the click wins; playback does not re-enter fullscreen');
    assert.equal(p.fullscreen, false);
    p.click(); await p.playing(); await p.flush();
    assert.deepEqual(p.calls, [true, false, true], 'Go fullscreen with a racing playing event: fullscreen once');
    // F11 after Go windowed (a change the script never sees), then a click racing a
    // playing event: the click reads the real state and wins.
    const r = page();
    r.setWatch(true); await r.playing(); await r.toggle();
    await r.f11();                          // user goes fullscreen by hand
    assert.equal(r.fullscreen, true);
    r.click(); await r.playing(); await r.flush();
    assert.deepEqual(r.calls, [true, false, false], 'Go windowed wins over the racing playing event');
    assert.equal(r.fullscreen, false);
    await r.playing();
    assert.deepEqual(r.calls, [true, false, false], 'and sticks');
    // First-ever click while watching but windowed (state never observed): the
    // window goes fullscreen and the racing playing event is a no-op.
    const q = page();
    q.setWatch(true);
    q.click(); await q.playing(); await q.flush();
    assert.deepEqual(q.calls, [true]);
    await q.playing();
    assert.deepEqual(q.calls, [true], 'flag corrected after the real state was read');
  }
  {
    // The watch page changes while the bridge is busy.
    const p = page();
    p.setWatch(true);
    p.click(); /* nothing yet */ await p.flush();
    assert.deepEqual(p.calls, [true], 'Go fullscreen from a watch page before any video plays');
    p.setWatch(false);                      // user backs out to the browse page ...
    p.click();                              // ... and clicks Go windowed there
    p.setWatch(true);                       // ... but a watch page opens before the bridge answers
    await p.flush();
    assert.deepEqual(p.calls, [true, false]);
    await p.playing();
    assert.deepEqual(p.calls, [true, false, true], 'the click was made on the browse page, so the new video goes fullscreen');
    const q = page();
    q.setWatch(true);
    q.playing();                            // playing queued, bridge not answered yet
    q.setWatch(false);                      // user leaves the watch page in the same tick
    await q.flush();
    assert.deepEqual(q.calls, [], 'a queued playing decision does not force fullscreen after the page was left');
    await q.elapse(1000);
    assert.deepEqual(q.calls, []);
  }
  {
    // Go windowed click still in flight when the watch page is left: the flag must not
    // survive onto the browse page or the next video.
    const p = page();
    p.setWatch(true); await p.playing();
    p.click();                              // Go windowed, bridge not answered yet
    p.setWatch(false); p.setWatch(true);    // autoplay-next swaps the watch page meanwhile
    await p.flush();
    assert.deepEqual(p.calls, [true, false]);
    await p.playing();
    assert.deepEqual(p.calls, [true, false, true], 'the next video goes fullscreen');
    const q = page();
    q.setWatch(true); await q.playing();
    q.click();
    q.setWatch(false);                      // Back to the browse page meanwhile
    await q.flush(); await q.elapse(1000);
    assert.deepEqual(q.calls, [true, false]);
    q.setWatch(true); await q.playing();
    assert.deepEqual(q.calls, [true, false, true], 'a later video goes fullscreen');
  }
  // The browse UI's own state is restored when the watch page is left: a
  // fullscreen home screen (Shield button or F11) stays fullscreen after a video,
  // a windowed one stays windowed.
  {
    const p = page();
    await p.toggle();                       // Go fullscreen on the home screen
    assert.deepEqual(p.calls, [true]);
    await p.elapse(1000);
    assert.deepEqual(p.calls, [true]);
    p.setWatch(true); await p.playing();
    assert.deepEqual(p.calls, [true], 'already fullscreen when the video starts');
    p.setWatch(false); await p.elapse(1000);
    assert.deepEqual(p.calls, [true], 'leaving the watch page keeps the fullscreen home screen');
    assert.equal(p.fullscreen, true);
    await p.toggle();                       // Go windowed on the home screen
    p.setWatch(true); await p.playing(); p.setWatch(false); await p.elapse(1000);
    assert.deepEqual(p.calls, [true, false, true, false], 'a windowed home screen is windowed again after a video');
    assert.equal(p.timers.size, 0, 'no timers left behind');
  }
  {
    // Fullscreen home screen via F11 (a change the script never sees).
    const p = page();
    await p.elapse(1000);                   // startup settled on the home screen
    await p.f11();
    p.setWatch(true); await p.playing();
    assert.deepEqual(p.calls, []);
    p.setWatch(false); await p.elapse(1000);
    assert.deepEqual(p.calls, [], 'F11 fullscreen home screen is kept after the video');
    assert.equal(p.fullscreen, true);
    await p.f11();                          // back to windowed by hand, then another video
    p.setWatch(true); await p.playing(); p.setWatch(false); await p.elapse(1000);
    assert.deepEqual(p.calls, [true, false], 'the state read at the next watch page wins');
  }
  {
    // Fullscreen home screen, then the user goes windowed during the video (Shield
    // button, or F11): Back restores the fullscreen home screen.
    const p = page();
    await p.toggle();
    p.setWatch(true); await p.playing(); await p.toggle();
    assert.deepEqual(p.calls, [true, false]);
    p.setWatch(false); await p.elapse(1000);
    assert.deepEqual(p.calls, [true, false, true], 'Go windowed mid-video: the home screen is fullscreen again');
    const q = page();
    await q.toggle();
    q.setWatch(true); await q.playing(); await q.f11();
    q.setWatch(false); await q.elapse(1000);
    assert.deepEqual(q.calls, [true, true], 'F11 mid-video: the home screen is fullscreen again');
  }
  {
    // Autoplay-next never records the playback state as the home-screen state.
    const p = page();
    p.setWatch(true); await p.playing();
    p.setWatch(false); p.setWatch(true); await p.playing();   // next video
    p.setWatch(false); await p.elapse(1000);
    assert.deepEqual(p.calls, [true, false], 'windowed home screen after an autoplay chain');
    const q = page();
    q.setWatch(true); await q.playing();
    q.setWatch(false); await q.elapse(300);                  // watch page left, exit still pending
    q.setWatch(true); await q.playing();                     // next video (no autoplay flash this time)
    q.setWatch(false); await q.elapse(1000);
    assert.deepEqual(q.calls, [true, false], 'windowed home screen after a slow watch-to-watch transition');
  }
  {
    // Unrelated body class changes never touch the cached browse state.
    const p = page();
    await p.elapse(1000);
    p.setWatch(true); await p.playing();
    p.touchClass(); await p.flush();        // player state class toggles while fullscreen
    p.setWatch(false); await p.elapse(1000);
    assert.deepEqual(p.calls, [true, false], 'a class change while watching does not record playback as the home state');
    await p.f11();                          // fullscreen home screen by hand
    p.touchClass(); await p.elapse(1000);   // browse-to-browse navigation
    assert.deepEqual(p.calls, [true, false], 'a class change while browsing does not undo F11');
    assert.equal(p.fullscreen, true);
    p.setWatch(true); await p.playing(); p.setWatch(false); await p.elapse(1000);
    assert.deepEqual(p.calls, [true, false], 'and the fullscreen home screen is kept after the next video');
    const q = page();                       // same, with a windowed home screen and the Shield button mid-video
    await q.elapse(1000);
    q.setWatch(true); await q.playing(); await q.toggle();
    q.touchClass(); await q.flush();
    q.setWatch(false); await q.elapse(1000);
    assert.deepEqual(q.calls, [true, false], 'windowed home screen stays windowed');
  }
  {
    // Go windowed on the home screen within the exit grace period: it is honored.
    const p = page();
    await p.toggle();                       // fullscreen home screen
    p.setWatch(true); await p.playing(); p.setWatch(false);
    await p.toggle();                       // Go windowed right after Back, before the timer
    assert.deepEqual(p.calls, [true, false]);
    await p.elapse(1000);
    assert.deepEqual(p.calls, [true, false], 'the pending exit does not re-enter fullscreen');
    p.setWatch(true); await p.playing(); p.setWatch(false); await p.elapse(1000);
    assert.deepEqual(p.calls, [true, false, true, false], 'and the home screen stays windowed from then on');
  }
  {
    // Go windowed on a watch page, then autoplay-next swaps the class briefly: the next video is fullscreen.
    const p = page();
    p.setWatch(true); await p.playing(); await p.toggle();
    p.setWatch(false); p.setWatch(true); await p.playing();
    await p.elapse(1000);
    assert.deepEqual(p.calls, [true, false, true]);
  }

  // Bridge not injected yet: nothing breaks, the next event retries.
  {
    const p = page({ tauri: false });
    p.setWatch(true); await p.playing(); await p.toggle();
    assert.deepEqual(p.calls, []);
    p.attachTauri();
    await p.playing();
    assert.deepEqual(p.calls, [true]);
  }

  // Document-start: <body> doesn't exist yet, the observer attaches on DOMContentLoaded.
  {
    const p = page({ bodyAtStart: false });
    p.domReady();
    p.setWatch(true); await p.playing();
    p.setWatch(false); await p.elapse(1000);
    assert.deepEqual(p.calls, [true, false]);
  }

  console.log('tv-fullscreen.js: all tests passed');
})().catch((error) => { console.error(error); process.exit(1); });
