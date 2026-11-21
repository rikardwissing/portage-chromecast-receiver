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
