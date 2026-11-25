'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright-core');

async function withMovie(generate, watch, flags = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-mkv-gop-'));
  let browser, server;
  function ffmpeg(args) {
    const run = spawnSync('ffmpeg', ['-loglevel', 'error', ...args], {cwd: dir, encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
  }
  try {
    generate(ffmpeg, dir);
    const mkv = fs.readFileSync(path.join(dir, 'source.mkv'));
    server = http.createServer((req, res) => {
      if (req.url === '/mkv-engine.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(fs.readFileSync(path.join(__dirname, '..', req.url.slice(1)))); return;
      }
      if (req.url === '/source.mkv') {
        const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        const start = range ? Number(range[1]) : 0, end = Math.min(Number(range?.[2] || mkv.length - 1), mkv.length - 1);
        res.writeHead(206, {'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${mkv.length}`});
        res.end(mkv.subarray(start, end + 1)); return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end('<video id="v" muted></video><script src="/mkv-engine.js"></script>');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    browser = await chromium.launch({channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required', ...flags]});
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await watch(page, mkv);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

test('direct MKV resumes inside an open GOP and keeps the playhead through quota eviction', {timeout: 60000}, async () => {
  await withMovie((ffmpeg, dir) => {
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '16',
      '-c:v', 'libx264', '-g', '25', '-x264-params', 'open-gop=1:scenecut=0', 'part.mkv']);
    fs.writeFileSync(path.join(dir, 'parts'), "file 'part.mkv'\n".repeat(3));
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', 'parts', '-f', 'lavfi', '-i', 'sine=sample_rate=48000',
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', 'source.mkv']);
  }, async page => {
    await page.evaluate(() => {
      window.hops = []; window.failures = [];
      window.engine = new MkvEngine('/source.mkv', 0, {startAt: 20.5, getTime: () => v.currentTime,
        seekTo: time => {hops.push(time); v.currentTime = time;}});
      engine.onEngineFailed = message => failures.push(message);
      v.src = engine.objectUrl; v.currentTime = 20.5;
    });
    await page.waitForFunction(() => v.readyState >= 3 && v.buffered.length && v.buffered.start(0) <= 20.5, null, {timeout: 15000});
    await page.evaluate(() => { v.playbackRate = 3; v.play(); });
    await page.waitForFunction(() => v.currentTime > 21.0 && v.getVideoPlaybackQuality().totalVideoFrames > 5);
    await page.waitForFunction(() => v.currentTime >= 28);
    await page.evaluate(() => { v.pause(); });
    const state = await page.evaluate(() => {
      const lane = Object.values(engine.lanes).find(l => l.track.type === 1);
      return {protectedStart: lane.sb.buffered.start(0), evictions: engine.staleRanges_(lane, 28)};
    });
    assert.ok(Math.abs(state.protectedStart - 16) < 0.1, String(state.protectedStart));
    assert.deepEqual(state.evictions, []);
    await page.evaluate(() => {
      engine.destroy();
      window.engine = new MkvEngine('/source.mkv', 0, {getTime: () => v.currentTime,
        seekTo: time => {hops.push(time); v.currentTime = time;}});
      engine.onEngineFailed = message => failures.push(message);
      v.src = engine.objectUrl;
    });
    await page.waitForFunction(() => v.buffered.length && v.buffered.start(0) < 1 && v.buffered.end(0) > 33);
    await page.evaluate(() => { v.playbackRate = 4; v.play(); });
    await page.waitForFunction(() => v.currentTime >= 28);
    await page.evaluate(() => { v.pause(); });
    await page.evaluate(() => {
      const lane = Object.values(engine.lanes).find(l => l.track.type === 1);
      const sb = lane.sb, append = sb.appendBuffer.bind(sb), remove = sb.remove.bind(sb);
      const marker = new Uint8Array(1);
      window.quotaProbe = {attempts: 0, removals: []};
      sb.appendBuffer = bytes => {
        if (bytes !== marker) return append(bytes);
        if (++quotaProbe.attempts === 1) throw new DOMException('Full buffer', 'QuotaExceededError');
        sb.appendBuffer = append;
        sb.remove = remove;
      };
      sb.remove = (from, end) => { quotaProbe.removals.push(end); return remove(from, end); };
      lane.queue.push(marker);
      engine.drain_(lane);
    });
    await page.waitForFunction(() => quotaProbe.attempts === 2, null, {timeout: 5000});
    const removals = await page.evaluate(() => quotaProbe.removals);
    assert.equal(removals.length, 1);
    assert.ok(Math.abs(removals[0] - 16) < 0.1, 'quota removal ends at the preceding IDR: ' + removals);
    await page.evaluate(() => { v.playbackRate = 3; v.play(); });
    await page.waitForFunction(() => v.currentTime > 29);
    assert.deepEqual(await page.evaluate(() => [...hops, ...failures]), []);
  });
});

function singleIDR(ffmpeg) {
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine=sample_rate=48000',
    '-t', '78', '-c:v', 'libx264', '-g', '25', '-x264-params', 'open-gop=1:scenecut=0', '-c:a', 'aac', 'source.mkv']);
}

test('software decoding presents a single-IDR MKV from an ordinary cue', {timeout: 30000}, async () => {
  await withMovie(singleIDR, async (page, mkv) => {
    const {MkvDemuxer, independentNalPicture} = require('../mkv-engine.js');
    const demux = new MkvDemuxer();
    demux.parseHeader(mkv);
    let ordinary = 0, independent = 0;
    const video = demux.tracks.find(track => track.type === 1);
    demux.parseClusters(mkv.subarray(demux.firstClusterOffset), demux.firstClusterOffset, (number, raw) => {
      if (number !== video.number || !raw.keyframe) return;
      ordinary++;
      if (independentNalPicture(raw.data, (video.codecPrivate[4] & 3) + 1, true)) independent++;
    });
    assert.equal(independent, 1);
    assert.ok(ordinary > 70);
    await page.evaluate(() => {
      window.frames = []; window.failures = [];
      function presented(now, frame) { frames.push(frame.mediaTime); v.requestVideoFrameCallback(presented); }
      v.requestVideoFrameCallback(presented);
      window.engine = new MkvEngine('/source.mkv', 0, {
        startAt: 60.5, getTime: () => v.currentTime, seekTo: t => { v.currentTime = t; }
      });
      engine.onEngineFailed = message => failures.push(message);
      v.src = engine.objectUrl; v.currentTime = 60.5;
      v.play();
    });
    await page.waitForFunction(() => frames.length >= 8 && frames.at(-1) > 60.7, null, {timeout: 8000});
    const first = await page.evaluate(() => frames[0]);
    assert.ok(Math.abs(first - 60.5) < 0.15, 'first displayed picture at ' + first);
    assert.deepEqual(await page.evaluate(() => failures), []);
  }, ['--disable-accelerated-video-decode']);
});

test('continuous single-IDR playback releases ordinary keyframes under quota', {timeout: 45000}, async () => {
  await withMovie(singleIDR, async page => {
    await page.evaluate(() => {
      window.failures = []; window.frames = [];
      function presented(now, frame) { frames.push(frame.mediaTime); v.requestVideoFrameCallback(presented); }
      v.requestVideoFrameCallback(presented);
      window.engine = new MkvEngine('/source.mkv', 0, {getTime: () => v.currentTime});
      engine.onEngineFailed = message => failures.push(message);
      v.src = engine.objectUrl;
    });
    await page.waitForFunction(() => v.buffered.length && v.buffered.start(0) < 1 && v.buffered.end(0) > 50);
    await page.evaluate(() => { v.playbackRate = 6; v.play(); });
    await page.waitForFunction(() => v.currentTime > 45.25);
    const end = await page.evaluate(async () => {
      const lane = engine.videoLane_, sb = lane.sb;
      if (sb.updating) await new Promise(r => sb.addEventListener('updateend', r, {once: true}));
      const append = sb.appendBuffer.bind(sb), marker = new Uint8Array(1);
      await new Promise(resolve => {
        let retries = 0;
        sb.appendBuffer = data => {
          if (data !== marker) return append(data);
          if (++retries === 1) throw new DOMException('Full buffer', 'QuotaExceededError');
          sb.appendBuffer = append;
          resolve();
        };
        lane.queue.push(marker);
        engine.drain_(lane);
      });
      return sb.buffered.length && sb.buffered.start(0);
    });
    assert.ok(end > 30 && end < 45, 'video buffer starts at ' + end);
    await page.waitForFunction(() => frames.some(t => t > 46 && t < 48), null, {timeout: 5000});
    assert.deepEqual(await page.evaluate(() => failures), []);
  });
});
