'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const receiver = fs.readFileSync(path.join(root, 'receiver.js'), 'utf8');

test('native buffer pressure cannot trigger startup fallback, reload or format recovery', () => {
  const handlers = {}, active = {}, detached = {}, sent = [];
  let cleared = 0;
  const start = receiver.indexOf("  document.addEventListener('portagebufferpressure'");
  const end = receiver.indexOf('  function armLoadWatch()', start);
  vm.runInNewContext(receiver.slice(start, end), {
    document: {addEventListener(name, handler) { handlers[name] = handler; }},
    mediaElement: () => active, clearLoadWatch: () => cleared++, slog() {},
    tellSenders: message => sent.push(JSON.parse(JSON.stringify(message))),
  });
  handlers.portagebufferpressure({composedPath: () => [active, {}]});
  assert.equal(cleared, 1); assert.deepEqual(sent, []);
  handlers.portagebufferfull({composedPath: () => [active, {}]});
  assert.equal(cleared, 2);
  assert.deepEqual(sent.map(m => m.type), ['notice']);
  assert.match(sent[0].reason, /seeking or resuming/);
  for (const handler of Object.values(handlers)) handler({composedPath: () => [detached]});
  assert.equal(cleared, 2); assert.equal(sent.length, 1);
  // Older DOMs without composedPath still identify a direct media target.
  handlers.portagebufferpressure({target: active}); assert.equal(cleared, 3);
});

test('CAF owns loading the vendored player so its readiness promise can settle', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+shaka-player\.portage/);
  const start = receiver.indexOf('  const startOptions = new cast.framework.CastReceiverOptions();');
  let options;
  vm.runInNewContext(receiver.slice(start, receiver.indexOf('context.start(startOptions);', start) + 'context.start(startOptions);'.length), {
    cast: {framework: {CastReceiverOptions: class {}}}, context: {start: value => {options = value;}},
    URL, document: {baseURI: 'https://receiver.example/subdirectory/'},
  });
  assert.notEqual(options.skipShakaLoad, true); assert.equal(options.useShakaForHls, true);
  assert.notEqual(options.skipPlayersLoad, true);
  assert.equal(options.shakaUrl, 'https://receiver.example/subdirectory/vendor/shaka/shaka-player.portage.js?v=2026-11-20.5');
  assert.equal(options.shakaVersion, '4.16.45');
});
