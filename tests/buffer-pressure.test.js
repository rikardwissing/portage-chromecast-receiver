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
  const start = receiver.indexOf('  let bufferFullReported = false;');
  const end = receiver.indexOf('  function armLoadWatch()', start);
  const context = vm.createContext({
    document: {addEventListener(name, handler) { handlers[name] = handler; }},
    mediaElement: () => active, clearLoadWatch: () => cleared++, slog() {},
    tellSenders: message => sent.push(JSON.parse(JSON.stringify(message))),
    teardownEngine() {}, clearSteppingDown() {}, playbackHealth: {reset() {}},
  });
  vm.runInContext(receiver.slice(start, end).replace(/  let loadWatch = null;[\s\S]*?window\.tvHelpers\.bufferPressure = clearLoadWatch;/, ''), context);
  handlers.portagebufferpressure({composedPath: () => [active, {}]});
  assert.equal(cleared, 1); assert.deepEqual(sent, []);
  handlers.portagebufferfull({composedPath: () => [active, {}]});
  assert.equal(cleared, 2);
  assert.deepEqual(sent.map(m => m.type), ['notice']);
  assert.deepEqual(sent[0], {type: 'notice', code: 'bufferFull',
    reason: 'This receiver’s playback buffer is full. A lower video bitrate may help.'});
  handlers.portagebufferfull({target: active});
  assert.equal(cleared, 3); assert.equal(sent.length, 1, 'audio/video and repeated appends share one suggestion per load');
  for (const handler of Object.values(handlers)) handler({composedPath: () => [detached]});
  assert.equal(cleared, 3); assert.equal(sent.length, 1);
  // Older DOMs without composedPath still identify a direct media target.
  handlers.portagebufferpressure({target: active}); assert.equal(cleared, 4);
  // Exercise the real LOAD reset, including when reloading the same title.
  const load = receiver.indexOf('  playerManager.setMessageInterceptor(messages.MessageType.LOAD, (request) => {');
  const body = receiver.indexOf('    teardownEngine();', load);
  vm.runInContext(receiver.slice(body, receiver.indexOf('    const media =', body)), context);
  handlers.portagebufferfull({target: active});
  assert.equal(sent.length, 2, 'a new explicit load can offer the suggestion again');
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
  assert.equal(options.shakaUrl, 'https://receiver.example/subdirectory/vendor/shaka/shaka-player.portage.js?v=2026-11-20.9');
  assert.equal(options.shakaVersion, '4.16.45');
});
