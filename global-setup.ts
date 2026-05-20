import "dotenv/config";

import { chromium } from "@playwright/test";

/**
 * Pre-flight GPU validation — runs once before any benchmark iterations.
 * Opens a throwaway browser, creates a WebGL context, reads the unmasked
 * renderer string, and aborts the whole test run if WebGL is falling back
 * to software rendering (SwiftShader / llvmpipe / etc.) — in which case
 * every benchmark number would be meaningless.
 *
 * Triggered by `globalSetup` in playwright.config.ts. Throwing here makes
 * Playwright skip all tests and exit non-zero.
 *
 * Env knobs:
 *   BENCH_REQUIRE_NVIDIA=1  — stricter: fail if renderer isn't NVIDIA. Use on AWS EC2.
 *   BENCH_SKIP_GPU_CHECK=1  — bypass entirely. Local-dev escape hatch only.
 */

const REQUIRE_NVIDIA = isTrue(process.env.BENCH_REQUIRE_NVIDIA);
const SKIP_CHECK = isTrue(process.env.BENCH_SKIP_GPU_CHECK);

const SOFTWARE_RENDERER_PATTERNS = [
  /swiftshader/i,
  /software only/i,
  /software rasterizer/i,
  /llvmpipe/i, // Mesa software fallback (Linux)
  /apple software renderer/i,
];

export default async function globalSetup(): Promise<void> {
  if (SKIP_CHECK) {
    console.log("[bench:gpu-check] BENCH_SKIP_GPU_CHECK=1 — skipping GPU validation");
    return;
  }

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--enable-precise-memory-info",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body><canvas id='probe' width='1' height='1'></canvas></body></html>");

    const gpu = await page.evaluate(() => {
      const canvas = document.getElementById("probe") as HTMLCanvasElement;
      const gl =
        (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ||
        (canvas.getContext("webgl") as WebGLRenderingContext | null);
      if (!gl) return { ok: false as const, renderer: null, vendor: null };
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = debugInfo
        ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
        : String(gl.getParameter(gl.RENDERER));
      const vendor = debugInfo
        ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL))
        : String(gl.getParameter(gl.VENDOR));
      return { ok: true as const, renderer, vendor };
    });

    if (!gpu.ok) {
      throw new Error(
        "[bench:gpu-check] WebGL is not available in this Chrome instance — cannot run benchmark.\n" +
          "Likely cause: GPU driver missing or Chrome started with --disable-gpu.",
      );
    }

    console.log(`[bench:gpu-check] WebGL renderer: ${gpu.renderer}`);
    console.log(`[bench:gpu-check] WebGL vendor:   ${gpu.vendor}`);

    for (const pattern of SOFTWARE_RENDERER_PATTERNS) {
      if (pattern.test(gpu.renderer)) {
        throw new Error(
          `[bench:gpu-check] GPU validation FAILED — detected software renderer: "${gpu.renderer}".\n` +
            "WebGL is falling back to CPU rendering. Benchmark numbers would be garbage.\n\n" +
            "If running on AWS EC2 g4dn:\n" +
            "  → install NVIDIA Gaming Driver per AWS docs:\n" +
            "    https://docs.aws.amazon.com/AWSEC2/latest/WindowsGuide/install-nvidia-driver.html\n" +
            "  → reboot, then re-run.\n" +
            "  → verify manually in Chrome with chrome://gpu (expect 'Hardware accelerated' for WebGL).\n\n" +
            "If running locally and you know your machine has no usable GPU:\n" +
            "  → set BENCH_SKIP_GPU_CHECK=1 to bypass (numbers will not be representative).",
        );
      }
    }

    if (REQUIRE_NVIDIA && !/nvidia/i.test(gpu.renderer)) {
      throw new Error(
        `[bench:gpu-check] BENCH_REQUIRE_NVIDIA=1 was set, but renderer is not NVIDIA: "${gpu.renderer}".\n` +
          "Expected something like 'ANGLE (NVIDIA, NVIDIA T4 ...)'. Aborting.\n" +
          "Check that the NVIDIA driver loaded correctly and Chrome is using it.",
      );
    }

    console.log("[bench:gpu-check] OK — hardware-accelerated WebGL confirmed.");
  } finally {
    await browser.close();
  }
}

function isTrue(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes";
}
