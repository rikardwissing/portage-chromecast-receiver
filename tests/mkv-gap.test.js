'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
global.MediaSource = function () {};
const {MkvEngine} = require('../mkv-engine.js');
function ranges(start, end) {
  return {length: 1, start: () => start, end: () => end};
}
test('a moving playhead or pending fetch never skips the missing open GOP', () => {
  let position = 3216.17, refills = [], hops = [];
  const video = {access: {}, sb: {buffered: ranges(3217.92, 3266.60)}};
  const engine = Object.assign(Object.create(MkvEngine.prototype), {
    demux: {durationMs: () => 3400000, cues: [{}]}, videoLane_: video, lanes: {video, audio: {sb: {buffered: ranges(3158.27, 3267.46)}}},
    getTime: () => position, lastFetchDoneAt: 0, log() {},
    repump_: t => refills.push(t), seekTo: t => hops.push(t)
  });
  engine.stallCheck_();
  position = 3216.21;
  engine.stallCheck_();
  engine.inflightAbort = {};
  engine.stallCheck_();
  assert.deepEqual(refills, []); assert.deepEqual(hops, []);
  engine.inflightAbort = null;
  engine.stallCheck_();
  assert.deepEqual(refills, [position]); assert.deepEqual(hops, []);
  video.sb.buffered = ranges(3203.16, 3266.60);
  engine.stallCheck_();
  assert.deepEqual(hops, []);
});
