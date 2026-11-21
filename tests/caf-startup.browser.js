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

test('CAF starts copied HLS and preserves encoded timestamps across rounded playlist durations', {timeout: 90000}, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'portage-caf-'));
  let browser, server;
  try {
    const caf = process.env.CAF_SCRIPT ? fs.readFileSync(process.env.CAF_SCRIPT) : await (async () => {
      const response = await fetch(sdk, {signal: AbortSignal.timeout(15000)});
      assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer());
    })();
    const result = spawnSync(process.env.FFMPEG || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '45',
      '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-g', '50', '-bf', '3',
      '-c:a', 'aac', '-b:a', '128k', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-hls_segment_type', 'fmp4', '-hls_segment_filename', path.join(fixture, 'segment-%d.m4s'),
      path.join(fixture, 'media.m3u8'),
    ], {encoding: 'utf8', timeout: 15000});
    assert.equal(result.status, 0, String(result.error || result.stderr));
    const init = fs.readFileSync(path.join(fixture, 'init.mp4'));
    const avcC = init.indexOf(Buffer.from('avcC'));
    assert.ok(avcC > 0);
    const codecs = 'avc1.' + init.subarray(avcC + 5, avcC + 8).toString('hex') + ',mp4a.40.2';
    // Playlist rounding must not move the already-continuous encoded A/V.
    let segment = 0;
    const playlist = path.join(fixture, 'media.m3u8');
    fs.writeFileSync(playlist, fs.readFileSync(playlist, 'utf8').replace(/#EXTINF:([\d.]+)/g,
      (_, duration) => '#EXTINF:' + (Number(duration) + (segment++ % 2 ? -0.05 : 0.05)).toFixed(6)));
    const requests = [];
    server = http.createServer(async (req, res) => {
      const name = new URL(req.url, 'http://local').pathname;
      requests.push(name);
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (name === '/caf.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(caf); return; }
      if (name === '/master.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="' + codecs + '",RESOLUTION=320x180\nmedia.m3u8\n'); return;
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
    await page.addInitScript(() => {
      window.offsetWrites = [];
      // Keep real decoding/playback, but model the field symptom: the
      // compositor presents one frame per second while the media clock moves.
      const frame = HTMLVideoElement.prototype.requestVideoFrameCallback;
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
        return frame.call(this, (at, metadata) => callback(at, {...metadata,
          presentedFrames: Math.floor(metadata.mediaTime)}));
      };
      const native = Object.getOwnPropertyDescriptor(SourceBuffer.prototype, 'timestampOffset');
      Object.defineProperty(SourceBuffer.prototype, 'timestampOffset', {...native,
        set(value) {native.set.call(this, value);window.offsetWrites.push(value);}});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, {waitUntil: 'domcontentloaded'});
    await page.evaluate(() => {
      const context = cast.framework.CastReceiverContext.getInstance();
      const manager = context.getPlayerManager();
      window.advisories = []; window.playbackCommands = [];
      context.sendCustomMessage = (_, __, message) => { window.advisories.push(message); };
      for (const method of ['load', 'stop']) {
        const original = manager[method].bind(manager);
        manager[method] = (...args) => {window.playbackCommands.push(method); return original(...args);};
      }
    });
    for (const start of [0, 6]) {
      await page.evaluate(({start, codecs}) => {
        window.offsetWrites = [];
        const manager = cast.framework.CastReceiverContext.getInstance().getPlayerManager();
        manager.load({type: 'LOAD', requestId: start + 1, autoplay: true, currentTime: start,
          media: {contentId: location.origin + '/master.m3u8', contentType: 'application/vnd.apple.mpegurl',
            streamType: 'BUFFERED', customData: {frameRate: 25, madeStream: true, copiedPicture: true, streamCodecs: codecs, streamContainer: 'fmp4'}}});
      }, {start, codecs});
      await page.waitForFunction(start => {
        const video = document.querySelector('cast-media-player').shadowRoot.querySelector('video');
        return video.currentTime > start + 4 && video.getVideoPlaybackQuality().totalVideoFrames > 75 && !video.paused;
      }, start, {timeout: 12000});
      assert.equal(await page.evaluate(() => shaka.Player.version), 'v4.16.45-portage5');
      const offsets = await page.evaluate(() => window.offsetWrites);
      assert.ok(offsets.every(value => Math.abs(value) < 0.001),
        'continuous media must not be retimed at each rounded playlist boundary: ' + offsets);
      if (start === 0) {
        await page.waitForFunction(() => window.advisories.some(m => m.code === 'playbackTrouble'), null, {timeout: 25000});
        const health = await page.evaluate(() => {
          const manager = cast.framework.CastReceiverContext.getInstance().getPlayerManager();
          const video = document.querySelector('cast-media-player').shadowRoot.querySelector('video');
          return {notices: window.advisories.filter(m => m.code === 'playbackTrouble'),
            commands: window.playbackCommands, time: video.currentTime, paused: video.paused,
            media: manager.getMediaInformation()};
        });
        assert.deepEqual(health.notices, [{type: 'notice', code: 'playbackTrouble',
          reason: 'Video or audio not playing smoothly? Try adjusting quality settings.'}]);
        assert.deepEqual(health.commands, ['load'], 'only the test initiated LOAD; the observer never controls playback');
        assert.ok(health.time > 15); assert.equal(health.paused, false);
        assert.equal(health.media.customData.streamCodecs, codecs);
        assert.ok(health.media.contentId.endsWith('/master.m3u8'));
      }
      // The real CAF shadow-DOM video must reach the advisory handler without
      // invoking LOAD/STOP or changing the selected stream. The append-budget
      // tests separately exercise the 15-second quota deadline and pause guard.
      const advisory = await page.evaluate(() => {
        const context = cast.framework.CastReceiverContext.getInstance();
        const manager = context.getPlayerManager();
        const video = document.querySelector('cast-media-player').shadowRoot.querySelector('video');
        const source = video.currentSrc, media = JSON.stringify(manager.getMediaInformation());
        const before = video.currentTime;
        const sent = [], calls = [];
        const send = context.sendCustomMessage, load = manager.load, stop = manager.stop;
        context.sendCustomMessage = (namespace, sender, message) => sent.push(message);
        manager.load = () => calls.push('load');
        manager.stop = () => calls.push('stop');
        try {
          const fire = (target, type) => target.dispatchEvent(new CustomEvent(type, {bubbles: true, composed: true}));
          const detached = document.createElement('video');
          document.body.appendChild(detached);
          fire(detached, 'portagebufferfull'); detached.remove();
          fire(video, 'portagebufferpressure');
          const transient = sent.length;
          fire(video, 'portagebufferfull'); fire(video, 'portagebufferfull');
          return {sent, transient, calls, before, source, currentSource: video.currentSrc,
            sameMedia: media === JSON.stringify(manager.getMediaInformation()), paused: video.paused};
        } finally {
          context.sendCustomMessage = send; manager.load = load; manager.stop = stop;
        }
      });
      assert.equal(advisory.transient, 0, 'detached events and temporary pressure stay silent');
      assert.deepEqual(advisory.sent.filter(message => message.type !== 'log'), [{type: 'notice', code: 'bufferFull',
        reason: 'This receiver’s playback buffer is full. A lower video bitrate may help.'}]);
      assert.deepEqual(advisory.calls, []);
      assert.equal(advisory.currentSource, advisory.source);
      assert.equal(advisory.sameMedia, true, 'URL, selected codec and quality metadata stay intact');
      assert.equal(advisory.paused, false);
      await page.waitForFunction(before => document.querySelector('cast-media-player').shadowRoot.querySelector('video').currentTime > before + 0.3,
        advisory.before, {timeout: 3000});
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
