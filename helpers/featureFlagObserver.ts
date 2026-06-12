import { type Page, type Response } from "@playwright/test";

import { type FeatureFlagKey } from "./featureFlags.js";

/**
 * Captures the feature-flag values the APP itself reads, by intercepting its
 * `GET .../public/feature-flags/{KEY}` responses (`page.on('response')`).
 *
 * Why intercept instead of fetching the flags ourselves: the deployed FE overrides
 * `VITE_API_URL` at build time via `import.meta.env`, so the API host baked into the
 * bundle differs from the one in `config.json` (dev FE → `smi-metaverso-rest-dev`,
 * config.json → the prod `ssot` host). Reading config.json hits the WRONG backend.
 * Intercepting the app's own requests is host-agnostic and gives the exact booleans
 * the app is acting on. Mirrors the app's fallback: a non-2xx response (e.g. the BE
 * returns 400 for unknown FRUSTUM_* keys) → false.
 */
export class FeatureFlagObserver {
  private flags: Partial<Record<string, boolean>> = {};
  private apiBase: string | null = null;

  private readonly handler = (res: Response): void => {
    const match = res.url().match(/\/public\/feature-flags\/([A-Za-z0-9_]+)(?:\?|#|$)/);
    if (!match) return;
    const key = match[1];
    if (!this.apiBase) this.apiBase = res.url().split("/public/feature-flags/")[0];
    if (!res.ok()) {
      this.flags[key] = false; // app's useFeatureFlag falls back to false on error
      return;
    }
    // Body is a bare JSON boolean ("true" / "false"). Read async, fire-and-forget.
    res
      .text()
      .then((t) => {
        this.flags[key] = t.trim().toLowerCase() === "true";
      })
      .catch(() => undefined);
  };

  attach(page: Page): void {
    page.on("response", this.handler);
  }

  detach(page: Page): void {
    page.off("response", this.handler);
  }

  /** Latest captured value for a flag, or undefined if not seen yet. */
  get(key: FeatureFlagKey): boolean | undefined {
    return this.flags[key];
  }

  /** Wait until a flag has been captured (or timeout). Returns the value, or
   * undefined if it never arrived. The app fetches the core flags at lobby/room
   * load, so by step6 they're long resolved — this is just a safety wait. */
  async waitFor(key: FeatureFlagKey, timeoutMs: number): Promise<boolean | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (this.flags[key] === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.flags[key];
  }

  /** All captured flags so far (for run_meta). */
  snapshot(): Record<string, boolean> {
    return { ...this.flags } as Record<string, boolean>;
  }

  hasAny(): boolean {
    return Object.keys(this.flags).length > 0;
  }

  /** The API host the app actually used (derived from intercepted URLs). */
  apiUrl(): string | null {
    return this.apiBase;
  }
}
