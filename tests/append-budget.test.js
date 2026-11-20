'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {test} = require('node:test');

function fixture() {
  let now = 0;
  const timers = new Set();
  const events = [];
  const video = {currentTime: 0, paused: false, pause() { this.paused = true; },
    dispatchEvent(event) { events.push(event.type); }};
  class ShakaError extends Error {
    constructor(severity, category, code) { super(String(code)); this.code = code; }
  }
  ShakaError.Code = {QUOTA_EXCEEDED_ERROR: 3017, OPERATION_ABORTED: 7001};
  ShakaError.Severity = {RECOVERABLE: 1};
  ShakaError.Category = {PLAYER: 7};
  const scope = {goog: {provide() {}, require() {}}, Uint8Array, ArrayBuffer,
    Date: {now: () => now}, CustomEvent: class { constructor(type) { this.type = type; } },
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); },
    shaka: {media: {}, util: {Error: ShakaError, Timer: class {
      constructor(fn) { this.fn = fn; }
      tickAfter() { timers.add(this.fn); return this; }
      stop() { timers.delete(this.fn); }
    }, BufferUtils: {toUint8(data) {
      return ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    }}}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../vendor/shaka/append_budget.js'), 'utf8'), scope);
  const budget = new scope.shaka.media.AppendBudget(video);
  const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
  return {budget, video, timers, events, flush,
    quota() { return new ShakaError(2, 3, 3017); },
    async tick(ms = 150) { now += ms; for (const fn of Array.from(timers)) fn(); await flush(); }};
}

test('large appends preserve every byte, order and typed-array bounds', async () => {
  const f = fixture();
  const backing = new Uint8Array(12 * 1024 * 1024 + 34);
  for (let n = 0; n < backing.length; n++) backing[n] = n % 251;
  const bytes = backing.subarray(17, backing.length - 17);
  const received = [];
  let inFlight = false;
  await f.budget.append(bytes, async piece => {
    assert.equal(inFlight, false); inFlight = true;
    assert.ok(piece.byteLength <= 4 * 1024 * 1024);
    assert.equal(piece.buffer, backing.buffer, 'slice is a view, not a second movie-sized allocation');
    await Promise.resolve(); received.push(Buffer.from(piece)); inFlight = false;
  }, f.budget.generation());
  assert.deepEqual(Buffer.concat(received), Buffer.from(bytes));
});

test('quota retries only rejected bytes and reduces the append size', async () => {
  const f = fixture(), bytes = new Uint8Array(5 * 1024 * 1024 + 77).fill(42);
  let accepted = 0, quotaCount = 0;
  await f.budget.append(bytes, async piece => {
    if (piece.length > 256 * 1024) { quotaCount++; throw f.quota(); }
    assert.equal(piece.byteOffset, accepted); accepted += piece.length;
  }, f.budget.generation());
  assert.equal(accepted, bytes.length); assert.ok(quotaCount > 0);
  assert.deepEqual(f.events, ['portagebufferpressure']);
});

test('a genuine native error is propagated without pretending the append succeeded', async () => {
  const f = fixture(), error = new Error('decode failure');
  await assert.rejects(f.budget.append(new Uint8Array(10), async () => { throw error; }, 0), e => e === error);
  assert.equal(f.timers.size, 0);
});

test('pause holds pending bytes; resume continues without a reload or lost tail', async () => {
  const f = fixture(); f.video.paused = true;
  let room = false, total = 0;
  const done = f.budget.append(new Uint8Array(100000), async piece => {
    if (!room) throw f.quota(); total += piece.length;
  }, 0);
  await f.flush(); await f.tick(120000);
  assert.deepEqual(f.events, ['portagebufferpressure']); assert.equal(total, 0);
  f.video.paused = false; f.video.currentTime = 1; room = true;
  await f.tick(); await done;
  assert.equal(total, 100000); assert.equal(f.timers.size, 0);
});

