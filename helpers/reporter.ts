import * as fs from "node:fs";
import * as path from "node:path";

import type { AssetMetrics, PhaseSnapshot } from "./phases.js";
import { fpsStats, max, mean, median, min, percentile, round, stddev } from "./stats.js";

/**
 * Convert a raw collector snapshot into computed PhaseMetrics (FPS lows, frame
 * time p95, heap stats, long-task aggregate). Returns null if the phase has no
 * samples (was skipped or didn't run long enough for any rAF callbacks).
 */
export function computePhaseMetrics(snap: PhaseSnapshot | undefined): PhaseMetrics | null {
  if (!snap || snap.frames.length === 0) return null;
  const fps = fpsStats(snap.frames);
  const longTotal = snap.longTasks.reduce((s, t) => s + t.duration, 0);
  const heapUsed = snap.heap.map((h) => h.used);
  const heapAlloc = (snap.heapTotal || []).map((h) => h.total);
  const domCounts = (snap.domNodes || []).map((d) => d.count);
  const mb = (n: number) => round(n / (1024 * 1024), 1);

  // GPU workload — per-frame samples from WebGL prototype patches. May be missing
  // on older snapshots or if the hook didn't install; treat as empty in that case.
  const drawCalls = snap.drawCalls || [];
  const triangles = snap.triangles || [];
  const textureBytes = snap.textureBytes || [];
  const textureUploadMs = snap.textureUploadMs || [];
  const bufferDataCalls = snap.bufferDataCalls || [];
  const bufferDataBytes = snap.bufferDataBytes || [];
  const bufferDataMs = snap.bufferDataMs || [];
  const textureBytesTotal = textureBytes.reduce((s, x) => s + x, 0);
  const textureUploadMsTotal = textureUploadMs.reduce((s, x) => s + x, 0);
  const bufferDataCallsTotal = bufferDataCalls.reduce((s, x) => s + x, 0);
  const bufferDataBytesTotal = bufferDataBytes.reduce((s, x) => s + x, 0);
  const bufferDataMsTotal = bufferDataMs.reduce((s, x) => s + x, 0);
  const programsStart = snap.programsStart ?? -1;
  const programsEnd = snap.programsEnd ?? -1;
  const programsDelta = programsStart >= 0 && programsEnd >= 0 ? programsEnd - programsStart : 0;

  // GPU frame time via EXT_disjoint_timer_query. Empty if extension unavailable
  // (some headless/VM environments). Single representative number = median +
  // p95/max for stutter analysis.
  const gpuFrameTimes = snap.gpuFrameTimesMs || [];

  // GLB parses completed during this phase (paired by Resource Timing observer +
  // first ARRAY_BUFFER bufferData ≥16KB).
  const glbSamples = snap.glbParseSamples || [];
  const glbParseTimes = glbSamples.map((s) => s.parseTimeMs).filter((n) => Number.isFinite(n));
  const glbBytesTotal = glbSamples.reduce((s, e) => s + (e.bytes || 0), 0);

  return {
    duration_ms: Math.round(Math.max(0, snap.endTs - snap.startTs)),
    fps: {
      avg: round(fps.avg, 1),
      p1_low: round(fps.p1_low, 1),
      p5_low: round(fps.p5_low, 1),
      min_fps: round(fps.min_fps, 1),
      max_fps: round(fps.max_fps, 1),
      frame_time_p95_ms: round(fps.frame_time_p95_ms, 2),
      frame_time_p99_ms: round(fps.frame_time_p99_ms, 2),
      max_frame_time_ms: round(fps.max_frame_time_ms, 2),
      samples: snap.frames.length,
      // Derived: CPU time per frame = total frame time - GPU time per frame.
      // Reflects work the main thread did between rAFs (JS, layout, React renders,
      // scene graph updates, etc). Clamped to 0 because pipelining means GPU time can
      // briefly overlap multiple frames and yield small negative values. Reported as 0
      // when GPU timer-query extension wasn't available (no signal to subtract).
      cpu_frame_time_ms_avg: gpuFrameTimes.length
        ? round(Math.max(0, mean(snap.frames) - mean(gpuFrameTimes)), 2)
        : 0,
      cpu_frame_time_ms_p95: gpuFrameTimes.length
        ? round(Math.max(0, fps.frame_time_p95_ms - percentile(gpuFrameTimes, 95)), 2)
        : 0,
    },
    long_tasks: { count: snap.longTasks.length, total_ms: round(longTotal, 1) },
    heap_mb: {
      avg: heapUsed.length ? mb(mean(heapUsed)) : 0,
      max: heapUsed.length ? mb(Math.max(...heapUsed)) : 0,
    },
    heap_total_mb: {
      avg: heapAlloc.length ? mb(mean(heapAlloc)) : 0,
      max: heapAlloc.length ? mb(Math.max(...heapAlloc)) : 0,
    },
    dom_nodes: {
      avg: domCounts.length ? Math.round(mean(domCounts)) : 0,
      max: domCounts.length ? Math.max(...domCounts) : 0,
    },
    gpu: {
      draw_calls_avg: drawCalls.length ? Math.round(mean(drawCalls)) : 0,
      draw_calls_p95: drawCalls.length ? Math.round(percentile(drawCalls, 95)) : 0,
      draw_calls_max: drawCalls.length ? Math.max(...drawCalls) : 0,
      triangles_avg: triangles.length ? Math.round(mean(triangles)) : 0,
      triangles_p95: triangles.length ? Math.round(percentile(triangles, 95)) : 0,
      triangles_max: triangles.length ? Math.max(...triangles) : 0,
      texture_bytes_total: textureBytesTotal,
      texture_upload_ms_total: round(textureUploadMsTotal, 2),
      buffer_data_calls_total: bufferDataCallsTotal,
      buffer_data_bytes_total: bufferDataBytesTotal,
      buffer_data_ms_total: round(bufferDataMsTotal, 2),
      programs_added: programsDelta,
      gpu_frame_time_ms_avg: gpuFrameTimes.length ? round(mean(gpuFrameTimes), 2) : 0,
      gpu_frame_time_ms_p95: gpuFrameTimes.length ? round(percentile(gpuFrameTimes, 95), 2) : 0,
      gpu_frame_time_ms_max: gpuFrameTimes.length ? round(Math.max(...gpuFrameTimes), 2) : 0,
      gpu_frame_time_samples: gpuFrameTimes.length,
      glb_parse_count: glbSamples.length,
      glb_parse_ms_median: glbParseTimes.length ? round(median(glbParseTimes), 1) : 0,
      glb_parse_ms_p95: glbParseTimes.length ? round(percentile(glbParseTimes, 95), 1) : 0,
      glb_parse_ms_max: glbParseTimes.length ? round(Math.max(...glbParseTimes), 1) : 0,
      glb_bytes_total: glbBytesTotal,
    },
  };
}

