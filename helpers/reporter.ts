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
  };
}

export interface RunMeta {
  bench_label: string | null;
  git_sha: string | null;
  chrome_user_agent: string | null;
  gpu_renderer: string | null;
  gpu_vendor: string | null;
  config_snapshot: Record<string, unknown>;
  started_at: string;
}

export interface IterationResult {
  starting_room: string; // the BENCH_ROOMS entry (museum/room) for this iteration
  iteration: number;
  timestamp: string;
  /** Optional run label (e.g. "ff-off" / "ff-on") for before/after comparison. */
  label: string | null;
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
  };
  long_tasks: { count: number; total_ms: number };
  heap_mb: { avg: number; max: number };
  heap_total_mb: { avg: number; max: number };
  dom_nodes: { avg: number; max: number };
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

export class Reporter {
  private results: IterationResult[] = [];
  private outDir: string;
  private meta: RunMeta | null = null;

  constructor(outDir: string) {
    this.outDir = outDir;
    fs.mkdirSync(outDir, { recursive: true });
  }

  setMeta(meta: RunMeta): void {
    this.meta = meta;
    this.flushIterations();
  }

  add(r: IterationResult): void {
    this.results.push(r);
    this.flushIterations();
  }

  private flushIterations(): void {
    const payload = { run_meta: this.meta, iterations: this.results };
    fs.writeFileSync(path.join(this.outDir, "iterations.json"), JSON.stringify(payload, null, 2));
  }

  writeSummary(): void {
    // CSV schema includes label column upfront for easy filtering / diff in spreadsheets
    const lines: string[] = ["label,starting_room,phase,metric,n,median,p95,mean,std,min,max"];
    const byLabelRoom = groupBy(this.results, (r) => `${r.label ?? ""}||${r.starting_room}`);

    for (const [key, results] of Object.entries(byLabelRoom)) {
      const [label, room] = key.split("||");
      // Per-room asset windows (lobby / target_room / next_room)
      for (const key of ROOM_ASSET_KEYS) {
        const windows = results.map((r) => r[key]?.window_ms).filter(isNum);
        const bytes = results.map((r) => r[key]?.total_bytes).filter(isNum);
        const counts = results.map((r) => r[key]?.count).filter(isNum);
        const meshCounts = results.map((r) => r[key]?.mesh_count).filter(isNum);
        addRow(lines, label ?? "", room ?? "", key, "window_ms", windows);
        addRow(lines, label ?? "", room ?? "", key, "total_bytes", bytes);
        addRow(lines, label ?? "", room ?? "", key, "count", counts);
        addRow(lines, label ?? "", room ?? "", key, "mesh_count", meshCounts);
      }

      const lbl = label ?? "";
      const rm = room ?? "";

      // WebGL context peak (per-iteration scalar)
      const webglPeaks = results.map((r) => r.webgl_contexts_peak).filter(isNum);
      addRow(lines, lbl, rm, "webgl", "contexts_peak", webglPeaks);

      // Room-load reliability — how often the FE needed a reload
      const targetReloads = results.map((r) => r.target_room_reloads).filter(isNum);
      const nextReloads = results.map((r) => r.next_room_reloads).filter(isNum);
      addRow(lines, lbl, rm, "room_load", "target_reloads", targetReloads);
      addRow(lines, lbl, rm, "room_load", "next_reloads", nextReloads);

      // Per-phase runtime metrics
      for (const phase of PHASE_ORDER) {
        const pick = (sel: (p: PhaseMetrics) => number | undefined): number[] =>
          results.map((r) => sel(r.phases[phase]!)).filter(isNum);

        addRow(lines, lbl, rm, phase, "fps_avg", pick((p) => p?.fps?.avg));
        addRow(lines, lbl, rm, phase, "fps_p1_low", pick((p) => p?.fps?.p1_low));
        addRow(lines, lbl, rm, phase, "fps_p5_low", pick((p) => p?.fps?.p5_low));
        addRow(lines, lbl, rm, phase, "min_fps", pick((p) => p?.fps?.min_fps));
        addRow(lines, lbl, rm, phase, "max_fps", pick((p) => p?.fps?.max_fps));
        addRow(lines, lbl, rm, phase, "frame_time_p95_ms", pick((p) => p?.fps?.frame_time_p95_ms));
        addRow(lines, lbl, rm, phase, "frame_time_p99_ms", pick((p) => p?.fps?.frame_time_p99_ms));
        addRow(lines, lbl, rm, phase, "max_frame_time_ms", pick((p) => p?.fps?.max_frame_time_ms));
        addRow(lines, lbl, rm, phase, "duration_ms", pick((p) => p?.duration_ms));
        addRow(lines, lbl, rm, phase, "long_tasks_count", pick((p) => p?.long_tasks?.count));
        addRow(lines, lbl, rm, phase, "long_tasks_total_ms", pick((p) => p?.long_tasks?.total_ms));
        addRow(lines, lbl, rm, phase, "heap_mb_avg", pick((p) => p?.heap_mb?.avg));
        addRow(lines, lbl, rm, phase, "heap_mb_max", pick((p) => p?.heap_mb?.max));
        addRow(lines, lbl, rm, phase, "heap_total_mb_max", pick((p) => p?.heap_total_mb?.max));
        addRow(lines, lbl, rm, phase, "dom_nodes_max", pick((p) => p?.dom_nodes?.max));
      }
    }

    fs.writeFileSync(path.join(this.outDir, "summary.csv"), lines.join("\n") + "\n");
    this.writeDeltaIfMultiLabel();
  }

