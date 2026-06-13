import "dotenv/config";

import { defineConfig } from "@playwright/test";

// Use the user's installed Chrome instead of Playwright's bundled Chromium build.
// Bundled Chromium sometimes has WebGL/GPU quirks that real Chrome doesn't —
// if you see black canvas / WebGL context lost, try BENCH_USE_SYSTEM_CHROME=1.
const useSystemChrome = ["1", "true", "yes"].includes((process.env.BENCH_USE_SYSTEM_CHROME || "").toLowerCase());

export default defineConfig({
  testDir: ".",
  testMatch: ["flow.spec.ts"],
  globalSetup: "./global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 10 * 60 * 1000,
  reporter: [["list"]],
  use: {
    headless: false,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      ...(useSystemChrome ? { channel: "chrome" as const } : {}),
      args: [
        "--enable-precise-memory-info",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-features=CalculateNativeWinOcclusion",
        // GPU helpers — try to keep hardware acceleration on even if Chromium would
        // otherwise blocklist the driver
        "--ignore-gpu-blocklist",
        "--enable-gpu-rasterization",
        "--enable-zero-copy",
        // Decouple rendering from the display refresh rate so FPS reflects the GPU
        // ceiling, not the screen's Hz. Critical on RDP/virtual displays (~32Hz cap)
        // where the refresh rate can differ BETWEEN runs and silently break the
        // FF-off vs FF-on FPS comparison. Both flags are needed: vsync gates frame
        // presentation, the rate-limit caps the compositor.
        "--disable-gpu-vsync",
        "--disable-frame-rate-limit",
      ],
    },
  },
});
