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
export async function readDiffOrFailureOutcome(
  args: ReadFailureArgs & { baseSha?: string; execFn?: Parameters<typeof readWorktreeDiff>[2] },
): Promise<{ ok: true; diff: string } | { ok: false; outcome: AdversarialOutcome }> {
  const r: WorktreeDiff = await readWorktreeDiff(args.cwd, args.baseSha, args.execFn);
  if (r.ok) return { ok: true, diff: r.diff };
  return { ok: false, outcome: diffUnreadableOutcome({ ...args, reason: r.reason }) };
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
  /**
   * The STRUCTURAL discriminant. `isDiffRereadError` reads THIS, not just
   * `instanceof`: the reviewer loop re-throws the caught error after it has
   * crossed a module boundary (`adversarial.ts` rethrows what `getDiff`
   * threw), and a class identity that does not survive that hop — a second
   * module instance, a re-exported class, a transpile boundary — would turn a
   * failed READ back into the generic `threw` outcome, which is exactly the
   * shape the retry ladder may re-run and which carries no
   * `diffUnreadable` marker. A property every instance carries is checked by
   * shape, so the classification does not depend on which copy of this class
   * produced the value.
   */
  readonly diffReread = true;
  constructor(reason: string) {
    super(reason);
    this.name = "DiffRereadError";
    this.reason = reason;
  }
}

/**
 * Is this throw the driver's failed diff READ, rather than a child that died?
 *
 * Shape-checked first (see {@link DiffRereadError.diffReread}), `instanceof`
 * as the fallback for an error built before this module was ever loaded.
 */
export function isDiffRereadError(err: unknown): err is DiffRereadError {
  if (typeof err !== "object" || err === null) return false;
  return (err as { diffReread?: unknown }).diffReread === true;
}

/** What one unreadable-diff failure needs in order to build its outcome. */
export interface ReadFailureArgs {
  id: string;
  cwd: string;
  multi: boolean;
  label: string;
  jobId: string;
  startedAt: number;
  priorOutcomes: Map<string, string>;
}

/**
 * The no-verdict outcome for a diff the driver could not read — the ONE
 * builder, used both by the read the pass performs itself
 * (`readDiffOrFailureOutcome`) and by the round-2+ re-read whose throw the
 * reviewer loop rethrows (#1634). Two ~60-line copies of the same literal used
 * to stand here, and they were the kind of duplicate that drifts: a field added
 * to one and not the other silently changes how one of the two failure shapes
 * routes.
 *
 * `reason` is the read's own git account (`WorktreeDiff.reason` / a
 * `DiffRereadError.reason`), never a pre-rendered sentence — the sentence is
 * `adversarialDiffReadReason`'s to write, and it bounds the text on the way
 * out, so the outcome, its dispatch event and the cap's evidence all carry the
 * same string.
 */
export function diffUnreadableOutcome(
  args: ReadFailureArgs & {
    /** The read's own account of the failure, naming the git command. */
    reason: string;
  },
): AdversarialOutcome {
  const { id, cwd, multi, label, jobId, startedAt, priorOutcomes } = args;
  const reason = adversarialDiffReadReason(id, cwd, args.reason);
  trace(`work-driver: ${reason} — NOT approving on an unreadable diff`);
  return {
    id,
    ok: false,
    rounds: 0,
    records: [],
    infra: true,
    threw: false,
    skipped: false,
    priorInfra: priorOutcomes.get(id) === "infra-failure",
    // #1634 — the structural marker. Every consumer (the cap routing, the
    // headless failure class, the retry ladder) reads THIS, never the prose of
    // `errorTail`.
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