test('playing without buffer progress reports once and preserves play intent', async () => {
  const f = fixture();
  const pending = f.budget.append(new Uint8Array(1), async () => { throw f.quota(); }, 0);
  await f.flush(); await f.tick(15000);
  assert.equal(f.video.paused, false); assert.deepEqual(f.events, ['portagebufferpressure', 'portagebufferfull']);
  await f.tick(60000); assert.equal(f.events.length, 2);
  const cancelled = assert.rejects(pending, e => e.code === 7001);
  f.budget.cancel(); await cancelled; assert.equal(f.timers.size, 0);
});

test('quota can reclaim played media and retry only the unaccepted tail', async () => {
  const f = fixture(); let accepted = 0, room = false, recoveries = 0;
  const bytes = new Uint8Array(5 * 1024 * 1024).fill(13);
  await f.budget.append(bytes, async piece => {
    assert.equal(piece.byteOffset, accepted);
    if (accepted && !room) throw f.quota();
    accepted += piece.length;
  }, 0, async () => { recoveries++; room = true; return true; });
  assert.equal(recoveries, 1); assert.equal(accepted, bytes.length);
  assert.equal(f.timers.size, 0); assert.equal(f.video.paused, false);
});

test('unsuccessful eviction waits rather than spinning or changing play state', async () => {
  const f = fixture(); let recoveries = 0;
  const pending = f.budget.append(new Uint8Array(1), async () => {throw f.quota();}, 0,
    async () => { recoveries++; return false; });
  await f.flush(); assert.equal(recoveries, 1); assert.equal(f.timers.size, 1);
  await f.tick(); assert.equal(recoveries, 2);
  const cancelled = assert.rejects(pending, e => e.code === 7001);
  f.budget.cancel(); await cancelled;
});

test('seek during asynchronous eviction cancels the old bytes before retry', async () => {
  const f = fixture(); let finishEviction, appends = 0;
  const pending = f.budget.append(new Uint8Array(1), async () => {appends++; throw f.quota();}, 0,
    () => new Promise(resolve => {finishEviction = resolve;}));
  await f.flush(); const cancelled = assert.rejects(pending, e => e.code === 7001);
  f.budget.cancel(); finishEviction(true); await cancelled;
  assert.equal(appends, 1); assert.equal(f.video.paused, false);
});

test('advancing playback resets the no-progress deadline', async () => {
  const f = fixture(); let room = false;
  const pending = f.budget.append(new Uint8Array(1), async () => { if (!room) throw f.quota(); }, 0);
  await f.flush(); await f.tick(14000);
  f.video.currentTime = 2; await f.tick(14000);
  assert.deepEqual(f.events, ['portagebufferpressure']);
  room = true; await f.tick(); await pending;
});

test('seek/unload cancels quota waits immediately; a replacement generation can append', async () => {
  const f = fixture(); let staleBytes = 0;
  const pending = f.budget.append(new Uint8Array(90000), async () => { staleBytes++; throw f.quota(); }, 0);
  await f.flush(); const attempts = staleBytes;
  const cancelled = assert.rejects(pending, e => e.code === 7001);
  f.budget.cancel(); await cancelled; await f.tick();
  assert.equal(staleBytes, attempts); assert.equal(f.timers.size, 0);
  let nextBytes = 0;
  await f.budget.append(new Uint8Array(20), async p => { nextBytes += p.length; }, f.budget.generation());
  assert.equal(nextBytes, 20);
});

test('cancelling during a native append waits for it, then never appends the old tail', async () => {
  const f = fixture(); let complete, calls = 0;
  const pending = f.budget.append(new Uint8Array(9 * 1024 * 1024), () => {
    calls++; return new Promise(resolve => { complete = resolve; });
  }, 0);
  const cancelled = assert.rejects(pending, e => e.code === 7001);
  f.budget.cancel(); complete(); await cancelled;
  assert.equal(calls, 1);
});
