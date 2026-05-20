# Room loading perf benchmark

Playwright runner that drives the deployed museum FE through a 3-phase scenario
(idle / rambling / exhibit-click) per room, per iteration. Captures FPS, frame time,
JS heap, long tasks, and MinIO asset-loading window. Designed for before/after
comparison driven by a feature flag toggle.

See `../PERF-BENCH-PLAN.md` for full rationale, AWS setup, and run methodology.

## Install (first time only)

From this directory:

```bash
npm install
npm run install:browsers   # downloads Chromium for Playwright

cp .env.example .env       # then edit .env with your values
```

`.env` is gitignored. `.env.example` is the committed template.

## Run

Config comes from `.env` (auto-loaded) plus any shell env vars (shell vars win over `.env`).

```bash
npm run bench
```

To override a single var for one run without editing `.env`:

```powershell
# Windows PowerShell
$env:BENCH_ITERATIONS = "1"; npm run bench
```

```bash
# Linux / macOS
BENCH_ITERATIONS=1 npm run bench
```

For CI / EC2 where committing a `.env` is undesirable, set all vars as shell env vars and skip `.env` entirely.

**Comparing rounds (before/after a feature-flag toggle):** results always write to `./results/` (single folder). Before flipping the flag and re-running, **manually copy** `./results/` somewhere safe (e.g. `./results-baseline/`). Re-run overwrites `./results/` with the new round.

## Env vars

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `BENCH_BASE_URL` | yes | — | Deployed FE URL, no trailing slash |
| `BENCH_ROOMS` | yes | — | Comma-separated STARTING room paths. Each runs the full lobby → portal → room A → POI → portal → room B scenario |
| `BENCH_ITERATIONS` | no | `10` | Iterations per starting room |
| `BENCH_WARMUP_SEC` | no | `5` | Idle time after the lobby finishes loading, before measurement starts |
| `BENCH_LOBBY_IDLE_SEC` | no | `5` | Idle measurement window in the lobby |
| `BENCH_ROOM_IDLE_SEC` | no | `5` | Idle measurement window in rooms A and B (after portal arrival) |
| `BENCH_POI_OPEN_SEC` | no | `8` | Time with POI panel open in room A |
| `BENCH_TRANSITION_TIMEOUT_SEC` | no | `60` | Max wait for portal transition (click → new room loaded) |
| `BENCH_OUTPUT_DIR` | no | `./results` | Where to write results (single folder; copy manually between rounds) |
| `BENCH_REQUIRE_NVIDIA` | no | unset | If `1`, pre-flight check fails the run unless WebGL renderer is NVIDIA. **Set on AWS EC2 g4dn.** |
| `BENCH_SKIP_GPU_CHECK` | no | unset | If `1`, skip the pre-flight GPU check entirely. Local-dev escape hatch only. |

## Output

Two files under `BENCH_OUTPUT_DIR`:

- `iterations.json` — every per-iteration record with full metric breakdown
- `summary.csv` — aggregate per (label, room, phase, metric): median, p95, mean, std, min, max

Console prints a live one-liner per iteration and a final summary table.

## Local development vs production runs

**Locally** (your dev machine): edit `.env` with short phase durations and low iteration count:

```ini
BENCH_BASE_URL=https://staging.example.com
BENCH_ROOMS=museum1/room1
BENCH_ITERATIONS=2
BENCH_IDLE_SEC=3
BENCH_RAMBLING_SEC=5
BENCH_EXHIBIT_SEC=5
```

then `npm run bench`. Numbers from a local run are not representative — your machine has variable load, different GPU, etc. The point of local runs is to verify the script navigates, detects "room loaded", finds an exhibit via cursor-scan, and writes output files.

**On the AWS lab instance** (`g4dn.xlarge`, see `../PERF-BENCH-PLAN.md` Phase 4): run with full iteration count. **MANDATORY pre-flight check**: open `chrome://gpu` and confirm `WebGL: Hardware accelerated` with NVIDIA renderer. SwiftShader → numbers worthless.

## Pre-flight GPU validation

Before any benchmark iterations run, `global-setup.ts` opens a throwaway Chrome,
creates a WebGL context, and reads the unmasked renderer string. If WebGL is
falling back to a software renderer (`SwiftShader`, `llvmpipe`, etc.), the run
aborts with a clear error and zero tests execute. This prevents producing
garbage numbers from a misconfigured GPU stack.

Strict mode (`BENCH_REQUIRE_NVIDIA=1`) additionally fails if the renderer is
not NVIDIA — use this on AWS EC2 g4dn instances to catch the case where the
NVIDIA Gaming Driver wasn't installed properly and Chrome silently fell back
to Intel/AMD/CPU rendering.

To bypass entirely on a known-limited local machine: `BENCH_SKIP_GPU_CHECK=1`.

## What the runner does per iteration

Scenario: **lobby → portal to room A → open POI in A → portal to room B**.

1. New incognito browser context (fresh cache / cookies / SW)
2. Navigate to starting room URL (treated as "lobby")
3. Wait for `.overlay[data-state="hidden"]` (loading overlay fades when assets cached + scene mounted)
4. Capture `assets_lobby` from Resource Timing API (filtered to asset extensions)
5. Warm-up: `BENCH_WARMUP_SEC` seconds with no collection
6. **Phase `lobby_idle`** — camera at spawn, no input, collect FPS / heap / long-tasks
7. **Phase `transition_to_a`** — rotate camera scanning `body[data-cursor]` for `"portal"`, click center on hit, wait for new room loaded. Capture `assets_room_a` (delta of resource entries)
8. **Phase `room_a_idle`** — idle in room A, collect
9. **Phase `room_a_poi_open`** — rotate camera scanning for `"poi"`, click center, hold with panel open
10. **Phase `transition_to_b`** — same as `transition_to_a` but from room A. Capture `assets_room_b`
11. **Phase `room_b_idle`** — idle in room B
12. Read collector snapshot via `window.__perfCollector.snapshot()`, compute per-phase stats, append to `iterations.json`
13. Close context

The collector script (`helpers/collectors.ts`) is injected via `addInitScript` before any page script runs, so the rAF sampler captures frames from the very first paint.

The portal / POI detection uses the museum's existing pattern: `PointerManager.jsx` sets `document.body.dataset.cursor` to `"poi"`, `"portal"`, `"tablet"`, or `"drawer"` when the pointer-lock crosshair is over an interactive object. We scan by rotating the camera and polling that value — no FE changes needed.

## Caveats

- **Pointer lock behavior under Playwright is not 100% guaranteed** — if mouse-delta movement doesn't propagate as pointer-lock `movementX/Y`, the cursor scans for portals/POIs will fail and most phases will be skipped. Symptom: every iteration ends with `notes: ["transition_to_a: no portal found in lobby — flow aborted"]`. Diagnostic: `await page.evaluate(() => document.pointerLockElement)` — should return the canvas element.
- **Flow can degrade gracefully**:
  - No portal in lobby → flow aborts after `lobby_idle`; only that phase has data
  - No POI in room A → `room_a_poi_open` recorded with no samples, flow continues to portal B
  - No portal in room A → `transition_to_b` and `room_b_idle` skipped
- **`performance.memory` is Chrome-only.** Heap metrics will be NaN on Firefox/WebKit (we only ship Chromium in the config).
- **Asset attribution is by Resource Timing delta** between transitions — if assets continue trickling in long after `overlay[data-state="hidden"]` fires, they'll be misattributed to the next room. In practice the overlay waits for `loaded` which means assets are cached, so this should be a small effect.
