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
 *
 * #1101 — `claimWaitsForIssues` is the boundary between the two kinds of
 * sibling this registry sees, and `setSiblingClaimWait` is what opens that
 * boundary: the queue declares the issue set it coordinates before any group
 * starts (see `runGroupedIssues` in work-entry.ts) and clears it on every exit
 * path. A claim held by ANOTHER process is a genuinely uncoordinated second
 * opinion: nothing in this invocation can wait it down, so
 * today's immediate `cross-group-conflict` park is correct and unchanged. A
 * claim held by THIS process belongs to a sibling group of the same queue, which
 * the queue can hold back until that sibling settles — parking it here is the
 * bug, because the loss arrives after explore+plan have already been paid for.
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
 * #1101 — issues whose cycle is a sibling of this one IN THE SAME PROCESS, and
 * whose path claims therefore must not park this cycle at plan.
 *
 * The queue registers a sibling's claim before it dispatches the group, and
 * drops it once the group settles. `readClaims` filters those entries out, so
 * `checkAndRegisterClaims` sees only claims this invocation cannot wait down:
 * another process's. That keeps the out-of-scope contract — cross-process
 * claim semantics are untouched — while the in-invocation case becomes a wait
 * in `work-queue.ts` instead of a park here.
 *
 * A `Set`, not an array: the membership test runs once per claim per plan step,
 * and an array read as "scan the sibling list" invites a `.includes` on a
 * growing queue. `null` (the default) disables the filter entirely, which is
 * the pre-#1101 behaviour and what every caller that does not know about this
 * gets.
 */
let siblingWaitIssues: Set<number> | null = null;

/**
 * Declare (or with `null`, clear) which issues are same-process siblings.
 *
 * #1101 fix-round — until this had no caller the whole sibling filter was
 * inert: `siblingWaitIssues` stayed `null`, so `claimWaitsForIssues` answered
 * `false` for every claim and an in-invocation sibling's plan-time claim parked
 * the dependent at plan with `cross-group-conflict`, which is precisely the
 * dispatch the queue's ordering edge exists to prevent. Its caller is
 * `runGroupedIssues`, which sets the full invocation issue set before workers
 * start and clears it in a `finally`.
 *
 * Module-level state, like the registry file it filters: one /work queue per
 * process is the assumption the rest of this module already makes (`PID` is a
 * module constant), and a second concurrent queue would see the other queue's
 * groups as siblings of its own — which is the same answer, not a wrong one.
 */
export function setSiblingClaimWait(issues: Iterable<number> | null): void {
  siblingWaitIssues = issues === null ? null : new Set(issues);
}

/** Whether a claim on `issue` is a same-process sibling the queue can wait on. */
export function claimWaitsForIssues(issue: number, pid: number): boolean {
  // Same-process only. A claim from another pid is never a sibling, whatever
  // the set says — that is the boundary the out-of-scope rule draws.
  if (pid !== PID || siblingWaitIssues === null) return false;
  return siblingWaitIssues.has(issue);
}

/**
 * The sibling set currently in force, for the tests that have to prove the
 * filter is LIVE rather than merely installed.
 *
 * `readClaims` is the production reader and it is what the wiring must fool, so
 * asserting through it is right — but a filter that always answered "sibling"
 * would satisfy that too. This is the negative half: `null` outside a queue,
 * the invocation's issues inside one. Test-only; no production caller reads
 * what a caller just wrote.
 */
export function siblingClaimWaitSnapshot(): number[] {
  return siblingWaitIssues === null ? [] : [...siblingWaitIssues];
}

/**
 * Whether the cross-group conflict check is enabled.
 * Override: `PI_ENSEMBLE_CROSS_GROUP_CONFLICTS=0`.
 *
 * #1101 fix-round — this is the check that reads the registry, so it is also
 * the switch that makes the sibling filter load-bearing. When it is disabled
 * there is nothing to wait down: the caller does not park on a conflict at all,
 * so hiding a sibling's claim from it changes nothing except what `readClaims`
 * reports. `readClaims` stays on this switch for that reason.
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
  // #1101 — and drop same-process sibling claims the queue is already waiting
  // on. Those are the claims that used to park a runnable cycle at plan; the
  // queue holds the dependent back instead, so the reactive check is left to
  // what only it can see (a claim no queue in this process is tracking).
  return (parsed as PathClaimEntry[]).filter(
    (entry) => isProcessAlive(entry.pid) && !claimWaitsForIssues(entry.issue, entry.pid),
  );
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
  // #1101 — `normaliseDeclaredPath` is the shared normaliser on BOTH sides of
  // this comparison (here for our declarations, in `registerClaim` for theirs).
  // It trims a trailing ` (new)` annotation, backticks, leading `./` and a
  // trailing slash, which is what makes a planner's `src/foo.ts (new)` match a
  // sibling's registered `src/foo.ts`. Changing it changes the conflict set,
  // so it is deliberately one function and not two that could drift.
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
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent } from "./workflow-state.ts";

export async function checkAndRegisterClaims(
  ctx: CycleContext,
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