export interface RunMeta {
  git_sha: string | null;
  chrome_user_agent: string | null;
  gpu_renderer: string | null;
  gpu_vendor: string | null;
  config_snapshot: Record<string, unknown>;
  started_at: string;
  /** Set by Reporter.finalize() once all iterations are done. */
  ended_at?: string;
  /** Host machine info captured at run start (os, cpu, ram). */
  host_info?: import("./hostInfo.js").HostInfo;
  /** Backend feature-flag state at run start. Critical for comparability: a FF-off
   * baseline must never be diffed against a FF-on run by accident. null = unknown
   * (API URL unresolved). */
  feature_flags?: Record<string, boolean> | null;
}

export interface IterationResult {
  starting_room: string; // the BENCH_ROOMS entry (museum/room) for this iteration
  iteration: number;
  timestamp: string;
  assets_lobby: AssetMetrics | null;
  assets_target_room: AssetMetrics | null;
  assets_next_room: AssetMetrics | null;
  phases: Record<string, PhaseMetrics>;
  webgl_contexts_peak?: number;
  /** Reloads needed to get target room mesh to load. 0 = first try worked. */
  target_room_reloads?: number;
  /** Reloads needed to get next room mesh to load. 0 = first try worked. */
  next_room_reloads?: number;
  notes?: string[];
  /** Optional debug payload — state of hooks at end of iteration. Used to diagnose
   * "metric reports 0" cases (which hook fired, which API was/wasn't available). */
  diagnostics?: unknown;
}

