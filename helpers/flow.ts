import * as path from "node:path";

import type { Page } from "@playwright/test";

import type { RoomObserver } from "./roomObserver.js";

/**
 * User-flow step functions for the museum app. NO metrics yet — this layer only
 * orchestrates the click-through. Each step logs to console and takes a screenshot
 * after completing, so when something breaks we can see exactly where.
 */

export interface FlowContext {
  page: Page;
  screenshotsDir: string; // absolute path
  log: (msg: string) => void;
  notes: string[];
  roomData: RoomObserver;
  /** Set by step7 while it INTENTIONALLY holds a POI exhibit open (for metrics), so the
   * periodic stray-overlay watcher doesn't close it. False/undefined otherwise. */
  poiHoldActive?: boolean;
}

async function snap(ctx: FlowContext, name: string): Promise<void> {
  await ctx.page.screenshot({ path: path.join(ctx.screenshotsDir, `${name}.png`), fullPage: false }).catch(() => undefined);
}

/**
 * Click a control, falling back to a synthetic `dispatchEvent("click")` if a real
 * click is intercepted by an overlaying element (e.g. the minimap <canvas> sits on
 * top of the `.map-expand-control` button in the legacy build). Returns true if a
 * click was issued, false if the element couldn't be found/clicked at all.
 */
async function robustClick(ctx: FlowContext, selector: string, timeoutMs = 5_000): Promise<boolean> {
  const loc = ctx.page.locator(selector).first();
  try {
    await loc.click({ timeout: timeoutMs });
    return true;
  } catch {
    try {
      await loc.dispatchEvent("click");
      ctx.log(`robustClick: '${selector}' intercepted by overlay — dispatched synthetic click`);
      return true;
    } catch {
      return false;
    }
  }
}

/** Extract the room slug (last path segment) from a page URL, e.g.
 * https://host/torino/hallway-1 → "hallway-1". Null if unparseable. */
function roomNameFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const segs = path.split("/").filter(Boolean);
    return segs.length ? segs[segs.length - 1] : null;
  } catch {
    return null;
  }
}

/** Step 1: at root URL `/`, click the yellow ENTRA button (StickyPointer). */
export async function step1_clickEnter(ctx: FlowContext): Promise<void> {
  ctx.log("step1: waiting for ENTRA button (.poly--link-container)");
  await ctx.page.waitForSelector(".poly--link-container", { timeout: 30_000 });
  await snap(ctx, "step1a-entra-visible");
  ctx.log("step1: clicking ENTRA");
  await ctx.page.locator(".poly--link-container").click();
  // Navigation to /lobby happens after initLoading() in onClick handler
  await ctx.page.waitForURL(/\/lobby/, { timeout: 30_000 });
  ctx.log(`step1: navigated to ${ctx.page.url()}`);
  await snap(ctx, "step1b-after-entra-click");
}

/** Step 2: in lobby, close the auto-opened help/controls dialog if present. */
export async function step2_closeHelpDialog(ctx: FlowContext): Promise<void> {
  ctx.log("step2: looking for help dialog");
  // Help dialog opens on first lobby visit (no localStorage entry = incognito always)
  try {
    await ctx.page.waitForSelector('.help-content[data-open="true"]', { timeout: 5_000 });
    ctx.log("step2: help dialog open — clicking close");
    await snap(ctx, "step2a-help-open");
    await ctx.page.locator(".help-button-close").click();
    // Wait for it to actually close (data-open should flip to false)
    await ctx.page.waitForSelector('.help-content[data-open="false"]', { timeout: 5_000 });
    ctx.log("step2: help dialog closed");
  } catch {
    ctx.log("step2: help dialog did not appear (already dismissed or different state) — continuing");
    ctx.notes.push("step2: help dialog not seen");
  }
  await snap(ctx, "step2b-after-close");
}

/** Step 3: in lobby, find the central tablet by sweeping the mouse down the
 * vertical center line. Much faster than a full grid scan since the tablet sits
 * along the player's forward axis at roughly screen-center. */
export async function step3_clickCentralTablet(ctx: FlowContext): Promise<boolean> {
  ctx.log("step3: vertical-scanning canvas center for tablet (data-cursor='tablet')");
  await ctx.page.waitForSelector("canvas", { timeout: 10_000 });

  const hit = await verticalScanForCursor(ctx.page, "tablet", {
    stepPx: 25,
    hoverPauseMs: 200,
    xRatio: 0.5,
    yStartRatio: 0.25,
    yEndRatio: 0.85,
  });
  if (!hit) {
    ctx.log("step3: tablet NOT found via vertical scan");
    ctx.notes.push("step3: tablet not found");
    await snap(ctx, "step3-FAIL-no-tablet");
    return false;
  }
  ctx.log(`step3: tablet found at (${hit.x}, ${hit.y}), clicking`);
  await snap(ctx, "step3a-tablet-hover");
  await ctx.page.mouse.click(hit.x, hit.y);
  await ctx.page.waitForTimeout(500);
  await snap(ctx, "step3b-after-click");
  return true;
}

/** Step 4: pick a museum from the catalog by name + click View. */
export async function step4_selectMuseum(ctx: FlowContext, museumName: string): Promise<void> {
  ctx.log(`step4: waiting for museum catalog (looking for tile with name='${museumName}')`);
  await ctx.page.waitForSelector("button.museum-card", { timeout: 15_000 });
  await snap(ctx, "step4a-catalog-open");

  // MuseumCard renders <img alt={museum.name}>. The museum's URL slug equals the
  // museum.name. So we match the tile whose image alt is exactly the museumName.
  const tile = ctx.page.locator(`button.museum-card:has(img[alt="${museumName}"])`).first();
  await tile.waitFor({ state: "visible", timeout: 10_000 });
  ctx.log(`step4: clicking tile for museum '${museumName}'`);
  await tile.click();
  await ctx.page.waitForTimeout(500); // let selection update the SelectedMuseum panel

  ctx.log("step4: clicking VISUALIZZA MUSEO 3D button (.view-or-buy-button)");
  await ctx.page.locator(".view-or-buy-button").click();
  await snap(ctx, "step4b-after-view-click");
}

/** Step 5: wait for museum to load (URL changes to /{museum}/{room}, overlay hidden). */
export async function step5_waitForMuseumLoaded(
  ctx: FlowContext,
  museumName: string,
  loadTimeoutMs = 180_000,
): Promise<string> {
  ctx.log(`step5: waiting for URL to become /${museumName}/<room>`);
  const pattern = new RegExp(`/${escapeRe(museumName)}/[^/]+`);
  await ctx.page.waitForURL(pattern, { timeout: 90_000 });
  ctx.log(`step5: at ${ctx.page.url()}, waiting for overlay hidden (timeout ${loadTimeoutMs / 1000}s)`);

  try {
    await ctx.page.waitForSelector('.overlay[data-state="hidden"]', { timeout: loadTimeoutMs });
  } catch (e) {
    // Diagnostic: capture overlay state + loading store snapshot to help find why
    const diag = await ctx.page
      .evaluate(() => {
        const ov = document.querySelector(".overlay");
        const overlayState = ov?.getAttribute("data-state") ?? "<no .overlay element>";
        const store = (window as unknown as { useLoadingStore?: { getState: () => Record<string, unknown> } })
          .useLoadingStore;
        const loadingState = store ? store.getState() : "<useLoadingStore not exposed on window>";
        return { overlayState, loadingState };
      })
      .catch(() => ({ overlayState: "<eval failed>", loadingState: null }));
    ctx.log(`step5: TIMEOUT waiting for overlay hidden. Diagnostic: ${JSON.stringify(diag, null, 2)}`);
    await snap(ctx, "step5-FAIL-overlay-not-hidden");
    throw e;
  }

  await snap(ctx, "step5-museum-loaded");
  return ctx.page.url();
}

