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

test('quota eviction releases played media; seeking after a full-buffer notice preserves play intent', {timeout: 80000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portage-eviction-'));
  let server, browser;
  try {
    const result = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=sample_rate=48000',
      '-t', '50', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
      '-hls_segment_filename', path.join(dir, 'segment-%d.m4s'), path.join(dir, 'media.m3u8')],
    {encoding: 'utf8', timeout: 15000});
    assert.equal(result.status, 0, String(result.error || result.stderr));
    server = http.createServer((req, res) => {
      const name = new URL(req.url, 'http://local').pathname;
      if (name === '/') {res.setHeader('Content-Type', 'text/html');res.end('<video id="v" muted></video><script src="/shaka.js"></script>');return;}
      const file = name === '/shaka.js' ? path.join(root, 'vendor/shaka/shaka-player.portage.js') : path.join(dir, path.basename(name));
      if (!fs.existsSync(file)) {res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
      res.end(fs.readFileSync(file));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: 'chrome'}),
      headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      window.probe = {quota: 0, removals: [], notices: 0, blockAll: false, forceEviction: true, errors: []};
      const add = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function(type) {
        const sb = add.call(this, type), append = sb.appendBuffer.bind(sb), remove = sb.remove.bind(sb);
        if (type.startsWith('video/')) {
          sb.appendBuffer = bytes => {
            // Model a renderer that cannot reclaim old data on append. Only
            // a real native remove can release this injected quota condition.
            if (probe.blockAll || (probe.forceEviction && v.currentTime >= 6 && sb.buffered.length && sb.buffered.start(0) < 2)) {
              probe.quota++; throw new DOMException('Full media buffer', 'QuotaExceededError');
            }
            return append(bytes);
          };
          sb.remove = (start, end) => {probe.removals.push({start, end, at: v.currentTime});return remove(start, end);};
        }
        return sb;
      };
      document.addEventListener('portagebufferfull', () => probe.notices++);
      shaka.polyfill.installAll();window.player = new shaka.Player();await player.attach(v);
      player.configure({abr: {enabled: false}, streaming: {bufferingGoal: 8, rebufferingGoal: 1, bufferBehind: 30}});
      player.addEventListener('error', e => probe.errors.push(e.detail.code));
      await player.load('/media.m3u8');probe.source = v.currentSrc;v.playbackRate = 2;await v.play();
    });
    await page.waitForFunction(() => probe.quota > 0 && v.currentTime > 20, null, {timeout: 20000});
    const recovered = await page.evaluate(() => ({...probe, paused: v.paused}));
    assert.ok(recovered.removals.length > 0);
    assert.ok(recovered.removals.every(r => r.end <= r.at - 2), 'keep the segment/keyframe safety margin');
    assert.equal(recovered.notices, 0); assert.equal(recovered.paused, false);
    await page.evaluate(() => {probe.forceEviction = false;probe.blockAll = true;});
    await page.waitForFunction(() => probe.notices > 0, null, {timeout: 30000});
    assert.equal(await page.evaluate(() => v.paused), false, 'buffer pressure cannot silently pause Cast');
    const beforeSeek = await page.evaluate(() => v.getVideoPlaybackQuality().totalVideoFrames);
    await page.evaluate(() => {probe.blockAll = false;v.currentTime = 3;});
    await page.waitForFunction(() => v.currentTime > 6 && !v.paused, null, {timeout: 12000});
    const resumed = await page.evaluate(() => ({source: v.currentSrc, original: probe.source,
      frames: v.getVideoPlaybackQuality().totalVideoFrames, errors: probe.errors}));
    assert.equal(resumed.source, resumed.original); assert.ok(resumed.frames > beforeSeek);
    assert.deepEqual(resumed.errors, []); assert.deepEqual(errors, []);
    await page.evaluate(() => {v.pause();v.currentTime = 16;});
    await page.waitForFunction(() => !v.seeking, null, {timeout: 5000});
    assert.equal(await page.evaluate(() => v.paused), true, 'an intentional pause remains paused across seek');
  } finally {
    if (browser) await browser.close();
    if (server) {server.closeAllConnections();await new Promise(resolve => server.close(resolve));}
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
