'use strict';
(function () {
  let active = false;
  const base = new URL('.', document.currentScript.src);
  function video() {
    const host = document.querySelector('cast-media-player');
    const candidates = host && host.shadowRoot ? Array.from(host.shadowRoot.querySelectorAll('video')) : [];
    return candidates.concat(Array.from(document.querySelectorAll('video'))).find(v => v.readyState >= 2 && v.videoWidth > 0);
  }
  function quality(v) {
    const q = v && v.getVideoPlaybackQuality();
    return q ? { time: v.currentTime, frames: q.totalVideoFrames, dropped: q.droppedVideoFrames, paused: v.paused, rate: v.playbackRate } : null;
  }
  function percentile(values, p) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }
  function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  async function limited(promise, ms) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation timed out')), ms); })]); }
    finally { clearTimeout(timer); }
  }
  window.PortageAssPerformance = async function (configURL, progress) {
    if (active) throw new Error('test already running');
    active = true;
    let instance, canvas;
    const result = { userAgent: navigator.userAgent, isolated: self.crossOriginIsolated, offscreen: typeof OffscreenCanvas === 'function', phases: [] };
    try {
      const config = await (await fetch(configURL)).json();
      const subContent = await (await fetch(config.ass)).text();
      const asset = name => new URL('jassub-qa/' + name, base).href;
      const JASSUB = (await import(asset('jassub.js'))).default;
      JASSUB._test();
      result.simd = JASSUB._supportsSIMD;
      result.memoryGB = navigator.deviceMemory;
      result.screen = { width: screen.width, height: screen.height, ratio: devicePixelRatio };
      const modern = config.forceSIMD && result.simd;
      result.forcedSIMD = !!modern;
      canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:10000';
      document.body.appendChild(canvas);
      const start = performance.now();
      instance = new JASSUB({ canvas, subContent, workerUrl: asset('jassub-renderer-worker.js?v=2026-11-12.11'),
        wasmUrl: asset(modern ? 'jassub-modern.wasm' : 'jassub.wasm'), wasmWorkerUrl: asset(modern ? 'jassub-wasm-worker-modern.js' : 'jassub-wasm-worker.js'),
        modernWasmUrl: asset('jassub-modern.wasm'), modernWasmWorkerUrl: asset('jassub-wasm-worker-modern.js'),
        fonts: config.fonts, queryFonts: false, debug: false, libassMemoryLimit: config.bitmapCacheMB, libassGlyphLimit: config.glyphCache });
      await limited(instance.ready, 45000);
      result.readyMs = performance.now() - start;
      result.backend = await instance.renderer.rendererBackend;
      progress({ readyMs: result.readyMs, backend: result.backend, simd: result.simd, forcedSIMD: result.forcedSIMD, memoryGB: result.memoryGB, screen: result.screen });
      for (const phase of config.phases) {
        const width = phase.width, height = phase.height;
        await instance.renderer._resizeCanvas(width, height, config.videoWidth, config.videoHeight);
        const v = video(), samples = [];
        let before;
        for (let i = 0; i < 8; i++) await limited(instance.renderer.profileFrame(phase.start + i / config.fps), 5000);
        before = quality(v);
        const began = performance.now(), interval = 1000 / config.fps;
        for (let i = 0; i < phase.frames; i++) {
          const scheduled = began + i * interval;
          const delay = scheduled - performance.now();
          if (delay > 0) await wait(delay);
          const sent = performance.now();
          const sample = await limited(instance.renderer.profileFrame(phase.start + i / config.fps, false), 5000);
          sample.roundTripMs = performance.now() - sent;
          sample.lateMs = performance.now() - (scheduled + interval);
          samples.push(sample);
        }
        const after = quality(v), elapsed = performance.now() - began;
        const captures = [];
        for (const time of [phase.start + 0.2, phase.start + 0.8]) captures.push(await limited(instance.renderer.profileFrame(time, true), 8000));
        const summary = { name: phase.name, width, height, before, after, frames: samples.length,
          durationMs: elapsed, late: samples.filter(s => s.lateMs > 2).length,
          overBudget: samples.filter(s => s.roundTripMs > interval).length, changed: samples.filter(s => s.changed).length,
          assP50: percentile(samples.map(s => s.assMs), .5), assP95: percentile(samples.map(s => s.assMs), .95),
          submitP95: percentile(samples.map(s => s.submitMs), .95), gpuP95: percentile(samples.map(s => s.gpuMs), .95),
          roundTripP50: percentile(samples.map(s => s.roundTripMs), .5), roundTripP95: percentile(samples.map(s => s.roundTripMs), .95),
          captures, samples };
        result.phases.push(summary);
        progress(Object.assign({}, summary, { samples: undefined }));
      }
      return result;
    } finally {
      if (instance) { try { await limited(instance.destroy(), 5000); } catch (_) {} }
      if (canvas) canvas.remove();
      active = false;
    }
  };
})();
