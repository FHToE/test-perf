import * as fs from "node:fs";
import * as path from "node:path";

import type { ConsoleMessage, Page, Request, Response } from "@playwright/test";

/**
 * Streams browser-side diagnostics (console, page errors, failed requests,
 * navigation events) to a per-iteration log file for post-run forensics.
 *
 * Returns an unsubscribe fn that the caller should call before closing the page.
 */
export function attachPageLogger(page: Page, logFilePath: string): () => void {
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  const stream = fs.createWriteStream(logFilePath, { flags: "w" });

  const write = (tag: string, msg: string): void => {
    const ts = new Date().toISOString();
    stream.write(`${ts} [${tag}] ${msg}\n`);
  };

  write("init", `--- Page log started for ${page.url() || "<unloaded>"}`);

  const onConsole = (m: ConsoleMessage): void => {
    const type = m.type();
    const text = m.text();
    const loc = m.location();
    const where = loc.url ? ` @ ${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : "";
    write(`console:${type}`, `${text}${where}`);
  };

  const onPageError = (err: Error): void => {
    write("pageerror", `${err.message}\n${err.stack || ""}`);
  };

  const onRequestFailed = (req: Request): void => {
    write("request-failed", `${req.method()} ${req.url()} — ${req.failure()?.errorText || "unknown"}`);
  };

  const onResponse = (resp: Response): void => {
    const status = resp.status();
    if (status >= 400) {
      write("response-error", `${status} ${resp.request().method()} ${resp.url()}`);
    }
  };

  const onFrameNavigated = (frame: { url(): string; parentFrame(): unknown }): void => {
    if (frame.parentFrame() === null) {
      write("nav", `→ ${frame.url()}`);
    }
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  page.on("framenavigated", onFrameNavigated);

  return () => {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
    page.off("response", onResponse);
    page.off("framenavigated", onFrameNavigated);
    stream.write(`${new Date().toISOString()} [end] --- Page log closed\n`);
    stream.end();
  };
}

/** Slugify a room path like "torino/hallway-1" → "torino__hallway-1" for filename use. */
export function roomSlug(room: string): string {
  return room.replace(/[\\/]/g, "__").replace(/[^a-zA-Z0-9_-]/g, "_");
}
