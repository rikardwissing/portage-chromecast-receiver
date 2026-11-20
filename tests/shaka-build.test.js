'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {test} = require('node:test');
test('vendored build matches the pinned patch, helper and compiler lockfile', () => {
  const root = path.resolve(__dirname, '../vendor/shaka');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'build.json')));
  assert.equal(manifest.upstream, '889d6b76de168e75bb306c5ad442d7a79ee09e68');
  assert.equal(manifest.version, 'v4.16.45-portage1');
  for (const [name, expected] of Object.entries(manifest.sha256)) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'), expected, name + ': rebuild the player after changing its source');
  }
});
