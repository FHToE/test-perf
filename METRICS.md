# Metrics reference

Every metric the benchmark produces, how it is computed, and the caveats that affect interpretation. Tied to the phases defined in `helpers/phases.ts` (`lobby_idle`, `transition_to_target`, `target_room_idle`, `target_room_walk`, `target_room_poi_open`, `transition_to_next`, `next_room_idle`, `next_room_walk`).

The hard constraint of this benchmark is **zero frontend changes**. Every metric below is collected externally — either through Playwright APIs, `performance.*` Web APIs, Chrome internal flags exposed via Playwright launch args, or `WebGLRenderingContext.prototype` patches injected with `addInitScript` before any page script runs.

---

## Rendering performance

### `fps_avg`, `fps_p1_low`, `fps_p5_low`, `min_fps`, `max_fps`

**How:** A passive `requestAnimationFrame` loop in the in-page collector records the millisecond delta between rAF callbacks (`frame_time_ms`). On a vsynced 60Hz display, `dt ≈ 16.67ms` → 60fps.

- `fps_avg` = `1000 / mean(frame_time_ms)`
- `fps_p1_low` = `1000 / mean(slowest 1% of frames)` — perceptually the "ugly stutter floor"
- `fps_p5_low` = `1000 / mean(slowest 5% of frames)` — broader stutter profile
- `min_fps` = `1000 / max(frame_time_ms)` — worst single frame (peak load)
- `max_fps` = `1000 / min(frame_time_ms)` — best single frame (peak headroom, usually display refresh-capped)

**Caveats:**
- Vsync caps `fps_avg` at the display refresh rate. On a 60Hz monitor "75 fps" is impossible — see `frame_time_p95_ms` for capacity headroom.
- Headless cloud runs may not vsync; expect higher raw FPS than user-visible reality.

### `frame_time_p95_ms`, `frame_time_p99_ms`, `max_frame_time_ms`

**How:** Percentiles over the same per-frame `dt` array. P95/P99 are the frame-time thresholds 95%/99% of frames stay under. P99 is where real stutters live; max is one-off outliers.

**Why prefer over fps_avg:** vsync ceiling hides changes in `fps_avg` once you hit refresh-cap, but frame-time percentiles still move (a scene rendering in 12ms vs 14ms both show 60fps but the headroom differs by ~17%).

### `cpu_frame_time_ms_avg`, `cpu_frame_time_ms_p95` (derived)

**How:** `max(0, frame_time - gpu_frame_time)` — total frame time minus the GPU portion measured by `EXT_disjoint_timer_query`. The avg variant uses `1000/fps_avg - mean(gpu_frame_times)`; the p95 variant uses `frame_time_p95 - gpu_frame_time_p95`. Clamped to 0 because GPU work can briefly pipeline across multiple frames, yielding small negative inferred CPU times that are just measurement noise.

**What this is:** the time the **main thread** spent between rAFs — JS work, layout, React renders, scene graph updates, animation logic, etc. Reported as 0 when GPU timer query is unavailable (extension missing in headless/VM env) — without the GPU signal to subtract, the inferred CPU time would just equal full frame time, misleading.

**Interpretation:**
- `cpu_frame_time ≈ frame_time` → **CPU-bound**, GPU is idle most of the frame. Asset optimization won't help — look at JS work, scene complexity, React renders.
- `cpu_frame_time << gpu_frame_time` → **GPU-bound**. Asset optimization (triangles, textures, shaders) will move FPS.
- Both balanced (each ~half) → frame time is being shared; either side could win, but biggest gains likely on whichever is closer to vsync.