/**
 * Step 6: ensure we're in the target room. If not, open the minimap and click
 * the target room's label to navigate. Returns true if (now) in target room.
 */
// The "expand minimap" control. Our local source calls it `.map-expand-control`, but
// the deployed build renamed it to `.minimap-expand-button` (aria "Espandi mappa").
// Union covers both builds AND both minimap modes so either flow can open the map.
const MINIMAP_EXPAND_SELECTOR = `.minimap-expand-button, .map-expand-control, [aria-label="Espandi mappa"]`;
// Either build's "map is expanded" signal (legacy DOM container OR single-canvas close button).
const MINIMAP_EXPANDED_SELECTOR = `.minimap-container.expanded, .minimap-close-button[data-hidden="false"]`;

export async function step6_ensureTargetRoom(
  ctx: FlowContext,
  museumName: string,
  targetRoomName: string,
  loadTimeoutMs = 180_000,
  singleCanvas = false,
): Promise<boolean> {
  if (ctx.page.url().endsWith(`/${targetRoomName}`)) {
    ctx.log(`step6: already in target room '${targetRoomName}'`);
    return true;
  }
  ctx.log(
    `step6: current URL ${ctx.page.url()} ≠ target '${targetRoomName}' — minimap nav (singleCanvas=${singleCanvas})`,
  );
  const reached = singleCanvas
    ? await navigateSingleCanvasMinimap(ctx, museumName, targetRoomName, loadTimeoutMs)
    : await navigateLegacyMinimap(ctx, museumName, targetRoomName, loadTimeoutMs);
  // The navigating click can leave the minimap EXPANDED in the new room (the in-canvas
  // map doesn't always auto-collapse on nav), which blocks the room canvas for the POI/
  // portal steps. Force it collapsed before proceeding.
  if (reached) await collapseMinimapIfOpen(ctx);
  return reached;
}

/**
 * Collapse the minimap if it's still expanded. Handles both builds: single-canvas
 * closes via `.minimap-close-button`; legacy toggles via the expand control. Best-effort.
 */
async function collapseMinimapIfOpen(ctx: FlowContext): Promise<void> {
  try {
    if ((await ctx.page.locator(MINIMAP_EXPANDED_SELECTOR).count()) === 0) return; // already collapsed
    ctx.log("step6: minimap still expanded after arrival — collapsing");
    // Single-canvas: dedicated close button.
    await robustClick(ctx, ".minimap-close-button", 3_000);
    // Legacy (or if close didn't take): toggle the expand control back.
    if ((await ctx.page.locator(MINIMAP_EXPANDED_SELECTOR).count()) > 0) {
      await robustClick(ctx, MINIMAP_EXPAND_SELECTOR, 3_000);
    }
    await ctx.page.waitForSelector(MINIMAP_EXPANDED_SELECTOR, { state: "detached", timeout: 3_000 }).catch(() => undefined);
    await snap(ctx, "step6d-minimap-collapsed");
  } catch {
    // best-effort — don't fail the flow on collapse trouble
  }
}

/**
 * Legacy (separate-canvas) minimap navigation: expand via the DOM map control, find
 * the target room's drei <Html> label (`.minimap-model-room-title`) by its display
 * title, and click through it to the room mesh underneath. Used when
 * SINGLE_CANVAS_ENABLED is OFF.
 */
async function navigateLegacyMinimap(
  ctx: FlowContext,
  museumName: string,
  targetRoomName: string,
  loadTimeoutMs: number,
): Promise<boolean> {
  // DIAGNOSTIC: the LEGACY (FF-off) minimap DOM was never validated against the deployed
  // build (FF was on until now). Dump what's actually there so we can fix the selectors.
  try {
    const dom = await ctx.page.evaluate(() => {
      const count = (s: string) => document.querySelectorAll(s).length;
      const buttons = Array.from(document.querySelectorAll("button")).map((b) => ({
        cls: b.className,
        al: b.getAttribute("aria-label"),
        vis: (b as HTMLElement).offsetParent !== null,
      }));
      return {
        mapExpandControl: count(".map-expand-control"),
        minimapExpandButton: count(".minimap-expand-button"),
        minimapContainer: count(".minimap-container"),
        minimapContainerExpanded: count(".minimap-container.expanded"),
        minimapCloseButton: count(".minimap-close-button"),
        minimapContent: count(".minimap-content"),
        minimapModelRoomTitle: count(".minimap-model-room-title"),
        roomControls: count(".room-controls"),
        buttons,
      };
    });
    ctx.log(`step6[legacy] DOM-probe: ${JSON.stringify(dom)}`);
  } catch (e) {
    ctx.log(`step6[legacy] DOM-probe failed: ${(e as Error).message}`);
  }

  // Open the minimap (toggle MapExpand button — selector union covers both builds).
  // robustClick falls back to dispatchEvent because the legacy minimap <canvas> overlays
  // the .map-expand-control button and intercepts a real pointer click.
  try {
    if (!(await robustClick(ctx, MINIMAP_EXPAND_SELECTOR, 5_000))) throw new Error("expand control not found");
    await ctx.page.waitForSelector(MINIMAP_EXPANDED_SELECTOR, { timeout: 5_000 });
    await snap(ctx, "step6a-minimap-expanded");
  } catch (e) {
    ctx.log(`step6: failed to open minimap — ${(e as Error).message}`);
    ctx.notes.push("step6: minimap expand failed");
    return false;
  }

  // Look up the target room's display title via the rooms-list API observer.
  // Minimap labels render `room.title`, not `room.name` (URL slug), so we need
  // the mapping to find the right label.
  const targetTitle = ctx.roomData.getTitleForName(targetRoomName);
  if (!targetTitle) {
    ctx.log(`step6: no title found in API rooms list for room name '${targetRoomName}' — cannot locate label`);
    ctx.notes.push(`step6: no title mapping for '${targetRoomName}'`);
    await snap(ctx, "step6-FAIL-no-title-mapping");
    return false;
  }
  ctx.log(`step6: target room '${targetRoomName}' has title '${targetTitle}' — searching minimap label`);

  // Find the minimap label DOM element with matching text. Drei's <Html center>
  // renders labels as `.minimap-model-room-title` divs with pointer-events:none.
  const label = ctx.page.locator(`.minimap-model-room-title`, { hasText: targetTitle }).first();
  try {
    await label.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    ctx.log(`step6: no minimap label visible with text "${targetTitle}"`);
    ctx.notes.push(`step6: minimap label "${targetTitle}" not visible`);
    await snap(ctx, "step6-FAIL-label-not-visible");
    return false;
  }

  const box = await label.boundingBox();
  if (!box) {
    ctx.log("step6: label has no bounding box (off-screen?)");
    return false;
  }
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  ctx.log(`step6: clicking minimap label at (${cx.toFixed(0)}, ${cy.toFixed(0)})`);
  await snap(ctx, "step6b-label-found");
  // Label has pointer-events:none — click passes through to the room mesh underneath
  await ctx.page.mouse.click(cx, cy);

  // Wait for URL to flip to the target room AND overlay to hide
  try {
    await ctx.page.waitForURL(new RegExp(`/${escapeRe(museumName)}/${escapeRe(targetRoomName)}(\\?|#|$)`), {
      timeout: 30_000,
    });
  } catch {
    ctx.log("step6: navigation to target room didn't fire");
    ctx.notes.push("step6: URL never changed to target room");
    await snap(ctx, "step6-FAIL-no-nav");
    return false;
  }
  try {
    await ctx.page.waitForSelector('.overlay[data-state="hidden"]', { timeout: loadTimeoutMs });
  } catch {
    ctx.log("step6: target room never finished loading");
    ctx.notes.push("step6: target room overlay timeout");
    await snap(ctx, "step6-FAIL-load-timeout");
    return false;
  }
  ctx.log(`step6: arrived at '${targetRoomName}'`);
  await snap(ctx, "step6c-arrived");
  return true;
}

