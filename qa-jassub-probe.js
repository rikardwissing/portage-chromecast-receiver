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
        worker = new Worker(new URL('qa-jassub-probe-worker.js', baseURL).href, { type: 'module' });
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
    canvas.width = 640;
    canvas.height = 360;
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
        subContent: '[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,1,2,0,2,20,20,20,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,JASSUB synthetic Cast probe',
        workerUrl: asset('jassub-renderer-worker.js'),
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
      var firstRenderStart = performance.now();
      await withTimeout(instance.manualRender({ expectedDisplayTime: performance.now(), width: 640, height: 360, mediaTime: 1.5 }), 8000, 'JASSUB resize');
      await withTimeout(instance.manualRender({ expectedDisplayTime: performance.now(), width: 640, height: 360, mediaTime: 2.0 }), 8000, 'JASSUB render');
      features.renderMs = Math.round(performance.now() - firstRenderStart);
      features.rendered = true;
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
