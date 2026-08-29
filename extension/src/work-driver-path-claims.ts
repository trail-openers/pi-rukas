/**
 * work-driver-path-claims — cross-group path-claim registry.
 *
 * When two /work groups declare paths[] that overlap, the second cycle must
 * park at plan with a named reason rather than colliding at integration.
 *
 * Registry lives at `.pi/work-state/path-claims.json`. Each entry records:
 *   - issue number
 *   - process PID (for liveness)
 *   - normalised paths claimed
 *   - cycle start timestamp
 *
 * Stale claims (process no longer running) are auto-skipped on read.
 * Escape hatch: PI_ENSEMBLE_CROSS_GROUP_CONFLICTS=0 disables the check.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import { workStateDir } from "./workflow-state.ts";

/** A single path claim entry in the registry. */
export interface PathClaimEntry {
  issue: number;
  pid: number;
  paths: string[];
  startedAt: number;
}

const CLAIMS_FILE = "path-claims.json";
const PID = process.pid;
const _STALE_MS = 3_600_000; // 1 hour — generous: a /work cycle rarely exceeds 30 min.

/**
 * Whether the cross-group conflict check is enabled.
 * Override: `PI_ENSEMBLE_CROSS_GROUP_CONFLICTS=0`.
 */
export function crossGroupConflictsEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS;
  return v !== "0" && v !== "false";
}

/**
 * Read the path-claims registry from disk.
 * Returns all entries whose process is still alive (PID liveness check).
 */
export async function readClaims(repoRoot: string): Promise<PathClaimEntry[]> {
  const file = path.join(workStateDir(repoRoot), CLAIMS_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    trace(
      `work-driver-path-claims: could not read claims: ${(err as Error).message?.slice(0, 200)}`,
    );
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    trace("work-driver-path-claims: claims file is not valid JSON — ignoring");
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // Filter to alive processes only.
  return (parsed as PathClaimEntry[]).filter((entry) => isProcessAlive(entry.pid));
}

/** Check whether a process with the given PID is still running. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check all declared paths from the given workstreams against claims held by
 * sibling cycles. Returns the sibling claims that overlap with ours.
 */
export function checkCrossGroupClaims(
  ourIssue: number,
  workstreams: Record<string, { paths?: string[]; outOfScope?: string[] }>,
): PathClaimEntry[] {
  return checkCrossGroupClaimsSync(ourIssue, workstreams);
}

/**
 * Synchronous core — accepts pre-loaded claims so callers can batch the disk
 * read. This is what `checkCrossGroupClaims` delegates to after reading the
 * registry from disk.
 */
export function checkCrossGroupClaimsSync(
  ourIssue: number,
  workstreams: Record<string, { paths?: string[]; outOfScope?: string[] }>,
  claims: PathClaimEntry[] = [],
): PathClaimEntry[] {
  // Collect and normalise our own paths.
  const ourPaths = new Set<string>();
  for (const ws of Object.values(workstreams)) {
    if (!ws.paths) continue;
    for (const p of ws.paths) {
      const normalised = normaliseDeclaredPath(p);
      if (normalised) ourPaths.add(normalised);
    }
  }
  if (ourPaths.size === 0) return [];

  const conflicts: PathClaimEntry[] = [];
  for (const claim of claims) {
    if (claim.issue === ourIssue) continue; // same cycle, not cross-group
    for (const claimedPath of claim.paths) {
      if (ourPaths.has(claimedPath)) {
        if (!conflicts.some((c) => c.issue === claim.issue)) {
          conflicts.push(claim);
        }
      }
    }
  }
  return conflicts;
}

/**
 * #571 — integrated claim check + register, returning an updated state
 * with a cap-hit event when a conflict is found. When no conflict exists,
 * registers the claim and returns state unchanged.
 */
import type { DriverContext } from "./work-driver-context.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent } from "./workflow-state.ts";

export async function checkAndRegisterClaims(
  ctx: DriverContext,
  state: WorkState,
  workstreams: Record<string, { paths?: string[]; outOfScope?: string[] }>,
): Promise<WorkState> {
  const allPaths = Object.values(workstreams).flatMap((ws) => ws.paths ?? []);
  if (allPaths.length === 0) return state; // nothing to claim

  const claims = await readClaims(ctx.repoRoot);
  const conflicts = checkCrossGroupClaimsSync(ctx.issue, workstreams, claims);

  if (conflicts.length > 0) {
    const sibling = conflicts[0];
    if (!sibling) return state;
    const overlap = allPaths.map(normaliseDeclaredPath).filter((p) => sibling.paths.includes(p));
    let next = state;
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "cross-group-conflict" as const,
      evidence: `issue #${sibling.issue} claims: ${sibling.paths.join(", ")}; overlapping: ${overlap.join(", ")}`,
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff" as const,
    });
    return {
      ...next,
      pipelineState: { ...next.pipelineState, status: "handoff", currentStep: "plan" },
    };
  }
  // No conflicts — register so siblings see our claim.
  await registerClaim(ctx.repoRoot, ctx.issue, allPaths);
  return state;
}

/**
 * Register a claim for the given paths. Atomic write + rename.
 * Returns the registry state after the write (for verification).
 */
export async function registerClaim(
  repoRoot: string,
  issue: number,
  paths: string[],
): Promise<PathClaimEntry[]> {
  const normalised = [...new Set(paths.map(normaliseDeclaredPath).filter(Boolean))];
  if (normalised.length === 0) return [];

  const all = await readClaims(repoRoot);
  // Remove our own previous claim (same issue, possibly re-registered).
  const withoutSelf = all.filter((c) => c.issue !== issue);
  // Remove stale claims.
  const alive = withoutSelf.filter((c) => isProcessAlive(c.pid));
  // Add our new claim.
  const entry: PathClaimEntry = {
    issue,
    pid: PID,
    paths: normalised,
    startedAt: Date.now(),
  };
  const updated = [...alive, entry];

  // Atomic write.
  const dir = workStateDir(repoRoot);
  const file = path.join(dir, CLAIMS_FILE);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
  return updated;
}

/**
 * Release (unregister) the claim for the given issue. Returns the remaining
 * claims after removal.
 */
export async function releaseClaim(repoRoot: string, issue: number): Promise<PathClaimEntry[]> {
  const all = await readClaims(repoRoot);
  const remaining = all.filter((c) => c.issue !== issue);
  // Write empty array instead of deleting file so consumers that read it
  // get a consistent shape.
  const dir = workStateDir(repoRoot);
  const file = path.join(dir, CLAIMS_FILE);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(remaining, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
  return remaining;
}