/**
 * Single-canvas minimap navigation (SINGLE_CANVAS_ENABLED on). The minimap is
 * composited INTO the main canvas — room labels are 3D <Text> with no DOM and the
 * room scene lives in a detached r3f root we can't introspect, so we can't compute a
 * specific room's screen coords. Instead: expand the (full-viewport) map and BLIND
 * grid-click it, checking the URL after each click.
 *
 * Why this is safe-ish: when expanded the map fills the whole viewport, so a pointer
 * never falls "outside" to dismiss it. Clicking empty backdrop or the player's own
 * room is a no-op (the map stays open); only clicking a DIFFERENT room navigates
 * (and collapses the map). So we sweep until the URL becomes the target — re-opening
 * the map if a stray click landed us in the wrong room first.
 */
async function navigateSingleCanvasMinimap(
  ctx: FlowContext,
  museumName: string,
  targetRoomName: string,
  loadTimeoutMs: number,
): Promise<boolean> {
  // Single-canvas "expanded" = the in-canvas-minimap close button is shown. (Verified
  // via DOM-probe on the deployed build: `.minimap-close-button[data-hidden="false"]`.)
  const EXPANDED = '.minimap-close-button[data-hidden="false"]';
  const targetRe = new RegExp(`/${escapeRe(museumName)}/${escapeRe(targetRoomName)}(\\?|#|$)`);

  const openMap = async (timeoutMs: number): Promise<boolean> => {
    try {
      if (!(await robustClick(ctx, MINIMAP_EXPAND_SELECTOR, timeoutMs))) return false;
      await ctx.page.waitForSelector(EXPANDED, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  };

  // DIAGNOSTIC: dump minimap-related DOM so we can see what's actually rendered
  // (legacy vs single-canvas, which selectors exist, which buttons are visible).
  try {
    const dom = await ctx.page.evaluate(() => {
      const count = (s: string) => document.querySelectorAll(s).length;
      const buttons = Array.from(document.querySelectorAll("button")).map((b) => ({
        cls: b.className,
        al: b.getAttribute("aria-label"),
        vis: (b as HTMLElement).offsetParent !== null,
      }));
      return {
        mapExpandControl: count(".map-expand-control"),
        minimapContainer: count(".minimap-container"),
        minimapContainerExpanded: count(".minimap-container.expanded"),
        minimapCloseButton: count(".minimap-close-button"),
        minimapCloseButtonShown: count('.minimap-close-button[data-hidden="false"]'),
        minimapContent: count(".minimap-content"),
        roomControls: count(".room-controls"),
        buttons,
      };
    });
    ctx.log(`step6[sc] DOM-probe: ${JSON.stringify(dom)}`);
  } catch (e) {
    ctx.log(`step6[sc] DOM-probe failed: ${(e as Error).message}`);
  }

  if (!(await openMap(8_000))) {
    ctx.log("step6[sc]: could not expand in-canvas minimap (.map-expand-control / close-button)");
    ctx.notes.push("step6[sc]: minimap did not expand");
    await snap(ctx, "step6-FAIL-sc-not-expanded");
    return false;
  }
  await snap(ctx, "step6a-sc-minimap-expanded");

  const vp = ctx.page.viewportSize() ?? { width: 1280, height: 720 };
  // Central band only — rooms sit toward the middle; outer margins are backdrop and
  // the top-right corner holds the close button (clicking it would just collapse).
  const xs: number[] = [];
  const ys: number[] = [];
  const xStep = Math.max(40, Math.round(vp.width * 0.06));
  const yStep = Math.max(40, Math.round(vp.height * 0.07));
  for (let x = Math.round(vp.width * 0.15); x <= Math.round(vp.width * 0.8); x += xStep) xs.push(x);
  for (let y = Math.round(vp.height * 0.25); y <= Math.round(vp.height * 0.85); y += yStep) ys.push(y);

  ctx.log(`step6[sc]: blind grid-click ${xs.length}×${ys.length}=${xs.length * ys.length} points for '${targetRoomName}'`);

  let clicks = 0;
  let wrongRooms = 0;
  const MAX_WRONG_ROOMS = 6; // bail if we keep landing in the wrong room

  outer: for (const y of ys) {
    for (const x of xs) {
      if (targetRe.test(ctx.page.url())) break outer;

      // If a previous click navigated us somewhere, the map collapses. DON'T assume
      // "wrong room" immediately: the URL update LAGS the nav, and misreading a
      // SUCCESSFUL nav as wrong-room makes us re-open the map IN the target room —
      // which then stays open and blocks the canvas for the POI/portal/walk steps.
      // So wait for the URL to settle before deciding.
      if ((await ctx.page.locator(EXPANDED).count()) === 0) {
        const reached = await ctx.page
          .waitForURL(targetRe, { timeout: 2_000 })
          .then(() => true)
          .catch(() => false);
        if (reached) break outer; // actually arrived — leave the map collapsed
        wrongRooms++;
        ctx.log(`step6[sc]: clicked into wrong room (${ctx.page.url()}) — reopening map [${wrongRooms}/${MAX_WRONG_ROOMS}]`);
        if (wrongRooms > MAX_WRONG_ROOMS) {
          ctx.notes.push(`step6[sc]: gave up after ${wrongRooms} wrong-room hits`);
          break outer;
        }
        // Let the wrong room settle, then re-open the map and keep sweeping.
        await ctx.page.waitForSelector('.overlay[data-state="hidden"]', { timeout: loadTimeoutMs }).catch(() => undefined);
        if (!(await openMap(5_000))) {
          ctx.notes.push("step6[sc]: minimap failed to re-open after wrong-room hit");
          break outer;
        }
      }

      await ctx.page.mouse.click(x, y);
      clicks++;
      // Give the nav a beat to flip the URL before the next iteration's collapse-check.
      await ctx.page.waitForTimeout(250);
      if (targetRe.test(ctx.page.url())) {
        ctx.log(`step6[sc]: HIT target after ${clicks} clicks at (${x}, ${y})`);
        break outer;
      }
    }
  }

  if (!targetRe.test(ctx.page.url())) {
    ctx.log(`step6[sc]: grid-click exhausted (${clicks} clicks, ${wrongRooms} wrong rooms) — never reached '${targetRoomName}'`);
    ctx.notes.push(`step6[sc]: blind minimap nav failed (${clicks} clicks)`);
    await snap(ctx, "step6-FAIL-sc-grid-exhausted");
    return false;
  }

  // Reached target — wait for it to finish loading.
  try {
    await ctx.page.waitForSelector('.overlay[data-state="hidden"]', { timeout: loadTimeoutMs });
  } catch {
    ctx.log("step6[sc]: target room never finished loading");
    ctx.notes.push("step6[sc]: target room overlay timeout");
    await snap(ctx, "step6-FAIL-sc-load-timeout");
    return false;
  }
  ctx.log(`step6[sc]: arrived at '${targetRoomName}'`);
  await snap(ctx, "step6c-sc-arrived");
  return true;
}

/**
 * Step 7: find an exhibit via cursor-scan. Hover the canvas in a dense grid and
 * watch `body[data-cursor]` for 'poi'. If nothing in initial view, walk forward
 * (skipping if wall) and rotate to bring new geometry into view.
 *
 * `holdMs` keeps the POI dialog open for that long before closing — useful for
 * sampling runtime metrics with the panel rendered. Pass 0 to skip the hold.
 */
export async function step7_findAndClickExhibit(ctx: FlowContext, holdMs: number): Promise<boolean> {
  // Read counts for the CURRENT room by URL — NOT getLatest(), which the FF-on prefetch
  // pollutes with other rooms' data (e.g. "test-yev"), making us wrongly skip.
  const room = ctx.roomData.getByName(roomNameFromUrl(ctx.page.url()));
  if (room && room.showpieces === 0) {
    ctx.log(`step7: room '${room.name ?? "?"}' has 0 showpieces per API — skipping`);
    return false;
  }
  if (room) {
    ctx.log(`step7: room '${room.name ?? "?"}' has ${room.showpieces} showpieces — cursor-scanning`);
  } else {
    ctx.log("step7: no API room data — cursor-scanning blindly");
  }
  await ensureNoBlockingDialog(ctx, "step7-start");
  await snap(ctx, "step7-pre-scan");

  let hit = await cursorScanFor(ctx, "poi");

  if (!hit) {
    ctx.log("step7: no POI in initial view — sweeping (walk + rotate + rescan)");
    hit = await sweepForCursor(ctx, "poi", "step7");
  }

  if (!hit) {
    ctx.log("step7: no exhibit found after sweep");
    if (room && room.showpieces > 0) {
      ctx.notes.push(`step7: API reported ${room.showpieces} showpieces but cursor-scan found none`);
    }
    return false;
  }
  ctx.log(`step7: clicking POI at (${hit.x}, ${hit.y})`);
  await snap(ctx, "step7a-poi-found");
  // Suppress the stray-overlay watcher while we INTENTIONALLY open + hold this POI.
  ctx.poiHoldActive = true;
  try {
    await ctx.page.mouse.click(hit.x, hit.y);

    // Verify the click actually opened the exhibit. Two builds:
    //  - FF-on poi-in-scene: a close "×" appears in the TOP-RIGHT QUARTER (our marker).
    //  - legacy DetailedPoi: Radix sets [role="dialog"][data-state="open"].
    // If neither shows, the scan-coords were a false positive — don't waste holdMs
    // polluting target_room_poi_open metrics with "empty canvas" frames.
    const poiCross = await waitForPoiCloseInTopRight(ctx, 3_000);
    const poiOpened =
      poiCross !== null ||
      (await ctx.page
        .waitForSelector('[role="dialog"][data-state="open"]', { timeout: 500 })
        .then(() => true)
        .catch(() => false));

    if (!poiOpened) {
      ctx.log("step7: clicked POI but exhibit never opened — false-positive cursor-scan");
      ctx.notes.push("step7: false-positive POI scan (exhibit never opened)");
      await snap(ctx, "step7-FAIL-no-dialog");
      return false;
    }
    ctx.log(
      poiCross
        ? `step7: exhibit open (× marker at ${poiCross.x.toFixed(0)},${poiCross.y.toFixed(0)})`
        : "step7: exhibit open (legacy dialog)",
    );

    if (holdMs > 0) {
      ctx.log(`step7: POI dialog open, holding for ${holdMs}ms`);
      await ctx.page.waitForTimeout(holdMs);
    }
    await snap(ctx, "step7b-poi-clicked");

    // Close the exhibit so it doesn't block the subsequent step8 portal search.
    await closeOpenPoiDialog(ctx);
    return true;
  } finally {
    ctx.poiHoldActive = false;
  }
}

/**
 * Defensive check: if ANY modal-like element is blocking the canvas (a stray
 * POI / poster / drawer panel from an unintended click), close it via Escape.
 * Call at the start of step7/step8 and when sweep walks return distance=0
 * (camera unable to move usually means physics paused by open UI, not a wall).
 *
 * Selectors widened beyond just Radix Dialog to catch the poster/drawer-style
 * panels too (they often have aria-modal or are children of body with high z-index).
 */
async function ensureNoBlockingDialog(ctx: FlowContext, reason: string): Promise<boolean> {
  // A stray FF-on POI preview blocks the canvas but isn't a role=dialog — close via its ×.
  const poiCross = await findPoiCloseInTopRight(ctx);
  if (poiCross) {
    ctx.log(`blocking exhibit preview (${reason}) — closing via × at (${poiCross.x.toFixed(0)}, ${poiCross.y.toFixed(0)})`);
    await ctx.page.mouse.click(poiCross.x, poiCross.y).catch(() => undefined);
    await ctx.page.waitForTimeout(400);
    await snap(ctx, `dialog-force-closed-${reason}`);
    return true;
  }
  const blocked = await ctx.page
    .evaluate(
      () =>
        !!document.querySelector('[role="dialog"][data-state="open"]') ||
        !!document.querySelector('[aria-modal="true"]') ||
        !!document.querySelector(".bottom-sheet[data-state='open']"),
    )
    .catch(() => false);
  if (!blocked) return false;
  ctx.log(`blocking-dialog detected (${reason}) — pressing Escape`);
  await ctx.page.keyboard.press("Escape").catch(() => undefined);
  await ctx.page.waitForTimeout(400);
  // Second attempt: click top-right where the X usually sits
  const stillBlocked = await ctx.page
    .evaluate(
      () =>
        !!document.querySelector('[role="dialog"][data-state="open"]') ||
        !!document.querySelector('[aria-modal="true"]'),
    )
    .catch(() => false);
  if (stillBlocked) {
    ctx.log(`blocking-dialog still present after Escape — clicking corner (1240, 200)`);
    await ctx.page.mouse.click(1240, 200).catch(() => undefined);
    await ctx.page.waitForTimeout(400);
  }
  await snap(ctx, `dialog-force-closed-${reason}`);
  return true;
}

/**
 * Find the exhibit-preview close "×", constrained to the TOP-RIGHT QUARTER of the
 * viewport (per user: with FF on the poi-in-scene preview opens with a close cross
 * there — use its presence as the "exhibit is open" marker and to close it). Returns
 * its center coords or null. Selector from the deployed DOM:
 * `.poi-preview-overlay--action-close` (aria "Esci dall'anteprima").
 */
async function findPoiCloseInTopRight(ctx: FlowContext): Promise<{ x: number; y: number } | null> {
  const vp = ctx.page.viewportSize() ?? { width: 1280, height: 720 };
  // Gate on the overlay being ACTIVE (data-active="true"). The whole .poi-preview-overlay
  // (and its close "×") is ALWAYS mounted, just hidden via CSS — so matching the button
  // blindly false-positives even with no exhibit open (it was spam-clicking the corner).
  const closeBtn = ctx.page
    .locator('.poi-preview-overlay[data-active="true"] .poi-preview-overlay--action-close')
    .first();
  if (!(await closeBtn.isVisible().catch(() => false))) return null;
  const box = await closeBtn.boundingBox().catch(() => null);
  if (!box) return null;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // Top-right quarter only.
  if (cx >= vp.width / 2 && cy <= vp.height / 2) return { x: cx, y: cy };
  return null;
}

/** Poll for the exhibit close "×" (top-right quarter) up to timeoutMs — its appearance
 * is our marker that the exhibit preview actually opened. */
async function waitForPoiCloseInTopRight(ctx: FlowContext, timeoutMs: number): Promise<{ x: number; y: number } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = await findPoiCloseInTopRight(ctx);
    if (c) return c;
    if (Date.now() >= deadline) return null;
    await ctx.page.waitForTimeout(150);
  }
}