  /**
   * If results contain >=2 distinct labels, write delta.csv comparing them per
   * (room, phase, metric). Useful for FF-on vs FF-off A/B reads at a glance.
   */
  private writeDeltaIfMultiLabel(): void {
    const labels = Array.from(new Set(this.results.map((r) => r.label).filter((l): l is string => !!l)));
    if (labels.length < 2) return;
    const [a, b] = labels;
    if (!a || !b) return;

    const lines: string[] = [`starting_room,phase,metric,${a}_median,${b}_median,delta,delta_pct`];
    const byRoom = groupBy(this.results, (r) => r.starting_room);

    for (const [room, results] of Object.entries(byRoom)) {
      const aResults = results.filter((r) => r.label === a);
      const bResults = results.filter((r) => r.label === b);
      if (aResults.length === 0 || bResults.length === 0) continue;

      for (const phase of PHASE_ORDER) {
        const metrics: Array<[string, (p: PhaseMetrics) => number | undefined]> = [
          ["fps_avg", (p) => p?.fps?.avg],
          ["fps_p5_low", (p) => p?.fps?.p5_low],
          ["frame_time_p95_ms", (p) => p?.fps?.frame_time_p95_ms],
          ["heap_mb_max", (p) => p?.heap_mb?.max],
          ["duration_ms", (p) => p?.duration_ms],
        ];
        for (const [metric, sel] of metrics) {
          const aVals = aResults.map((r) => sel(r.phases[phase]!)).filter(isNum);
          const bVals = bResults.map((r) => sel(r.phases[phase]!)).filter(isNum);
          if (aVals.length === 0 || bVals.length === 0) continue;
          const aMed = median(aVals);
          const bMed = median(bVals);
          const delta = bMed - aMed;
          const deltaPct = aMed !== 0 ? (delta / aMed) * 100 : 0;
          lines.push([room, phase, metric, fmt(aMed), fmt(bMed), fmt(delta), fmt(deltaPct)].join(","));
        }
      }
    }
    fs.writeFileSync(path.join(this.outDir, "delta.csv"), lines.join("\n") + "\n");
  }

  printConsoleSummary(): void {
    const byLabelRoom = groupBy(this.results, (r) => `${r.label ?? ""}||${r.starting_room}`);

    console.log("");
    console.log("=".repeat(78));
    console.log("BENCHMARK SUMMARY");
    console.log("=".repeat(78));

    for (const [key, results] of Object.entries(byLabelRoom)) {
      const [label, room] = key.split("||");
      const labelStr = label ? `[${label}] ` : "";
      console.log("");
      console.log(`${labelStr}Starting room: ${room}  (n=${results.length})`);

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
        console.log(
          `  ${phase.padEnd(22)} fps_avg=${fmt(median(fpsAvg))}  fps_p5=${fmt(median(fpsP5))}  frame_p95=${fmt(median(ftP95))}ms  frame_p99=${fmt(median(ftP99))}ms  dur=${fmt(median(dur))}ms`,
        );
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
    console.log(`Per-iteration data: ${path.resolve(this.outDir, "iterations.json")}`);
    console.log(`Summary CSV:        ${path.resolve(this.outDir, "summary.csv")}`);
    console.log("");
  }
}

function addRow(
  lines: string[],
  label: string,
  room: string,
  phase: string,
  metric: string,
  values: number[],
): void {
  if (values.length === 0) {
    lines.push([label, room, phase, metric, "0", "", "", "", "", "", ""].join(","));
    return;
  }
  lines.push(
    [
      label,
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
