'use strict';
(function () {
  var scriptURL = document.currentScript && document.currentScript.src || location.href;
  var baseURL = new URL('.', scriptURL);
  var lastRun = null;

  function contextSupport(kind) {
    try {
      if (typeof OffscreenCanvas !== 'function') return false;
      var canvas = new OffscreenCanvas(2, 2);
      var context = canvas.getContext(kind, { alpha: false, antialias: false, depth: false, stencil: false });
      if (context && kind.indexOf('webgl') === 0) {
        var extension = context.getExtension('WEBGL_lose_context');
        if (extension) extension.loseContext();
      }
      return !!context;
    } catch (error) {
      return false;
    }
  }

  function probeWorker() {
    return new Promise(function (resolve) {
      var worker;
      var finished = false;
      var timer = setTimeout(function () {
        if (finished) return;
        finished = true;
        if (worker) worker.terminate();
        resolve({ supported: false, error: 'worker probe timed out' });
      }, 8000);
      try {
        worker = new Worker(new URL('qa-jassub-probe-worker.js?v=2026-11-12.2', baseURL).href, { type: 'module' });
        worker.onmessage = function (event) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          worker.terminate();
          resolve({ supported: true, details: event.data });
        };
        worker.onerror = function (event) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (worker) worker.terminate();
          resolve({ supported: false, error: String(event.message || 'worker error') });
        };
      } catch (error) {
        finished = true;
        clearTimeout(timer);
        resolve({ supported: false, error: String(error) });
      }
    });
  }

  function withTimeout(promise, milliseconds, label) {
    var timer;
    return Promise.race([promise, new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error(label + ' timed out')); }, milliseconds);
    })]).finally(function () { clearTimeout(timer); });
  }

  async function run() {
    var video = document.createElement('video');
    var features = {
      userAgent: navigator.userAgent,
      secureContext: !!window.isSecureContext,
      crossOriginIsolated: !!window.crossOriginIsolated,
      deviceMemory: navigator.deviceMemory || null,
      webAssembly: typeof WebAssembly === 'object',
      textDecoder: typeof TextDecoder === 'function',
      offscreenCanvas: typeof OffscreenCanvas === 'function',
      offscreen2d: contextSupport('2d'),
      offscreenWebGL1: contextSupport('webgl'),
      offscreenWebGL2: contextSupport('webgl2'),
      worker: typeof Worker === 'function',
      proxy: typeof Proxy === 'function',
      fetch: typeof fetch === 'function',
      promise: typeof Promise === 'function',
      getVideoPlaybackQuality: typeof video.getVideoPlaybackQuality === 'function',
      requestVideoFrameCallback: typeof video.requestVideoFrameCallback === 'function'
    };
    var worker = await probeWorker();
    features.moduleWorker = worker.supported;
    features.workerResult = worker.details || null;
    if (worker.error) features.workerError = worker.error;

    var asset = function (name) { return new URL('jassub-qa/' + name, baseURL).href; };
    var moduleURL = asset('jassub.js');
    var canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    canvas.id = 'qa-jassub-output';
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;background:#10121f;';
    document.body.appendChild(canvas);
    var instance;
    try {
      var imported = await withTimeout(import(moduleURL), 12000, 'JASSUB module load');
      var JASSUB = imported.default;
      features.jassubVersion = '2.5.37';
      features.wasmSIMD = !!JASSUB._supportsSIMD;
      instance = new JASSUB({
        canvas: canvas,
        subContent: '[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,56,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,1,3,2,2,60,60,50,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:06.00,Default,,0,0,0,,{\\move(300,540,1620,540,0,5000)\\t(0,2500,\\fs72\\1c&H0000FF&)}JASSUB animated synthetic Cast probe',
        workerUrl: asset('jassub-renderer-worker.js?v=2026-11-12.2'),
        wasmUrl: asset('jassub.wasm'),
        wasmWorkerUrl: asset('jassub-wasm-worker.js'),
        modernWasmUrl: asset('jassub-modern.wasm'),
        modernWasmWorkerUrl: asset('jassub-wasm-worker-modern.js'),
        fonts: [asset('default.woff2')],
        debug: false
      });
      var readyStart = performance.now();
      await withTimeout(instance.ready, 25000, 'JASSUB worker/WASM ready');
      features.readyMs = Math.round(performance.now() - readyStart);
      try { features.rendererBackend = await instance.renderer.rendererBackend; } catch (error) { features.rendererBackend = 'unavailable: ' + String(error); }
      var warmupStart = performance.now();
      var warmupFrames = 10;
      for (var w = 0; w < warmupFrames; w++) {
        await withTimeout(instance.manualRender({ expectedDisplayTime: performance.now() + 34, width: 1920, height: 1080, mediaTime: 1.0 + w / 30 }), 1500, 'JASSUB warm-up frame');
      }
      features.warmup = { frames: warmupFrames, durationMs: Math.round(performance.now() - warmupStart) };
      var intervalMs = 1000 / 30;
      var benchmarkStart = performance.now();
      var renderTimes = [];
      var missedDeadlines = 0;
      var benchmarkError = null;
      for (var i = 0; i < 90; i++) {
        if (performance.now() - benchmarkStart > 12000) break;
        var scheduledStart = benchmarkStart + i * intervalMs;
        var waitMs = scheduledStart - performance.now();
        if (waitMs > 0) await new Promise(function (resolve) { setTimeout(resolve, waitMs); });
        var frameStart = performance.now();
        var deadline = benchmarkStart + (i + 1) * intervalMs;
        try {
          await withTimeout(instance.manualRender({ expectedDisplayTime: deadline, width: 1920, height: 1080, mediaTime: 1.5 + i / 30 }), 1500, 'JASSUB benchmark frame');
        } catch (error) {
          benchmarkError = String(error);
          break;
        }
        var frameEnd = performance.now();
        renderTimes.push(frameEnd - frameStart);
        if (frameEnd > deadline) missedDeadlines++;
      }
      var sortedTimes = renderTimes.slice().sort(function (a, b) { return a - b; });
      var percentile = function (p) { return sortedTimes.length ? Math.round(sortedTimes[Math.min(sortedTimes.length - 1, Math.ceil(p * sortedTimes.length) - 1)] * 10) / 10 : null; };
      features.benchmark = {
        width: 1920, height: 1080, targetFps: 30, frameIntervalMs: Math.round(intervalMs * 10) / 10,
        frames: renderTimes.length, requestedFrames: 90, totalMs: Math.round((performance.now() - benchmarkStart) * 10) / 10,
        warmupFrames: warmupFrames, p50Ms: percentile(0.5), p95Ms: percentile(0.95),
        maxMs: sortedTimes.length ? Math.round(sortedTimes[sortedTimes.length - 1] * 10) / 10 : null,
        lateDeadlines: missedDeadlines, frameTimesMs: renderTimes.map(function (value) { return Math.round(value * 10) / 10; })
      };
      if (benchmarkError) features.benchmark.error = benchmarkError;
      try {
        features.pixelSamples = [await withTimeout(instance.renderer.captureSummary(1.5), 4000, 'JASSUB first pixel sample'), await withTimeout(instance.renderer.captureSummary(4.4), 4000, 'JASSUB second pixel sample')];
        features.pixelFramesDiffer = features.pixelSamples[0] && features.pixelSamples[1] && features.pixelSamples[0].checksum !== features.pixelSamples[1].checksum;
      } catch (error) {
        features.pixelCaptureError = String(error);
      }
      features.rendered = renderTimes.length > 0;
      features.canvasVisible = !!canvas.isConnected;
      return { ok: true, features: features };
    } finally {
      if (instance) {
        try { await withTimeout(instance.destroy(), 4000, 'JASSUB cleanup'); } catch (error) {}
      }
      canvas.remove();
    }
  }

  window.PortageJassubProbe = function () {
    if (!lastRun) lastRun = run().catch(function (error) { return { ok: false, error: String(error), stack: error && error.stack ? String(error.stack).slice(0, 1500) : '' }; });
    return lastRun;
  };
})();