/**
 * Close the open exhibit. FF-on poi-in-scene: click the "×" in the top-right quarter.
 * Legacy DetailedPoi (Radix Dialog): Escape. Falls back to Escape + corner-click.
 * Safe to call when nothing is open — no-op.
 */
async function closeOpenPoiDialog(ctx: FlowContext): Promise<void> {
  const cross = await findPoiCloseInTopRight(ctx);
  if (cross) {
    ctx.log(`step7: closing exhibit via × at (${cross.x.toFixed(0)}, ${cross.y.toFixed(0)})`);
    await ctx.page.mouse.click(cross.x, cross.y).catch(() => undefined);
    await ctx.page.waitForTimeout(400);
  } else {
    // Legacy Radix Dialog closes on Escape.
    await ctx.page.keyboard.press("Escape").catch(() => undefined);
    await ctx.page.waitForTimeout(400);
  }
  // Verify nothing is still blocking the canvas (either build).
  const stillOpen =
    (await findPoiCloseInTopRight(ctx)) !== null ||
    (await ctx.page.evaluate(() => !!document.querySelector('[role="dialog"][data-state="open"]')).catch(() => false));
  if (stillOpen) {
    ctx.log("step7: exhibit still open — Escape + corner-click fallback");
    await ctx.page.keyboard.press("Escape").catch(() => undefined);
    await ctx.page.waitForTimeout(300);
    await ctx.page.mouse.click(1240, 200).catch(() => undefined);
    await ctx.page.waitForTimeout(400);
  }
  await snap(ctx, "step7c-poi-closed");
}

