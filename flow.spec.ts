/**
 * Multi-room flow + per-phase perf metrics.
 *
 * Walks: root → ENTRA → lobby → close help → click tablet → catalog → select museum
 *       → museum loads → ensure target room (minimap if needed) → exhibit (optional)
 *       → portal → next room → exhibit-in-next-room (if not found before).
 *
 * Per iteration: collector captures FPS / frame time / heap / long tasks per phase,
 * plus asset-window for lobby / target_room / next_room. Results aggregated into
 * `results/iterations.json` (per-iter detail) and `results/summary.csv` (cross-iter stats).
 *
 * Run: `npm run flow` (see package.json).
 *
 * Each step also logs to console AND writes a per-iteration flow log
 * `results/logs/iter-N_<slug>.flow.log` for debugging the scenario itself.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { type BrowserContext, type Page, test } from "@playwright/test";

import { WEBGL_CAMERA_HOOK_INIT } from "./helpers/cameraHook.js";
import { COLLECTOR_INIT } from "./helpers/collectors.js";
import { type FlowContext } from "./helpers/flow.js";
import {
  step1_clickEnter,
  step2_closeHelpDialog,
  step3_clickCentralTablet,
  step4_selectMuseum,
  step5_waitForMuseumLoaded,
  step6_ensureTargetRoom,
  step7_findAndClickExhibit,
  step8_findAndUsePortal,
  step10_walkAround,
  ensureRoomLoadedWithRetry,
} from "./helpers/flow.js";
import { attachPageLogger, roomSlug } from "./helpers/pageLogger.js";
import {
  captureAssetsSince,
  endPhase,
  getPhaseSnapshot,
  getResourceCount,
  PHASE_NAMES,
  startPhase,
  type AssetMetrics,
} from "./helpers/phases.js";
import { computePhaseMetrics, type IterationResult, Reporter } from "./helpers/reporter.js";
import { RoomObserver } from "./helpers/roomObserver.js";

import { loadConfig } from "./config.js";

const cfg = loadConfig();

// eslint-disable-next-line no-console
console.log(`[flow] config:`, JSON.stringify(cfg, null, 2));

const reporter = new Reporter(cfg.outputDir);

// run_meta: persisted in iterations.json so a stakeholder can tell whether two
// result files are comparable (same GPU? same Chrome version? same commit?).
function gitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

reporter.setMeta({
  bench_label: cfg.label,
  git_sha: gitSha(),
  chrome_user_agent: null, // populated after first page boot (set in test)
  gpu_renderer: process.env.BENCH_GPU_RENDERER || null, // optional; global-setup could persist
  gpu_vendor: process.env.BENCH_GPU_VENDOR || null,
  config_snapshot: { ...cfg },
  started_at: new Date().toISOString(),
});

// In dry-run mode we share ONE browser context + ONE page across all iterations
// → Playwright records ONE combined video for the entire run. Trade-off: cold
// cache is NOT reset between iterations (acceptable since dry-run is just a
// smoke test, not a real benchmark).
let sharedContext: BrowserContext | null = null;
let sharedPage: Page | null = null;

test.beforeAll(async ({ browser }) => {
  if (!cfg.dryRun) return;
  sharedContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: path.join(cfg.outputDir, "videos"),
      size: { width: 1280, height: 720 },
    },
  });
  await sharedContext.addInitScript({ content: WEBGL_CAMERA_HOOK_INIT });
  await sharedContext.addInitScript({ content: COLLECTOR_INIT });
  sharedPage = await sharedContext.newPage();
  // eslint-disable-next-line no-console
  console.log(`[flow] dry-run: shared context + page created — one combined video at end`);
});

test.afterAll(async () => {
  reporter.writeSummary();
  reporter.printConsoleSummary();

  if (sharedContext && sharedPage) {
    const videoObj = sharedPage.video();
    await sharedPage.close().catch(() => undefined);
    await sharedContext.close().catch(() => undefined);
    if (videoObj) {
      const combinedPath = path.join(cfg.outputDir, "videos", "combined.webm");
      try {
        await videoObj.saveAs(combinedPath);
        await videoObj.delete();
        // eslint-disable-next-line no-console
        console.log(`📹 combined dry-run video: ${combinedPath}`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`📹 combined video save failed: ${(e as Error).message}`);
      }
    }
  }
});

for (const room of cfg.rooms) {
  // BENCH_ROOMS entries are "{museumName}/{roomName}" — split for the flow.
  const [museumName, ...rest] = room.split("/");
  const targetRoomName = rest.join("/");
  if (!museumName || !targetRoomName) {
    throw new Error(`BENCH_ROOMS entry '${room}' must be in the form 'museumName/roomName'`);
  }

  for (let i = 1; i <= cfg.iterations; i++) {
    const iterIdx = i;
    test(`flow | ${room} | iter ${iterIdx}/${cfg.iterations}`, async ({ browser }, testInfo) => {
      testInfo.setTimeout(10 * 60 * 1000);

      // dry-run uses the shared context+page set up in beforeAll (one combined video).
      // real mode creates a fresh context per iteration (cold-cache isolation).
      let context: BrowserContext;
      let page: Page;
      const usingShared = cfg.dryRun && sharedContext !== null && sharedPage !== null;

      if (usingShared) {
        context = sharedContext!;
        page = sharedPage!;
        // Clear collector state from previous iteration so phases don't leak between rooms
        await page.evaluate(() => {
          const w = window as unknown as { __perfCollector?: { reset: () => void } };
          w.__perfCollector?.reset();
        });
      } else {
        context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        await context.addInitScript({ content: WEBGL_CAMERA_HOOK_INIT });
        await context.addInitScript({ content: COLLECTOR_INIT });
        page = await context.newPage();
      }

      const slug = roomSlug(room);
      const logFile = path.join(cfg.outputDir, "logs", `iter-${iterIdx}_${slug}.page.log`);
      const flowLogFile = path.join(cfg.outputDir, "logs", `iter-${iterIdx}_${slug}.flow.log`);
      const screenshotsDir = path.join(cfg.outputDir, "flow", `iter-${iterIdx}_${slug}`);
      fs.mkdirSync(path.dirname(flowLogFile), { recursive: true });
      const flowLogStream = fs.createWriteStream(flowLogFile, { flags: "w" });

      const detachLogger = attachPageLogger(page, logFile);

      const roomObserver = new RoomObserver();
      roomObserver.attach(page);

      const notes: string[] = [];
      const ctx: FlowContext = {
        page,
        screenshotsDir,
        log: (msg: string) => {
          const line = `${new Date().toISOString()} ${msg}`;
          flowLogStream.write(line + "\n");
          // eslint-disable-next-line no-console
          console.log(`  ${msg}`);
        },
        notes,
        roomData: roomObserver,
      };

      const startUrl = cfg.baseUrl + "/";
      // eslint-disable-next-line no-console
      console.log(`\n[flow] [${room}] iter ${iterIdx}/${cfg.iterations}`);
      // eslint-disable-next-line no-console
      console.log(`  log: ${logFile}`);
      // eslint-disable-next-line no-console
      console.log(`  screenshots: ${screenshotsDir}`);
      // eslint-disable-next-line no-console
      console.log(`  → ${startUrl}`);

      let assetsLobby: AssetMetrics | null = null;
      let assetsTargetRoom: AssetMetrics | null = null;
      let assetsNextRoom: AssetMetrics | null = null;
      let foundExhibitInFirstRoom = false;
      let targetRoomReloads = 0;
      let nextRoomReloads = 0;

      try {
        await page.goto(startUrl, { waitUntil: "domcontentloaded" });

        await step1_clickEnter(ctx);
        await step2_closeHelpDialog(ctx);

        // Lobby is fully loaded. Asset window for lobby = everything fetched so far.
        assetsLobby = await captureAssetsSince(page, 0, cfg.assetHostFilter);
        const resourcesAfterLobby = await getResourceCount(page);
        ctx.log(`assets_lobby: window=${assetsLobby.window_ms}ms count=${assetsLobby.count} bytes=${assetsLobby.total_bytes}`);

        // Phase: lobby_idle — sit and collect metrics
        await startPhase(page, PHASE_NAMES.LOBBY_IDLE);
        await page.waitForTimeout(cfg.lobbyIdleSec * 1000);
        await endPhase(page, PHASE_NAMES.LOBBY_IDLE);

        const tabletClicked = await step3_clickCentralTablet(ctx);
        if (!tabletClicked) throw new Error("step3 failed — could not find/click lobby tablet");

        // Phase: transition_to_target — from museum click through to target room reached
        await startPhase(page, PHASE_NAMES.TRANSITION_TO_TARGET);
        await step4_selectMuseum(ctx, museumName);
        await step5_waitForMuseumLoaded(ctx, museumName, cfg.transitionTimeoutSec * 1000);

        const inTargetRoom = await step6_ensureTargetRoom(
          ctx,
          museumName,
          targetRoomName,
          cfg.transitionTimeoutSec * 1000,
        );
        await endPhase(page, PHASE_NAMES.TRANSITION_TO_TARGET);

        // Asset window for target_room = everything fetched since lobby was loaded
        assetsTargetRoom = await captureAssetsSince(page, resourcesAfterLobby, cfg.assetHostFilter);
        const resourcesAfterTargetRoom = await getResourceCount(page);
        ctx.log(`assets_target_room: window=${assetsTargetRoom.window_ms}ms count=${assetsTargetRoom.count} bytes=${assetsTargetRoom.total_bytes}`);

        if (!inTargetRoom) {
          ctx.log("flow: did not reach target room — aborting POI/portal steps");
          ctx.notes.push("flow: target room unreachable — POI/portal steps skipped");
        } else {
          await roomObserver.waitForNew(2_000);

          // Health check: confirm room mesh actually loaded (skybox+minimap render
          // even when GLB load failed). Retry with page.reload() on fail, track count.
          const targetCheck = await ensureRoomLoadedWithRetry(ctx, cfg.transitionTimeoutSec * 1000);
          targetRoomReloads = targetCheck.reloadCount;
          const targetMeshOk = targetCheck.loaded;
          if (!targetMeshOk) {
            ctx.notes.push(`ROOM_NOT_LOADED: target room mesh missing after ${targetCheck.reloadCount} reload(s)`);
          } else if (targetRoomReloads > 0) {
            ctx.notes.push(`target room needed ${targetRoomReloads} reload(s) to load mesh`);
          }

          // WRAPPER phase: target_room_visit covers stay in target room BEFORE
          // portal click — idle + walk + POI hold. Bounded so it does NOT include
          // the leave-room cost (portal search + click + next-room load).
          await startPhase(page, PHASE_NAMES.TARGET_ROOM_VISIT);

          // Phase: target_room_idle — settle in the target room
          await startPhase(page, PHASE_NAMES.TARGET_ROOM_IDLE);
          await page.waitForTimeout(cfg.roomIdleSec * 1000);
          await endPhase(page, PHASE_NAMES.TARGET_ROOM_IDLE);

          // Phase: target_room_walk — deterministic camera path (mirror of next_room_walk)
          await startPhase(page, PHASE_NAMES.TARGET_ROOM_WALK);
          if (targetMeshOk) {
            await step10_walkAround(ctx, 9000);
          } else {
            ctx.log("target_room_walk: SKIPPED — target room mesh not loaded");
          }
          await endPhase(page, PHASE_NAMES.TARGET_ROOM_WALK);

          // Phase: target_room_poi_open — hold POI panel open for cfg.poiOpenSec
          // Skipped if mesh didn't load — wasting ~30s on impossible POI scan.
          await startPhase(page, PHASE_NAMES.TARGET_ROOM_POI_OPEN);
          if (targetMeshOk) {
            foundExhibitInFirstRoom = await step7_findAndClickExhibit(ctx, cfg.poiOpenSec * 1000);
          } else {
            ctx.log("step7: SKIPPED — target room mesh not loaded");
          }
          await endPhase(page, PHASE_NAMES.TARGET_ROOM_POI_OPEN);

          // CLOSE target_room_visit BEFORE the leave-room cost begins
          await endPhase(page, PHASE_NAMES.TARGET_ROOM_VISIT);

          // Phase: transition_to_next — portal SEARCH + click + nav. Full leave cost.
          const prevRoomUrl = roomObserver.getLatest()?.url;
          await startPhase(page, PHASE_NAMES.TRANSITION_TO_NEXT);
          let portalUsed = false;
          if (targetMeshOk) {
            portalUsed = await step8_findAndUsePortal(ctx);
          } else {
            ctx.log("step8: SKIPPED — target room mesh not loaded");
          }
          await endPhase(page, PHASE_NAMES.TRANSITION_TO_NEXT);

          if (portalUsed) {
            assetsNextRoom = await captureAssetsSince(page, resourcesAfterTargetRoom, cfg.assetHostFilter);
            ctx.log(`assets_next_room: window=${assetsNextRoom.window_ms}ms count=${assetsNextRoom.count} bytes=${assetsNextRoom.total_bytes}`);

            // Health check: confirm next room mesh loaded too (with retry on fail)
            const nextCheck = await ensureRoomLoadedWithRetry(ctx, cfg.transitionTimeoutSec * 1000);
            nextRoomReloads = nextCheck.reloadCount;
            const nextMeshOk = nextCheck.loaded;
            if (!nextMeshOk) {
              ctx.notes.push(`ROOM_NOT_LOADED: next room mesh missing after ${nextCheck.reloadCount} reload(s)`);
            } else if (nextRoomReloads > 0) {
              ctx.notes.push(`next room needed ${nextRoomReloads} reload(s) to load mesh`);
            }

            // WRAPPER phase: next_room_visit covers entire stay in post-portal room
            await startPhase(page, PHASE_NAMES.NEXT_ROOM_VISIT);

            // Phase: next_room_idle — settle in the post-portal room
            await startPhase(page, PHASE_NAMES.NEXT_ROOM_IDLE);
            await page.waitForTimeout(cfg.roomIdleSec * 1000);
            await endPhase(page, PHASE_NAMES.NEXT_ROOM_IDLE);

            // Phase: next_room_walk — deterministic camera path for clean
            // FPS-during-movement metric. ~6 sec total. Skip if mesh missing.
            await startPhase(page, PHASE_NAMES.NEXT_ROOM_WALK);
            if (nextMeshOk) {
              await step10_walkAround(ctx, 9000);
            } else {
              ctx.log("step10: SKIPPED — next room mesh not loaded");
            }
            await endPhase(page, PHASE_NAMES.NEXT_ROOM_WALK);

            // Step 9: try POI in next room ONLY if we didn't find one before — POI search
            // costs ~30s, skip if we already have metrics for it. The whole step9
            // window stays inside next_room_visit so its metrics are included.
            if (!foundExhibitInFirstRoom && nextMeshOk) {
              ctx.log("step9: no exhibit in target room — trying in next room");
              await roomObserver.waitForChange(prevRoomUrl, 5_000);
              const foundInSecond = await step7_findAndClickExhibit(ctx, 0); // no hold — we just want to verify it works
              if (foundInSecond) {
                ctx.log("step9: exhibit found in next room");
              } else {
                ctx.log("step9: no exhibit in next room either");
                ctx.notes.push("step9: no exhibit found in either room");
              }
            }

            await endPhase(page, PHASE_NAMES.NEXT_ROOM_VISIT);
          }
        }

        await page.screenshot({ path: path.join(screenshotsDir, "ZZ-final.png") }).catch(() => undefined);

        // Pull collector snapshot + compute per-phase metrics
        const snap = await getPhaseSnapshot(page);
        const phaseMetrics: IterationResult["phases"] = {};
        for (const name of Object.values(PHASE_NAMES)) {
          const m = computePhaseMetrics(snap[name]);
          if (m) phaseMetrics[name] = m;
        }

        // WebGL contexts peak (monotonic counter from cameraHook)
        const webglStats = (await page
          .evaluate(() => (window as unknown as { __webglContextStats?: () => { peak: number } }).__webglContextStats?.())
          .catch(() => undefined)) as { peak: number } | undefined;

        const result: IterationResult = {
          starting_room: room,
          iteration: iterIdx,
          timestamp: new Date().toISOString(),
          label: cfg.label,
          assets_lobby: assetsLobby,
          assets_target_room: assetsTargetRoom,
          assets_next_room: assetsNextRoom,
          phases: phaseMetrics,
          webgl_contexts_peak: webglStats?.peak,
          target_room_reloads: targetRoomReloads,
          next_room_reloads: nextRoomReloads,
          notes: notes.length ? notes : undefined,
        };
        reporter.add(result);

        // eslint-disable-next-line no-console
        console.log(`  ✓ flow completed${notes.length ? ` (notes: ${notes.length})` : ""}`);
        if (notes.length) {
          // eslint-disable-next-line no-console
          for (const n of notes) console.log(`    note: ${n}`);
        }
      } catch (e) {
        await page.screenshot({ path: path.join(screenshotsDir, "FAIL-final.png") }).catch(() => undefined);
        throw e;
      } finally {
        roomObserver.detach(page);
        detachLogger();
        flowLogStream.end();
        if (!usingShared) {
          // Per-iteration context: close it normally. No video in real mode (video
          // only enabled in dry-run, which always uses shared context).
          await page.close().catch(() => undefined);
          await context.close().catch(() => undefined);
        }
        // Shared context+page stay alive across iterations; closed once in afterAll
        // along with the single combined video.
      }
    });
  }
}
