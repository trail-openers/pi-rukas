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
 * A claim is only honoured while its owner is a cycle that could still write.
 * #1454 — that was `process.kill(pid, 0)` in a private helper, which disagreed
 * with the driver's own liveness primitive in BOTH directions (it read pid 1 /
 * EPERM as dead and pid 0 — "signal my whole process group" — as alive), and
 * it honoured a claim left behind by a cycle that had already reached a
 * terminal status. Six observed parks were of that shape: the claimant had
 * exited or parked, never released, and every later cycle touching the same
 * files parked against it while the claims file an operator was told to
 * inspect read `[]`.
 *
 * So staleness is now one predicate — `claimStaleReason` — that reads:
 *   - `processAlive` from work-driver-resume.ts, the SAME primitive
 *     classifyRunningState uses for state-file owners. There is deliberately
 *     no module-local kill(pid,0) here: two liveness notions in one harness
 *     diverge, and they did.
 *   - the claimant's OWN state file: a terminal status means finished, and a
 *     finished cycle holds nothing (this is what catches the live-but-dead
 *     owner a pid probe cannot).
 *   - `CLAIM_STALE_MS` as the last resort, for an entry whose state file
 *     cannot be read at all — bounded so a corrupt entry eventually stops
 *     parking cycles, generous so it cannot race a legitimately long develop
 *     dispatch.
 *
 * Stale entries are dropped on read AND pruned from the file by the next
 * writer, so the footprint does not survive a crash indefinitely.
 *
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
import { processAlive } from "./work-driver-resume.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { WorkState } from "./workflow-state.ts";
import { isTerminalState, readState, workStateDir } from "./workflow-state.ts";

/** A single path claim entry in the registry. */
export interface PathClaimEntry {
  issue: number;
  pid: number;
  paths: string[];
  startedAt: number;
}

const CLAIMS_FILE = "path-claims.json";
const PID = process.pid;

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
 * #1454 — how long an UNREADABLE-claimant entry may still park a cycle.
 *
 * The bound applies ONLY when the claimant's state file cannot be read (a
 * fresh claim whose branch step has not run, or a state file that is corrupt).
 * A claim whose state file is terminal, or whose owner pid has exited, is
 * stale at any age — no clock involved.
 *
 * Generous on purpose: a single develop dispatch can legitimately run tens of
 * minutes without the claimant's state file being readable by a sibling, and
 * pruning a live claim is exactly the false-positive that lets two cycles edit
 * one file. An earlier revision carried this constant as `_STALE_MS` and read
 * it nowhere — a stale rule that exists on paper is indistinguishable from no
 * rule, which is the bug this file had.
 * Override: `PI_ENSEMBLE_CLAIM_STALE_MS`.
 */
export const CLAIM_STALE_MS: number = (() => {
  const raw = process.env.PI_ENSEMBLE_CLAIM_STALE_MS;
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3_600_000;
})();

/**
 * Why a claim is not honoured, or null when it still reserves its paths.
 *
 * `now` and `stateReader` are injectable so the offline suite can pin the age
 * rule and the terminal-status rule without sleeping or writing real state
 * files. Production callers pass neither.
 */
export async function claimStaleReason(
  repoRoot: string,
  entry: PathClaimEntry,
  now: number = Date.now(),
  stateReader: (repoRoot: string, issue: number) => Promise<WorkState | undefined> = readState,
): Promise<string | null> {
  if (!processAlive(entry.pid)) return "owner-exited";
  let claimant: WorkState | undefined;
  try {
    claimant = await stateReader(repoRoot, entry.issue);
  } catch (err) {
    trace(
      `work-driver-path-claims: could not read claimant #${entry.issue}: ${(err as Error).message?.slice(0, 200)}`,
    );
    claimant = undefined;
  }
  if (claimant !== undefined && isTerminalState(claimant)) {
    return `claimant-${claimant.pipelineState.status}`;
  }
  const startedAt = entry.startedAt;
  if (!Number.isFinite(startedAt) || now - startedAt > CLAIM_STALE_MS) return "unverifiable-age";
  return null;
}

/**
 * Read the path-claims registry from disk.
 *
 * Returns the entries that still reserve their paths. Stale ones are skipped
 * AND pruned from the file (best-effort — a prune failure only means the next
 * reader repeats the work). The prune is what makes a re-run start from a
 * clean claim set instead of inheriting a crashed cycle's footprint.
 */
export async function readClaims(repoRoot: string): Promise<PathClaimEntry[]> {
  const all = await readRawClaims(repoRoot);
  const now = Date.now();
  const fresh: PathClaimEntry[] = [];
  const stale: PathClaimEntry[] = [];
  for (const entry of all) {
    if (await claimStaleReason(repoRoot, entry, now)) stale.push(entry);
    else fresh.push(entry);
  }
  // #1101 — drop same-process sibling claims the queue is already waiting on.
  // Those are the claims that used to park a runnable cycle at plan; the queue
  // holds the dependent back instead, so the reactive check is left to what
  // only it can see (a claim no queue in this process is tracking). Deliberately
  // AFTER the staleness pass and before the prune is handed the stale list:
  // a sibling the queue is coordinating is neither fresh nor stale, and must
  // never join the prune — the queue's own cycle still holds it.
  const gateable = fresh.filter((entry) => !claimWaitsForIssues(entry.issue, entry.pid));
  if (stale.length > 0) await pruneClaims(repoRoot, stale);
  return gateable;
}

