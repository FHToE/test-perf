/**
 * Playwright-injected WebGL hooks:
 *   1) Camera position capture via `cameraPosition` uniform (used by walkForward
 *      for distance measurement). THREE uploads it to most material shaders each
 *      frame; we stash `[x,y,z]` on `window.__lastCameraPos`.
 *   2) Active WebGL context counter — wraps `HTMLCanvasElement.prototype.getContext`,
 *      tracks unique webgl/webgl2 contexts seen. Exposes `window.__webglContextStats()`.
 *
 * Both run from `addInitScript` BEFORE any page script so they patch prototypes
 * before THREE constructs the renderer.
 */
export const WEBGL_CAMERA_HOOK_INIT = /* js */ `
(() => {
  if (window.__cameraHookInstalled) return;
  window.__cameraHookInstalled = true;
  window.__lastCameraPos = null;
  window.__cameraUpdateCount = 0;

  // WebGL context counter — tracks how many distinct canvases acquired a webgl/webgl2
  // context. We can't reliably hook "context lost" so this is monotonic; report peak.
  let webglContextsSeen = 0;
  const origGetCtx = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetCtx.call(this, type, attrs);
    if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
      if (!this.__webglCounted) {
        this.__webglCounted = true;
        webglContextsSeen++;
      }
    }
    return ctx;
  };
  window.__webglContextStats = () => ({ peak: webglContextsSeen });

  const locToName = new WeakMap();

  function patch(ctxProto) {
    if (!ctxProto) return;
    const origGetLoc = ctxProto.getUniformLocation;
    ctxProto.getUniformLocation = function (program, name) {
      const loc = origGetLoc.call(this, program, name);
      if (loc) locToName.set(loc, name);
      return loc;
    };

    const origU3 = ctxProto.uniform3fv;
    ctxProto.uniform3fv = function (loc, value) {
      try {
        if (loc && locToName.get(loc) === 'cameraPosition') {
          // value can be Float32Array or number[]
          window.__lastCameraPos = [value[0], value[1], value[2]];
          window.__cameraUpdateCount++;
        }
      } catch (_) {}
      return origU3.call(this, loc, value);
    };

    const origU3f = ctxProto.uniform3f;
    if (origU3f) {
      ctxProto.uniform3f = function (loc, x, y, z) {
        try {
          if (loc && locToName.get(loc) === 'cameraPosition') {
            window.__lastCameraPos = [x, y, z];
            window.__cameraUpdateCount++;
          }
        } catch (_) {}
        return origU3f.call(this, loc, x, y, z);
      };
    }
  }

  patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
  patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
})();
`;
