// Exercise real controller + player scripts together against a deterministic media fixture.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
function fixture(host = 'macos') {
  const listeners = {};
  const attributes = new Set();
  let poll, now = 0, pressed = [], watch = true;
  const seeks = [];
  let plays = 0;
  class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } preventDefault() {} stopImmediatePropagation() {} }
  class Input {}
  const dispatch = e => (listeners[e.type] || []).forEach(fn => fn(e));
  const video = { paused: false, currentTime: 50, duration: 100, seeking: false,
    seekable: { length: 1, start: () => 0, end: () => 100 } };
  const player = {
    pauseVideo() { video.paused = true; dispatch(new Event('pause')); },
    playVideo() { plays++; video.paused = false; dispatch(new Event('play')); },
    seekTo(t) { seeks.push(t); video.seeking = true; },
    getStatsForNerds: () => ({ resolution: '1920x1080@30' }),
  };
  const document = {
    body: { classList: { contains: () => watch }, dispatchEvent: dispatch, appendChild() {} },
    documentElement: { setAttribute: k => attributes.add(k), hasAttribute: k => attributes.has(k), removeAttribute: k => attributes.delete(k), toggleAttribute() {} },
    querySelector: s => s === '.html5-video-player' ? player : s === 'video.html5-main-video' ? video : null,
    getElementById: () => ({ style: {} }),
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  };
  const window = { __pakeHost: host, addEventListener: document.addEventListener, dispatchEvent: dispatch };
  window.top = window;
  const context = vm.createContext({ window, document, Event, KeyboardEvent: Event,
    HTMLInputElement: Input, HTMLTextAreaElement: Input,
    localStorage: { getItem: () => null }, navigator: { language: 'en', getGamepads: () => [{ connected: true, mapping: 'standard', axes: [], buttons: Array.from({length:17}, (_,i) => ({pressed: pressed.includes(i)})) }] },
    performance: { now: () => now }, setInterval(fn, ms) { if (ms === 16) poll = fn; return 1; },
    clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, innerWidth: 1920, innerHeight: 1080,
  });
  for (const name of ['tv-player.js', 'tv-gamepad.js']) vm.runInContext(fs.readFileSync(`${__dirname}/../native/${name}`, 'utf8'), context);
  return {video, seeks, attributes, get plays() {return plays;},
    press(button) { pressed = []; now += 100; poll(); pressed = [button]; now += 100; poll(); },
    hold() { now += 1000; poll(); },
    key(code, target, repeat = false) { dispatch(new Event('keydown', {code, target, repeat})); },
    settled() {video.currentTime = seeks.at(-1); video.seeking = false; dispatch(new Event('seeked'));},
    set watch(value) {watch = value;}, Input };
}
{
 const p = fixture();
 p.press(4); assert.equal(p.video.paused, true); assert.equal(p.seeks.length, 0);
 p.press(5); assert.equal(p.seeks.at(-1), 50 + 1/30); assert.equal(p.video.paused, true);
 p.hold(); assert.equal(p.seeks.length, 1);
 p.settled(); p.press(4); assert.equal(p.seeks.at(-1), 50); assert.equal(p.plays, 0);
 p.settled(); p.press(7); assert.equal(p.seeks.at(-1), 60); assert.equal(p.plays, 1); assert.equal(p.video.paused, false);
 p.hold(); assert.equal(p.plays, 1);
 p.press(7); assert.equal(p.seeks.at(-1), 70); assert.equal(p.plays, 2);
 p.press(6); assert.equal(p.seeks.at(-1), 60); assert.equal(p.plays, 3);
 p.settled(); p.video.currentTime = 3; p.press(6); assert.equal(p.seeks.at(-1), 0);
 p.settled(); p.video.currentTime = 98; p.press(7); assert.equal(p.seeks.at(-1), 100);
}
{
 const p = fixture(); p.video.seekable = {length:1, start:()=>200, end:()=>300}; p.video.currentTime=205;
 p.press(6); assert.equal(p.seeks.at(-1), 200);
 p.video.seekable.length=0; p.press(7); assert.equal(p.plays, 1);
}
{
 const p=fixture(); p.watch=false; p.press(7); p.press(4); assert.equal(p.seeks.length,0); assert.equal(p.video.paused,false);
 p.watch=true; p.key('F8',new p.Input()); p.key('F8',{isContentEditable:true}); p.key('F8',null,true);
 assert.equal(p.plays,0);
}
{
 const p=fixture('android'); p.key('F8'); p.key('F7'); assert.equal(p.plays,0);
}
{
 // Windows uses native keyboard delivery; verify player side of that route.
 const p=fixture('windows'); p.key('Comma'); assert.equal(p.video.paused,true);
 p.key('Period'); assert.equal(p.seeks.at(-1),50+1/30);
 p.settled(); p.key('F7'); assert.equal(p.video.paused,false); assert.equal(p.plays,1);
}
console.log('Desktop controller/player integration: all tests passed');
