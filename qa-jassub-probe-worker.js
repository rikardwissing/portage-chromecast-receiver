'use strict';
function testContext(kind) {
  try {
    if (typeof OffscreenCanvas !== 'function') return false;
    const canvas = new OffscreenCanvas(2, 2);
    const context = canvas.getContext(kind, { alpha: false, antialias: false, depth: false, stencil: false });
    if (context && kind.indexOf('webgl') === 0) {
      const extension = context.getExtension('WEBGL_lose_context');
      if (extension) extension.loseContext();
    }
    return !!context;
  } catch (error) {
    return false;
  }
}
self.postMessage({
  workerGlobal: typeof WorkerGlobalScope === 'function' && self instanceof WorkerGlobalScope,
  offscreenCanvas: typeof OffscreenCanvas === 'function',
  offscreen2d: testContext('2d'),
  offscreenWebGL1: testContext('webgl'),
  offscreenWebGL2: testContext('webgl2'),
  wasm: typeof WebAssembly === 'object',
  textDecoder: typeof TextDecoder === 'function',
  fetch: typeof fetch === 'function',
  proxy: typeof Proxy === 'function'
});
