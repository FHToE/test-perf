// Injected into the page via addInitScript BEFORE any page script runs.
// Passive frame-time sampler + longtask observer + heap/DOM sampler.
// Playwright drives collection via window.__perfCollector.startPhase(name) / endPhase(name).
//
// Supports OVERLAPPING phases — multiple phases can be active at once. Frame
// samples are attributed to ALL currently active phases simultaneously. Outside
// any phase, samples are silently dropped.

export const COLLECTOR_INIT = /* js */ `
(() => {
  if (window.__perfCollector) return;

  const state = {
    phases: new Set(), // multiple active simultaneously
    samples: {}, // phaseName -> { frames, longTasks, heap, heapTotal, domNodes, startTs, endTs }
  };

  // Defensive flush on pagehide — page reload or navigation will wipe the realm.
  // closeOpenPhases() ensures any active phase gets endTs set so its duration_ms
  // is valid in the snapshot pulled before the reload.
  try {
    window.addEventListener('pagehide', () => {
      if (window.__perfCollector) window.__perfCollector.closeOpenPhases();
    }, { capture: true });
  } catch (_) {}

  // Default Resource Timing buffer is 250 entries — a full museum iteration easily
  // exceeds that (HDR cubemap mips + GLBs + textures + API calls). When the buffer
  // overflows, OLD entries are dropped — but captureAssetsSince(page, sinceIndex)
  // calls entries.slice(sinceIndex) on the LIVE buffer. Once entries are dropped,
  // every existing sinceIndex becomes stale and asset windows include wrong entries.
  // Bump to 10000 (cheap — each entry is ~200 bytes, 2MB worst case).
  try { performance.setResourceTimingBufferSize(10000); } catch (_) {}

  function ensurePhaseBucket(name) {
    if (!state.samples[name]) {
      state.samples[name] = {
        frames: [],
        longTasks: [],
        heap: [],          // used JS heap samples (ts, used)
        heapTotal: [],     // allocated JS heap samples (ts, total)
        domNodes: [],      // dom node count samples (ts, count)
        drawCalls: [],     // per-frame draw call count
        triangles: [],     // per-frame triangle count
        textureBytes: [],  // per-frame texture upload bytes (most frames 0)
        textureUploadMs: [], // per-frame wall-clock time spent in texImage2D calls
        bufferDataCalls: [], // per-frame bufferData call count
        bufferDataBytes: [], // per-frame bufferData bytes
        bufferDataMs: [],    // per-frame wall-clock time spent in bufferData calls
        gpuFrameTimesMs: [], // EXT_disjoint_timer_query results (ms per frame, async 1-3 frame delay)
        glbParseSamples: [], // [{url, parseTimeMs, bytes}] — GLB parses that COMPLETED during this phase
        glbCompletedAtStart: 0, // glb.completed.length at startPhase (to slice new entries on endPhase)
        programsStart: -1, // cumulative WebGLProgram count at startPhase
        programsEnd: -1,   // cumulative WebGLProgram count at endPhase
        startTs: performance.now(),
        endTs: 0,
      };
    }
    return state.samples[name];
  }

  function eachActive(fn) {
    state.phases.forEach((p) => fn(ensurePhaseBucket(p)));
  }

  // Frame-time sampler: passive rAF loop. On a 60fps render, dt ≈ 16.67ms.
  // Also captures GPU workload counters set by WebGL prototype patches (cameraHook.ts).
  //
  // NB: the IIFE guard makes init idempotent WITHIN a realm. A page reload, however,
  // REPLACES the JS realm — fresh window, guard does not fire (new global), new rAF
  // starts. The previous realm's rAF + state dies. Cross-realm phase continuity is
  // handled by flow.spec.ts: snapshotAccumulator pulls __perfCollector.snapshot()
  // BEFORE each reload via ensureRoomLoadedWithRetry's onBeforeReload callback, then
  // merges with the post-reload realm's final snapshot.
  let lastFrame = performance.now();
  function frame(now) {
    const dt = now - lastFrame;
    lastFrame = now;
    // Drive the GPU timer query lifecycle BEFORE reading counters — tickGpuFrame
    // polls pending queries (results that became available) and rotates begin/end.
    if (window.__gpuStats && typeof window.__gpuStats.tickGpuFrame === 'function') {
      window.__gpuStats.tickGpuFrame();
    }
    // Read and reset per-frame GPU counters BEFORE attributing — the patches
    // accumulate across all draw calls between rAF ticks.
    const gpu = window.__gpuStats ? window.__gpuStats.readAndReset() : null;
    if (state.phases.size > 0) {
      eachActive((b) => {
        b.frames.push(dt);
        if (gpu) {
          b.drawCalls.push(gpu.drawCalls);
          b.triangles.push(gpu.triangles);
          b.textureBytes.push(gpu.textureBytes);
          b.textureUploadMs.push(gpu.textureUploadMs);
          b.bufferDataCalls.push(gpu.bufferDataCalls);
          b.bufferDataBytes.push(gpu.bufferDataBytes);
          b.bufferDataMs.push(gpu.bufferDataMs);
          // GPU frame times arrive in batches (0-2 per tick due to 1-3 frame query lag).
          // Spread them across all active phases — minor skew acceptable for averages.
          if (gpu.gpuFrameTimesMs && gpu.gpuFrameTimesMs.length > 0) {
            for (let i = 0; i < gpu.gpuFrameTimesMs.length; i++) {
              b.gpuFrameTimesMs.push(gpu.gpuFrameTimesMs[i]);
            }
          }
        }
      });
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Long task observer
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const obs = new PerformanceObserver((list) => {
        if (state.phases.size === 0) return;
        for (const entry of list.getEntries()) {
          eachActive((b) => b.longTasks.push({ start: entry.startTime, duration: entry.duration }));
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
    } catch (e) {
      // longtask not supported in this browser; silently skip
    }
  }

  // Resource Timing observer — fires whenever a network resource entry finalizes.
  // We use this (NOT fetch.arrayBuffer hook) as the GLB-parse "T0" signal: it works
  // regardless of how the loader consumes the body (arrayBuffer vs body.getReader
  // streaming — THREE r170+ uses the latter for progress reporting, breaking the
  // arrayBuffer hook). Observer fires asynchronously a few ms after response ends,
  // but we use entry.responseEnd as the canonical T0 timestamp (same time origin as
  // performance.now()), so parseTimeMs = bufferDataAt - responseEnd is still accurate.
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const meshRe = /\\.(glb|gltf|ply)(\\?|$)/i;
      const resObs = new PerformanceObserver((list) => {
        if (!window.__gltfParseTracker) return;
        for (const entry of list.getEntries()) {
          if (!meshRe.test(entry.name)) continue;
          const r = entry;
          const bytes = r.encodedBodySize || r.transferSize || 0;
          window.__gltfParseTracker.markFetched(r.name, r.responseEnd, bytes);
        }
      });
      // buffered: true → catches entries that fired BEFORE the observer was attached
      // (e.g. initial GLB requested during page bootstrap before our init script).
      resObs.observe({ type: 'resource', buffered: true });
    } catch (e) {
      // resource timing not supported; silently skip
    }
  }

  // Heap + DOM sampler — every 500ms while any phase is active. Note: real VRAM
  // tracking was attempted via chrome.gpuBenchmarking.getGpuMemoryUsedInBytes() AND
  // CDP Performance.getMetrics — BOTH paths return no GPU memory in modern Chrome
  // (validated 2026-05-22). Use texture_bytes_total + buffer_data_bytes_total per
  // phase as the FE-controlled proxy. JS heap remains the only programmatic memory
  // signal we have access to.
  setInterval(() => {
    if (state.phases.size === 0) return;
    const ts = performance.now();
    const mem = performance.memory;
    const domCount = document.getElementsByTagName('*').length;
    eachActive((b) => {
      if (mem) {
        b.heap.push({ ts, used: mem.usedJSHeapSize });
        b.heapTotal.push({ ts, total: mem.totalJSHeapSize });
      }
      b.domNodes.push({ ts, count: domCount });
    });
  }, 500);

  window.__perfCollector = {
    startPhase(name) {
      // Reject restart of an already-completed phase — would silently corrupt:
      //   - duration_ms would cover only the latest window while frames[] etc spans all
      //   - programsStart locks in the FIRST start (programsEnd minus that spans both windows)
      // Each phase name should appear exactly once per iteration.
      if (state.samples[name] && state.samples[name].endTs > 0) {
        console.warn('[perf] startPhase("' + name + '") called after endPhase — ignored. Each phase should appear once per iteration.');
        return;
      }
      state.phases.add(name);
      const b = ensurePhaseBucket(name);
      b.startTs = performance.now();
      // Snapshot cumulative program count at phase start so we can derive how many
      // NEW programs were created during the phase (programsEnd - programsStart).
      if (window.__gpuStats && b.programsStart === -1) {
        b.programsStart = window.__gpuStats.programs.size;
      }
      // Snapshot the GLB parse tracker's completed-list length so endPhase can slice
      // only the parses that completed during this phase.
      if (window.__gltfParseTracker) {
        b.glbCompletedAtStart = window.__gltfParseTracker.snapshot().completed.length;
      }
    },
    endPhase(name) {
      // If called without a name, end the most-recently-added phase (legacy behavior).
      const target = name || (state.phases.size === 1 ? state.phases.values().next().value : null);
      if (!target) return;
      const b = state.samples[target];
      if (b) {
        b.endTs = performance.now();
        if (window.__gpuStats) b.programsEnd = window.__gpuStats.programs.size;
        if (window.__gltfParseTracker) {
          const snap = window.__gltfParseTracker.snapshot();
          // All parses that completed AFTER startPhase are attributed to this phase.
          b.glbParseSamples = snap.completed.slice(b.glbCompletedAtStart).map((e) => ({
            url: e.url,
            parseTimeMs: e.parseTimeMs,
            bytes: e.bytes,
          }));
        }
      }
      state.phases.delete(target);
    },
    snapshot() {
      return JSON.parse(JSON.stringify(state.samples));
    },
    /**
     * Close any phases left open. Called from pagehide handler so an in-flight
     * phase doesn't end up with endTs=0 (which would give negative duration_ms)
     * if the page reloads or unloads while a phase is active. The snapshot taken
     * before reload (via flow.spec.ts onBeforeReload) then captures clean data.
     */
    closeOpenPhases() {
      const now = performance.now();
      state.phases.forEach((p) => {
        const b = state.samples[p];
        if (b && b.endTs === 0) {
          b.endTs = now;
          if (window.__gpuStats) b.programsEnd = window.__gpuStats.programs.size;
        }
      });
      state.phases.clear();
    },

    /**
     * Reset between iterations sharing a browser context (dry-run mode). Clears
     * phase samples PLUS cumulative state in cameraHook globals — without this,
     * iter≥2 sees stale __gpuStats.programs Set (programs_added always 0) and
     * stale __gltfParseTracker.completed[] (baseline misattribution at startPhase).
     */
    reset() {
      state.phases.clear();
      state.samples = {};
      if (window.__gpuStats && typeof window.__gpuStats.fullReset === 'function') {
        window.__gpuStats.fullReset();
      }
      if (window.__gltfParseTracker && typeof window.__gltfParseTracker.fullReset === 'function') {
        window.__gltfParseTracker.fullReset();
      }
    },
  };
})();
`;
