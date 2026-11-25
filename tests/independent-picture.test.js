'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../fmp4-split.js'), 'utf8');
const independent = vm.runInNewContext(source.slice(source.indexOf('  function independentPicture('),
  source.indexOf('  class Fmp4SplitTransmuxer')) + '\nindependentPicture;', {independentNalPicture: require('../mkv-engine.js').independentNalPicture});
function sample(codec, nal, lengthSize = 4) {
  const data = new Uint8Array(lengthSize + 2);data[lengthSize - 1] = 2;data[lengthSize] = nal;
  return {is_sync: true, description: {[codec]: {lengthSizeMinusOne: lengthSize - 1}}, data};
}
test('an AVC sync flag cannot turn a non-IDR intra picture into an independent picture', () => {
  assert.equal(independent(sample('avcC', 0x41)), false);
  for (const size of [1, 2, 4]) assert.equal(independent(sample('avcC', 0x65, size)), true);
});
test('HEVC random access types and unknown or malformed samples are handled explicitly', () => {
  for (let type = 16; type <= 21; type++) assert.equal(independent(sample('hvcC', type << 1)), true);
  for (const type of [1, 8, 9, 22, 32]) assert.equal(independent(sample('hvcC', type << 1)), false);
  assert.equal(independent({description: {}, data: new Uint8Array(4)}), null);
  const broken = sample('avcC', 0x65);broken.data[3] = 10;
  assert.equal(independent(broken), false);
});
