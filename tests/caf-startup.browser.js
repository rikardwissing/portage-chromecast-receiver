'use strict';
// Exercise the actual CAF loader and player, not a mock of receiver options.
// Requires Chrome, ffmpeg and access to Google's CAF SDK (or CAF_SCRIPT).
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const root = path.resolve(__dirname, '..');
const sdk = 'https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js';

test('CAF cold and cached HLS loads reach moving frames with the pinned player', {timeout: 60000}, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'portage-caf-'));
  let browser, server;
  try {
    const caf = process.env.CAF_SCRIPT ? fs.readFileSync(process.env.CAF_SCRIPT) : await (async () => {
      const response = await fetch(sdk, {signal: AbortSignal.timeout(15000)});
      assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer());
    })();
    const result = spawnSync(process.env.FFMPEG || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '16',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '50',
      '-c:a', 'aac', '-b:a', '128k', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-hls_segment_type', 'fmp4', '-hls_segment_filename', path.join(fixture, 'segment-%d.m4s'),
      path.join(fixture, 'media.m3u8'),
    ], {encoding: 'utf8', timeout: 15000});
    assert.equal(result.status, 0, String(result.error || result.stderr));
    const requests = [];
    server = http.createServer(async (req, res) => {
      const name = new URL(req.url, 'http://local').pathname;
      requests.push(name);
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (name === '/caf.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(caf); return; }
      if (name === '/master.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.42c00c,mp4a.40.2",RESOLUTION=320x180\nmedia.m3u8\n'); return;
      }
      const media = /^\/(media\.m3u8|init\.mp4|segment-\d+\.m4s)$/.test(name);
      const file = path.join(media ? fixture : root, name === '/' ? 'index.html' : name);
      if (!fs.existsSync(file)) {res.writeHead(404); res.end(); return;}
      let body = fs.readFileSync(file);
      if (name === '/') body = body.toString().replace(sdk, '/caf.js');
      // Delay the first Shaka response so LOAD actually arrives while CAF is
      // waiting for the library. It must wait, then fetch media and decode.
      if (name.includes('shaka-player.portage')) await new Promise(resolve => setTimeout(resolve, 300));
      res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.html') ? 'text/html' : file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
      res.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: 'chrome'}),
      headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
    const page = await browser.newPage();
    const errors = [], playerRequests = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('request', r => {if (/shaka-player.*\.js/.test(r.url())) playerRequests.push(r.url());});
    await page.goto(`http://127.0.0.1:${server.address().port}/`, {waitUntil: 'domcontentloaded'});
    for (const start of [0, 6]) {
      await page.evaluate(start => {
        const manager = cast.framework.CastReceiverContext.getInstance().getPlayerManager();
        manager.load({type: 'LOAD', requestId: start + 1, autoplay: true, currentTime: start,
          media: {contentId: location.origin + '/master.m3u8', contentType: 'application/vnd.apple.mpegurl',
            streamType: 'BUFFERED', customData: {madeStream: true, streamCodecs: 'avc1.42c00c,mp4a.40.2', streamContainer: 'fmp4'}}});
      }, start);
      await page.waitForFunction(start => {
        const video = document.querySelector('cast-media-player').shadowRoot.querySelector('video');
        return video.currentTime > start + 1 && video.getVideoPlaybackQuality().totalVideoFrames > 15 && !video.paused;
      }, start, {timeout: 12000});
      assert.equal(await page.evaluate(() => shaka.Player.version), 'v4.16.45-portage2');
    }
    assert.equal(playerRequests.length, 1, 'CAF loads the pinned player once, including across repeat LOAD');
    assert.ok(playerRequests[0].includes('/vendor/shaka/shaka-player.portage.js'));
    assert.ok(requests.includes('/master.m3u8'));
    assert.ok(requests.some(name => /segment-\d+\.m4s/.test(name)));
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(fixture, {recursive: true, force: true});
  }
});
