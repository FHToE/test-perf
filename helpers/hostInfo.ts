import * as os from "node:os";

export interface HostInfo {
  /** Operating system platform — e.g. "win32", "linux", "darwin". */
  platform: string;
  /** OS release string (Windows kernel ver / Linux kernel / Darwin ver). */
  release: string;
  /** Process arch — "x64", "arm64", etc. */
  arch: string;
  /** CPU model name from the first core. All cores assumed identical. */
  cpu_model: string;
  /** Logical CPU count (vCPUs reported by the OS). */
  cpu_count: number;
  /** Total physical memory in MB. */
  total_memory_mb: number;
  /** Node.js version running the bench (no v prefix). */
  node_version: string;
}

/**
 * Capture machine-level info at the moment the bench starts. Persisted into
 * iterations.json's run_meta so a later reader can tell whether two runs are
 * comparable (same hardware → yes; different CPU/RAM → take results with a grain).
 *
 * Pure Node — no network, no spawned processes. Safe to call in test init.
 */
export function getHostInfo(): HostInfo {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    release: os.release(),
    arch: process.arch,
    cpu_model: cpus[0]?.model?.trim() ?? "unknown",
    cpu_count: cpus.length,
    total_memory_mb: Math.round(os.totalmem() / (1024 * 1024)),
    node_version: process.versions.node,
  };
}
