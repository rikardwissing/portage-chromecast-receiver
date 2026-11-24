'use strict';
// A generated H.264/AAC Matroska file exercises the shared reader through
// real MSE decoding and seeks. AC-3 byte fidelity/decode is tested separately
// because desktop Chrome does not expose an AC-3 SourceBuffer.
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const {MkvDemuxer} = require('../mkv-engine.js');
const cat = (...b) => Buffer.concat(b.map(v => Buffer.from(v)));
function vint(n) {let w = 1; while (n >= 2 ** (7 * w) - 1) w++; const b = Buffer.alloc(w); b.writeUIntBE(n, 0, w); b[0] |= 1 << (8 - w); return b;}
const el = (id, ...b) => {const body = cat(...b); return cat(Buffer.from(id, 'hex'), vint(body.length), body);};
const uint = (id, n) => {let w = 1; while (n >= 2 ** (8 * w)) w++; const b = Buffer.alloc(w); b.writeUIntBE(n, 0, w); return el(id, b);};
const real = (id, n) => {const b = Buffer.alloc(8); b.writeDoubleBE(n); return el(id, b);};
function strippedFile(original) {
  const d = new MkvDemuxer(); assert.equal(d.parseHeader(original), true);
  const tracks = d.tracks.filter(t => t.type === 1 || t.type === 2);
  const entries = tracks.map(t => el('ae', uint('d7', t.number), uint('83', t.type), el('86', Buffer.from(t.codecId)),
    el('63a2', t.codecPrivate), ...(t.defaultDurationNs ? [uint('23e383', t.defaultDurationNs)] : []),
    t.type === 1 ? el('e0', uint('b0', t.video.width), uint('ba', t.video.height))
      : el('e1', real('b5', t.audio.sampleRate), uint('9f', t.audio.channels)),
    t.type === 1 ? el('6d80', el('6240', el('5034', uint('4254', 3), el('4255', [0])))) : []));
  const blocks = [];
  d.parseClusters(original.subarray(d.firstClusterOffset), d.firstClusterOffset, (number, sample) => {
    const t = tracks.find(t => t.number === number); if (!t) return;
    assert.equal(sample.laceCount, 1);
    const head = Buffer.alloc(4); head[0] = 0x80 | number; head.writeInt16BE(sample.ptsMs, 1); head[3] = sample.keyframe ? 0x80 : 0;
    if (t.type === 1) assert.equal(sample.data[0], 0);
    blocks.push(el('a3', head, t.type === 1 ? sample.data.subarray(1) : sample.data));
  });
  return cat(el('1a45dfa3'), el('18538067', el('1549a966', real('4489', d.durationMs())),
    el('1654ae6b', ...entries), el('1f43b675', uint('e7', 0), ...blocks)));
}

test('direct header-stripped MKV decodes and seeks without changing source or tracks', {timeout: 45000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portage-mkv-')); let browser, server;
  try {
    const fixture = path.join(dir, 'fixture.mkv');
    const encode = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'sine=sample_rate=48000', '-t', '18', '-c:v', 'libx264', '-preset', 'fast',
      '-g', '50', '-bf', '3', '-c:a', 'aac', fixture], {timeout: 15000});
    assert.equal(encode.status, 0, String(encode.stderr));
    const mkv = strippedFile(fs.readFileSync(fixture));
    server = http.createServer((req, res) => {
      if (req.url === '/engine.js') {res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(__dirname, '../mkv-engine.js'))); return;}
      if (req.url === '/source.mkv') {
        const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
        const from = range ? +range[1] : 0, to = range ? Math.min(+range[2], mkv.length - 1) : mkv.length - 1;
        res.writeHead(range ? 206 : 200, {'Content-Type': 'video/x-matroska', 'Content-Length': to - from + 1,
          'Content-Range': `bytes ${from}-${to}/${mkv.length}`, 'Accept-Ranges': 'bytes'});
        res.end(mkv.subarray(from, to + 1)); return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end('<video id="v" autoplay></video><script src="/engine.js"></script><script>window.failures=[];window.engine=new MkvEngine("/source.mkv",0,{getTime:()=>v.currentTime,audioStrict:true});engine.onEngineFailed=e=>failures.push(e);v.src=engine.objectUrl;</script>');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => v.currentTime > 2 && v.getVideoPlaybackQuality().totalVideoFrames > 30, null, {timeout: 10000});
    const source = await page.evaluate(() => v.currentSrc);
    for (const target of [10, 3]) {
      await page.evaluate(target => {engine.reposition(target); v.currentTime = target;}, target);
      await page.waitForFunction(target => v.currentTime > target + 1 && !v.paused && !v.seeking, target, {timeout: 8000});
    }
    const state = await page.evaluate(() => ({failures, source: v.currentSrc,
      codecs: Object.values(engine.lanes).map(l => l.track.codecId), error: v.error && v.error.message}));
    assert.deepEqual(errors, []); assert.deepEqual(state.failures, []); assert.equal(state.error, null);
    assert.equal(state.source, source); assert.deepEqual(state.codecs, ['V_MPEG4/ISO/AVC', 'A_AAC']);
    await page.evaluate(() => engine.destroy());
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(r => server.close(r));
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
