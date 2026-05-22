/**
 * Playwright-injected WebGL hooks:
 *   1) Camera position capture via `cameraPosition` uniform (used by walkForward
 *      for distance measurement). THREE uploads it to most material shaders each
 *      frame; we stash `[x,y,z]` on `window.__lastCameraPos`.
 *   2) Active WebGL context counter — wraps `HTMLCanvasElement.prototype.getContext`,
 *      tracks unique webgl/webgl2 contexts seen. Exposes `window.__webglContextStats()`.
 *   3) GPU workload counters — wraps draw / program / texture-upload calls so the
 *      collector can read per-frame draw calls + triangles + texture upload bytes,
 *      plus a cumulative distinct-program count. Exposes `window.__gpuStats`:
 *        { drawCalls, triangles, textureBytes, programs: Set, readAndReset() }
 *      The collector calls `readAndReset()` at each rAF tick to capture per-frame
 *      values and zero the running counters; `programs.size` is cumulative.
 *      Triangle count is derived from `mode` + `count` of each draw call (TRIANGLES,
 *      TRIANGLE_STRIP, TRIANGLE_FAN); non-triangle modes contribute 0. Texture bytes
 *      use `data.byteLength` for compressed uploads and width*height*bpp(format,type)
 *      for uncompressed, falling back to width*height*4 (RGBA8) when format unknown.
 */
