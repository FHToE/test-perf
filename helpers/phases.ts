import type { Page } from "@playwright/test";

/**
 * Phase names attributed by the in-page perf collector. Tied to the multi-room
 * flow in `flow.spec.ts`: lobby_idle → transition_to_target → target_room_idle
 * → target_room_poi_open → transition_to_next → next_room_idle.
 *
 * Some phases may be absent in a given iteration: e.g. if the target room has
 * no POI, `target_room_poi_open` is skipped; if no portal, `transition_to_next`
 * + `next_room_idle` are skipped.
 */
export const PHASE_NAMES = {
  LOBBY_IDLE: "lobby_idle",
  TRANSITION_TO_TARGET: "transition_to_target",
  TARGET_ROOM_VISIT: "target_room_visit", // WRAPPER: entered → BEFORE portal click; overlaps idle/walk/POI
  TARGET_ROOM_IDLE: "target_room_idle",
  TARGET_ROOM_WALK: "target_room_walk", // deterministic walk sweep
  TARGET_ROOM_POI_OPEN: "target_room_poi_open",
  TRANSITION_TO_NEXT: "transition_to_next", // includes portal SEARCH + click + nav (entire leave-room cost)
  NEXT_ROOM_VISIT: "next_room_visit", // WRAPPER: arrived → end of all next-room phases
  NEXT_ROOM_IDLE: "next_room_idle",
  NEXT_ROOM_WALK: "next_room_walk",
} as const;

export type PhaseName = (typeof PHASE_NAMES)[keyof typeof PHASE_NAMES];

export interface AssetMetrics {
  window_ms: number;
  total_bytes: number;
  count: number;
  mesh_count: number; // subset of count — 3D mesh formats only (.glb/.gltf/.ply)
}

export interface PhaseSnapshot {
  frames: number[];
  longTasks: { start: number; duration: number }[];
  heap: { ts: number; used: number }[];
  heapTotal: { ts: number; total: number }[];
  domNodes: { ts: number; count: number }[];
  /** Per-frame draw call count (one entry per rAF tick during the phase). */
  drawCalls?: number[];
  /** Per-frame triangle count (one entry per rAF tick during the phase). */
  triangles?: number[];
  /** Per-frame texture upload bytes (one entry per rAF tick; most frames 0). */
  textureBytes?: number[];
  /** Per-frame wall-clock time (ms) spent inside texImage2D/texSubImage2D/compressed* calls. */
  textureUploadMs?: number[];
  /** Per-frame bufferData call count. */
  bufferDataCalls?: number[];
  /** Per-frame bufferData bytes (geometry uploaded). */
  bufferDataBytes?: number[];
  /** Per-frame wall-clock time (ms) spent inside bufferData calls. */
  bufferDataMs?: number[];
  /** GPU frame time (ms) via EXT_disjoint_timer_query — one entry per completed query.
   * Arrives 1-3 frames after the frame it measured; aggregation hides the lag. Empty
   * if the extension is unavailable (some headless / VM environments). */
  gpuFrameTimesMs?: number[];
  /** GLB parses (fetch-end → first bufferData) that completed during this phase. */
  glbParseSamples?: { url: string; parseTimeMs: number; bytes: number }[];
  /** Cumulative WebGLProgram count at startPhase. -1 if not captured. */
  programsStart?: number;
  /** Cumulative WebGLProgram count at endPhase. -1 if not captured. */
  programsEnd?: number;
  startTs: number;
  endTs: number;
}

export async function startPhase(page: Page, phase: string): Promise<void> {
  await page.evaluate(
    (p) => (window as unknown as { __perfCollector: { startPhase: (n: string) => void } }).__perfCollector.startPhase(p),
    phase,
  );
}

/**
 * End a specific phase. With overlapping support, the name MUST be passed —
 * collector tracks multiple active phases and needs to know which to close.
 */
export async function endPhase(page: Page, phase: string): Promise<void> {
  await page.evaluate(
    (p) => (window as unknown as { __perfCollector: { endPhase: (n: string) => void } }).__perfCollector.endPhase(p),
    phase,
  );
}

export async function getPhaseSnapshot(page: Page): Promise<Record<string, PhaseSnapshot>> {
  return page.evaluate(
    () => (window as unknown as { __perfCollector: { snapshot: () => unknown } }).__perfCollector.snapshot(),
  ) as Promise<Record<string, PhaseSnapshot>>;
}

/**
 * Capture asset-window metrics for resource entries appended since `sinceIndex`.
 * Caller records `getResourceCount(page)` before an action that triggers new
 * loads, passes the count here after, gets back `{window_ms, total_bytes, count}`
 * attributed to the new entries only.
 */
export async function captureAssetsSince(page: Page, sinceIndex: number): Promise<AssetMetrics> {
  return page.evaluate((since) => {
    const all = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const newEntries = all.slice(since);
    const assetExt = /\.(glb|gltf|jpg|jpeg|png|webp|avif|mp4|mp3|ply|pdf)(\?|$)/i;
    const meshExt = /\.(glb|gltf|ply)(\?|$)/i;
    const assets = newEntries.filter((e) => assetExt.test(e.name));
    if (assets.length === 0) {
      return { window_ms: 0, total_bytes: 0, count: 0, mesh_count: 0 };
    }
    const earliest = Math.min(...assets.map((e) => e.startTime));
    const latest = Math.max(...assets.map((e) => e.responseEnd));
    const totalBytes = assets.reduce((s, e) => s + (e.encodedBodySize || e.transferSize || 0), 0);
    const meshCount = assets.filter((e) => meshExt.test(e.name)).length;
    return {
      window_ms: Math.round(latest - earliest),
      total_bytes: totalBytes,
      count: assets.length,
      mesh_count: meshCount,
    };
  }, sinceIndex);
}

export async function getResourceCount(page: Page): Promise<number> {
  return page.evaluate(() => performance.getEntriesByType("resource").length);
}
