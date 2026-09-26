/**
 * Shared types and formatters for the /runs surface (prune in runs.ts,
 * viewer in runs-viewer.ts). Extracted from runs.ts so the two modules
 * don't import from each other.
 */
import { PRUNE_MIN_AGE_MS } from "./runs-retention.ts";

export interface RunFile {
  path: string;
  filename: string;
  runId: string;
  role: string;
  seq: number | null;
  mtimeMs: number;
  sizeBytes: number;
}

export interface Batch {
  runId: string;
  mtimeMs: number; // newest child's mtime
  children: RunFile[];
}

/**
 * True when a batch is old enough to be a prune candidate AND past the
 * safety floor. The preview and the actual deletion must both use this so
 * they can never disagree about what would be deleted.
 */
export function isPruneCandidate(mtimeMs: number, now: number, windowMs: number): boolean {
  return now - mtimeMs >= windowMs && now - mtimeMs >= PRUNE_MIN_AGE_MS;
}

export function fmtRelative(mtimeMs: number, now = Date.now()): string {
  const dMs = now - mtimeMs;
  if (dMs < 60_000) return `${Math.round(dMs / 1000)}s ago`;
  if (dMs < 3_600_000) return `${Math.round(dMs / 60_000)}m ago`;
  if (dMs < 86_400_000) return `${Math.round(dMs / 3_600_000)}h ago`;
  return `${Math.round(dMs / 86_400_000)}d ago`;
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}
