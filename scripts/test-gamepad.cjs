// Unit tests for native/tv-gamepad.js: runs the initialization script in a
// minimal fake page (no browser needed) and drives its 16 ms poll by hand.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../native/tv-gamepad.js'), 'utf8');

function page(host) {
  const events = [];   // KeyboardEvents dispatched into the page
  const custom = [];   // pake:* events dispatched on window
  const invoked = [];  // native bridge calls (Windows)
  const pads = [];
  let now = 0;
  let poll;
  class Event { constructor(type) { this.type = type; } }
  class KeyboardEvent extends Event {
    constructor(type, init) { super(type); Object.assign(this, init); this.isTrusted = false; }
  }
  const body = { dispatchEvent: (event) => { events.push(event); return true; } };
  const document = { activeElement: null, body };
  const window = {
    __pakeHost: host,
    dispatchEvent: (event) => { custom.push(event.type); return true; },
    addEventListener() {},
  };
  window.top = window;
  if (host === 'windows') {
    window.__TAURI__ = { core: { invoke: (command, args) => { invoked.push({ command, ...args }); return Promise.resolve(); } } };
  }
  const context = vm.createContext({
    window, Event, KeyboardEvent,
    navigator: { getGamepads: () => pads },
    document,
    performance: { now: () => now },
    setInterval: (fn) => { poll = fn; return 1; },
  });
  vm.runInContext(source, context);
  assert.ok(poll, 'script must start polling');
  const pad = (pressed = [], axes = [0, 0]) => ({
    connected: true, mapping: 'standard', axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
  });
  return {
    events, custom, invoked, document,
    set: (...p) => { pads.length = 0; pads.push(...p); },
    pad,
    // Advance time and poll once (16 ms, like the real interval).
    tick: (ms = 16) => { now += ms; poll(); },
    taps: () => events.filter((e) => e.type === 'keydown').map((e) => e.code),
  };
}

