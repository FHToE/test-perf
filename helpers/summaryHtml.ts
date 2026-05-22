import type { IterationResult, PhaseMetrics, RunMeta } from "./reporter.js";

const PHASE_ORDER = [
  "lobby_idle",
  "transition_to_target",
  "target_room_visit",
  "target_room_idle",
  "target_room_walk",
  "target_room_poi_open",
  "transition_to_next",
  "next_room_visit",
  "next_room_idle",
  "next_room_walk",
] as const;

/**
 * Build a self-contained HTML page summarizing a benchmark run. Used by dry-run
 * mode to render results in the browser at end of session — captured by the
 * Playwright video so the user can see the outcome without opening JSON files.
 *
 * Returns a complete HTML document as a string. Pass to `page.goto("data:text/html;..."`.
 * Designed for 1280x720 viewport (matches recordVideo config).
 */
export function buildSummaryHtml(meta: RunMeta | null, results: readonly IterationResult[]): string {
  const headerLines: string[] = [];
  if (meta?.started_at) headerLines.push(`Started: ${escapeHtml(meta.started_at)}`);
  if (meta?.ended_at) headerLines.push(`Ended: ${escapeHtml(meta.ended_at)}`);
  if (meta?.git_sha) headerLines.push(`Git: ${escapeHtml(meta.git_sha.slice(0, 7))}`);
  if (meta?.gpu_renderer) headerLines.push(`GPU: ${escapeHtml(meta.gpu_renderer)}`);
  const h = meta?.host_info;
  if (h) {
    headerLines.push(`CPU: ${escapeHtml(h.cpu_model)} (${h.cpu_count} vCPU)`);
    headerLines.push(`RAM: ${(h.total_memory_mb / 1024).toFixed(1)} GB`);
    headerLines.push(`OS: ${escapeHtml(h.platform)} ${escapeHtml(h.release)}`);
  }
  if (meta?.chrome_user_agent) {
    // Trim long UA — show only Chrome version chunk
    const chromeMatch = meta.chrome_user_agent.match(/Chrome\/[\d.]+/);
    if (chromeMatch) headerLines.push(`Chrome: ${escapeHtml(chromeMatch[0].split("/")[1] || "")}`);
  }

  const sections = results.map((iter) => renderIterationSection(iter)).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Bench Summary</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", system-ui, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 16px; font-size: 13px; line-height: 1.4; }
  h1 { font-size: 18px; margin: 0 0 4px 0; color: #58a6ff; }
  .meta { color: #8b949e; font-size: 11px; margin-bottom: 12px; }
  .meta span { margin-right: 14px; }
  h2 { font-size: 14px; margin: 12px 0 6px 0; color: #f0883e; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
  th, td { padding: 4px 8px; text-align: right; border-bottom: 1px solid #21262d; font-size: 11px; }
  th { color: #8b949e; font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; background: #161b22; }
  td.phase { text-align: left; color: #c9d1d9; font-weight: 500; }
  td.gpu-bound { color: #ff7b72; }
  td.cpu-bound { color: #79c0ff; }
  td.muted { color: #6e7681; }
  .notes { color: #d29922; font-size: 11px; margin: 4px 0 12px 0; padding: 6px 8px; background: #221c0a; border-left: 3px solid #d29922; }
  .footer { color: #6e7681; font-size: 10px; margin-top: 16px; text-align: center; }
</style>
</head>
<body>
<h1>Benchmark Summary</h1>
<div class="meta">${headerLines.map((l) => `<span>${l}</span>`).join("")}</div>
${sections}
<div class="footer">Iterations: ${results.length} · Open <code>iterations.json</code> in run dir for full breakdown</div>
</body>
</html>`;
}

function renderIterationSection(iter: IterationResult): string {
  const notes = (iter.notes || []).map((n) => `<div class="notes">${escapeHtml(n)}</div>`).join("");
  const reloadInfo: string[] = [];
  if (iter.target_room_reloads) reloadInfo.push(`target reloads: ${iter.target_room_reloads}`);
  if (iter.next_room_reloads) reloadInfo.push(`next reloads: ${iter.next_room_reloads}`);
  const reloadHtml = reloadInfo.length > 0 ? `<div class="notes">⚠ ${reloadInfo.join(", ")}</div>` : "";

  const rows = PHASE_ORDER.map((phase) => renderPhaseRow(phase, iter.phases[phase])).filter(Boolean).join("");

  return `<h2>${escapeHtml(iter.starting_room)} — iter ${iter.iteration}</h2>
${reloadHtml}${notes}
<table>
<thead>
<tr>
  <th style="text-align:left">Phase</th>
  <th>FPS</th>
  <th>Frame p95</th>
  <th>GPU ms</th>
  <th>CPU ms</th>
  <th>Triangles</th>
  <th>Draws</th>
  <th>Tex up MB</th>
  <th>Progs+</th>
  <th>GLB#</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>`;
}

function renderPhaseRow(phase: string, m: PhaseMetrics | undefined): string {
  if (!m) {
    return `<tr><td class="phase muted">${phase}</td><td colspan="9" class="muted" style="text-align:left">no samples</td></tr>`;
  }
  const gpuMs = m.gpu.gpu_frame_time_ms_avg;
  const cpuMs = m.fps.cpu_frame_time_ms_avg;
  // Highlight the dominant bottleneck for quick visual scan
  const gpuClass = gpuMs > 0 && gpuMs >= cpuMs * 2 ? "gpu-bound" : "";
  const cpuClass = cpuMs > 0 && cpuMs >= gpuMs * 2 ? "cpu-bound" : "";

  return `<tr>
  <td class="phase">${escapeHtml(phase)}</td>
  <td>${fmt(m.fps.avg, 1)}</td>
  <td>${fmt(m.fps.frame_time_p95_ms, 1)}</td>
  <td class="${gpuClass}">${gpuMs > 0 ? fmt(gpuMs, 1) : `<span class="muted">—</span>`}</td>
  <td class="${cpuClass}">${cpuMs > 0 ? fmt(cpuMs, 1) : `<span class="muted">—</span>`}</td>
  <td>${formatThousands(m.gpu.triangles_avg)}</td>
  <td>${m.gpu.draw_calls_avg}</td>
  <td>${fmt(m.gpu.texture_bytes_total / (1024 * 1024), 1)}</td>
  <td>${m.gpu.programs_added || `<span class="muted">0</span>`}</td>
  <td>${m.gpu.glb_parse_count || `<span class="muted">0</span>`}</td>
</tr>`;
}

function fmt(n: number, digits: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return n.toFixed(digits);
}

function formatThousands(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
