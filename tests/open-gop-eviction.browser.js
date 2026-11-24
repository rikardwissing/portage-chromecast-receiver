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

test('open-GOP buffer eviction stops at independent pictures, not playlist boundaries', {timeout: 60000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portage-open-gop-'));
  let server, browser;
  const ffmpeg = args => {
    const result = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args],
      {cwd: dir, encoding: 'utf8', timeout: 15000});
    assert.equal(result.status, 0, String(result.error || result.stderr));
  };
  try {
    // Non-IDR intra pictures every second, fully independent IDRs every 12s.
    // The copied HLS segments are only 2s long, so segment duration is not a
    // valid upper bound on coded-frame removal's dependency window.
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '12',
      '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-g', '25',
      '-x264-params', 'open-gop=1:scenecut=0', 'part.mp4']);
    fs.writeFileSync(path.join(dir, 'concat.txt'), "file 'part.mp4'\n".repeat(3));
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy',
      '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
      '-hls_segment_filename', 'segment-%d.m4s', 'media.m3u8']);
    server = http.createServer((req, res) => {
      const name = new URL(req.url, 'http://local').pathname;
      if (name === '/') {res.setHeader('Content-Type', 'text/html');res.end('<video id="v" muted></video><script src="/shaka.js"></script><script src="/mp4box.all.min.js"></script><script>window.__dolbySplitActive=true;</script><script src="/video-access.js"></script><script src="/fmp4-split.js"></script>');return;}
      const file = name === '/shaka.js' ? (process.env.SHAKA_BUNDLE || path.join(root, 'vendor/shaka/shaka-player.portage.js')) :
        path.join(name.endsWith('.js') ? root : dir, path.basename(name));
      if (!fs.existsSync(file)) {res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
      res.end(fs.readFileSync(file));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: 'chrome'}),
      headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      window.probe = {removals: [], errors: []};
      const add = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function(type) {
        const sb = add.call(this, type), remove = sb.remove.bind(sb);
        sb.remove = (start, end) => {probe.removals.push({start, end, at: v.currentTime});return remove(start, end);};
        return sb;
      };
      window.__fmp4SplitRegister();shaka.polyfill.installAll();
      window.player = new shaka.Player();await player.attach(v);
      player.configure({abr: {enabled: false}, mediaSource: {forceTransmux: true},
        manifest: {hls: {sequenceMode: false, ignoreManifestTimestampsInSegmentsMode: true}},
        streaming: {bufferingGoal: 4, rebufferingGoal: 1, bufferBehind: 4}});
      player.addEventListener('error', e => probe.errors.push(e.detail.code));
      await player.load('/media.m3u8');probe.source = v.currentSrc;v.playbackRate = 3;await v.play();
    });
    await page.waitForFunction(() => v.currentTime > 32, null, {timeout: 18000});
    const result = await page.evaluate(() => ({...probe, sourceNow: v.currentSrc,
      frames: v.getVideoPlaybackQuality().totalVideoFrames}));
    assert.ok(result.removals.length > 0);
    assert.ok(result.removals.every(r => r.end <= r.at &&
      [0, 12, 24].some(idr => Math.abs(r.end - idr) < 0.1)),
    'removal must stop at encoded IDRs, even when HLS segments and sync flags say otherwise: ' + JSON.stringify(result.removals));
    assert.ok(result.removals.some(r => r.end > 10), 'old data was actually reclaimed');
    assert.equal(result.sourceNow, result.source);assert.ok(result.frames > 200);
    assert.deepEqual(result.errors, []);
  } finally {
    if (browser) await browser.close();
    if (server) {server.closeAllConnections();await new Promise(resolve => server.close(resolve));}
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
