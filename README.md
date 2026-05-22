# Room loading perf benchmark

Playwright runner that drives the deployed museum FE through the full visitor flow (lobby → museum catalog → target room → POI → portal → next room) per starting room, per iteration. Captures FPS, frame time, GPU/CPU breakdown, JS heap, draw calls, triangles, texture + buffer uploads, GLB parse time, asset windows. Designed for before/after comparison driven by a backend feature flag toggle.

See [METRICS.md](METRICS.md) for the full metric reference (every field, how it's computed, caveats, what's NOT measured and why).

## Install (first time)

From this directory:

```bash
npm install
npm run install:browsers   # downloads Chromium for Playwright
cp .env.example .env       # then edit .env with your values
```

`.env` is gitignored. `.env.example` is the committed template.

## Run

Config comes from `.env` (auto-loaded by dotenv) plus shell env vars (shell vars win over `.env`).

```bash
npm run flow
```

Override a single var without editing `.env`:

```powershell
# Windows PowerShell — note: env vars persist for the SHELL SESSION;
# Remove-Item Env:BENCH_ROOMS before re-running with .env defaults
$env:BENCH_ITERATIONS = "1"; npm run flow
```

```bash
# Linux / macOS
BENCH_ITERATIONS=1 npm run flow
```

## Run folders and delta vs previous

Each run lands in `${BENCH_OUTPUT_DIR}/<start>_to_<end>/` (or `<start>__running/` while in progress). Inside:

- `iterations.json` — per-iteration record with full metric breakdown + run_meta
- `summary.csv` — aggregate per (room × phase × metric): median, p95, mean, std, min, max
- `delta.csv` — auto-generated if a prior completed run exists in `BENCH_OUTPUT_DIR`: compares current vs prior medians + stds (use `|delta| > 2 × max(std)` as rough signal-vs-noise check)
- `logs/` — per-iteration `*.flow.log` (scenario actions) and `*.page.log` (browser console)
- `flow/` — per-iteration screenshots at key step boundaries

To do a before/after FF toggle:

1. `npm run flow` → first run lands in some `<start>_to_<end>/`
2. Flip the FE feature flag
3. `npm run flow` again → second run lands in a new folder, `delta.csv` inside automatically diffs against the first

No manual labels, no environment variables to remember.

## Env vars

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `BENCH_BASE_URL` | yes | — | Deployed FE URL, no trailing slash |
| `BENCH_ROOMS` | yes | — | Comma-separated `museum/room` starting points |
| `BENCH_ITERATIONS` | no | `10` | Iterations per starting room |
| `BENCH_WARMUP_SEC` | no | `5` | Idle time after the lobby finishes loading, before collection starts |
| `BENCH_LOBBY_IDLE_SEC` | no | `5` | Idle collection window in the lobby |
| `BENCH_ROOM_IDLE_SEC` | no | `15` | Idle collection window in target/next rooms (15s ≈ 900 frames at 60fps for stable p95) |
| `BENCH_POI_OPEN_SEC` | no | `8` | Time the POI panel is held open |
| `BENCH_TRANSITION_TIMEOUT_SEC` | no | `60` | Max wait for portal transition |
| `BENCH_OUTPUT_DIR` | no | `./results` (or `./results-dry-run` in dry-run) | Base directory; per-run subfolder is created inside |
| `BENCH_DRY_RUN` | no | unset | If `1` → 1 iteration, shared context, single combined video; writes to `./results-dry-run/`. Use for smoke-testing the flow; numbers not comparable to real runs (video encoder adds ~5-15% overhead) |
| `BENCH_SWEEP_MAX_ATTEMPTS` | no | `20` | Max walk+rotate cycles when searching for POI/portal |
| `BENCH_REQUIRE_NVIDIA` | no | unset | If `1`, pre-flight aborts unless WebGL renderer is NVIDIA. Set on AWS EC2 g4dn / cloud GPU hosts |
| `BENCH_SKIP_GPU_CHECK` | no | unset | If `1`, skip pre-flight GPU validation. Local-dev escape hatch only — numbers are meaningless without hardware GPU |
| `BENCH_USE_SYSTEM_CHROME` | no | unset | If `1`, use the user's installed Chrome instead of Playwright's bundled Chromium. Try if bundled Chromium has WebGL quirks (black canvas, context lost) |

## What the runner does per iteration

Scenario: **root → ENTRA → lobby → close help → click tablet → catalog → select museum → museum loads → ensure target room (minimap if needed) → walk-around → POI → portal → next room → walk-around → optional POI in next room**.

Phases tracked (see `helpers/phases.ts` PHASE_NAMES):
- `lobby_idle` — settle in lobby, collect baseline
- `transition_to_target` — museum click through to target room reached
- `target_room_visit` (wrapper) — entered target room → just before portal click
  - `target_room_idle` — stand still in target room
  - `target_room_walk` — deterministic forward + return walk
  - `target_room_poi_open` — POI panel held open
- `transition_to_next` — portal search + click + nav (full leave-room cost)
- `next_room_visit` (wrapper) — arrived in next room → end of all next-room phases
  - `next_room_idle`, `next_room_walk` — same as target

**Wrapper phases SUM their children** (overlapping phase model — both wrapper and child receive each frame sample). Never sum wrapper + children in roll-ups.

The collector (`helpers/collectors.ts`) is injected via `addInitScript` before any page script runs. WebGL prototype patches (`helpers/cameraHook.ts`) capture draw calls, triangles, texture/buffer uploads, GPU frame time via `EXT_disjoint_timer_query`, plus camera position for distance feedback. Resource Timing observer pairs GLB fetch completion with first `bufferData` for parse-time measurement. Zero frontend changes.

Cross-realm continuity: when `ensureRoomLoadedWithRetry` reloads the page, snapshot is pulled before reload and merged with the post-reload realm's final snapshot (`snapshotAccumulator` in `flow.spec.ts`).

## Pre-flight GPU validation

Before iterations run, `global-setup.ts` opens a throwaway Chrome and reads the unmasked WebGL renderer string. If WebGL falls back to software (`SwiftShader`, `llvmpipe`), the run aborts. `BENCH_REQUIRE_NVIDIA=1` additionally requires "NVIDIA" in the renderer string — use on cloud GPU hosts to catch driver-fallback cases.

## Caveats

- **Pointer lock under Playwright** is not 100% guaranteed. If `movementX/Y` doesn't propagate, the cursor scan for POIs/portals fails and `notes` will say so. Diagnostic: `await page.evaluate(() => document.pointerLockElement)`.
- **Flow degrades gracefully** — if no POI is found in a room, the phase is recorded with no samples and the flow continues. Reload count is tracked per iteration (`target_room_reloads`, `next_room_reloads`).
- **`performance.memory` is Chrome-only.** Heap metrics report 0 on Firefox/WebKit (we only ship Chromium).
- **Cross-origin asset bytes need `Timing-Allow-Origin`**. MinIO origin must set the header or `total_bytes` will be 0 for those assets.
- **GPU frame time requires `EXT_disjoint_timer_query_webgl2`**. Some headless/VM environments don't expose it — check `diagnostics.has_gpu_timer_query` per iteration.
- **Real VRAM is not measurable** in modern Chrome (both `chrome.gpuBenchmarking` and CDP confirmed). Use `texture_bytes_total + buffer_data_bytes_total` per phase as the FE-controlled GPU pressure proxy.

See [METRICS.md](METRICS.md) for the full caveat catalogue per metric.
