'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const root = path.resolve(__dirname, '..');

test('split muxed streams reclaim old audio even when video was already evicted', {timeout: 45000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portage-muxed-eviction-'));
  let server, browser;
  try {
    const result = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=sample_rate=48000',
      '-t', '36', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(dir, 'segment-%d.ts'), path.join(dir, 'media.m3u8')],
    {encoding: 'utf8', timeout: 15000});
    assert.equal(result.status, 0, String(result.error || result.stderr));
    server = http.createServer((req, res) => {
      const name = new URL(req.url, 'http://local').pathname;
      if (name === '/') {res.setHeader('Content-Type', 'text/html');res.end('<video id="v" muted></video><script src="/shaka.js"></script>');return;}
      const file = name === '/shaka.js' ? (process.env.SHAKA_BUNDLE || path.join(root, 'vendor/shaka/shaka-player.portage.js')) : path.join(dir, path.basename(name));
      if (!fs.existsSync(file)) {res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
      res.end(fs.readFileSync(file));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: 'chrome'}),
      headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      window.probe = {buffers: {}, removals: [], quota: 0, armed: false, errors: []};
      const add = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function(type) {
        const sb = add.call(this, type), append = sb.appendBuffer.bind(sb), remove = sb.remove.bind(sb);
        const kind = type.startsWith('video/') ? 'video' : 'audio';
        probe.buffers[kind] = sb;
        sb.appendBuffer = bytes => {
          // Model independent native eviction: the video buffer discarded
          // its oldest data, while audio still needs explicit reclamation.
          if (kind === 'audio' && probe.armed && sb.buffered.length && sb.buffered.start(0) < 1) {
            probe.quota++; throw new DOMException('Audio buffer full', 'QuotaExceededError');
          }
          return append(bytes);
        };
        sb.remove = (start, end) => {probe.removals.push({kind, start, end, at: v.currentTime});return remove(start, end);};
        return sb;
      };
      shaka.polyfill.installAll();window.player = new shaka.Player();await player.attach(v);
      player.configure({abr: {enabled: false}, mediaSource: {forceTransmux: true},
        streaming: {bufferingGoal: 4, rebufferingGoal: 1, bufferBehind: 30}});
      player.addEventListener('error', e => probe.errors.push(e.detail.code));
      await player.load('/media.m3u8');probe.source = v.currentSrc;v.playbackRate = 2;await v.play();
    });
    await page.waitForFunction(() => v.currentTime > 8 && probe.buffers.video && probe.buffers.audio &&
      !probe.buffers.video.updating && !probe.buffers.audio.updating, null, {timeout: 12000});
    await page.evaluate(async () => {
      const sb = probe.buffers.video;
      await new Promise((resolve, reject) => {
        sb.addEventListener('updateend', resolve, {once: true});
        sb.addEventListener('error', reject, {once: true});
        sb.remove(0, 4);
      });
      probe.videoStart = sb.buffered.start(0);
      probe.audioStart = probe.buffers.audio.buffered.start(0);
      probe.armed = true;
    });
    await page.waitForFunction(() => probe.quota > 0 && v.currentTime > 22, null, {timeout: 18000});
    const resultState = await page.evaluate(() => ({videoStart: probe.videoStart, audioStart: probe.audioStart,
      audioNow: probe.buffers.audio.buffered.start(0), removals: probe.removals,
      source: v.currentSrc, original: probe.source, paused: v.paused, errors: probe.errors}));
    assert.ok(resultState.videoStart >= 4 && resultState.audioStart < 1);
    assert.ok(resultState.audioNow >= 1, 'old audio must actually be removed');
    assert.ok(resultState.removals.some(r => r.kind === 'audio' && r.start < 1));
    assert.ok(resultState.removals.every(r => r.end <= r.at - 2), 'protect the current decoding dependencies');
    assert.equal(resultState.source, resultState.original);
    assert.equal(resultState.paused, false);assert.deepEqual(resultState.errors, []);
  } finally {
    if (browser) await browser.close();
    if (server) {server.closeAllConnections();await new Promise(resolve => server.close(resolve));}
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
