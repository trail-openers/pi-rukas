/**
 * work-driver-path-claims-staleness — when a path claim stops counting, and
 * the shape a claim must have to count at all.
 *
 * Split out of `work-driver-path-claims.ts` for the 500-line gate (AGENTS.md
 * §12). The seam is the one the code already had: the registry module owns the
 * file (read, prune, register, release, the lock), and this one owns the two
 * *predicates* a caller applies to an entry — plus the age bound they share and
 * the entry shape check they both start from.
 *
 * #1454 r2 — there are TWO predicates, not one, because a reader and a writer
 * ask different questions and the safe answer runs opposite ways:
 *
 *   - `claimStaleReason` — "may I park a cycle on this claim?" Answers NO when
 *     the owner cannot be verified. A false "stale" costs one spurious park,
 *     which is the cheap direction, and the whole point of #1454 was that an
 *     unverifiable claimant must stop parking cycles forever.
 *   - `claimDeletionReason` — "may I DELETE this entry from the file?" Needs
 *     positive proof of death, or age past the bound. A false "stale" here
 *     destroys a live sibling's reservation and lets two workstreams edit one
 *     file, which is the failure the registry exists to prevent.
 *
 * They used to be one function, and `registerClaim` used the reader's rule.
 * Eight concurrent claim writers lost seven of their claims to it.
 */

import { trace } from "./trace.ts";
import { processAlive } from "./work-driver-resume.ts";
import type { WorkState } from "./workflow-state.ts";
import { isTerminalState, readState } from "./workflow-state.ts";

/** A single path claim entry in the registry. */
export interface PathClaimEntry {
  issue: number;
  pid: number;
  paths: string[];
  startedAt: number;
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
 *
 * FLOORED at 5 minutes. The bound is the only thing standing between a
 * hand-edited `PI_ENSEMBLE_CLAIM_STALE_MS=1` and every claim expiring the
 * instant it is written — two cycles then claim the same file and collide at
 * integration under `git apply`, which is the failure this whole registry
 * exists to prevent. A sub-5-minute bound is never what an operator means, and
 * the cost of ignoring it is a lost claim, so the value is clamped rather than
 * trusted.
 * Override: `PI_ENSEMBLE_CLAIM_STALE_MS`.
 */
export const CLAIM_STALE_MIN_FLOOR_MS = 300_000;

/** Default age bound when nothing is configured. */
const CLAIM_STALE_DEFAULT_MS = 3_600_000;

/**
 * #1454 r2 — the age-bound rule as a pure function of the raw env string, so
 * the suite can pin the behaviour (default, clamp, garbage, unset) by calling
 * it instead of pattern-matching this file's source. A source-text assertion
 * passes when the rule is deleted and the test is renamed.
 */
export function resolveClaimStaleMs(raw: string | undefined): number {
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : CLAIM_STALE_DEFAULT_MS;
  return Math.max(value, CLAIM_STALE_MIN_FLOOR_MS);
}

export const CLAIM_STALE_MS: number = resolveClaimStaleMs(process.env.PI_ENSEMBLE_CLAIM_STALE_MS);

/**
 * #1454 r2 — is this a claim we may act on?
 *
 * The registry is operator-editable JSON, and the code downstream of the read
 * assumes `pid` is killable, `startedAt` is comparable, and `paths` is an array
 * it can `.includes()`. An entry failing any of those is not a claim — there is
 * no reservation to honour because there is nothing well-formed to honour — so
 * it is reported stale at the read boundary and pruned by whoever got the read.
 * A half-written entry that survives is a `TypeError` in someone else's plan
 * step.
 */
export function validClaimEntry(entry: unknown): entry is PathClaimEntry {
  if (entry === null || typeof entry !== "object") return false;
  const rec = entry as Record<string, unknown>;
  if (typeof rec.issue !== "number" || !Number.isInteger(rec.issue)) return false;
  // pid 0 means "signal my whole process group" and a negative pid means a
  // process GROUP — neither is ever a claim holder, and the pre-#1454 liveness
  // helper read both as proof of life in the wrong direction. The bound is
  // `<= 0`, deliberately NOT `< 2`:
  //
  // The canonical predicate `processAlive` treats EPERM as ALIVE ("the pid
  // exists but belongs to another user"), and pid 1 is exactly that case — so
  // rejecting it here would have the registry call dead an owner the rest of
  // the harness calls alive, which is the two-notions-of-liveness bug #1454
  // exists to remove. `test-work-driver-cross-group-conflicts.ts` §2 pins the
  // two helpers to the SAME verdict for pid 1 and is explicit that pid 1 counts
  // as alive while pid 0 is rejected outright. Non-integers, NaN, zero and
  // negatives all fail here AND in `processAlive`, so no shape is honoured by
  // one and refused by the other.
  if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid <= 0) return false;
  if (typeof rec.startedAt !== "number" || !Number.isFinite(rec.startedAt)) return false;
  if (!Array.isArray(rec.paths)) return false;
  return rec.paths.every((p) => typeof p === "string");
}

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
  if (!validClaimEntry(entry)) return "malformed-entry";
  if (!processAlive(entry.pid)) return "owner-exited";
  let claimant: WorkState | undefined;
  let stateUnreadable = false;
  try {
    claimant = await stateReader(repoRoot, entry.issue);
  } catch (err) {
    stateUnreadable = true;
    trace(
      `work-driver-path-claims: claimant #${entry.issue} state is unreadable — the age bound decides: ${(err as Error).message?.slice(0, 200)}`,
    );
    claimant = undefined;
  }
  if (claimant !== undefined && isTerminalState(claimant)) {
    return `claimant-${claimant.pipelineState.status}`;
  }
  const startedAt = entry.startedAt;
  if (!Number.isFinite(startedAt) || now - startedAt > CLAIM_STALE_MS) {
    return stateUnreadable ? "unreadable-state" : "unverifiable-age";
  }
  return null;
}