// --- macOS: keys are synthesized in the page ---
{
  const p = page('macos');
  p.set(p.pad([0]));                      // A
  p.tick();
  assert.deepEqual(p.events.map((e) => [e.type, e.code, e.key, e.keyCode, e.which, e.bubbles]),
    [['keydown', 'Enter', 'Enter', 13, 13, true], ['keyup', 'Enter', 'Enter', 13, 13, true]]);
  for (let i = 0; i < 60; i++) p.tick();  // held ~1 s: a non-repeating button fires once
  assert.deepEqual(p.taps(), ['Enter']);
  assert.equal(p.invoked.length, 0, 'no native bridge calls on macOS');
}
{
  // Every mapped button, same as pake_xinput.rs MAPPINGS.
  const expected = { 12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight', 0: 'Enter', 1: 'Escape',
    2: 'Space', 3: 'Slash', 9: 'Enter', 8: 'Escape', 4: 'PageUp', 5: 'PageDown', 10: 'Enter', 11: 'Escape' };
  for (const [button, code] of Object.entries(expected)) {
    const p = page('macos');
    p.set(p.pad([+button]));
    p.tick();
    assert.deepEqual(p.taps(), [code], `button ${button}`);
  }
  const keys = { Space: ' ', Slash: '/', Escape: 'Escape', PageDown: 'PageDown' };
  for (const [code, key] of Object.entries(keys)) {
    const p = page('macos');
    p.set(p.pad([{ Space: 2, Slash: 3, Escape: 1, PageDown: 5 }[code]]));
    p.tick();
    assert.equal(p.events[0].key, key);
  }
}
{
  // Triggers: player events only, never keys; guide button ignored.
  const p = page('macos');
  p.set(p.pad([6, 7, 16]));
  p.tick();
  assert.deepEqual(p.custom, ['pake:captions-toggle', 'pake:aspect-toggle']);
  assert.deepEqual(p.taps(), []);
  p.tick();                               // held: no re-fire
  assert.equal(p.custom.length, 2);
}
{
  // D-pad auto-repeat: 350 ms delay, then every ~110 ms.
  const p = page('macos');
  p.set(p.pad([12]));
  p.tick();                               // t=16: press
  assert.equal(p.taps().length, 1);
  while (p.events.length / 2 < 2) p.tick();
  const t2 = p.events.length;             // first repeat
  const ticksToFirstRepeat = t2;          // 2 events per tap
  // first repeat lands once 350 ms have elapsed since the press at t=16
  assert.ok(ticksToFirstRepeat === 4, `first repeat after delay (${t2} events)`);
  let count = 0;
  for (let i = 0; i < 70; i++) p.tick();  // ~1.1 s more
  count = p.taps().length;
  assert.ok(count >= 11 && count <= 13, `about 9 Hz repeat (${count} taps)`);
  assert.ok(p.taps().every((c) => c === 'ArrowUp'));
  p.set(p.pad([]));
  p.tick();
  const released = p.taps().length;
  for (let i = 0; i < 30; i++) p.tick();
  assert.equal(p.taps().length, released, 'nothing fires after release');
}
{
  // Debounce: a re-press within 80 ms is ignored, a later one fires again.
  const p = page('macos');
  p.set(p.pad([0])); p.tick();
  p.set(p.pad([])); p.tick();
  p.set(p.pad([0])); p.tick();            // 32 ms after the first press
  assert.deepEqual(p.taps(), ['Enter']);
  p.set(p.pad([])); p.tick();
  p.set(p.pad([0])); p.tick(100);
  assert.deepEqual(p.taps(), ['Enter', 'Enter']);
}
{
  // Left stick: Gamepad API y is +down; threshold 0.5; strongest pad wins.
  const p = page('macos');
  p.set(p.pad([], [0.8, 0])); p.tick();
  p.set(p.pad([], [-0.8, 0])); p.tick(100);
  p.set(p.pad([], [0, -0.9])); p.tick(100);
  p.set(p.pad([], [0, 0.9])); p.tick(100);
  p.set(p.pad([], [0.3, 0.3])); p.tick(100);  // inside dead zone
  assert.deepEqual(p.taps(), ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']);
  p.set(p.pad([], [0.2, 0]), p.pad([], [-0.7, 0])); p.tick(100);
  assert.equal(p.taps().at(-1), 'ArrowLeft');
}
{
  // A pad that is disconnected or not standard-mapped is ignored.
  const p = page('macos');
  p.set({ ...p.pad([0]), connected: false }, { ...p.pad([0]), mapping: '' }, null);
  p.tick();
  assert.deepEqual(p.taps(), []);
}
{
  // Keys go to the focused element when there is one, and fall back to <body>.
  const p = page('macos');
  const focused = [];
  p.document.activeElement = { dispatchEvent: (e) => { focused.push(e.code); return true; } };
  p.set(p.pad([0]));
  p.tick();
  assert.deepEqual(focused, ['Enter', 'Enter']);
  assert.deepEqual(p.events, []);
}

// --- Windows: state is forwarded to the native bridge ---
{
  const p = page('windows');
  p.tick();                               // the first poll reports the (neutral) state once
  assert.deepEqual(p.invoked, [{ command: 'page_gamepad', buttons: 0, x: 0, y: 0 }]);
  for (let i = 0; i < 20; i++) p.tick();
  assert.equal(p.invoked.length, 1, 'idle state is not repeated');
  p.set(p.pad([0, 12], [0.25, 0.75]));
  p.tick();
  assert.deepEqual(p.invoked.at(-1), { command: 'page_gamepad', buttons: (1 << 0) | (1 << 12), x: 0.25, y: -0.75 });
  assert.equal(p.events.length, 0, 'no in-page keys on Windows');
  for (let i = 0; i < 6; i++) p.tick();   // held 96 ms more: no heartbeat yet
  assert.equal(p.invoked.length, 2);
  p.tick();                               // >100 ms since last send: heartbeat
  assert.equal(p.invoked.length, 3);
  p.set(p.pad([7]));                      // RT: player event, and a changed state
  p.tick();
  assert.deepEqual(p.custom, ['pake:aspect-toggle']);
  assert.equal(p.invoked.at(-1).buttons, 1 << 7);
  p.set(p.pad([]));
  p.tick();
  assert.deepEqual(p.invoked.at(-1), { command: 'page_gamepad', buttons: 0, x: 0, y: 0 });
  for (let i = 0; i < 20; i++) p.tick();
  assert.equal(p.invoked.length, 5, 'no heartbeat while idle');
}

console.log('tv-gamepad.js: all tests passed');