/** Read the file verbatim — no liveness, no pruning. For writers and diagnostics. */
async function readRawClaims(repoRoot: string): Promise<PathClaimEntry[]> {
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
  // #1454 — no liveness filter HERE. `readClaims` is the reader that decides
  // staleness (`claimStaleReason`) and prunes; `registerClaim`/`releaseClaim`
  // read this raw file because a writer must never lose an entry it did not
  // set out to remove. The pre-#1454 shape filtered here, which made every
  // writer's snapshot lossy.
  //
  // #1101 — the same-process sibling filter lives in `readClaims` (the gate's
  // read), not here, for exactly that reason: hiding a sibling's claim is a
  // *reading* decision, and a writer that hid it would prune a live sibling.
  return parsed as PathClaimEntry[];
}

/**
 * Remove specific entries from the file, leaving every other entry alone.
 *
 * #1454 — matching is by issue AND pid, not by issue alone: two entries for
 * one issue can coexist (a re-run after a crash), and pruning by issue would
 * delete the live one with the corpse.
 *
 * Deliberately NOT a rewrite from `readClaims()`: that filtered read drops
 * entries it merely failed to verify, so releasing one issue used to silently
 * erase an unrelated sibling's ownership.
 */
async function pruneClaims(repoRoot: string, stale: PathClaimEntry[]): Promise<void> {
  const file = path.join(workStateDir(repoRoot), CLAIMS_FILE);
  try {
    const current = await readRawClaims(repoRoot);
    const isStale = (c: PathClaimEntry) =>
      stale.some((s) => s.issue === c.issue && s.pid === c.pid);
    const remaining = current.filter((c) => !isStale(c));
    if (remaining.length === current.length) return;
    await writeClaims(file, remaining);
    trace(
      `work-driver-path-claims: pruned ${stale.length} stale claim(s): ${stale.map((s) => `#${s.issue}@${s.pid}`).join(", ")}`,
    );
  } catch (err) {
    // A failed prune must not cost a cycle whose claim check is otherwise
    // sound: the entries are already skipped on read, so the only cost of a
    // failed prune is that the next reader repeats it.
    trace(`work-driver-path-claims: prune failed: ${(err as Error).message?.slice(0, 200)}`);
  }
}

/** Atomic write + rename — the one writer shape for the claims file. */
async function writeClaims(file: string, entries: PathClaimEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
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

import type { CycleContext, DriverContext } from "./work-driver-context.ts";
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
      // `claimant<N>` is the machine-readable carrier humanActionFor and
      // explainCap read — prose is not a stable interface.
      evidence: `claimant${sibling.issue} issue #${sibling.issue} claims: ${sibling.paths.join(", ")}; overlapping: ${overlap.join(", ")}`,
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

  // `readClaims` is the single place staleness is decided — the same
  // predicate the gate runs, so a claim cannot be pruned by one path and
  // honoured by the other.
  const all = await readClaims(repoRoot);
  // Remove our own previous claim (same issue, possibly re-registered).
  const withoutSelf = all.filter((c) => c.issue !== issue);
  // Add our new claim.
  const entry: PathClaimEntry = {
    issue,
    pid: PID,
    paths: normalised,
    startedAt: Date.now(),
  };
  const updated = [...withoutSelf, entry];

  await writeClaims(path.join(workStateDir(repoRoot), CLAIMS_FILE), updated);
  return updated;
}

/**
 * Release (unregister) a cycle's claims. Returns the remaining claims.
 *
 * One issue, or the whole group: a grouped cycle (`/work 10 11`) claims EVERY
 * issue in the group (that is what work-driver-registry.claimCycle does), so
 * clearing only the primary leaves a sibling entry behind to park the next
 * cycle — the same zombie, one issue short. Callers that know the group pass
 * every number; `releaseClaim(repoRoot, 1421)` is the single-issue form.
 *
 * #1454 — this writes the raw registry minus the released issues rather than
 * `readClaims()` minus them. The old shape rebuilt the file from a
 * liveness-FILTERED read, so releasing one issue silently erased every other
 * entry the read could not verify — a live sibling's ownership could evaporate
 * as a side effect of an unrelated release. A release now removes exactly what
 * it is told to and nothing else.
 */
export async function releaseClaim(
  repoRoot: string,
  issue: number | number[],
): Promise<PathClaimEntry[]> {
  const file = path.join(workStateDir(repoRoot), CLAIMS_FILE);
  const all = await readRawClaims(repoRoot);
  const mine = new Set(Array.isArray(issue) ? issue : [issue]);
  const remaining = all.filter((c) => !mine.has(c.issue));
  // Write the empty array rather than deleting the file, so consumers that
  // read it always get a consistent shape.
  await writeClaims(file, remaining);
  return remaining;
}
