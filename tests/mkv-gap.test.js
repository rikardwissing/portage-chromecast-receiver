'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
global.MediaSource = function () {};
const {MkvEngine, MkvDemuxer} = require('../mkv-engine.js');

function ranges(...spans) {
  return {length: spans.length, start: i => spans[i][0], end: i => spans[i][1]};
}

function cluster(pts, idr) {
  const nal = [0, 0, 0, 2, idr ? 0x65 : 0x41, 0x80];
  const block = [0x81, 0, 0, 0x80, ...nal];
  const timestamp = Buffer.alloc(4);
  timestamp.writeUInt32BE(pts);
  const body = [0xe7, 0x84, ...timestamp, 0xa3, 0x80 + block.length, ...block];
  return Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x80 + body.length, ...body]);
}

function movie(count, spacing, idrs = [0]) {
  const demux = new MkvDemuxer();
  demux.timestampScale = 1000000;
  demux.firstClusterOffset = 400;
  const lane = {track: {type: 1, number: 1}, access: {avc: true, length: 4}, clusterAccess: {}};
  const clusters = Array.from({length: count}, (_, i) => cluster(i * spacing, idrs.includes(i)));
  const cues = clusters.map((part, i) => ({timeMs: i * spacing, clusterOffset: 400 + part.length * i}));
  demux.cues = cues;
  const bytes = Buffer.concat([Buffer.alloc(400), ...clusters]);
  const reads = [], pumps = [];
  const engine = Object.assign(Object.create(MkvEngine.prototype), {
    demux, videoLane_: lane, generation: 1, totalBytes: bytes.length,
    pump_(offset, landing) { pumps.push([offset, landing]); },
    fetchRange_(start, end) {
      reads.push([start, end]);
      return Promise.resolve(bytes.subarray(start, end + 1));
    }
  });
  return {engine, lane, cues, reads, pumps};
}

test('an hour into a single-IDR file, probes stay near the target and use the ordinary video cue', async () => {
  const {engine, cues, reads, pumps} = movie(4000, 1000);
  await engine.pumpFrom_(3600450);
  assert.deepEqual(pumps, [[cues[3600].clusterOffset, null]]);
  assert.ok(reads.length <= 2, String(reads.length));
  assert.ok(reads.every(([start]) => start >= cues[3576].clusterOffset));
  assert.ok(reads.reduce((sum, [a, b]) => sum + b - a + 1, 0) <= 2 * 1024 * 1024 + 64 * 1024);
});

test('a known recent independent picture can be used without a network probe', async () => {
  const {engine, lane, cues, reads, pumps} = movie(4000, 1000);
  lane.clusterAccess[cues[3582].clusterOffset] = 3582000;
  await engine.pumpFrom_(3600450);
  assert.deepEqual(pumps, [[cues[3582].clusterOffset, null]]);
  assert.equal(reads.length, 0);
});

test('a cold seek finds an independent picture eighteen seconds behind the requested cue', async () => {
  const {engine, cues, reads, pumps} = movie(4000, 1000, [0, 3582]);
  await engine.pumpFrom_(3600450);
  assert.deepEqual(pumps, [[cues[3582].clusterOffset, null]]);
  assert.equal(reads.length, 2);
});

test('widely spaced cluster offsets cannot exhaust the probe byte budget', async () => {
  const {engine, cues, reads, pumps} = movie(40, 1000);
  cues.forEach((cue, i) => { cue.clusterOffset += i * 3 * 1024 * 1024; });
  engine.totalBytes = cues.at(-1).clusterOffset + 1024;
  await engine.pumpFrom_(30450);
  assert.deepEqual(pumps, [[cues[30].clusterOffset, null]]);
  assert.deepEqual(reads, [[cues[30].clusterOffset, cues[30].clusterOffset + 65535]]);
});

test('a distant sole cue uses the existing uncued seek and waits for a video keyframe', async () => {
  const {engine, pumps, reads} = movie(1, 1000);
  engine.estimateOffset_ = async ms => { assert.equal(ms, 3600000); return 760000; };
  await engine.pumpFrom_(3600000);
  assert.deepEqual(pumps, [[760000, 3600000]]);
  assert.deepEqual(reads, []);
});

test('eviction prefers a nearby independent picture and releases played ordinary keyframes on sparse encodes', () => {
  const engine = Object.create(MkvEngine.prototype);
  const lane = {access: {}, sb: {buffered: ranges([0, 100])}, accessTimes: {0: true, 12: false, 16: true, 18: false, 70: false, 80: false}};
  assert.deepEqual(engine.staleRanges_(lane, 28), [[0, 15.999]]);
  assert.deepEqual(engine.staleRanges_(lane, 90), [[0, 79.999]]);
  lane.sb.buffered = ranges([60, 100]);
  assert.deepEqual(engine.staleRanges_(lane, 90), [[60, 79.999]]);
  assert.deepEqual(Object.keys(lane.accessTimes), ['70', '80']);
});

test('a small full buffer releases a played cue before the playhead runs dry', () => {
  const engine = Object.create(MkvEngine.prototype);
  const lane = {access: {}, sb: {buffered: ranges([0, 8])}, accessTimes: {0: true, 3: false, 5: false, 7: false}};
  assert.deepEqual(engine.staleRanges_(lane, 5), []);
  assert.deepEqual(engine.staleRanges_(lane, 7.5), [[0, 4.999]]);
});

function stalled(video, audio) {
  const hops = [], repumps = [];
  const engine = Object.assign(Object.create(MkvEngine.prototype), {
    getTime: () => 45, demux: {durationMs: () => 3600000, cues: [{}]},
    videoLane_: {access: {}}, lanes: {video: {track: {type: 1}, sb: {buffered: video}}, audio: {track: {type: 2}, sb: {buffered: audio}}},
    log() {}, lastFetchDoneAt: 0, seekTo: t => hops.push(t), repump_: t => repumps.push(t)
  });
  return {engine, hops, repumps};
}

test('a genuine gap hops on the first watchdog tick even during a slow upload', () => {
  const {engine, hops, repumps} = stalled(ranges([46.5, 60]), ranges([43, 60]));
  engine.inflightAbort = {};
  engine.lastFetchDoneAt = Date.now();
  engine.stallCheck_();
  assert.deepEqual(hops, [46.55]);
  assert.deepEqual(repumps, []);
});

test('an empty stalled buffer repumps on the first eligible check', () => {
  const {engine, hops, repumps} = stalled(ranges(), ranges());
  engine.stallCheck_();
  assert.deepEqual(repumps, [45]);
  assert.deepEqual(hops, []);
});