/**
 * The conservative staleness rule a WRITER applies. Positive proof of death,
 * OR an entry past the age bound; anything short of that is "keep".
 *
 * #1454 r2 — this is the fix for the bug the lock did not cause. `registerClaim`
 * filtered peers through `claimStaleReason`, the READER's rule, and lost seven
 * of eight concurrent claims.
 *
 * The concrete failure: eight `bun` processes raced on the registry. Each had
 * written its claim and exited milliseconds later (a smoke-test child, and in
 * production any cycle between steps). A sibling entering `registerClaim` read
 * that entry, found the pid gone, and deleted it — a claim written a moment ago
 * by a process the reader never saw alive. `owner-exited` is the ONLY reason the
 * reader may answer from a pid probe, and a pid probe says nothing about a
 * process that had not started yet when the probe's subject was created.
 *
 * So the writer prunes on:
 *   - a malformed entry (never a claim at all);
 *   - a state file that reads as a terminal status — positive proof the cycle
 *     finished and simply never released;
 *   - an owner pid that is gone AND an entry older than the age bound, the same
 *     bound the reader applies. Age is what makes a dead-owner delete safe: the
 *     entry has outlived any process that could still be working on it.
 *
 * A dead owner YOUNG enough to still be a live claim is kept. That is the
 * asymmetry: keeping it costs nothing (the reader already ignores it, so it
 * parks nobody), deleting it can collide two workstreams.
 */
export async function claimDeletionReason(
  repoRoot: string,
  entry: PathClaimEntry,
  now: number = Date.now(),
  stateReader: (repoRoot: string, issue: number) => Promise<WorkState | undefined> = readState,
): Promise<string | null> {
  if (!validClaimEntry(entry)) return "malformed-entry";
  const aged = now - entry.startedAt > CLAIM_STALE_MS;
  if (!processAlive(entry.pid)) {
    // A corpse is only deletable once it has been a corpse long enough that no
    // plausible owner is still mid-step. Young and unverified is kept.
    return aged ? "owner-exited" : null;
  }
  let claimant: WorkState | undefined;
  try {
    claimant = await stateReader(repoRoot, entry.issue);
  } catch (err) {
    // An unreadable state file is not evidence anyone is dead.
    trace(
      `work-driver-path-claims: claimant #${entry.issue} state is unreadable — the writer keeps the entry: ${(err as Error).message?.slice(0, 200)}`,
    );
    return null;
  }
  if (claimant !== undefined && isTerminalState(claimant)) {
    return `claimant-${claimant.pipelineState.status}`;
  }
  return null;
}
