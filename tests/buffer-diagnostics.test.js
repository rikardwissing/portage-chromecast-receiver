'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('buffer diagnostics record removals and quota errors without changing native results', () => {
  const source = fs.readFileSync(path.join(__dirname, '../receiver.js'), 'utf8');
  const quota = new Error('full');quota.name = 'QuotaExceededError';
  const calls = [];
  const buffer = {buffered: {length: 1, start: () => 4, end: () => 12},
    appendBuffer(data) {calls.push(data);throw quota;},
    remove(start, end) {calls.push([start, end]);return 'removed';}, abort() {return 'aborted';}};
  class MediaSource {addSourceBuffer() {return buffer;}}
  const scope = vm.createContext({window: {MediaSource}, MediaSource, WeakMap,
    document: {querySelector: type => type === 'video' ? {currentTime: 8} : null}});
  vm.runInContext(source.slice(source.indexOf('function mediaElement()'), source.indexOf('let context = null;')), scope);
  const sb = new MediaSource().addSourceBuffer('video/mp4');
  scope.buffer = sb;
  assert.equal(sb.remove(0, 4), 'removed');assert.equal(sb.abort(), 'aborted');
  const recorded = vm.runInContext('diagnosticBufferOperations.get(buffer)', scope);
  assert.equal(recorded.recent[0].operation, 'remove');
  assert.equal(recorded.recent[0].at, 8);
  assert.equal(recorded.recent[0].end, 4);
  const data = new Uint8Array(100);
  for (let i = 0; i < 20; i++) assert.throws(() => sb.appendBuffer(data), e => e === quota);
  assert.equal(recorded.quota, 20);assert.equal(recorded.aborts, 1);
  assert.equal(recorded.recent.length, 12, 'diagnostics have a bounded footprint');
  assert.ok(recorded.recent.every(entry => entry.operation === 'appendError' && entry.bytes === 100));
  assert.equal(calls.length, 21);
});
