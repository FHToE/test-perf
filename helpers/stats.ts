export function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

export function stddev(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

export function min(arr: number[]): number {
  return arr.length ? Math.min(...arr) : NaN;
}

export function max(arr: number[]): number {
  return arr.length ? Math.max(...arr) : NaN;
}

export interface FpsStats {
  avg: number;
  p1_low: number;
  p5_low: number;
  min_fps: number; // worst single frame (1000 / max_frame_time) — peak load, single-outlier
  max_fps: number; // best single frame (1000 / min_frame_time) — peak headroom, capped by display refresh
  frame_time_p95_ms: number;
  frame_time_p99_ms: number; // where stutters actually live — more useful than max_frame_time
  max_frame_time_ms: number;
  samples: number;
}

// Compute FPS metrics from per-frame interval samples (ms between rAF callbacks).
// 1%/5% low FPS = average FPS computed over the slowest 1%/5% of frames.
// frame_time_p95 = 95th percentile frame time (more stable than max — ignores outliers).
// min_fps / max_fps = single-frame extremes (peak load / peak headroom).
export function fpsStats(frameTimesMs: number[]): FpsStats {
  if (frameTimesMs.length === 0) {
    return {
      avg: NaN, p1_low: NaN, p5_low: NaN, min_fps: NaN, max_fps: NaN,
      frame_time_p95_ms: NaN, frame_time_p99_ms: NaN, max_frame_time_ms: NaN, samples: 0,
    };
  }
  const avg_fps = 1000 / mean(frameTimesMs);
  const sortedDesc = [...frameTimesMs].sort((a, b) => b - a);
  const onePctCount = Math.max(1, Math.ceil(sortedDesc.length * 0.01));
  const fivePctCount = Math.max(1, Math.ceil(sortedDesc.length * 0.05));
  const onePct = sortedDesc.slice(0, onePctCount);
  const fivePct = sortedDesc.slice(0, fivePctCount);
  const maxFt = max(frameTimesMs);
  const minFt = min(frameTimesMs);
  return {
    avg: round(avg_fps, 2),
    p1_low: round(1000 / mean(onePct), 2),
    p5_low: round(1000 / mean(fivePct), 2),
    min_fps: round(1000 / maxFt, 2),
    max_fps: minFt > 0 ? round(1000 / minFt, 2) : 0,
    frame_time_p95_ms: round(percentile(frameTimesMs, 95), 2),
    frame_time_p99_ms: round(percentile(frameTimesMs, 99), 2),
    max_frame_time_ms: round(maxFt, 2),
    samples: frameTimesMs.length,
  };
}

export function round(n: number, places: number): number {
  if (Number.isNaN(n)) return NaN;
  const k = 10 ** places;
  return Math.round(n * k) / k;
}