export const WEBGL_CAMERA_HOOK_INIT = /* js */ `
(() => {
  if (window.__cameraHookInstalled) return;
  window.__cameraHookInstalled = true;
  window.__lastCameraPos = null;
  window.__cameraUpdateCount = 0;

  // WebGL context counter — tracks how many distinct canvases acquired a webgl/webgl2
  // context. We can't reliably hook "context lost" so this is monotonic; report peak.
  // Also stashes the first context + EXT_disjoint_timer_query extension on glRef
  // for the GPU frame time measurement below.
  let webglContextsSeen = 0;
  let glRef = null;
  let timerExt = null;
  let timerExtConstant = 0;
  const origGetCtx = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetCtx.call(this, type, attrs);
    if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
      if (!this.__webglCounted) {
        this.__webglCounted = true;
        webglContextsSeen++;
      }
      // Latch first context that's both WebGL2 AND big enough to be the real scene
      // canvas (skip 1x1 probe canvases that THREE/Drei use for feature detection).
      // We require WebGL2 because the timer query lifecycle uses gl.beginQuery /
      // endQuery / getQueryParameter / QUERY_RESULT — all WebGL2-only. The WebGL1
      // EXT_disjoint_timer_query extension puts those methods on the extension
      // object itself (createQueryEXT, etc.) which we deliberately do NOT support.
      const isWebGL2 = (type === 'webgl2') ||
        (typeof WebGL2RenderingContext !== 'undefined' && ctx instanceof WebGL2RenderingContext);
      const looksReal = (this.width || 0) >= 100 && (this.height || 0) >= 100;
      if (!glRef && isWebGL2 && looksReal) {
        glRef = ctx;
        try {
          timerExt = ctx.getExtension('EXT_disjoint_timer_query_webgl2');
          if (timerExt) timerExtConstant = timerExt.TIME_ELAPSED_EXT;
        } catch (_) {}
      }
    }
    return ctx;
  };
  window.__webglContextStats = () => ({ peak: webglContextsSeen, hasTimerQuery: !!timerExt });

  // GPU workload counters. Running per-frame totals; collector reads and resets each rAF.
  const gpu = {
    drawCalls: 0,
    triangles: 0,
    textureBytes: 0,
    textureUploadMs: 0,
    bufferDataCalls: 0,
    bufferDataBytes: 0,
    bufferDataMs: 0,
    programs: new Set(),
    // GPU frame time measurements via EXT_disjoint_timer_query. Each entry is one
    // completed query (1 frame's GPU ms). Accumulates between collector reads.
    gpuFrameTimesMs: [],
  };
  // Timer-query state — async; results land 1-3 frames after endQuery.
  let activeGpuQuery = null;
  const pendingGpuQueries = [];
  window.__gpuStats = {
    programs: gpu.programs,
    readAndReset() {
      const out = {
        drawCalls: gpu.drawCalls,
        triangles: gpu.triangles,
        textureBytes: gpu.textureBytes,
        textureUploadMs: gpu.textureUploadMs,
        bufferDataCalls: gpu.bufferDataCalls,
        bufferDataBytes: gpu.bufferDataBytes,
        bufferDataMs: gpu.bufferDataMs,
        programsTotal: gpu.programs.size,
        // Returns ALL completed GPU frame time queries since last read (typically 0-2
        // per rAF tick due to 1-3 frame query result latency).
        gpuFrameTimesMs: gpu.gpuFrameTimesMs.slice(),
      };
      gpu.drawCalls = 0;
      gpu.triangles = 0;
      gpu.textureBytes = 0;
      gpu.textureUploadMs = 0;
      gpu.bufferDataCalls = 0;
      gpu.bufferDataBytes = 0;
      gpu.bufferDataMs = 0;
      gpu.gpuFrameTimesMs.length = 0;
      return out;
    },
    /**
     * Drive the GPU timer-query lifecycle. Called by the rAF collector each tick.
     * Polls pending queries for results, ends the previously-active query
     * (captures the FRAME we just finished — between previous rAF and this one),
     * and begins a fresh query for the upcoming frame. Silently no-ops when the
     * EXT_disjoint_timer_query_webgl2 extension is unavailable.
     *
     * Disjoint handling: per spec, GPU_DISJOINT_EXT signals that ALL outstanding
     * TIME_ELAPSED measurements since the last successful read are unreliable, and
     * the flag is reset on read. We poll it ONCE at the top of the tick; if true,
     * drop ALL pending + active queries and skip this tick entirely.
     */
    tickGpuFrame() {
      if (!glRef || !timerExt) return;
      // 0) Disjoint check — single read for the whole tick.
      let disjoint = false;
      try { disjoint = !!glRef.getParameter(timerExt.GPU_DISJOINT_EXT); } catch (_) {}
      if (disjoint) {
        for (let i = 0; i < pendingGpuQueries.length; i++) {
          try { glRef.deleteQuery(pendingGpuQueries[i]); } catch (_) {}
        }
        pendingGpuQueries.length = 0;
        if (activeGpuQuery) {
          try { glRef.endQuery(timerExtConstant); glRef.deleteQuery(activeGpuQuery); } catch (_) {}
          activeGpuQuery = null;
        }
        return;
      }
      // 1) Poll pending queries — results are async (1-3 frames late).
      for (let i = pendingGpuQueries.length - 1; i >= 0; i--) {
        const q = pendingGpuQueries[i];
        try {
          if (glRef.getQueryParameter(q, glRef.QUERY_RESULT_AVAILABLE)) {
            const ns = glRef.getQueryParameter(q, glRef.QUERY_RESULT);
            glRef.deleteQuery(q);
            pendingGpuQueries.splice(i, 1);
            gpu.gpuFrameTimesMs.push(ns / 1e6);
          }
        } catch (_) { pendingGpuQueries.splice(i, 1); }
      }
      // 2) End the active query (captures everything queued since last beginQuery).
      if (activeGpuQuery) {
        try {
          glRef.endQuery(timerExtConstant);
          pendingGpuQueries.push(activeGpuQuery);
        } catch (_) {}
        activeGpuQuery = null;
      }
      // 3) Begin a new query for the upcoming frame. Only one TIME_ELAPSED_EXT query
      // can be active at a time per spec — that's why we begin/end in this order.
      try {
        const q = glRef.createQuery();
        if (q) {
          glRef.beginQuery(timerExtConstant, q);
          activeGpuQuery = q;
        }
      } catch (_) {}
    },
    /**
     * Full reset including cumulative state. Called by __perfCollector.reset()
     * between dry-run iterations sharing the same browser context. Without this,
     * iter≥2 sees stale programs Set → programs_added always 0.
     */
    fullReset() {
      gpu.drawCalls = 0;
      gpu.triangles = 0;
      gpu.textureBytes = 0;
      gpu.textureUploadMs = 0;
      gpu.bufferDataCalls = 0;
      gpu.bufferDataBytes = 0;
      gpu.bufferDataMs = 0;
      gpu.gpuFrameTimesMs.length = 0;
      gpu.programs.clear();
      // Don't try to delete pending queries on context that may be gone — best-effort.
      pendingGpuQueries.length = 0;
      activeGpuQuery = null;
    },
  };

  // GLB parse tracker — pairs .glb/.gltf/.ply fetches (via fetch+arrayBuffer hook)
  // with the FIRST WebGL bufferData call after the fetch resolves. The interval
  // approximates "time from network done to first geometry on GPU" = parse + GPU prep.
  // For sequential loads (the common case in our flow) attribution is accurate;
  // concurrent loads can mis-attribute (we use FIFO order). Each entry records
  // url + fetchedAt + bytes; on bufferData we shift the oldest pending entry into
  // completed[] with parseTimeMs = bufferDataAt - fetchedAt.
  //
  // Heuristics to avoid hijacking by non-GLTF bufferData calls (postprocess passes,
  // Drei <Line>, InstancedMesh dynamic updates, ELEMENT_ARRAY_BUFFER index uploads):
  //   - markBufferData only pairs for target=ARRAY_BUFFER (34962) and size >= 16KB
  //   - stale-pending TTL: entries older than 10s are evicted on each markBufferData,
  //     so a GLB with no geometry (animation-only, camera-only) doesn't leak forever.
  const GLB_MIN_BUFFER_BYTES = 16 * 1024;
  const GLB_STALE_TTL_MS = 10000;
  const glb = {
    pending: [],     // [{url, fetchedAt, bytes}]
    completed: [],   // [{url, fetchedAt, parseEndAt, parseTimeMs, bytes}]
    droppedStale: 0, // diagnostic: pending entries dropped for exceeding TTL
  };
  window.__gltfParseTracker = {
    markFetched(url, ts, bytes) {
      glb.pending.push({ url, fetchedAt: ts, bytes });
    },
    markBufferData(ts, target, bytes) {
      // Evict stale pendings on every call so they can't be hijacked later.
      while (glb.pending.length > 0 && ts - glb.pending[0].fetchedAt > GLB_STALE_TTL_MS) {
        glb.pending.shift();
        glb.droppedStale++;
      }
      if (glb.pending.length === 0) return;
      // ARRAY_BUFFER only — ELEMENT_ARRAY_BUFFER (indices) would systematically under-time.
      if (target !== 34962) return;
      // Filter sub-16KB buffers — uniforms, particles, Drei helpers.
      if (bytes < GLB_MIN_BUFFER_BYTES) return;
      const entry = glb.pending.shift();
      entry.parseEndAt = ts;
      entry.parseTimeMs = ts - entry.fetchedAt;
      glb.completed.push(entry);
    },
    snapshot() {
      // Return a deep copy so callers can iterate safely.
      return {
        pending: glb.pending.map((e) => ({ ...e })),
        completed: glb.completed.map((e) => ({ ...e })),
        droppedStale: glb.droppedStale,
      };
    },
    fullReset() {
      glb.pending.length = 0;
      glb.completed.length = 0;
      glb.droppedStale = 0;
    },
  };

  // GL mode constants — same numeric values across WebGL1/2.
  const GL_POINTS = 0, GL_LINES = 1, GL_LINE_LOOP = 2, GL_LINE_STRIP = 3;
  const GL_TRIANGLES = 4, GL_TRIANGLE_STRIP = 5, GL_TRIANGLE_FAN = 6;

  function trianglesFromMode(mode, count) {
    if (count <= 0) return 0;
    switch (mode) {
      case GL_TRIANGLES: return (count / 3) | 0;
      case GL_TRIANGLE_STRIP:
      case GL_TRIANGLE_FAN: return Math.max(0, count - 2);
      default: return 0;
    }
  }

  // Bytes-per-pixel for common (format, type) pairs. Returns 0 when unknown so caller
  // can fall back to a conservative RGBA8 estimate (width*height*4).
  // PACKED formats (UNSIGNED_SHORT_5_6_5/4_4_4_4/5_5_5_1) are detected FIRST and
  // return 2 bytes/pixel directly — they pack all components into one 16-bit unit, so
  // the (components × bytesPerComponent) formula would overcount 4× for RGBA × 4_4_4_4.
  function bppFromFormatType(format, type) {
    // Packed 16-bit pixel formats: type alone determines size.
    // UNSIGNED_SHORT_5_6_5=33635, UNSIGNED_SHORT_4_4_4_4=32819, UNSIGNED_SHORT_5_5_5_1=32820
    if (type === 33635 || type === 32819 || type === 32820) return 2;
    // Packed 32-bit pixel formats (WebGL2): UNSIGNED_INT_2_10_10_10_REV=33640,
    // UNSIGNED_INT_10F_11F_11F_REV=35899, UNSIGNED_INT_5_9_9_9_REV=35902,
    // FLOAT_32_UNSIGNED_INT_24_8_REV=36269 (depth+stencil — 8 bytes)
    if (type === 33640 || type === 35899 || type === 35902) return 4;
    if (type === 36269) return 8;
    // Standard formats: components × bytesPerComponent.
    // format: ALPHA=6406, RGB=6407, RGBA=6408, LUMINANCE=6409, LUMINANCE_ALPHA=6410,
    // RED=6403 (WebGL2), RG=33319, RED_INTEGER=36244, RG_INTEGER=33320,
    // RGB_INTEGER=36248, RGBA_INTEGER=36249, DEPTH_COMPONENT=6402
    let components = 0;
    switch (format) {
      case 6403: case 6402: case 6406: case 6409: case 36244: components = 1; break;
      case 6410: case 33319: case 33320: components = 2; break;
      case 6407: case 36248: components = 3; break;
      case 6408: case 36249: components = 4; break;
      default: return 0;
    }
    switch (type) {
      case 5121: case 5120: return components;            // BYTE / UNSIGNED_BYTE
      case 5122: case 5123: return components * 2;        // SHORT / UNSIGNED_SHORT
      case 5124: case 5125: case 5126: return components * 4; // INT / UINT / FLOAT
      case 5131: case 36193: return components * 2;       // HALF_FLOAT
      default: return components; // unknown — assume 1 byte/component
    }
  }

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

    // Draw calls — count + accumulate triangle estimate.
    const origDrawElements = ctxProto.drawElements;
    if (origDrawElements) {
      ctxProto.drawElements = function (mode, count, type, offset) {
        gpu.drawCalls++;
        gpu.triangles += trianglesFromMode(mode, count);
        return origDrawElements.call(this, mode, count, type, offset);
      };
    }
    const origDrawArrays = ctxProto.drawArrays;
    if (origDrawArrays) {
      ctxProto.drawArrays = function (mode, first, count) {
        gpu.drawCalls++;
        gpu.triangles += trianglesFromMode(mode, count);
        return origDrawArrays.call(this, mode, first, count);
      };
    }
    const origDrawElementsInstanced = ctxProto.drawElementsInstanced;
    if (origDrawElementsInstanced) {
      ctxProto.drawElementsInstanced = function (mode, count, type, offset, primcount) {
        // primcount=0 is a no-op draw per spec; don't count it as load.
        if (primcount > 0) {
          gpu.drawCalls++;
          gpu.triangles += trianglesFromMode(mode, count) * primcount;
        }
        return origDrawElementsInstanced.call(this, mode, count, type, offset, primcount);
      };
    }
    const origDrawArraysInstanced = ctxProto.drawArraysInstanced;
    if (origDrawArraysInstanced) {
      ctxProto.drawArraysInstanced = function (mode, first, count, primcount) {
        if (primcount > 0) {
          gpu.drawCalls++;
          gpu.triangles += trianglesFromMode(mode, count) * primcount;
        }
        return origDrawArraysInstanced.call(this, mode, first, count, primcount);
      };
    }

    // Programs — count distinct WebGLProgram objects ever created.
    const origCreateProgram = ctxProto.createProgram;
    if (origCreateProgram) {
      ctxProto.createProgram = function () {
        const p = origCreateProgram.call(this);
        if (p) gpu.programs.add(p);
        return p;
      };
    }

    // Texture uploads — accumulate bytes pushed to GPU + wall-clock time spent in the
    // upload call. texImage2D is a synchronous WebGL call that queues the upload to
    // the driver; performance.now() before/after captures CPU-side time including
    // any blocking on internal driver queues. Not the same as actual GPU bandwidth
    // time, but a useful proxy that scales with size + format conversion overhead.
    const origTexImage2D = ctxProto.texImage2D;
    if (origTexImage2D) {
      ctxProto.texImage2D = function (...args) {
        try {
          let bytes = 0;
          if (args.length === 9) {
            // texImage2D(target, level, internalformat, width, height, border, format, type, pixels)
            const w = args[3], h = args[4], format = args[6], type = args[7], pixels = args[8];
            if (pixels && typeof pixels.byteLength === 'number') {
              bytes = pixels.byteLength;
            } else {
              const bpp = bppFromFormatType(format, type) || 4;
              bytes = w * h * bpp;
            }
          } else if (args.length === 6) {
            // texImage2D(target, level, internalformat, format, type, source) — source is image/canvas/video
            const source = args[5];
            const w = source && (source.naturalWidth || source.videoWidth || source.width) || 0;
            const h = source && (source.naturalHeight || source.videoHeight || source.height) || 0;
            const bpp = bppFromFormatType(args[3], args[4]) || 4;
            bytes = w * h * bpp;
          }
          if (bytes > 0) gpu.textureBytes += bytes;
        } catch (_) {}
        const t0 = performance.now();
        const r = origTexImage2D.apply(this, args);
        gpu.textureUploadMs += performance.now() - t0;
        return r;
      };
    }
    const origTexSubImage2D = ctxProto.texSubImage2D;
    if (origTexSubImage2D) {
      ctxProto.texSubImage2D = function (...args) {
        try {
          let bytes = 0;
          if (args.length === 9) {
            // texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels)
            const w = args[4], h = args[5], format = args[6], type = args[7], pixels = args[8];
            if (pixels && typeof pixels.byteLength === 'number') {
              bytes = pixels.byteLength;
            } else {
              const bpp = bppFromFormatType(format, type) || 4;
              bytes = w * h * bpp;
            }
          } else if (args.length === 7) {
            // texSubImage2D(target, level, xoffset, yoffset, format, type, source)
            const source = args[6];
            const w = source && (source.naturalWidth || source.videoWidth || source.width) || 0;
            const h = source && (source.naturalHeight || source.videoHeight || source.height) || 0;
            const bpp = bppFromFormatType(args[4], args[5]) || 4;
            bytes = w * h * bpp;
          }
          if (bytes > 0) gpu.textureBytes += bytes;
        } catch (_) {}
        const t0 = performance.now();
        const r = origTexSubImage2D.apply(this, args);
        gpu.textureUploadMs += performance.now() - t0;
        return r;
      };
    }
    const origCompressedTexImage2D = ctxProto.compressedTexImage2D;
    if (origCompressedTexImage2D) {
      ctxProto.compressedTexImage2D = function (...args) {
        try {
          // compressedTexImage2D(target, level, internalformat, width, height, border, data)
          // data.byteLength is the exact VRAM footprint of the compressed block.
          const data = args[6];
          if (data && typeof data.byteLength === 'number') gpu.textureBytes += data.byteLength;
        } catch (_) {}
        const t0 = performance.now();
        const r = origCompressedTexImage2D.apply(this, args);
        gpu.textureUploadMs += performance.now() - t0;
        return r;
      };
    }
    const origCompressedTexSubImage2D = ctxProto.compressedTexSubImage2D;
    if (origCompressedTexSubImage2D) {
      ctxProto.compressedTexSubImage2D = function (...args) {
        try {
          // compressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format, data)
          const data = args[7];
          if (data && typeof data.byteLength === 'number') gpu.textureBytes += data.byteLength;
        } catch (_) {}
        const t0 = performance.now();
        const r = origCompressedTexSubImage2D.apply(this, args);
        gpu.textureUploadMs += performance.now() - t0;
        return r;
      };
    }

    // Buffer uploads (geometry data: vertex positions, indices, normals, UVs).
    // bufferData is the GPU-upload moment for THREE.BufferAttribute. Triggers the
    // GLTF parse-tracker (the FIRST sufficiently-large ARRAY_BUFFER upload after a
    // .glb fetch marks "parse done"). The 5-arg WebGL2 overload
    // (target, srcData, usage, srcOffset, length) needs special byte calc: 'length'
    // is ELEMENT count, not byte count — multiply by srcData.BYTES_PER_ELEMENT.
    function bufferUploadBytes(sizeOrData, srcOffset, length) {
      if (typeof sizeOrData === 'number') return sizeOrData; // alloc-only form
      if (!sizeOrData || typeof sizeOrData.byteLength !== 'number') return 0;
      // 5-arg overload: explicit element-count window into srcData.
      if (typeof length === 'number' && length > 0 && sizeOrData.BYTES_PER_ELEMENT) {
        return length * sizeOrData.BYTES_PER_ELEMENT;
      }
      // 5-arg overload with length=0 means "to end of array from srcOffset".
      if (typeof srcOffset === 'number' && srcOffset > 0 && sizeOrData.BYTES_PER_ELEMENT) {
        return sizeOrData.byteLength - srcOffset * sizeOrData.BYTES_PER_ELEMENT;
      }
      return sizeOrData.byteLength;
    }

    const origBufferData = ctxProto.bufferData;
    if (origBufferData) {
      ctxProto.bufferData = function (...args) {
        const target = args[0];
        let bytes = 0;
        try {
          bytes = bufferUploadBytes(args[1], args[3], args[4]);
          if (bytes > 0) {
            gpu.bufferDataBytes += bytes;
            gpu.bufferDataCalls++;
          }
          if (window.__gltfParseTracker) {
            window.__gltfParseTracker.markBufferData(performance.now(), target, bytes);
          }
        } catch (_) {}
        const t0 = performance.now();
        const r = origBufferData.apply(this, args);
        gpu.bufferDataMs += performance.now() - t0;
        return r;
      };
    }
    // bufferSubData — updates a slice of an existing buffer. Same byte-calc rules.
    // Critical for InstancedBufferAttribute updates and dynamic geometry. Without this
    // hook, runtime geometry churn is invisible to bufferData_* metrics.
    const origBufferSubData = ctxProto.bufferSubData;
    if (origBufferSubData) {
      ctxProto.bufferSubData = function (...args) {
        // bufferSubData(target, dstByteOffset, srcData, srcOffset, length)
        let bytes = 0;
        try {
          bytes = bufferUploadBytes(args[2], args[3], args[4]);
          if (bytes > 0) {
            gpu.bufferDataBytes += bytes;
            gpu.bufferDataCalls++;
          }
          // bufferSubData is NEVER the first upload of a GLB (initial geometry is
          // bufferData), so don't feed parse-tracker — would only cause hijacks.
        } catch (_) {}
        const t0 = performance.now();
        const r = origBufferSubData.apply(this, args);
        gpu.bufferDataMs += performance.now() - t0;
        return r;
      };
    }
  }

  patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
  patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
  // GLB parse "T0" is captured in collectors.ts via PerformanceObserver({type:'resource'}).
})();
`;
