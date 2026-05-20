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

  function ensurePhaseBucket(name) {
    if (!state.samples[name]) {
      state.samples[name] = {
        frames: [],
        longTasks: [],
        heap: [],        // used JS heap samples (ts, used)
        heapTotal: [],   // allocated JS heap samples (ts, total)
        domNodes: [],    // dom node count samples (ts, count)
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
  let lastFrame = performance.now();
  function frame(now) {
    const dt = now - lastFrame;
    lastFrame = now;
    if (state.phases.size > 0) eachActive((b) => b.frames.push(dt));
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

  // Heap + DOM sampler — every 500ms while any phase is active
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
      state.phases.add(name);
      ensurePhaseBucket(name).startTs = performance.now();
    },
    endPhase(name) {
      // If called without a name, end the most-recently-added phase (legacy behavior).
      const target = name || (state.phases.size === 1 ? state.phases.values().next().value : null);
      if (!target) return;
      const b = state.samples[target];
      if (b) b.endTs = performance.now();
      state.phases.delete(target);
    },
    snapshot() {
      return JSON.parse(JSON.stringify(state.samples));
    },
    reset() {
      state.phases.clear();
      state.samples = {};
    },
  };
})();
`;