export interface PhaseMetrics {
  duration_ms: number;
  fps: {
    avg: number;
    p1_low: number;
    p5_low: number;
    min_fps: number;
    max_fps: number;
    frame_time_p95_ms: number;
    frame_time_p99_ms: number;
    max_frame_time_ms: number;
    samples: number;
    /** Derived: total frame time minus GPU frame time. 0 if GPU timer query unavailable. */
    cpu_frame_time_ms_avg: number;
    cpu_frame_time_ms_p95: number;
  };
  long_tasks: { count: number; total_ms: number };
  heap_mb: { avg: number; max: number };
  heap_total_mb: { avg: number; max: number };
  dom_nodes: { avg: number; max: number };
  gpu: {
    draw_calls_avg: number;
    draw_calls_p95: number;
    draw_calls_max: number;
    triangles_avg: number;
    triangles_p95: number;
    triangles_max: number;
    texture_bytes_total: number;
    /** Total wall-clock ms spent in texImage2D/compressed* calls during the phase. */
    texture_upload_ms_total: number;
    /** Total bufferData calls (geometry uploads to GPU) during the phase. */
    buffer_data_calls_total: number;
    /** Total bytes of geometry uploaded to GPU during the phase. */
    buffer_data_bytes_total: number;
    /** Total wall-clock ms spent inside bufferData calls during the phase. */
    buffer_data_ms_total: number;
    programs_added: number;
    /** GPU time per frame (ms) via EXT_disjoint_timer_query. 0 if extension unavailable.
     * Pair with frame_time_p95_ms to identify CPU-bound vs GPU-bound: if gpu_frame_time
     * ≈ frame_time then GPU-bound; if gpu_frame_time << frame_time then CPU-bound. */
    gpu_frame_time_ms_avg: number;
    gpu_frame_time_ms_p95: number;
    gpu_frame_time_ms_max: number;
    gpu_frame_time_samples: number;
    /** GLB/GLTF/PLY parses (resource entry responseEnd → first bufferData) completed during the phase. */
    glb_parse_count: number;
    glb_parse_ms_median: number;
    glb_parse_ms_p95: number;
    glb_parse_ms_max: number;
    /** Sum of bytes of .glb/.gltf/.ply files parsed during the phase. */
    glb_bytes_total: number;
  };
}

// Reflects the actual flow: lobby → (transition) → target room visit (idle, POI, portal search) → portal → next room visit
const PHASE_ORDER = [
  "lobby_idle",
  "transition_to_target",
  "target_room_visit",
  "target_room_idle",
  "target_room_walk",
  "target_room_poi_open",
  "transition_to_next",
  "next_room_visit",
  "next_room_idle",
  "next_room_walk",
] as const;

const ROOM_ASSET_KEYS = ["assets_lobby", "assets_target_room", "assets_next_room"] as const;

/** ISO timestamp with `:` replaced by `-` so it's filesystem-safe on Windows. */
function fsSafeTs(d: Date = new Date()): string {
  return d.toISOString().replace(/:/g, "-").replace(/\..+$/, "");
}

const RUNNING_SUFFIX = "__running";

