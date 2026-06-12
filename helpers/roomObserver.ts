import type { Page, Response } from "@playwright/test";

/**
 * Observes BE responses for the current room and exposes counts of interactive
 * objects (POIs / portals). The FE fetches `/public/rooms/{uuid}` whenever a
 * room is entered; the response is `RoomPublic` with `showpieces[]` (POIs) and
 * `neighbors[]` (portals).
 *
 * Use to skip cursor-scan steps when we know there's nothing to find.
 */
export interface RoomCounts {
  showpieces: number;
  neighbors: number;
  name?: string;
  url: string;
}

export class RoomObserver {
  private latest: RoomCounts | null = null;
  private titleByName: Map<string, string> = new Map();
  // Room counts keyed by slug name. The FF-on app PREFETCHES other rooms'
  // /public/rooms/<uuid> data, so `latest` is often a prefetched room (e.g. "test-yev"),
  // not the one we're standing in — read by name via getByName() instead.
  private byName: Map<string, RoomCounts> = new Map();
  private detached = false;
  private handler: ((resp: Response) => void | Promise<void>) | null = null;

  attach(page: Page): void {
    this.handler = async (resp) => {
      if (this.detached) return;
      const url = resp.url();
      const isSingleRoom = /\/public\/rooms\/[a-f0-9-]{36}(\?|$)/i.test(url);
      const isRoomsList = !isSingleRoom && /\/public\/rooms(\?|$)/i.test(url);
      if (!isSingleRoom && !isRoomsList) return;
      if (resp.status() !== 200) return;
      try {
        const json = await resp.json();
        if (isSingleRoom) {
          const room = json as { showpieces?: unknown[]; neighbors?: unknown[]; name?: string };
          const counts: RoomCounts = {
            showpieces: Array.isArray(room.showpieces) ? room.showpieces.length : 0,
            neighbors: Array.isArray(room.neighbors) ? room.neighbors.length : 0,
            name: room.name,
            url,
          };
          this.latest = counts;
          if (room.name) this.byName.set(room.name, counts);
        } else if (isRoomsList && Array.isArray(json)) {
          for (const r of json as Array<{ name?: string; title?: string }>) {
            if (r.name && r.title) this.titleByName.set(r.name, r.title);
          }
        }
      } catch {
        // body wasn't JSON or already consumed — ignore
      }
    };
    page.on("response", this.handler);
  }

  /** Look up a room's display title by its URL-slug name (from cached rooms-list responses). */
  getTitleForName(name: string): string | undefined {
    return this.titleByName.get(name);
  }

  detach(page: Page): void {
    this.detached = true;
    if (this.handler) {
      page.off("response", this.handler);
      this.handler = null;
    }
  }

  /** Returns the most recent room data, or null if no /public/rooms/<uuid> response has been seen yet. */
  getLatest(): RoomCounts | null {
    return this.latest;
  }

  /** Room counts for a specific slug name (robust to prefetch overwriting `latest`). */
  getByName(name: string | null | undefined): RoomCounts | undefined {
    return name ? this.byName.get(name) : undefined;
  }

  /** Clear cached data — call before a navigation/transition so the next read reflects only post-nav state. */
  reset(): void {
    this.latest = null;
  }

  /**
   * Block until any room-data response is captured (or timeout). Returns
   * immediately if data already exists. Useful right after the initial room
   * load — gives the API response time to land before we read counts.
   */
  async waitForNew(timeoutMs = 30_000, pollIntervalMs = 100): Promise<RoomCounts | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.latest !== null) return this.latest;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return null;
  }

  /**
   * Block until `latest.url` differs from `sinceUrl` (or timeout). Use after
   * a portal transition: pass the URL of the previous room's response so we
   * wait specifically for the NEW room's API response, not the cached one.
   */
  async waitForChange(sinceUrl: string | undefined, timeoutMs = 15_000, pollIntervalMs = 100): Promise<RoomCounts | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.latest && this.latest.url !== sinceUrl) return this.latest;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return this.latest;
  }
}