/**
 * Close the help/guide dialog (the "Mostra/nascondi guida" overlay) if it's open.
 * It can re-open mid-flow from a stray key/click; the bench never wants it open.
 * Targets ONLY the help close "×" (`.help-button-close`, aria "Chiudi guida") so it
 * NEVER closes the POI exhibit we intentionally hold open in step7. Safe no-op when
 * the dialog isn't shown. Returns true if it closed something.
 */
export async function dismissHelpDialog(ctx: FlowContext): Promise<boolean> {
  // Gate on the guide actually being OPEN (data-open) — its close "×" is always
  // mounted/visible, so matching the button alone false-positives on every poll.
  const open = await ctx.page
    .locator('.help-content[data-open="true"]')
    .count()
    .then((c) => c > 0)
    .catch(() => false);
  if (!open) return false;
  ctx.log("dismissing stray help/guide dialog (×)");
  await ctx.page.locator(".help-button-close").first().click({ timeout: 2_000 }).catch(() => undefined);
  await ctx.page.waitForTimeout(250);
  return true;
}

/**
 * Periodic safety net (run on a timer during each iteration): dismiss stray overlays
 * that block the canvas mid-flow:
 *  - the help/guide dialog (always safe to close), and
 *  - a stray exhibit/poster preview opened by an unintended click (close via its ×) —
 *    BUT only when step7 isn't intentionally holding a POI open (ctx.poiHoldActive),
 *    so we never close the exhibit we're sampling metrics on.
 */
export async function dismissStrayOverlays(ctx: FlowContext): Promise<void> {
  await dismissHelpDialog(ctx);
  if (ctx.poiHoldActive) return; // step7 is holding a POI open on purpose — leave it
  const cross = await findPoiCloseInTopRight(ctx);
  if (cross) {
    ctx.log(`dismissing stray exhibit/poster preview (×) at (${cross.x.toFixed(0)}, ${cross.y.toFixed(0)})`);
    await ctx.page.mouse.click(cross.x, cross.y).catch(() => undefined);
    await ctx.page.waitForTimeout(250);
  }
}

/**
 * Step 8: find a portal via cursor-scan. Hover canvas in a dense grid, watch
 * `body[data-cursor]` for 'portal'. If nothing in initial view, walk forward
 * (skipping if wall) and rotate to bring new geometry into view.
 */