/** Metrics included in delta.csv per (room × phase). Order = display order. */
const DELTA_METRICS: Array<[string, (p: PhaseMetrics) => number | undefined]> = [
  ["fps_avg", (p) => p?.fps?.avg],
  ["fps_p5_low", (p) => p?.fps?.p5_low],
  ["frame_time_p95_ms", (p) => p?.fps?.frame_time_p95_ms],
  ["heap_mb_max", (p) => p?.heap_mb?.max],
  ["duration_ms", (p) => p?.duration_ms],
  ["draw_calls_avg", (p) => p?.gpu?.draw_calls_avg],
  ["triangles_avg", (p) => p?.gpu?.triangles_avg],
  ["texture_bytes_total", (p) => p?.gpu?.texture_bytes_total],
  ["texture_upload_ms_total", (p) => p?.gpu?.texture_upload_ms_total],
  ["buffer_data_bytes_total", (p) => p?.gpu?.buffer_data_bytes_total],
  ["buffer_data_ms_total", (p) => p?.gpu?.buffer_data_ms_total],
  ["programs_added", (p) => p?.gpu?.programs_added],
  ["gpu_frame_time_ms_avg", (p) => p?.gpu?.gpu_frame_time_ms_avg],
  ["gpu_frame_time_ms_p95", (p) => p?.gpu?.gpu_frame_time_ms_p95],
  ["cpu_frame_time_ms_avg", (p) => p?.fps?.cpu_frame_time_ms_avg],
  ["cpu_frame_time_ms_p95", (p) => p?.fps?.cpu_frame_time_ms_p95],
  ["glb_parse_ms_median", (p) => p?.gpu?.glb_parse_ms_median],
];

export class Reporter {
  private results: IterationResult[] = [];
  private baseDir: string;
  private _runDir: string;
  private meta: RunMeta | null = null;
  private startTs: string;

  /**
   * @param baseDir parent directory for all runs (e.g. `./results`). Each run lands in
   *  a timestamped subfolder: while running `<start>__running/`, renamed by `finalize()`
   *  to `<start>_to_<end>/`. `delta.csv` compares against the most-recent prior completed
   *  run in `baseDir`.
   */
  constructor(baseDir: string) {
    this.baseDir = baseDir;
    fs.mkdirSync(baseDir, { recursive: true });
    this.startTs = fsSafeTs();
    this._runDir = path.join(baseDir, `${this.startTs}${RUNNING_SUFFIX}`);
    fs.mkdirSync(this._runDir, { recursive: true });
  }

  /** Per-run output directory. Callers writing logs/screenshots should use this. */
  get runDir(): string {
    return this._runDir;
  }

  /** Base directory shared across runs. Callers needing files that MUST NOT be renamed
   * mid-run (e.g. Playwright video files held open until context close) should use this. */
  get baseRunDir(): string {
    return this.baseDir;
  }

  /** Stable identifier for this run — the start timestamp used in the folder name.
   * Useful for naming sibling artifacts (e.g. videos in baseDir) so they don't collide. */
  get runId(): string {
    return this.startTs;
  }

  /** Read-only snapshot of accumulated iteration results. For HTML/JSON renderers. */
  getResults(): readonly IterationResult[] {
    return this.results;
  }

  /** Current run metadata (git_sha, gpu_renderer, started_at, etc). */
  getMeta(): RunMeta | null {
    return this.meta;
  }

  setMeta(meta: RunMeta): void {
    this.meta = meta;
    this.flushIterations();
  }

  /** Partial update of run meta — useful for fields detected after run start
   * (e.g. chrome_user_agent / gpu_renderer captured after first page boot). */
  updateMeta(patch: Partial<RunMeta>): void {
    if (!this.meta) return;
    this.meta = { ...this.meta, ...patch };
    this.flushIterations();
  }

  add(r: IterationResult): void {
    this.results.push(r);
    this.flushIterations();
  }

  private flushIterations(): void {
    const payload = { run_meta: this.meta, iterations: this.results };
    fs.writeFileSync(path.join(this._runDir, "iterations.json"), JSON.stringify(payload, null, 2));
  }

  /**
   * Mark the run complete. Renames `<start>__running/` → `<start>_to_<end>/`,
   * sets `meta.ended_at`, flushes iterations.json. Safe to call once at afterAll.
   */
  finalize(): void {
    const endTs = fsSafeTs();
    if (this.meta) this.meta.ended_at = new Date().toISOString();
    const finalDir = path.join(this.baseDir, `${this.startTs}_to_${endTs}`);
    try {
      if (this._runDir !== finalDir) {
        fs.renameSync(this._runDir, finalDir);
        this._runDir = finalDir;
      }
    } catch (e) {
      // Rename failed (file lock, permissions). Keep the __running dir.
      // eslint-disable-next-line no-console
      console.warn(`[reporter] finalize rename failed: ${(e as Error).message}`);
    }
    this.flushIterations();
  }

