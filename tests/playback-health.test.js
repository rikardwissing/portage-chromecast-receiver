'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {Monitor, Observer} = require('../playback-health');
function stream() {
  const monitor = new Monitor(), notices = [];
  let s = {at: 0, position: 0, state: 'PLAYING', paused: false, rate: 1, frames: 0, dropped: 0, expectedFPS: 24};
  return {monitor, notices, step(n = 1, changes = {}) {
    for (let i = 0; i < n; i++) {
      s = {...s, at: s.at + 1, position: s.position + 1, frames: s.frames + 24,
        ...(typeof changes === 'function' ? changes(s) : changes)};
      const reason = monitor.sample(s); if (reason) notices.push(reason);
    }
    return s;
  }};
}
test('advancing audio/clock with sparse video and ZERO dropped frames offers settings once', () => {
  const t = stream(); t.step(14);
  t.step(30, s => ({frames: s.frames + (s.at % 2 ? 1 : 0)}));
  assert.deepEqual(t.notices, ['sparseVideo']);
});
test('poor video from the start is detected using the declared stream cadence', () => {
  const t = stream(); t.step(30, s => ({frames: s.frames + 1}));
  assert.deepEqual(t.notices, ['sparseVideo']);
});
test('learned cadence works when a direct file has no reported frame rate', () => {
  const t = stream(); t.step(20, {expectedFPS: null});
  t.step(20, s => ({frames: s.frames + 1}));
  assert.deepEqual(t.notices, ['sparseVideo']);
});
test('healthy video, unknown counters, genuine low-fps material and isolated brief holes stay silent', () => {
  for (const changes of [{}, {frames: null, dropped: null}, s => ({frames: s.frames + 1, expectedFPS: 1})]) {
    const t = stream(); t.step(60, changes); assert.deepEqual(t.notices, []);
  }
  const t = stream(); t.step(15);
  t.step(1, s => ({position: s.position, frames: s.frames, state: 'BUFFERING'}));
  t.step(40, {state: 'PLAYING'}); assert.deepEqual(t.notices, []);
});
test('persistent stalls and repeated interruptions are observed after playback starts', () => {
  const t = stream(); t.step(15);
  t.step(10, s => ({position: s.position, frames: s.frames, state: 'BUFFERING'}));
  assert.deepEqual(t.notices, ['stalled']);
  const r = stream(); r.step(15);
  for (let i = 0; i < 3; i++) {
    r.step(2, s => ({position: s.position, frames: s.frames, state: 'BUFFERING'}));
    r.step(3, {state: 'PLAYING'});
  }
  assert.deepEqual(r.notices, ['repeatedStalls']);
});
test('startup, pause, hidden timers, explicit seeks, idle and ended playback cannot warn', () => {
  const t = stream();
  t.step(60, {position: 0, frames: 0, state: 'BUFFERING'});
  t.step(15, {state: 'PLAYING'});
  for (const inactive of [{paused: true}, {state: 'PAUSED'}, {state: 'IDLE'}, {hidden: true}, {ended: true}]) {
    t.step(20, s => ({position: s.position, frames: s.frames, ...inactive}));
    t.step(15, {state: 'PLAYING', paused: false, hidden: false, ended: false});
  }
  for (let i = 0; i < 3; i++) {
    t.monitor.suspend(t.step().at);
    t.step(7, s => ({position: s.position, frames: s.frames, seeking: true}));
    t.step(5, {seeking: false});
  }
  t.monitor.suspend(t.step().at);
  t.step(30, s => ({position: s.position, frames: s.frames, seeking: true}));
  t.step(30, {seeking: false});
  assert.deepEqual(t.notices, []);
});
test('large clock jumps, timer suspension and frame counter resets discard stale evidence', () => {
  for (const change of [s => ({position: s.position + 400}), {position: 0}, s => ({at: s.at + 40}), {frames: 0}]) {
    const t = stream(); t.step(15); t.step(5, s => ({frames: s.frames})); t.step(1, change);
    t.step(5, s => ({frames: s.frames})); t.step(20);
    assert.deepEqual(t.notices, []);
  }
});
test('heavy sustained dropped frames are observable without format policy', () => {
  const t = stream(); t.step(15); t.step(20, s => ({frames: s.frames + 12, dropped: s.dropped + 12}));
  assert.deepEqual(t.notices, ['droppedVideo']);
});
test('new loads clear the one-notice limit', () => {
  const t = stream(); t.step(35, s => ({frames: s.frames + 1}));
  t.monitor.reset(); t.step(35, s => ({frames: s.frames + 1}));
  assert.deepEqual(t.notices, ['sparseVideo', 'sparseVideo']);
});
test('observer prefers presented frames to decode totals and cancels stale frame callbacks', () => {
  let at = 0, callback, cancelled = 0;
  const video = {currentTime: 0, paused: false, ended: false, seeking: false, videoWidth: 1280, playbackRate: 1,
    requestVideoFrameCallback(fn) {callback = fn; return 1;}, cancelVideoFrameCallback() {cancelled++;},
    getVideoPlaybackQuality() {return {totalVideoFrames: at * 24, droppedVideoFrames: 0};}};
  const notices = [];
  const observer = new Observer({video: () => video, state: () => 'PLAYING', notify: n => notices.push(n),
    expectedFPS: () => 24, now: () => at});
  observer.tick();
  for (at = 1; at < 40; at++) {
    video.currentTime = at;
    callback(0, {presentedFrames: at}); observer.tick();
  }
  assert.deepEqual(notices, ['sparseVideo']);
  const stale = callback;
  observer.reset(); assert.equal(cancelled, 1);
  observer.tick();
  stale(0, {presentedFrames: 99999});
  assert.equal(observer.presented, null, 'a queued callback from the old load cannot report frames for the new load');
});