export async function step8_findAndUsePortal(ctx: FlowContext): Promise<boolean> {
  // Read counts for the CURRENT room by URL — NOT getLatest() (FF-on prefetch pollutes
  // it with other rooms like "test-yev", making us wrongly skip the portal).
  const room = ctx.roomData.getByName(roomNameFromUrl(ctx.page.url()));
  if (room && room.neighbors === 0) {
    ctx.log(`step8: room '${room.name ?? "?"}' has 0 neighbors per API — no portal to use, skipping`);
    ctx.notes.push("step8: skipped — room has no neighbors");
    return false;
  }
  if (room) {
    ctx.log(`step8: room '${room.name ?? "?"}' has ${room.neighbors} neighbor(s) — cursor-scanning for portal`);
  } else {
    ctx.log("step8: no API room data — cursor-scanning blindly");
  }
  await ensureNoBlockingDialog(ctx, "step8-start");
  await snap(ctx, "step8-pre-scan");

  let hit = await cursorScanFor(ctx, "portal");

  if (!hit) {
    ctx.log("step8: no portal in initial view — sweeping (walk + rotate + rescan)");
    hit = await sweepForCursor(ctx, "portal", "step8");
  }

  if (!hit) {
    ctx.log("step8: portal NOT found after sweep");
    ctx.notes.push("step8: portal not found in any view");
    await snap(ctx, "step8-FAIL-no-portal");
    return false;
  }

  const urlBefore = ctx.page.url();
  ctx.log(`step8: clicking portal at (${hit.x}, ${hit.y})`);
  await snap(ctx, "step8a-portal-found");
  await ctx.page.mouse.click(hit.x, hit.y);

  // Wait for either URL change or overlay reappearing
  try {
    await Promise.race([
      ctx.page.waitForFunction((before) => window.location.href !== before, urlBefore, { timeout: 10_000 }),
      ctx.page.waitForSelector('.overlay[data-state="visible"], .overlay[data-state="fade-out"]', { timeout: 10_000 }),
    ]);
  } catch {
    ctx.log("step8: no navigation signal — portal click may have been a no-op");
  }

  ctx.log("step8: waiting for next room to finish loading");
  try {
    await ctx.page.waitForSelector('.overlay[data-state="hidden"]', { timeout: 90_000 });
    ctx.log(`step8: arrived at ${ctx.page.url()}`);
    await snap(ctx, "step8b-after-portal");
    return true;
  } catch {
    ctx.log("step8: room-load timed out after portal");
    ctx.notes.push("step8: room load timed out");
    await snap(ctx, "step8-FAIL-load-timeout");
    return false;
  }
}

/**
 * Health check: confirm the room's 3D mesh actually loaded by attempting two
 * short walks (forward, then rotated 180° if first failed). If the room GLB
 * failed to download / parse, there's no floor + no collision and camera
 * stays put on BOTH attempts. Skybox + minimap may still render, masking the
 * issue visually.
 *
 * Why two attempts: player can spawn nose-to-wall in narrow corridors —
 * forward walk fails but room is loaded fine. Trying the opposite direction
 * after a 180° rotate distinguishes "wall in front" (false positive) from
 * "no floor anywhere" (real load failure).
 *
 * Threshold: 0.2 m per 700ms walk — permissive; a real walk yields ~2-3 m.
 */
async function probeRoomLoaded(ctx: FlowContext): Promise<boolean> {
  // Defensive: release any latched KeyW from a prior step that might've thrown
  await ctx.page.keyboard.up("KeyW").catch(() => undefined);

  const probe1 = await walkForward(ctx.page, 700);
  if (probe1.distance >= 0.2) {
    ctx.log(`room-loaded probe: distance=${probe1.distance.toFixed(2)}m → OK (mesh loaded, forward)`);
    return true;
  }
  ctx.log(`room-loaded probe: forward=${probe1.distance.toFixed(2)}m (< 0.2m) — trying after 180° rotate`);

  // Maybe we spawned facing a wall. Rotate 180° and try the other way.
  await dragRotate(ctx.page, 560, 0);
  const probe2 = await walkForward(ctx.page, 700);
  if (probe2.distance >= 0.2) {
    ctx.log(`room-loaded probe: distance=${probe2.distance.toFixed(2)}m → OK (mesh loaded, after rotate)`);
    return true;
  }
  ctx.log(`room-loaded probe: both attempts < 0.2m (fwd=${probe1.distance.toFixed(2)}, after-rotate=${probe2.distance.toFixed(2)}) → FAIL`);
  return false;
}

/**
 * Validate room mesh loaded with retry. On fail, reloads the page (URL stays the
 * same, FE re-auto-logs-in and re-loads the room), waits for overlay-hidden, and
 * re-probes. Returns `{loaded, reloadCount}` — caller logs reloadCount to stats
 * so we know how often the FE flakes on initial load.
 *
 * `loadTimeoutMs` is the overlay-hidden timeout per reload attempt.
 */
export async function ensureRoomLoadedWithRetry(
  ctx: FlowContext,
  loadTimeoutMs: number,
  maxRetries = 2,
  /**
   * Called by the caller BEFORE each page.reload() so it can pull the current
   * collector snapshot and merge it into a cross-realm accumulator. Page reload
   * replaces the JS realm — without this hook, all phase samples collected up to
   * this point are lost when the new realm starts with a fresh empty collector.
   */
  onBeforeReload?: () => Promise<void>,
): Promise<{ loaded: boolean; reloadCount: number }> {
  // Settle on room entry: let the just-loaded room stabilize (textures/shaders/physics)
  // for 5s before we start probing / moving / scanning. Runs on EVERY room entry
  // (target + next), before any measured phase begins.
  ctx.log("room-entry: settling 5s before probe/scan");
  await ctx.page.waitForTimeout(5_000);
  let loaded = await probeRoomLoaded(ctx);
  let reloadCount = 0;

  while (!loaded && reloadCount < maxRetries) {
    reloadCount++;
    ctx.log(`room-load: mesh missing — reload attempt ${reloadCount}/${maxRetries}`);
    await snap(ctx, `room-load-FAIL-pre-reload-${reloadCount}`);
    if (onBeforeReload) {
      try { await onBeforeReload(); } catch (e) { ctx.log(`room-load: onBeforeReload threw — ${(e as Error).message}`); }
    }
    try {
      await ctx.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      // FE may re-show the help/controls dialog after reload — close it if so.
      // step2 is idempotent (no-op if dialog isn't there).
      await step2_closeHelpDialog(ctx);
      await ctx.page.waitForSelector('.overlay[data-state="hidden"]', { timeout: loadTimeoutMs });
    } catch (e) {
      ctx.log(`room-load: reload ${reloadCount} timed out — ${(e as Error).message}`);
      continue;
    }
    loaded = await probeRoomLoaded(ctx);
  }

  if (!loaded) {
    ctx.log(`room-load: FAILED after ${reloadCount} reload(s) — proceeding with mesh skip`);
    await snap(ctx, "room-load-FAIL-final");
  } else if (reloadCount > 0) {
    ctx.log(`room-load: recovered after ${reloadCount} reload(s)`);
  }
  return { loaded, reloadCount };
}

/**
 * Step 10: deterministic round-trip walk for clean "FPS during movement" metrics.
 * Walks forward N segments tracking ACTUAL displacement; walks BACKWARD (KeyS)
 * until cumulative return distance matches outbound (so wall hits on outbound
 * don't cause overshoot on return). NO rotations — end state matches start
 * exactly (same position + same facing), independent of FE rotation sensitivity.
 *
 * `durationMs` = walking-time budget for outbound. Inbound walks as many
 * segments as needed to retrace, capped at 2× outbound for safety.
 */
