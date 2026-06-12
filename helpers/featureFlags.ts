/**
 * Backend feature-flag keys the museum app reads at runtime via
 * `GET {API}/public/feature-flags/{KEY}` → boolean. Mirrors the FeatureFlag union +
 * named hooks in core/features/feature-flags/useFeatureFlag.ts.
 *
 * Values are captured at runtime by FeatureFlagObserver, which intercepts the app's
 * OWN requests (the deployed FE's import.meta.env VITE_API_URL override points the
 * bundle at a different backend than config.json, so fetching them ourselves hits the
 * wrong host). Several of these steer the FLOW, not just the metrics:
 *  - SINGLE_CANVAS_ENABLED   → minimap is composited into the main canvas (no DOM
 *                              room labels) — changes step6 navigation entirely.
 *  - PROGRESSIVE_ROOM_LOAD_ENABLED → defers showpiece loading (affects POI timing).
 *  - PREFETCH_STRATEGY_ENABLED     → warms rooms on minimap hover (asset attribution).
 * The LOD/FRUSTUM flags affect what's rendered (the metrics we measure), not navigation.
 */
export const FEATURE_FLAG_KEYS = [
  "SINGLE_CANVAS_ENABLED",
  "LOD_ENABLED",
  "LOD_PREFER_KTX_ENABLED",
  "FRUSTUM_ENABLED",
  "FRUSTUM_DISTANCE_ENABLED",
  "PROGRESSIVE_ROOM_LOAD_ENABLED",
  "PREFETCH_STRATEGY_ENABLED",
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];
export type FeatureFlags = Record<FeatureFlagKey, boolean>;