test('recorded H.264 plus copied Opus trouble is caught with no dropped frames', () => {
  // Actual Portage-generated HLS/fMP4 on a Cast receiver, 2026-11-21.
  // Only timing/counters are retained: no title, addresses or credentials.
  const samples = require('./fixtures/sparse-video.json');
  const monitor = new Monitor(), notices = [];
  for (const sample of samples) {
    const reason = monitor.sample(sample);
    if (reason) notices.push({at: sample.at, reason});
  }
  assert.equal(notices.length, 1);
  assert.equal(notices[0].reason, 'sparseVideo');
  assert.ok(notices[0].at >= 20 && notices[0].at < 35, 'after the startup grace and sustained bad video, before 35 seconds');
  assert.ok(samples.every(s => s.dropped === 0));
});

const {BufferedStart} = require('../playback-health');
function startup(at = 0) {
  const monitor = new BufferedStart(), updates = [];
  let now = 0;
  const ranges = [[at, at + 30]];
  const video = {currentTime: at, readyState: 4, videoWidth: 1920, playbackRate: 1,
    buffered: {get length() {return ranges.length;}, start: i => ranges[i][0], end: i => ranges[i][1]}};
  monitor.reset('load', at);
  return {monitor, updates, ranges, video, tick(n, {advance = 0, state = 'BUFFERING', hidden = false, dt = 1} = {}) {
    for (let i = 0; i < n; i++) {
      now += dt;
      video.currentTime += advance;
      const update = monitor.sample(video, state, now, hidden);
      if (update) updates.push(update);
    }
  }};
}
test('buffered LG startup at zero and at resume with an initial 117 ms clock advance offers a video-only retry once', () => {
  for (const start of [0, 6, 3900]) {
    const t = startup(start);
    t.tick(1, {state: 'PLAYING'}); t.video.currentTime += 0.117;
    t.tick(12); assert.deepEqual(t.updates, []);
    t.tick(50); assert.deepEqual(t.updates, [{load: 'load', state: 'stalled', position: start + 0.117}]);
    t.tick(4, {advance: 1, state: 'PLAYING'});
    assert.deepEqual(t.updates[1], {load: 'load', state: 'playing'});
    t.tick(30); assert.equal(t.updates.length, 2);
  }
});
test('startup evidence requires contiguous buffered video at the clock and an uninterrupted attempt to play', () => {
  for (const field of ['paused', 'ended', 'seeking', 'hidden', 'audioOnly', 'idle', 'notReady', 'rate', 'short', 'gap', 'suspended']) {
    const t = startup();
    t.tick(9);
    if (field === 'short') t.ranges[0][1] = 1;
    if (field === 'gap') t.ranges[0][0] = 0.5;
    if (field === 'audioOnly') t.video.videoWidth = 0;
    if (field === 'notReady') t.video.readyState = 1;
    if (field === 'rate') t.video.playbackRate = 0;
    t.video[field] = true;
    t.tick(20, {hidden: field === 'hidden', state: field === 'idle' ? 'IDLE' : 'BUFFERING', dt: field === 'suspended' ? 8 : 1});
    t.ranges[0] = [0, 30]; Object.assign(t.video, {[field]: false, videoWidth: 1920, readyState: 4, playbackRate: 1});
    t.tick(8); assert.deepEqual(t.updates, [], field);
    t.tick(5, {advance: 1}); t.tick(30); assert.deepEqual(t.updates, [], field);
  }
});
test('startup detection follows load/seek lifetime and ignores mid-playback stalls', () => {
  const t = startup();
  t.tick(9);
  t.monitor.seek(100); t.video.currentTime = 100; t.ranges[0] = [100, 130];
  t.tick(9); assert.deepEqual(t.updates, []);
  t.monitor.reset('next', 100); t.tick(10); assert.deepEqual(t.updates, []);
  t.tick(8); assert.equal(t.updates[0].load, 'next');
  assert.deepEqual(t.monitor.seek(200), {load: 'next', state: 'cleared'});
  t.monitor.reset(); t.tick(60); assert.equal(t.updates.length, 1);
  const healthy = startup(10);
  healthy.tick(18, {advance: 0.5}); healthy.tick(60);
  assert.deepEqual(healthy.updates, []);
});

test('a stalled resume with only 2.7 seconds buffered offers once, then clears when playback starts', () => {
  const t = startup(5.462);
  t.ranges[0] = [0, 8.162];
  t.video.seeking = true; t.tick(5);
  t.video.seeking = false; t.tick(20);
  assert.deepEqual(t.updates, []);
  t.tick(4); t.tick(30);
  assert.deepEqual(t.updates, [{load: 'load', state: 'stalled', position: 5.462}]);
  t.tick(3, {advance: 0.5});
  assert.equal(t.updates.at(-1).state, 'playing');
});

test('a short buffer still filling during a slow startup waits for playback', () => {
  const t = startup();
  t.ranges[0][1] = 2.1;
  for (let i = 0; i < 45; i++) {
    t.ranges[0][1] += 0.045;
    t.tick(1);
  }
  assert.deepEqual(t.updates, []);
  t.tick(4, {advance: 0.5}); t.tick(40);
  assert.deepEqual(t.updates, []);
});
