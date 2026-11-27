'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const receiver = fs.readFileSync(path.join(__dirname, '..', 'receiver.js'), 'utf8');

function clock(shift, buffers) {
  const start = receiver.indexOf('  pictureClock() {');
  const end = receiver.indexOf('  clear() {', start);
  const context = vm.createContext({window: {__sourceBuffers: buffers}});
  return vm.runInContext('({timelineShift: ' + shift + ',\n' + receiver.slice(start, end) + '})', context).pictureClock();
}

test('picture subtitles follow the served media clock in both Shaka modes', () => {
  const sequence = [{kind: 'video', buffer: {timestampOffset: -2.856}}];
  const segments = [{kind: 'audio', buffer: {timestampOffset: 0}}, {kind: 'video', buffer: {timestampOffset: 0}}];
  assert.ok(Math.abs(26.88 + clock(2.856, segments) - 24.024) < 1e-9, 'segments mode keeps media time, which runs ahead by the shift');
  assert.ok(Math.abs(24.024 + clock(2.856, sequence) - 24.024) < 1e-9, 'sequence mode already rebased the media to playlist time');
});

test('loads without a served shift keep the element clock', () => {
  assert.equal(clock('NaN', [{kind: 'video', buffer: {timestampOffset: -9.956}}]), 0);
  assert.equal(clock(2.856, []), -2.856);
});