  writeSummary(): void {
    const lines: string[] = ["starting_room,phase,metric,n,median,p95,mean,std,min,max"];
    const byRoom = groupBy(this.results, (r) => r.starting_room);

    for (const [room, results] of Object.entries(byRoom)) {
      // Per-room asset windows (lobby / target_room / next_room)
      for (const key of ROOM_ASSET_KEYS) {
        const windows = results.map((r) => r[key]?.window_ms).filter(isNum);
        const bytes = results.map((r) => r[key]?.total_bytes).filter(isNum);
        const counts = results.map((r) => r[key]?.count).filter(isNum);
        const meshCounts = results.map((r) => r[key]?.mesh_count).filter(isNum);
        addRow(lines, room, key, "window_ms", windows);
        addRow(lines, room, key, "total_bytes", bytes);
        addRow(lines, room, key, "count", counts);
        addRow(lines, room, key, "mesh_count", meshCounts);
      }

      // WebGL context peak (per-iteration scalar)
      const webglPeaks = results.map((r) => r.webgl_contexts_peak).filter(isNum);
      addRow(lines, room, "webgl", "contexts_peak", webglPeaks);

      // Room-load reliability — how often the FE needed a reload
      const targetReloads = results.map((r) => r.target_room_reloads).filter(isNum);
      const nextReloads = results.map((r) => r.next_room_reloads).filter(isNum);
      addRow(lines, room, "room_load", "target_reloads", targetReloads);
      addRow(lines, room, "room_load", "next_reloads", nextReloads);

      // Per-phase runtime metrics
      for (const phase of PHASE_ORDER) {
        const pick = (sel: (p: PhaseMetrics) => number | undefined): number[] =>
          results.map((r) => sel(r.phases[phase]!)).filter(isNum);

        addRow(lines, room, phase, "fps_avg", pick((p) => p?.fps?.avg));
        addRow(lines, room, phase, "fps_p1_low", pick((p) => p?.fps?.p1_low));
        addRow(lines, room, phase, "fps_p5_low", pick((p) => p?.fps?.p5_low));
        addRow(lines, room, phase, "min_fps", pick((p) => p?.fps?.min_fps));
        addRow(lines, room, phase, "max_fps", pick((p) => p?.fps?.max_fps));
        addRow(lines, room, phase, "frame_time_p95_ms", pick((p) => p?.fps?.frame_time_p95_ms));
        addRow(lines, room, phase, "frame_time_p99_ms", pick((p) => p?.fps?.frame_time_p99_ms));
        addRow(lines, room, phase, "max_frame_time_ms", pick((p) => p?.fps?.max_frame_time_ms));
        addRow(lines, room, phase, "cpu_frame_time_ms_avg", pick((p) => p?.fps?.cpu_frame_time_ms_avg));
        addRow(lines, room, phase, "cpu_frame_time_ms_p95", pick((p) => p?.fps?.cpu_frame_time_ms_p95));
        addRow(lines, room, phase, "duration_ms", pick((p) => p?.duration_ms));
        addRow(lines, room, phase, "long_tasks_count", pick((p) => p?.long_tasks?.count));
        addRow(lines, room, phase, "long_tasks_total_ms", pick((p) => p?.long_tasks?.total_ms));
        addRow(lines, room, phase, "heap_mb_avg", pick((p) => p?.heap_mb?.avg));
        addRow(lines, room, phase, "heap_mb_max", pick((p) => p?.heap_mb?.max));
        addRow(lines, room, phase, "heap_total_mb_max", pick((p) => p?.heap_total_mb?.max));
        addRow(lines, room, phase, "dom_nodes_max", pick((p) => p?.dom_nodes?.max));
        addRow(lines, room, phase, "draw_calls_avg", pick((p) => p?.gpu?.draw_calls_avg));
        addRow(lines, room, phase, "draw_calls_p95", pick((p) => p?.gpu?.draw_calls_p95));
        addRow(lines, room, phase, "draw_calls_max", pick((p) => p?.gpu?.draw_calls_max));
        addRow(lines, room, phase, "triangles_avg", pick((p) => p?.gpu?.triangles_avg));
        addRow(lines, room, phase, "triangles_p95", pick((p) => p?.gpu?.triangles_p95));
        addRow(lines, room, phase, "triangles_max", pick((p) => p?.gpu?.triangles_max));
        addRow(lines, room, phase, "texture_bytes_total", pick((p) => p?.gpu?.texture_bytes_total));
        addRow(lines, room, phase, "texture_upload_ms_total", pick((p) => p?.gpu?.texture_upload_ms_total));
        addRow(lines, room, phase, "buffer_data_calls_total", pick((p) => p?.gpu?.buffer_data_calls_total));
        addRow(lines, room, phase, "buffer_data_bytes_total", pick((p) => p?.gpu?.buffer_data_bytes_total));
        addRow(lines, room, phase, "buffer_data_ms_total", pick((p) => p?.gpu?.buffer_data_ms_total));
        addRow(lines, room, phase, "programs_added", pick((p) => p?.gpu?.programs_added));
        addRow(lines, room, phase, "gpu_frame_time_ms_avg", pick((p) => p?.gpu?.gpu_frame_time_ms_avg));
        addRow(lines, room, phase, "gpu_frame_time_ms_p95", pick((p) => p?.gpu?.gpu_frame_time_ms_p95));
        addRow(lines, room, phase, "gpu_frame_time_ms_max", pick((p) => p?.gpu?.gpu_frame_time_ms_max));
        addRow(lines, room, phase, "gpu_frame_time_samples", pick((p) => p?.gpu?.gpu_frame_time_samples));
        addRow(lines, room, phase, "glb_parse_count", pick((p) => p?.gpu?.glb_parse_count));
        addRow(lines, room, phase, "glb_parse_ms_median", pick((p) => p?.gpu?.glb_parse_ms_median));
        addRow(lines, room, phase, "glb_parse_ms_p95", pick((p) => p?.gpu?.glb_parse_ms_p95));
        addRow(lines, room, phase, "glb_parse_ms_max", pick((p) => p?.gpu?.glb_parse_ms_max));
        addRow(lines, room, phase, "glb_bytes_total", pick((p) => p?.gpu?.glb_bytes_total));
      }
    }

    fs.writeFileSync(path.join(this._runDir, "summary.csv"), lines.join("\n") + "\n");
  }