**Caveat:** the avg/p95 mixing means percentile comparisons aren't perfectly aligned (p95 of frame_time doesn't necessarily contain the p95 of gpu_time). For coarse direction-of-arrow, fine; for tight stats, prefer per-frame derivation (not currently implemented because gpu queries arrive 1-3 frames late and don't align 1:1 with rAF samples).

---

## CPU memory + DOM

### `heap_mb.avg`, `heap_mb.max`, `heap_total_mb.avg`, `heap_total_mb.max`

**How:** Sampled every 500ms while any phase is active via `performance.memory.usedJSHeapSize` / `totalJSHeapSize` (requires Chrome's `--enable-precise-memory-info` flag, already set in `playwright.config.ts`). Output in MB.

- `heap_mb` = currently used JS heap
- `heap_total_mb` = allocated JS heap (always ≥ used; grows in steps as V8 expands)

**Caveats:**
- Only works in Chrome with the flag. Firefox returns 0.
- Sampling cadence (500ms) can miss short-lived allocations that the GC reclaims between samples.

### `dom_nodes.avg`, `dom_nodes.max`

**How:** Same 500ms sampler runs `document.getElementsByTagName('*').length`. Tracks DOM churn during transitions (Radix dialogs, loading overlays, etc).

---

## Long tasks (main-thread blocking)

### `long_tasks.count`, `long_tasks.total_ms`

**How:** `PerformanceObserver({ entryTypes: ['longtask'] })`. Any main-thread task >50ms (W3C Long Tasks API definition). Each entry's `duration` is summed.

**What this catches:** Synchronous JS work that blocks input. GLTF parse spikes, big React renders, MapStruct shader compilation, etc.

**Caveats:** Cannot attribute to a specific function without devtools profiling; it just confirms blockage happened.

---

## WebGL contexts

### `webgl_contexts_peak`

**How:** `HTMLCanvasElement.prototype.getContext` is patched to count unique canvases that successfully acquired a `webgl`/`webgl2` context. Monotonic counter, reported as the peak observed.

**Why:** Catches context leaks where a stale canvas is replaced without being disposed — each leak doubles VRAM usage and can trigger Chrome's per-tab WebGL context limit (~16 contexts → context-lost cascade).

**Caveats:** Doesn't decrement on context loss (no reliable hook for that). A `>1` value indicates a leak only if the app shouldn't have multiple canvases.

---

## Asset windows (per room)

### `assets_lobby`, `assets_target_room`, `assets_next_room`
Each contains `window_ms`, `total_bytes`, `count`, `mesh_count`.

**How:** `performance.getEntriesByType("resource")` (Resource Timing API) returns every network request the page made, with precise `startTime` / `responseEnd` timestamps. Before each room transition the test captures the current entry index; after the transition it slices the new entries, filters by extension (`.glb|.gltf|.jpg|.jpeg|.png|.webp|.avif|.mp4|.mp3|.ply|.pdf`), and computes:

- `window_ms` = `max(responseEnd) - min(startTime)` — wall-clock window from first request to last byte
- `total_bytes` = sum of `encodedBodySize` (compressed) or `transferSize` fallback
- `count` = total asset entries
- `mesh_count` = subset with `.glb`/`.gltf`/`.ply` extension

**Caveats:**
- `encodedBodySize` is 0 for cross-origin responses without a proper `Timing-Allow-Origin` header. The museum's MinIO origin must set `Timing-Allow-Origin: *` (or matching origin) for asset bytes to count — otherwise `total_bytes` is a vast underestimate.
- `window_ms` measures the network burst, not "time the user waited" — parsing + GPU setup happen after. See `glb_parse_ms_*` for that.

---

## GPU workload (per phase, per frame)

All GPU metrics come from `WebGLRenderingContext.prototype` patches installed via `addInitScript` before THREE constructs its renderer. The patches accumulate per-call counters; the in-page rAF collector reads-and-resets them each frame and attributes the per-frame totals to all currently active phases.

### `draw_calls_avg`, `draw_calls_p95`, `draw_calls_max`

**How:** Patches on `drawElements`, `drawArrays`, `drawElementsInstanced`, `drawArraysInstanced` increment a counter on every call. The rAF loop captures the per-frame total before resetting.

- avg = mean across all frames in the phase
- p95 = 95th percentile per-frame draw call count
- max = single worst frame

**What changes this:** material count, mesh count, instancing usage, frustum culling efficiency.

### `triangles_avg`, `triangles_p95`, `triangles_max`

**How:** Same patches compute triangle count from `(mode, count)`:
- `TRIANGLES` (mode=4) → `count / 3`
- `TRIANGLE_STRIP` (5), `TRIANGLE_FAN` (6) → `count - 2`
- Other modes (POINTS, LINES, LINE_STRIP, LINE_LOOP) → 0 (we only track rendered triangles)
- Instanced calls multiply by `primcount`

**Caveat:** This is "triangles submitted to GPU per frame", not "triangles visible". GPU early-Z, occlusion, and Hi-Z can drop a large fraction before rasterization. The number reflects CPU→GPU command stream, which is what FE controls.

### `texture_bytes_total`

**How:** Patches on `texImage2D`, `texSubImage2D`, `compressedTexImage2D`, `compressedTexSubImage2D` estimate bytes uploaded per call:
- Compressed uploads: exact `data.byteLength` (this is the on-GPU footprint of the compressed block)
- Uncompressed with explicit dims: `width × height × bpp(format, type)` (lookup table for RGBA/RGB/LUMINANCE × UNSIGNED_BYTE/SHORT/FLOAT/HALF_FLOAT)
- Uncompressed with image-source overload (6-arg form): `source.naturalWidth × naturalHeight × bpp` with RGBA8 fallback
- Sum across all frames in the phase

**Caveats:**
- Counts every mipmap level separately (each `texImage2D` call uploads one level). This is correct — each level uses GPU bandwidth and memory.
- **Counts render target allocations** when called with `pixels=null`. Render targets allocate GPU memory but don't transfer CPU→GPU data. Inflates the number by render-target sizes (typically a few MB to ~50MB).
- For a real 8K HDR cubemap with PMREM mips, the number is legitimately ~1GB. That's not a bug.

### `texture_upload_ms_total`

**How:** Each `tex*Image2D` patch wraps the original call with `performance.now()` before/after; the elapsed time is accumulated into a per-frame counter. Sum per phase = total wall-clock time the main thread spent in texture upload calls.

**What this measures:** CPU-side time including format conversion, mipmap generation queuing, and any driver-internal blocking. It is NOT GPU transfer time — that happens asynchronously after the WebGL call returns.

**Useful for:** spotting frames where a synchronous upload of a huge texture stalls the main thread (which `frame_time_p99_ms` reflects).

### `buffer_data_calls_total`, `buffer_data_bytes_total`, `buffer_data_ms_total`

**How:** Patches on `bufferData` count calls, sum bytes (from `sizeOrData.byteLength` if typed array, else the raw `size` arg), and wrap with `performance.now()` for timing.

**What this measures:** geometry upload to GPU. Each `THREE.BufferAttribute` triggers one `bufferData` per call. Useful diff between FF on/off if mesh decimation is in scope.

### `programs_added`

**How:** `createProgram` patch adds returned WebGLProgram objects to a `Set`. `programs_added` = `Set.size at endPhase` minus `Set.size at startPhase`.

**What this measures:** shader compilation count during the phase. New materials → new shader variants → expensive `compileShader`/`linkProgram` calls that stall the GPU pipeline.

**Useful for:** confirming a feature flag actually reduces shader variants (a common optimization target).

### `gpu_frame_time_ms_avg`, `gpu_frame_time_ms_p95`, `gpu_frame_time_ms_max`, `gpu_frame_time_samples`

**How:** Async GPU timer query via `EXT_disjoint_timer_query_webgl2` (WebGL2) or `EXT_disjoint_timer_query` (WebGL1 fallback). The rAF loop calls `__gpuStats.tickGpuFrame()` each tick which:
1. Polls all pending queries for completion (results arrive 1-3 frames after the frame they measured)
2. Ends the previously-active query (captures everything the GPU did between rAFs N-1 and N — that's THREE's full render of frame N-1 plus browser composite)
3. Begins a new query for the upcoming frame

The driver's `GPU_DISJOINT_EXT` flag is checked before reading — if the GPU clock was disjoint during the query (rare on dedicated GPUs, sometimes happens on shared/integrated), that sample is discarded as unreliable.

**Pair with `frame_time_p95_ms` to identify the bottleneck:**
- `gpu_frame_time ≈ frame_time` → GPU-bound (shrink textures/triangles to win)
- `gpu_frame_time << frame_time` → CPU-bound (JS/scene-update is the cost; GPU is idle)
- `gpu_frame_time_p95 ≫ gpu_frame_time_avg` → GPU stutters (likely shader compile or huge upload during render)

**Caveats:**
- `gpu_frame_time_samples` may be lower than the `frames.samples` count if the extension is unavailable in the running browser (some headless / VM environments without proper GPU passthrough). Check the `samples` field before trusting the average.
- Aggregates ALL completed queries arriving during the phase. Slight skew (~50ms at 60fps) possible because a query's result may land in a different phase than where the work happened — fine for averages over long phases, less accurate for sub-second phases.

### `glb_parse_count`, `glb_parse_ms_median`, `glb_parse_ms_p95`, `glb_parse_ms_max`, `glb_bytes_total`

**How:** Two coordinated hooks track each `.glb`/`.gltf`/`.ply` file from network done to GPU ready:

1. **Fetch hook** wraps `window.fetch` and `XMLHttpRequest.send` for URLs matching the mesh extension regex. When the response's `arrayBuffer()` resolves (bytes are CPU-side ready), the tracker records `{url, fetchedAt: performance.now(), bytes}` into a `pending[]` queue.
2. **`bufferData` hook** (already used for byte tracking) additionally calls `tracker.markBufferData(performance.now())`. The tracker shifts the oldest `pending` entry into `completed[]` and computes `parseTimeMs = bufferDataAt - fetchedAt`.

At `startPhase` the collector snapshots `completed.length`; at `endPhase` it slices everything added after that → those parses are attributed to this phase.

**What this measures:** wall-clock time from "GLTFLoader has the bytes" to "first geometry buffer uploaded to GPU". Covers: `JSON.parse` of glTF header, BufferGeometry construction, BufferAttribute setup, and the initial GPU bufferData call. Does NOT cover the network download itself (that is `assets_*.window_ms`) and does NOT cover material/texture setup (those happen separately, captured by `programs_added` and `texture_*`).

**Caveats:**
- Pairing is FIFO. For sequential loads (the common case — one room model loads at a time) attribution is exact. For concurrent loads of multiple `.glb` files the times may be swapped between files. The aggregate count and total remain correct.
- First `bufferData` after fetch is a heuristic. If the first call uploaded a small index buffer before the main vertex buffer, parse time is slightly underestimated. The error is typically a few ms.
- Skipped if `__gltfParseTracker` or `__gpuStats` failed to install (logged at page-init time).

---

## Reliability counters

### `target_room_reloads`, `next_room_reloads`

**How:** Counted in the test driver. `ensureRoomLoadedWithRetry` probes whether the room mesh is loaded after spawn (by walking a small distance and checking the camera moved). If the walk distance is below threshold (player is nose-to-wall or scene didn't load), the page is reloaded and counted.

**0 = first try worked.** Anything `>0` per iteration means the room failed initial load and needed a reload.

---

## Run folders and delta vs previous

Each run lands in `${BENCH_OUTPUT_DIR}/<start>_to_<end>/` (or `<start>__running/` while in progress). The reporter auto-generates `delta.csv` comparing the current run against the **most recent previously completed** run in `BENCH_OUTPUT_DIR`. No manual labelling — to do a before/after toggle you just: bench → flip the FE feature flag → bench again → open `delta.csv` in the second run's folder.

Example `delta.csv`:

```
starting_room,phase,metric,prev_median,curr_median,delta,delta_pct,prev_run=2026-05-21T22-30-15_to_2026-05-21T22-58-04,curr_run=2026-05-22T10-12-50_to_2026-05-22T10-40-30
torino/hallway-1,target_room_walk,fps_avg,58.4,73.1,14.7,25.2,,
torino/hallway-1,target_room_walk,triangles_avg,850000,320000,-530000,-62.4,,
torino/hallway-1,target_room_walk,texture_bytes_total,47185920,12582912,-34603008,-73.3,,
torino/hallway-1,target_room_walk,gpu_frame_time_ms_avg,18.6,9.4,-9.2,-49.5,,
torino/hallway-1,transition_to_target,glb_parse_ms_median,184.2,72.8,-111.4,-60.5,,
```

The delta set includes: `fps_avg`, `fps_p5_low`, `frame_time_p95_ms`, `heap_mb_max`, `duration_ms`, `draw_calls_avg`, `triangles_avg`, `texture_bytes_total`, `texture_upload_ms_total`, `buffer_data_bytes_total`, `buffer_data_ms_total`, `programs_added`, `gpu_frame_time_ms_avg`, `gpu_frame_time_ms_p95`, `glb_parse_ms_median`. Add more by editing the `DELTA_METRICS` array in `reporter.ts`.

If no prior run exists in `BENCH_OUTPUT_DIR`, `delta.csv` is silently skipped (the first run has nothing to diff against).

---

## What's NOT measured (and why)

| Metric | Why not |
|---|---|
| `time_to_interactive_ms` per W3C TTI | Requires Long Tasks observer + network quiescence detection over a 5-second window. Approximated by `transition_to_target.duration_ms`. |
| **Real VRAM (GPU memory used)** | **Not accessible in modern Chrome — confirmed 2026-05-22 via two independent probes.** `chrome.gpuBenchmarking.getGpuMemoryUsedInBytes()` was removed (the 44 methods that remain on `gpuBenchmarking` cover GPU process control, driver info, input simulation — none expose memory). CDP `Performance.getMetrics` returns 36 metrics (JS heap, DOM, paint, CPU) but no GPU memory. `Memory.getProcessMemoryInfo` and `SystemInfo.getProcessInfo` don't exist. Only path remaining is HTML-scraping `chrome://gpu` page — too fragile. **Proxy:** `texture_bytes_total + buffer_data_bytes_total` per phase tracks the GPU memory the FE explicitly uploads, which is the actionable signal anyway. |
| Per-shader compile time | Requires hook on `compileShader`/`linkProgram`. Useful but increases hook surface. |
| Texture decode time (BASIS/KTX2) | Happens in the BasisTranscoder Web Worker which is opaque to our hooks. Workers don't share `__gpuStats` global. |
| `WEBGL_multi_draw` and `drawElementsBaseVertex` (WebGL2) | Not hooked. These are called on extension objects returned by `getExtension`, not on the WebGL context prototype. If THREE uses `multi_draw` for merged static geometry, those draw calls + triangles are invisible. Verify with `gl.getExtension('WEBGL_multi_draw')` returning truthy on your target build — if so, this gap matters; otherwise no impact. |

## Caveats with wrapper phases (`target_room_visit`, `next_room_visit`)

The OVERLAPPING phase model attributes each frame to ALL active phases simultaneously. Wrapper phases like `target_room_visit` span the entire stay in a room (idle + walk + POI), so during `target_room_idle` BOTH `target_room_idle` and `target_room_visit` receive the same frame samples and GPU counters.

This means **wrapper totals are NOT independent of child totals**: `target_room_visit.texture_bytes_total` is the SUM of texture uploads attributable to `target_room_idle` + `target_room_walk` + `target_room_poi_open`. Never sum wrapper + children in roll-up code — you'll double- or triple-count.

The wrapper exists to give a single "stay in room" number for delta comparison; the children break it down by activity. They're complementary, not additive.

---

## Reading the numbers in practice

A typical "is FF on/off making a real difference?" pass:

1. Identify the BOTTLENECK first via **`gpu_frame_time_ms_avg` vs `cpu_frame_time_ms_avg`**:
   - GPU dominates → optimizing assets (triangles, textures) helps directly
   - CPU dominates → asset optimization may not move FPS at all; look at `long_tasks_total_ms`, `heap_mb_max`, scene complexity, React render churn
2. Compare **`triangles_avg` + `texture_bytes_total` + `buffer_data_bytes_total`** per room — these are the inputs you control via asset tier and what FE pushes to GPU.
3. Compare **`draw_calls_avg`** — drops if FF unifies materials or instancing kicks in more aggressively.
4. THEN look at **`fps_avg` + `frame_time_p95_ms`** — these are the outputs that downstream value depends on.
5. If 2-3 moved but 4 didn't → bottleneck is on the other side (if GPU-bound check shadowmap/postprocess overhead; if CPU-bound check JS pressure).
6. If 4 moved without 2-3 moving → either GC pressure, measurement noise, or browser-internal optimizations kicking in differently; rerun with more iterations.
