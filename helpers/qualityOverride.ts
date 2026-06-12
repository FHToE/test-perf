/**
 * Builds the JS that, run as an init script, seeds the museum app's
 * preferences-store BEFORE any app code executes. The seed forces
 * performanceMode=custom + the chosen LOD, which prevents AutoPerformanceManager
 * from mounting (so the FPS-driven LOD/feature step changes don't fire) and
 * pins the bench at a known quality.
 *
 * Equivalent to a user opening Preferences → Performance Mode: Custom → Quality: <tier>.
 *
 * MIRROR of FEATURE_DEFAULTS and PERSIST_VERSION in:
 *   packages/museum/src/features/preferences/constants.ts
 *   packages/museum/src/features/preferences/hooks/usePreferencesStore.ts
 * If you bump PERSIST_VERSION in the FE or change FEATURE_DEFAULTS shape,
 * update this file too — otherwise the seed will get migrated/ignored.
 */

export type ForceQuality = "low" | "medium" | "high";

const PERSIST_VERSION = 2;
const STORE_KEY = "preferences-store";

const FEATURE_DEFAULTS = {
  low: { portal: false, shadows: 0, pixelRatio: 0.75 },
  medium: { portal: true, shadows: 1024, pixelRatio: 1 },
  high: { portal: true, shadows: 4096, pixelRatio: 1.5 },
} as const;

export function buildPreferencesSeedScript(quality: ForceQuality): string {
  const payload = {
    state: {
      performanceMode: "custom",
      customSnapshot: null,
      lod: quality,
      features: { ...FEATURE_DEFAULTS[quality] },
    },
    version: PERSIST_VERSION,
  };
  // JSON.stringify of JSON.stringify so the inner string is a JS string literal
  // safely embedded in the init script (handles quotes/backslashes correctly).
  const json = JSON.stringify(JSON.stringify(payload));
  const key = JSON.stringify(STORE_KEY);
  return `
(() => {
  try {
    localStorage.setItem(${key}, ${json});
    // eslint-disable-next-line no-console
    console.log('[perf-bench] seeded preferences-store with quality=${quality} (performanceMode=custom)');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[perf-bench] failed to seed preferences-store:', e);
  }
})();
`;
}
