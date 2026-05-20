import "dotenv/config";

export interface BenchConfig {
  baseUrl: string;
  rooms: string[];
  iterations: number;
  warmupSec: number;
  lobbyIdleSec: number;
  roomIdleSec: number;
  poiOpenSec: number;
  transitionTimeoutSec: number;
  outputDir: string;
  /** Optional run label (e.g. "ff-off" / "ff-on") for before/after comparison. */
  label: string | null;
  /** Only asset URLs containing this string contribute to asset windows. Default = no filter. */
  assetHostFilter: string | null;
  /** Dry run: force 1 iteration per room, record video, write to results-dry-run/ so real metrics aren't polluted. */
  dryRun: boolean;
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function numEnv(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env ${name} must be a number, got: ${v}`);
  return n;
}

function boolEnv(name: string): boolean {
  const v = (process.env[name] || "").toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes";
}

export function loadConfig(): BenchConfig {
  const rooms = (process.env.BENCH_ROOMS || "")
    .split(",")
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  if (rooms.length === 0) {
    throw new Error("BENCH_ROOMS must be a comma-separated list of starting room paths (e.g. torino/hallway-1,muciv/hall)");
  }

  const dryRun = boolEnv("BENCH_DRY_RUN");
  const defaultOutDir = dryRun ? "./results-dry-run" : "./results";
  return {
    baseUrl: reqEnv("BENCH_BASE_URL").replace(/\/+$/, ""),
    rooms,
    // Dry run = exactly 1 iteration per room (smoke test). Ignores BENCH_ITERATIONS.
    iterations: dryRun ? 1 : numEnv("BENCH_ITERATIONS", 10),
    warmupSec: numEnv("BENCH_WARMUP_SEC", 5),
    lobbyIdleSec: numEnv("BENCH_LOBBY_IDLE_SEC", 5),
    // Bumped 5→15: 15s @60fps = 900 frames → stable p1_low / p5_low / p95
    roomIdleSec: numEnv("BENCH_ROOM_IDLE_SEC", 15),
    poiOpenSec: numEnv("BENCH_POI_OPEN_SEC", 8),
    transitionTimeoutSec: numEnv("BENCH_TRANSITION_TIMEOUT_SEC", 60),
    outputDir: process.env.BENCH_OUTPUT_DIR || defaultOutDir,
    label: process.env.BENCH_LABEL || null,
    assetHostFilter: process.env.BENCH_ASSET_HOST_FILTER || null,
    dryRun,
  };
}
