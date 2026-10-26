/**
 * work-driver-adversarial-fanout-diff — #1634: the adversarial gate's diff read
 * and its failure route. Split from work-driver-adversarial-fanout.ts
 * (AGENTS.md §12 file-size limit). Leaf module — no DriverContext dependency.
 *
 * The defect this closes: `fetchDiff` returned `""` for EVERY failure — no cwd,
 * a directory that is not a repository, a `git diff` that threw or exited
 * non-zero — and the fan-out's `!diff.trim()` guard read that as a clean tree:
 * `adversarial-skipped-empty-diff` + `adversarial-approved {rounds: 0}`. A
 * killed develop round whose worktree nobody could read was therefore "approved"
 * and merged. #384 removed exactly this from the lens path; this is the same
 * rule on the pre-commit read: **the no-signal answer is never approval.**
 */

import { trace } from "./trace.ts";
import {
  adversarialDiffReadReason,
  isDiffUnreadableOutcome,
} from "./work-driver-adversarial-diff-cap.ts";
import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";
import { type WorktreeDiff, readWorktreeDiff } from "./work-driver-diff-read.ts";

/**
 * Read one workstream's diff, or return the NO-VERDICT outcome the fan-out
 * records instead — which is never `skipped`.
 *
 * The outcome is `infra: true` with a `dispatch-failed` event and
 * `diffUnreadable: true`: nobody judged the diff, so it is not a rejection.
 *
 * #1634 fix round — the read is DETERMINISTIC, so this outcome never enters a
 * retry ladder. A missing worktree, a directory that is not a repository, or a
 * `git diff` that fails says the same thing the second time; the in-step ladder
 * and the step router's RETRY_ONCE path both decline it (see
 * `isTransientAdversarialOutcome` and the router's `diffUnreadable` guard), so
 * the gate parks at once with `adversarial-diff-unreadable` instead of burning
 * multi-second waits to re-run a read that cannot change. A router path that
 * cannot see the outcome still sees the marker on the event.
 */
export async function readDiffOrFailureOutcome(args: {
  id: string;
  cwd: string;
  baseSha?: string;
  multi: boolean;
  label: string;
  jobId: string;
  startedAt: number;
  priorOutcomes: Map<string, string>;
  execFn?: Parameters<typeof readWorktreeDiff>[2];
}): Promise<{ ok: true; diff: string } | { ok: false; outcome: AdversarialOutcome }> {
  const { id, cwd, multi, label, jobId, startedAt, priorOutcomes } = args;
  const r: WorktreeDiff = await readWorktreeDiff(cwd, args.baseSha, args.execFn);
  if (r.ok) return { ok: true, diff: r.diff };
  const reason = adversarialDiffReadReason(id, cwd, r.reason);
  trace(`work-driver: ${reason} — NOT approving on an unreadable diff`);
  return {
    ok: false,
    outcome: {
      id,
      ok: false,
      rounds: 0,
      records: [],
      infra: true,
      threw: false,
      skipped: false,
      priorInfra: priorOutcomes.get(id) === "infra-failure",
      // Distinguishes "the reviewer could not be run" from "the diff could not
      // be read", so the aggregate parks with the cap that names the read.
      diffUnreadable: true,
      rejectionText: reason,
      errorTail: reason,
      failureEvent: {
        kind: "dispatch-failed",
        step: "adversarial",
        role: "adversarial-loop",
        jobId,
        label,
        ms: Date.now() - startedAt,
        at: Date.now(),
        errorTail: reason,
        // #1634 — the structural marker. Every consumer (the cap routing, the
        // headless failure class, the retry ladder) reads THIS, never the
        // prose of `errorTail`.
        diffUnreadable: true,
      },
      branchEvent: multi
        ? {
            kind: "branch-completed",
            step: "adversarial",
            workstreamId: id,
            ok: false,
            ms: Date.now() - startedAt,
            error: reason,
            at: Date.now(),
          }
        : undefined,
    },
  };
}

/**
 * The round-2+ re-read the reviewer loop calls before each round (#859).
 *
 * #1634 fix round — a failed re-read is the SAME failure as a failed first
 * read, so it reports the same way. It used to throw a plain `Error` which the
 * loop caught, noted, and carried on reviewing the PREVIOUS round's diff — to an
 * `APPROVED` it had no diff to justify. Now it throws a `DiffRereadError`, and
 * the caller converts that into the no-verdict `diffUnreadable` outcome. A
 * throw from any other cause stays the ordinary `threw` outcome the ladder may
 * retry, so the two shapes must not be collapsed into one branch.
 */
export class DiffRereadError extends Error {
  /** The read's own account of the failure, naming the git command. */
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "DiffRereadError";
    this.reason = reason;
  }
}

/** Is this throw the driver's failed diff READ, rather than a child that died? */
export function isDiffRereadError(err: unknown): err is DiffRereadError {
  return err instanceof DiffRereadError;
}

/**
 * The no-verdict outcome for a failed re-read: the same shape the first read's
 * failure returns, so the aggregate parks with `adversarial-diff-unreadable`
 * whichever of the two reads broke.
 */
export function diffRereadFailureOutcome(args: {
  id: string;
  cwd: string;
  multi: boolean;
  label: string;
  jobId: string;
  startedAt: number;
  priorOutcomes: Map<string, string>;
  reason: string;
}): AdversarialOutcome {
  const { id, cwd, multi, label, jobId, startedAt, priorOutcomes } = args;
  const reason = adversarialDiffReadReason(id, cwd, args.reason);
  trace(`work-driver: ${reason} — NOT approving on an unreadable diff (round re-read)`);
  return {
    id,
    ok: false,
    rounds: 0,
    records: [],
    infra: true,
    threw: false,
    skipped: false,
    priorInfra: priorOutcomes.get(id) === "infra-failure",
    diffUnreadable: true,
    rejectionText: reason,
    errorTail: reason,
    failureEvent: {
      kind: "dispatch-failed",
      step: "adversarial",
      role: "adversarial-loop",
      jobId,
      label,
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: reason,
      diffUnreadable: true,
    },
    branchEvent: multi
      ? {
          kind: "branch-completed",
          step: "adversarial",
          workstreamId: id,
          ok: false,
          ms: Date.now() - startedAt,
          error: reason,
          at: Date.now(),
        }
      : undefined,
  };
}

// Re-exported from the cap module so the retry ladder's guard and the gate's
// aggregate read one predicate, not two copies of it.
export { isDiffUnreadableOutcome };
