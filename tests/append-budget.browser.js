'use strict';
// Real MSE regression. Requires Chrome and ffmpeg; generates its own media.
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const root = path.resolve(__dirname, '..');

test('real Shaka retains the stream across quota, pause, repeated seeks and unload', {timeout: 180000}, async () => {
  const fixture = process.env.MEDIA_FIXTURE || fs.mkdtempSync(path.join(os.tmpdir(), 'portage-mse-'));
  if (!process.env.MEDIA_FIXTURE) {
    const result = spawnSync(process.env.FFMPEG || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '60',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-b:v', '23M', '-minrate', '23M', '-maxrate', '23M', '-bufsize', '23M',
      '-g', '250', '-keyint_min', '250', '-sc_threshold', '0', '-x264-params', 'nal-hrd=cbr:force-cfr=1',
      '-c:a', 'aac', '-b:a', '128k', '-f', 'hls', '-hls_time', '10', '-hls_playlist_type', 'vod',
      '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(fixture, 'segment-%d.m4s'), path.join(fixture, 'media.m3u8'),
    ], {encoding: 'utf8', timeout: 60000});
    assert.equal(result.status, 0, String(result.error || result.stderr));
  }
  const server = http.createServer((req, res) => {
    const name = req.url.split('?')[0];
    if (name === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<video id="v" muted></video><script src="/shaka.js"></script>'); return; }
    if (name === '/master.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=23128000,CODECS="avc1.42c029,mp4a.40.2",RESOLUTION=320x180\nmedia.m3u8\n'); return;
    }
    const file = name === '/shaka.js' ? path.join(root, 'vendor/shaka/shaka-player.portage.js') : path.join(fixture, path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
    res.setHeader('Content-Length', fs.statSync(file).size); fs.createReadStream(file).pipe(res);
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({
      ...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: 'chrome'}), headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--mse-video-buffer-size-limit-mb=30'],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      window.probe = {quota: 0, appends: 0, errors: [], notices: 0, pressure: 0, presented: 0, types: []};
      const add = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function(type) {
        probe.types.push(type);
        const buffer = add.call(this, type), append = buffer.appendBuffer.bind(buffer);
        buffer.appendBuffer = function(bytes) {
          probe.appends++;
          try { return append(bytes); } catch (e) { if (e.name === 'QuotaExceededError') probe.quota++; throw e; }
        };
        return buffer;
      };
      const frame = () => { probe.presented++; v.requestVideoFrameCallback(frame); };
      v.requestVideoFrameCallback(frame);
      document.addEventListener('portagebufferpressure', () => probe.pressure++);
      document.addEventListener('portagebufferfull', () => probe.notices++);
      shaka.polyfill.installAll();
      window.player = new shaka.Player(); await player.attach(v);
      player.configure({abr: {enabled: false}, manifest: {hls: {sequenceMode: false}}, streaming: {bufferingGoal: 20, rebufferingGoal: 1}});
      player.addEventListener('error', e => probe.errors.push(e.detail.code));
      await player.load('/master.m3u8', 0);
      probe.source = v.currentSrc; probe.track = player.getVariantTracks().find(t => t.active);
      v.playbackRate = 3; await v.play();
    });
    const state = () => page.evaluate(() => ({...probe, time: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames,
      paused: v.paused, source: v.currentSrc, error: v.error && v.error.message,
      track: player.getVariantTracks().find(t => t.active), buffer: player.getBufferedInfo()}));
    await page.waitForFunction(() => probe.quota > 0 && v.currentTime > 3, null, {timeout: 20000});
    const first = await state();
    assert.ok(first.pressure > 0, 'real quota failures reach the receiver watchdog-cancellation event');
    await page.evaluate(() => v.pause());
    await new Promise(resolve => setTimeout(resolve, 1000));
    const paused = await state();
    assert.equal(paused.paused, true); assert.ok(Math.abs(paused.time - first.time) < 0.5);
    assert.equal(paused.notices, 0); assert.deepEqual(paused.errors, []);
    await page.evaluate(() => v.play());
    await page.waitForFunction(() => v.currentTime > 13, null, {timeout: 20000});
    for (const target of [34, 4, 44, 14]) {
      const before = await state();
      await page.evaluate(t => { v.currentTime = t; }, target);
      await page.waitForFunction(({target, frames, presented}) => v.currentTime > target + 3 && v.currentTime < target + 12 &&
        v.getVideoPlaybackQuality().totalVideoFrames > frames + 30 && probe.presented > presented + 15 && !v.seeking,
      {target, frames: before.frames, presented: before.presented}, {timeout: 20000});
      const after = await state();
      assert.equal(after.source, first.source, 'seek retains the MediaSource URL');
      assert.deepEqual(after.track, first.track, 'codec, resolution, variant and bandwidth stay selected');
      assert.deepEqual(after.errors, []); assert.equal(after.error, null); assert.equal(after.notices, 0);
      assert.ok(after.buffer.total.some(r => r.start <= after.time && r.end > after.time), 'both audio and video cover playback');
    }
    await page.evaluate(() => v.pause());
    const quotaBefore = (await state()).quota;
    await page.waitForFunction(n => probe.quota > n, quotaBefore, {timeout: 10000});
    const unloaded = Date.now();
    await page.evaluate(() => player.unload());
    assert.ok(Date.now() - unloaded < 3000, 'unload cancels a pending quota wait promptly');
    await page.evaluate(async () => { await player.load('/master.m3u8', 0); await v.play(); });
    await page.waitForFunction(() => v.currentTime > 3 && v.readyState >= 3, null, {timeout: 20000});
    const last = await state();
    assert.deepEqual(last.errors, []); assert.deepEqual(errors, []);
    console.log(JSON.stringify({version: await page.evaluate(() => shaka.Player.version), nativeQuotaRejections: last.quota,
      decodedFrames: last.frames, types: last.types, repeatedSeeks: 4, reloads: 'explicit unload/load only'}));
    await page.evaluate(() => player.destroy());
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    if (!process.env.MEDIA_FIXTURE) fs.rmSync(fixture, {recursive: true, force: true});
  }
});