export async function step10_walkAround(ctx: FlowContext, durationMs: number): Promise<void> {
  const FORWARD_MS = 1500;
  const outboundSegments = Math.max(2, Math.round(durationMs / FORWARD_MS / 2));
  ctx.log(`step10: round-trip walk — ${outboundSegments} forward + ${outboundSegments}+ backward`);
  await snap(ctx, "step10-walk-start");

  // Outbound: walk forward, tracking actual displacement per segment.
  // Abort if cameraUnknown (camera hook not capturing positions) — without
  // distance feedback we can't return to spawn, leaving subsequent phases
  // measuring the camera at an arbitrary spot.
  let outboundDist = 0;
  for (let i = 0; i < outboundSegments; i++) {
    const w = await walkForward(ctx.page, FORWARD_MS);
    if (w.cameraUnknown) {
      ctx.log(`step10: ABORT — camera position unknown after outbound #${i + 1}; round-trip skipped`);
      ctx.notes.push("step10: aborted — camera position lost (cameraHook not capturing)");
      await snap(ctx, "step10-walk-end-aborted");
      return;
    }
    outboundDist += w.distance;
    ctx.log(`step10: outbound #${i + 1} — distance=${w.distance.toFixed(2)}m (cumulative=${outboundDist.toFixed(2)}m)`);
  }

  // Inbound: walk BACKWARD until cumulative return distance ≥ outbound.
  // No rotation needed — physics moves us back along the same axis we faced.
  // Hard cap at 2× outboundSegments to avoid infinite loop if FE physics breaks.
  const tolerance = 0.5;
  const maxInboundSegments = outboundSegments * 2;
  let inboundDist = 0;
  let inboundSegments = 0;
  for (let i = 0; i < maxInboundSegments && inboundDist < outboundDist - tolerance; i++) {
    const w = await walkBackward(ctx.page, FORWARD_MS);
    if (w.cameraUnknown) {
      ctx.log(`step10: ABORT — camera position unknown during inbound #${inboundSegments + 1}`);
      ctx.notes.push("step10: aborted mid-inbound — camera position lost");
      await snap(ctx, "step10-walk-end-aborted");
      return;
    }
    inboundDist += w.distance;
    inboundSegments++;
    ctx.log(`step10: inbound #${inboundSegments} — distance=${w.distance.toFixed(2)}m (cumulative=${inboundDist.toFixed(2)}m / target=${outboundDist.toFixed(2)}m)`);
  }
  if (inboundDist < outboundDist - tolerance) {
    ctx.log(`step10: inbound capped at ${inboundSegments} segments (covered ${inboundDist.toFixed(2)}m of ${outboundDist.toFixed(2)}m)`);
  }

  await snap(ctx, "step10-walk-end");
}

/* ---------- internals ---------- */

/**
 * Dense cursor-scan across the canvas: hover the mouse over a grid and watch
 * `document.body.dataset.cursor` for the target value. Returns hit position or null.
 * Step 40px × 150ms hover ≈ ~50 cells covering middle 75% of canvas in ~7s.
 */
async function cursorScanFor(
  ctx: FlowContext,
  target: "poi" | "portal" | "tablet" | "drawer",
): Promise<{ x: number; y: number } | null> {
  const observed = new Set<string>();
  // Scan window: skip top 40% (sky/ceiling) + bottom 20% (close floor/HUD) — middle
  // band is where portals + exhibits land in practice. Y step is finer than X (30 vs 60)
  // so we don't skip rows where a small interactive sits.
  const hit = await gridScanForCursor(ctx.page, target, {
    stepPx: 60,
    stepYPx: 30,
    hoverPauseMs: 100,
    xStartRatio: 0.1,
    xEndRatio: 0.9,
    yStartRatio: 0.4,
    yEndRatio: 0.8,
    observed,
  });
  if (hit) {
    ctx.log(`cursor-scan[${target}]: HIT at (${hit.x}, ${hit.y})`);
    return hit;
  }
  ctx.log(`cursor-scan[${target}]: not found. Observed cursors during scan: [${Array.from(observed).join(", ") || "<none>"}]`);
  return null;
}

/**
 * Wall-follow exploration: portals tend to be in walls, exhibits anywhere. The
 * algorithm walks forward, scans after each step, and turns based on what it
 * hit. When walking is blocked (distance < WALL_THRESHOLD_M), turn sharply
 * (~90°) — we just bumped a wall and want to slide along it. When walking
 * freely, gently turn ~30° to keep exploring new orientations.
 *
 * Up to MAX_ATTEMPTS = 12 walks ≈ explores 4-6 wall edges of a typical room.
 */
async function sweepForCursor(
  ctx: FlowContext,
  target: "poi" | "portal",
  stepLabel: string,
): Promise<{ x: number; y: number } | null> {
  // Tuned for the worst-case open rooms (e.g. sibaritide/room-2 — 27 POIs scattered
  // across an outdoor area). Override via BENCH_SWEEP_MAX_ATTEMPTS for one-off tuning.
  const MAX_ATTEMPTS = parseInt(process.env.BENCH_SWEEP_MAX_ATTEMPTS || "20", 10);
  // Skip cursor-scan if we walked < this distance — view didn't change enough to be worth
  // a ~7-sec scan. Lower bound also doubles as wall detection. Source: FE physics terminal
  // velocity 6.25 m/s × 1.2s ≈ 5m on clear path; < 2.5m means significant obstruction.
  const SCAN_SKIP_THRESHOLD_M = 2.5;
  let consecutiveFreeWalks = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const walk = await walkForward(ctx.page, 1200);
    ctx.log(`${stepLabel}: walk #${attempt + 1} — distance=${walk.distance.toFixed(2)}m`);

    // distance=0 often means a panel opened over the canvas (POI/poster/drawer)
    // and physics paused — NOT a wall. Try to close any blocker before re-deciding.
    if (walk.distance < 0.05) {
      const wasBlocked = await ensureNoBlockingDialog(ctx, `${stepLabel}-walk${attempt + 1}-zero`);
      if (wasBlocked) {
        ctx.log(`${stepLabel}: panel was blocking canvas — retry this attempt`);
        attempt--; // re-do this iteration after closing the panel
        continue;
      }
    }

    // PORTAL: scan BEFORE rotate — portals are usually on walls, walking toward
    // them brings them into central view without needing a rotation pivot.
    if (target === "portal" && walk.distance >= SCAN_SKIP_THRESHOLD_M) {
      await snap(ctx, `${stepLabel}-walk-${attempt + 1}`);
      const hit = await cursorScanFor(ctx, target);
      if (hit) return hit;
    }

    // Pick rotation angle based on how stuck we got:
    //   < 1m  → corner / full block → 180° reverse
    //   < 2.5m → side-wall slide    → 90° sharp
    //   ≥ 2.5m → free walk          → 30° gentle (90° after 3 in a row)
    let rotPx: number;
    if (walk.distance < 1) {
      ctx.log(`${stepLabel}: walked < 1m (stuck in corner) — 180° reverse`);
      rotPx = 560;
      consecutiveFreeWalks = 0;
    } else if (walk.distance < SCAN_SKIP_THRESHOLD_M) {
      ctx.log(`${stepLabel}: walked < ${SCAN_SKIP_THRESHOLD_M}m — sharp turn ~90° to follow wall`);
      rotPx = 280;
      consecutiveFreeWalks = 0;
    } else {
      consecutiveFreeWalks++;
      if (consecutiveFreeWalks >= 3) {
        ctx.log(`${stepLabel}: 3 free walks in a row — sharper turn to find a wall edge`);
        rotPx = 280;
        consecutiveFreeWalks = 0;
      } else {
        ctx.log(`${stepLabel}: free walk — gentle turn ~30° to widen exploration`);
        rotPx = 90;
      }
    }
    await dragRotate(ctx.page, rotPx, 0);

    // POI: scan AFTER rotate — exhibits are scattered (often around the player),
    // a new rotation angle reveals new candidates better than a new position.
    if (target === "poi") {
      await snap(ctx, `${stepLabel}-rotated-${attempt + 1}`);
      const hit = await cursorScanFor(ctx, target);
      if (hit) return hit;
    }
  }
  return null;
}