  /**
   * Find the most-recent COMPLETED prior run in baseDir (folders ending `_to_<ts>`,
   * excluding the current run and any `__running/` strays). Load its iterations.json
   * and compute deltas vs the current run's results. No-op if no prior run exists.
   */
  writeDeltaVsPrevious(): void {
    let prior: { dir: string; results: IterationResult[] } | null = null;
    try {
      const entries = fs
        .readdirSync(this.baseDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.endsWith(RUNNING_SUFFIX) && path.join(this.baseDir, e.name) !== this._runDir)
        .map((e) => e.name)
        .sort(); // ISO-ish names sort lexicographically === chronologically
      for (let i = entries.length - 1; i >= 0; i--) {
        const candidate = path.join(this.baseDir, entries[i]!);
        const itPath = path.join(candidate, "iterations.json");
        if (!fs.existsSync(itPath)) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(itPath, "utf-8")) as { iterations?: IterationResult[] };
          if (parsed.iterations && parsed.iterations.length > 0) {
            prior = { dir: candidate, results: parsed.iterations };
            break;
          }
        } catch {
          // skip malformed prior run
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[reporter] could not scan baseDir for prior runs: ${(e as Error).message}`);
      return;
    }

    if (!prior) {
      // eslint-disable-next-line no-console
      console.log("[reporter] no prior run found — skipping delta.csv");
      return;
    }

    const priorName = path.basename(prior.dir);
    const currName = path.basename(this._runDir);
    // eslint-disable-next-line no-console
    console.log(`[reporter] delta vs prior run: ${priorName}`);

    // CSV includes std-dev of both runs so a reader can sanity-check whether
    // the delta is larger than the noise floor (rough check: |delta| > 2× max(stds)
    // → likely real signal; < that → likely measurement noise).
    const lines: string[] = [
      `starting_room,phase,metric,prev_median,curr_median,delta,delta_pct,prev_std,curr_std,prev_run=${priorName},curr_run=${currName}`,
    ];
    const currByRoom = groupBy(this.results, (r) => r.starting_room);
    const prevByRoom = groupBy(prior.results, (r) => r.starting_room);

    const allRooms = new Set([...Object.keys(currByRoom), ...Object.keys(prevByRoom)]);
    for (const room of allRooms) {
      const currResults = currByRoom[room] || [];
      const prevResults = prevByRoom[room] || [];
      if (currResults.length === 0 || prevResults.length === 0) continue;

      for (const phase of PHASE_ORDER) {
        for (const [metric, sel] of DELTA_METRICS) {
          const currVals = currResults.map((r) => sel(r.phases[phase]!)).filter(isNum);
          const prevVals = prevResults.map((r) => sel(r.phases[phase]!)).filter(isNum);
          if (currVals.length === 0 || prevVals.length === 0) continue;
          const prevMed = median(prevVals);
          const currMed = median(currVals);
          const delta = currMed - prevMed;
          const deltaPct = prevMed !== 0 ? (delta / prevMed) * 100 : 0;
          const prevStd = stddev(prevVals);
          const currStd = stddev(currVals);
          lines.push(
            [room, phase, metric, fmt(prevMed), fmt(currMed), fmt(delta), fmt(deltaPct), fmt(prevStd), fmt(currStd), "", ""].join(","),
          );
        }
      }
    }
    fs.writeFileSync(path.join(this._runDir, "delta.csv"), lines.join("\n") + "\n");
  }

  printConsoleSummary(): void {
    const byRoom = groupBy(this.results, (r) => r.starting_room);

    console.log("");
    console.log("=".repeat(78));
    console.log("BENCHMARK SUMMARY");
    console.log("=".repeat(78));

    for (const [room, results] of Object.entries(byRoom)) {
      console.log("");
      console.log(`Starting room: ${room}  (n=${results.length})`);

      for (const key of ROOM_ASSET_KEYS) {
        const w = results.map((r) => r[key]?.window_ms).filter(isNum);
        const b = results.map((r) => r[key]?.total_bytes).filter(isNum);
        if (w.length === 0) {
          console.log(`  ${key.padEnd(18)} (no samples — phase did not complete)`);
        } else {
          console.log(
            `  ${key.padEnd(18)} window_ms median=${fmt(median(w))} p95=${fmt(percentile(w, 95))}  total_bytes median=${fmt(median(b))}`,
          );
        }
      }

      for (const phase of PHASE_ORDER) {
        const pick = (sel: (p: PhaseMetrics) => number | undefined): number[] =>
          results.map((r) => sel(r.phases[phase]!)).filter(isNum);

        const fpsAvg = pick((p) => p?.fps?.avg);
        if (fpsAvg.length === 0) {
          console.log(`  ${phase.padEnd(18)} (no samples — phase skipped)`);
          continue;
        }
        const fpsP5 = pick((p) => p?.fps?.p5_low);
        const ftP95 = pick((p) => p?.fps?.frame_time_p95_ms);
        const ftP99 = pick((p) => p?.fps?.frame_time_p99_ms);
        const dur = pick((p) => p?.duration_ms);
        const dcAvg = pick((p) => p?.gpu?.draw_calls_avg);
        const triAvg = pick((p) => p?.gpu?.triangles_avg);
        const txBytes = pick((p) => p?.gpu?.texture_bytes_total);
        console.log(
          `  ${phase.padEnd(22)} fps_avg=${fmt(median(fpsAvg))}  fps_p5=${fmt(median(fpsP5))}  frame_p95=${fmt(median(ftP95))}ms  frame_p99=${fmt(median(ftP99))}ms  dur=${fmt(median(dur))}ms`,
        );
        if (dcAvg.length > 0) {
          const triK = (n: number) => `${round(n / 1000, 1)}k`;
          const mb = (n: number) => `${round(n / (1024 * 1024), 1)}MB`;
          const txMs = pick((p) => p?.gpu?.texture_upload_ms_total);
          console.log(
            `  ${"".padEnd(22)}   draw_calls=${fmt(median(dcAvg))}  triangles=${triK(median(triAvg))}  texture_upload=${mb(median(txBytes))} (${fmt(median(txMs))}ms)`,
          );
          const gpuMs = pick((p) => p?.gpu?.gpu_frame_time_ms_avg);
          const cpuMs = pick((p) => p?.fps?.cpu_frame_time_ms_avg);
          const glbCount = pick((p) => p?.gpu?.glb_parse_count);
          const glbMed = pick((p) => p?.gpu?.glb_parse_ms_median);
          const parts: string[] = [];
          if (gpuMs.length > 0 && median(gpuMs) > 0) {
            parts.push(`gpu=${fmt(median(gpuMs))}ms`);
            if (cpuMs.length > 0) parts.push(`cpu=${fmt(median(cpuMs))}ms`);
          }
          if (glbCount.length > 0 && median(glbCount) > 0) {
            parts.push(`glb_parses=${fmt(median(glbCount))} median=${fmt(median(glbMed))}ms`);
          }
          if (parts.length > 0) console.log(`  ${"".padEnd(22)}   ${parts.join("  ")}`);
        }
      }

      // WebGL peak summary line
      const peaks = results.map((r) => r.webgl_contexts_peak).filter(isNum);
      if (peaks.length > 0) {
        console.log(`  ${"webgl".padEnd(18)} contexts_peak median=${fmt(median(peaks))}`);
      }

      // Room-load reliability summary
      const tr = results.map((r) => r.target_room_reloads).filter(isNum);
      const nr = results.map((r) => r.next_room_reloads).filter(isNum);
      if (tr.length > 0 || nr.length > 0) {
        const trTotal = tr.reduce((a, b) => a + b, 0);
        const nrTotal = nr.reduce((a, b) => a + b, 0);
        console.log(`  ${"room_load".padEnd(18)} reloads target=${trTotal}/${tr.length} next=${nrTotal}/${nr.length}`);
      }
    }
    console.log("");
    console.log(`Run dir:            ${path.resolve(this._runDir)}`);
    console.log(`Per-iteration data: ${path.resolve(this._runDir, "iterations.json")}`);
    console.log(`Summary CSV:        ${path.resolve(this._runDir, "summary.csv")}`);
    const deltaPath = path.join(this._runDir, "delta.csv");
    if (fs.existsSync(deltaPath)) console.log(`Delta CSV:          ${path.resolve(deltaPath)}`);
    console.log("");
  }
}

function addRow(
  lines: string[],
  room: string,
  phase: string,
  metric: string,
  values: number[],
): void {
  if (values.length === 0) {
    lines.push([room, phase, metric, "0", "", "", "", "", "", ""].join(","));
    return;
  }
  lines.push(
    [
      room,
      phase,
      metric,
      String(values.length),
      fmt(median(values)),
      fmt(percentile(values, 95)),
      fmt(mean(values)),
      fmt(stddev(values)),
      fmt(min(values)),
      fmt(max(values)),
    ].join(","),
  );
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && !Number.isNaN(v);
}

function fmt(n: number): string {
  return Number.isNaN(n) ? "" : String(round(n, 2));
}

function groupBy<T>(arr: T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (out[k] ||= []).push(item);
  }
  return out;
}
