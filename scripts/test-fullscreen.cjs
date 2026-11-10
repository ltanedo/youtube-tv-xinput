// Unit tests for native/tv-fullscreen.js: runs the initialization script in a
// minimal fake page (no browser needed) with a scripted Tauri window bridge,
// and drives the body-class mutations, media events, Shield-panel toggle
// events and timers by hand.
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
    // First-ever click while watching and windowed by F11 (state never observed): the
    // real state is read and the window goes fullscreen; the flag is corrected.
    const q = page();
    q.setWatch(true);
    q.click(); await q.playing(); await q.flush();
    assert.deepEqual(q.calls, [true]);
    await q.playing();
    assert.deepEqual(q.calls, [true], 'flag corrected after the real state was read');
  }
  {
    // Go fullscreen from the browse page: stays until toggled back or a watch page is left.
    const p = page();
    await p.toggle();
    assert.deepEqual(p.calls, [true]);
    await p.elapse(1000);
    assert.deepEqual(p.calls, [true]);
    p.setWatch(true); await p.playing(); p.setWatch(false); await p.elapse(1000);
    assert.deepEqual(p.calls, [true, false], 'leaving a watch page returns to the window as usual');
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
