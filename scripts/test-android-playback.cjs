const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync('android/app/src/main/assets/playback-recovery.js', 'utf8');
function fixture() {
  let tick, now = 0, position = 10, seeks = [], frames = 0, dropped = 0;
  let buffered = true, seekable = true, ad = false, id = 'video-a';
  const video = { currentSrc: 'blob:test', paused: false, ended: false, seeking: false, error: null, playbackRate: 1,
    get currentTime() { return position; }, set currentTime(value) { seeks.push(value); position = value; },
    get buffered() { return {length: buffered ? 1 : 0, start: () => 0, end: () => 200}; },
    get seekable() { return {length: seekable ? 1 : 0, start: () => 0, end: () => 200}; },
    getVideoPlaybackQuality: () => ({totalVideoFrames: frames, droppedVideoFrames: dropped}) };
  const player = { getVideoData: () => ({video_id:id}), classList:{contains:()=>ad} };
  const window = {__yttvForeground:true};
  vm.runInNewContext(code, {window, performance:{now:()=>now}, setInterval:f=>tick=f,
    document:{body:{classList:{contains:()=>true}},querySelector:s=>s.startsWith('video')?video:player}});
  return {video,window,seeks,
    tick(advance=0, drop=0) { now+=2000;position+=advance;frames+=60;dropped+=drop;tick(); },
    set buffer(v) {buffered=v;}, set canSeek(v) {seekable=v;}, set ad(v) {ad=v;}, set id(v) {id=v;}};
}
const run=(f,n,advance=0,drop=0)=>{for(let i=0;i<n;i++) f.tick(advance,drop);};
let f=fixture();run(f,7);assert.equal(f.seeks.length,0);f.tick();assert.equal(f.seeks.length,1);
assert.equal(f.window.__yttvRecovery.reason,'buffered-stall');assert.ok(Math.abs(f.seeks[0]-10.05)<1e-6);
run(f,14);assert.equal(f.seeks.length,1);f.tick();assert.equal(f.seeks.length,2);
run(f,60);assert.equal(f.seeks.length,2,'recovery is bounded per video');
f.video.paused=true;run(f,5);f.video.paused=false;run(f,20);assert.equal(f.seeks.length,2,'pause must not reset budget');
f.id='video-b';run(f,8);assert.equal(f.seeks.length,3,'new video gets a fresh recovery budget');
f=fixture();run(f,30,2);assert.equal(f.seeks.length,0,'healthy playback stays untouched');
f=fixture();run(f,8,2,30);assert.equal(f.seeks.length,1);assert.equal(f.window.__yttvRecovery.reason,'dropped-frames');
f=fixture();run(f,6,2);f.tick(2,40);run(f,3,2);assert.equal(f.seeks.length,0,'isolated dropped-frame burst ignored');
for(const condition of ['paused','ended','seeking','error']) {
 f=fixture();f.video[condition]=true;run(f,30);assert.equal(f.seeks.length,0,condition);
}
f=fixture();f.buffer=false;run(f,30);assert.equal(f.seeks.length,0,'network buffering is not a decoder stall');
f=fixture();f.canSeek=false;run(f,30);assert.equal(f.seeks.length,0,'never seek outside seekable media');
f=fixture();f.ad=true;run(f,30);assert.equal(f.seeks.length,0,'ad playback untouched');
f=fixture();f.window.__yttvForeground=false;run(f,30,2,50);assert.equal(f.seeks.length,0,'hidden video frames are not stutter');
console.log('Android playback recovery: all tests passed');