/** Walk backward (KeyS) for `durationMs`, returning displacement (m). Same FE
 * physics as forward — useful for symmetric round-trip without rotation. */
async function walkBackward(page: Page, durationMs: number): Promise<{ distance: number; cameraUnknown?: boolean }> {
  return walkInDirection(page, "KeyS", durationMs);
}

/**
 * Hold W for `durationMs` to walk forward, measuring REAL world-space distance
 * via the `cameraPosition` uniform captured by WEBGL_CAMERA_HOOK_INIT.
 *
 * Reference values (FE-derived, see PlayerController/{usePlayerMovement,
 * usePlayerPhysics,constants}.js):
 *   - accel = 25 units/sec² when forward held
 *   - damping = exp(-4*delta) per frame → terminal velocity = 25/4 = 6.25 m/s
 *   - 1 unit = 1 metre (playerHeight=1.7, detectionRangeMetres=0.5)
 *   - Expected 1.2s walk from rest on clear path: ~5-6 m
 *
 * Returns `{distance: number}` in metres. Caller decides what threshold means.
 */
async function walkForward(page: Page, durationMs: number): Promise<{ distance: number; cameraUnknown?: boolean }> {
  return walkInDirection(page, "KeyW", durationMs);
}

/** Internal: hold any movement key for durationMs, measure horizontal displacement. */
async function walkInDirection(
  page: Page,
  key: "KeyW" | "KeyS" | "KeyA" | "KeyD",
  durationMs: number,
): Promise<{ distance: number; cameraUnknown?: boolean }> {
  const before = (await page.evaluate(() => (window as unknown as { __lastCameraPos: number[] | null }).__lastCameraPos)) as
    | [number, number, number]
    | null;
  await page.keyboard.down(key);
  await page.waitForTimeout(durationMs);
  await page.keyboard.up(key);
  await page.waitForTimeout(250); // let physics settle (damping continues after key release)
  const after = (await page.evaluate(() => (window as unknown as { __lastCameraPos: number[] | null }).__lastCameraPos)) as
    | [number, number, number]
    | null;

  if (!before || !after) {
    // Camera hook didn't capture cameraPosition (shader not rendering / context lost).
    // Surface as a flag so callers can decide what to do — DON'T fabricate a distance
    // (the previous sentinel of 99 cascaded into round-trip walks trying to retrace
    // 99m which is impossible, leaving the camera in a nondeterministic position).
    return { distance: 0, cameraUnknown: true };
  }
  // Ignore Y (vertical) — only horizontal travel matters
  const dx = after[0] - before[0];
  const dz = after[2] - before[2];
  return { distance: Math.sqrt(dx * dx + dz * dz) };
}

/**
 * Rotate the camera in DRAG mode by simulating a click+drag on the canvas.
 * `deltaX` positive → drag left → camera turns right. Approx 400px ≈ 120° turn,
 * but tune per FE's drag sensitivity.
 */
async function dragRotate(page: Page, deltaX: number, deltaY = 0): Promise<void> {
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // Drag in the opposite direction of where we want to look
  await page.mouse.move(cx - deltaX, cy - deltaY, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(400); // let camera settle after drag
}

interface VerticalScanOptions {
  stepPx?: number;
  hoverPauseMs?: number;
  xRatio?: number;
  yStartRatio?: number;
  yEndRatio?: number;
}

/**
 * Sweep the mouse down a vertical line at xRatio (default 0.5 = center) and
 * read body[data-cursor] at each step. Use for objects you know sit along the
 * player's forward axis (e.g. the lobby tablet at spawn).
 */
async function verticalScanForCursor(
  page: Page,
  target: string,
  opts: VerticalScanOptions = {},
): Promise<{ x: number; y: number } | null> {
  const stepPx = opts.stepPx ?? 25;
  const hoverPauseMs = opts.hoverPauseMs ?? 200;
  const xRatio = opts.xRatio ?? 0.5;
  const yStartRatio = opts.yStartRatio ?? 0.2;
  const yEndRatio = opts.yEndRatio ?? 0.85;

  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const x = Math.floor(viewport.width * xRatio);
  const startY = Math.max(20, Math.floor(viewport.height * yStartRatio));
  const endY = Math.min(viewport.height - 20, Math.ceil(viewport.height * yEndRatio));

  for (let y = startY; y <= endY; y += stepPx) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(hoverPauseMs);
    const cursor = await page.evaluate(() => document.body.dataset.cursor || "");
    if (cursor === target) return { x, y };
  }
  return null;
}

interface GridScanOptions {
  /** Horizontal step in pixels (column-to-column within a row). */
  stepPx?: number;
  /** Vertical step in pixels (row-to-row). Defaults to stepPx if omitted. */
  stepYPx?: number;
  hoverPauseMs?: number;
  xStartRatio?: number;
  xEndRatio?: number;
  yStartRatio?: number;
  yEndRatio?: number;
  /** Optional set the scanner fills with all distinct cursor values it observed. Diagnostic only. */
  observed?: Set<string>;
}

/**
 * Grid-scan the canvas in click-to-walk (non-pointer-locked) mode: move mouse over
 * a grid and read body[data-cursor]. Returns first hit position or null.
 *
 * Tune `stepPx` smaller and `hoverPauseMs` larger if scans miss small targets.
 * Use the `*Ratio` options (0..1) to restrict the scan area — e.g. yStart=0.25
 * + yEnd=0.75 scans only the middle 50% vertically.
 */
async function gridScanForCursor(
  page: Page,
  target: string,
  opts: GridScanOptions = {},
): Promise<{ x: number; y: number } | null> {
  const stepPx = opts.stepPx ?? 50;
  const stepYPx = opts.stepYPx ?? stepPx;
  const hoverPauseMs = opts.hoverPauseMs ?? 180;
  const xStartRatio = opts.xStartRatio ?? 0;
  const xEndRatio = opts.xEndRatio ?? 1;
  const yStartRatio = opts.yStartRatio ?? 0;
  const yEndRatio = opts.yEndRatio ?? 1;

  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const startX = Math.max(20, Math.floor(viewport.width * xStartRatio));
  const endX = Math.min(viewport.width - 20, Math.ceil(viewport.width * xEndRatio));
  const startY = Math.max(20, Math.floor(viewport.height * yStartRatio));
  const endY = Math.min(viewport.height - 20, Math.ceil(viewport.height * yEndRatio));

  for (let y = startY; y <= endY; y += stepYPx) {
    for (let x = startX; x <= endX; x += stepPx) {
      await page.mouse.move(x, y);
      await page.waitForTimeout(hoverPauseMs);
      const cursor = await page.evaluate(() => document.body.dataset.cursor || "");
      if (cursor) opts.observed?.add(cursor);
      if (cursor === target) return { x, y };
    }
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
