/**
 * adversarial-reread — what one round's diff re-read does to the round, and
 * what a failed one does to the loop (#859, #1634).
 *
 * Split from `adversarial.ts` (AGENTS.md §12, the 500-line gate). The loop owns
 * WHEN a re-read runs and how its result is folded into the round state; this
 * module owns the two decisions that were buried in the loop's `catch` and kept
 * getting their prose re-derived:
 *
 *   1. **Who owned the read.** A re-read of a range the loop computed ITSELF
 *      (`rangeDiffFn`) is a transient: the loop keeps the previous diff, reviews
 *      it, and records the staleness — that is #859's rule, and it is correct
 *      because the caller can re-run that read and the note is the operator's
 *      record. A re-read the CALLER supplied (`params.getDiff`) is not the
 *      loop's to ride out: on the /work path that function IS the gate
 *      (`readWorktreeDiff`), and this loop is what decides whether a branch may
 *      be committed. Carrying the previous round's diff into the reviewer and
 *      accepting its verdict there is an APPROVED with no diff behind it — the
 *      #1634 bug class — so the failure is rethrown, unchanged, and the caller
 *      turns it into its no-verdict `diffUnreadable` outcome.
 *   2. **What the record says.** The staleness note and the trace line name the
 *      round and the reason, and nothing else, so the wording the operator reads
 *      has exactly one producer.
 *
 * Ownership is decided where the substitution happens (the loop passes
 * `rereadIsLoopOwn`, computed from whether `getDiff` still is the caller's
 * function) rather than by sniffing the error: identity is the positive fact,
 * an error message is somebody's prose. The loop reports that identity through
 * {@link onRereadFailure}'s `rereadIsLoopOwn` argument.
 */

import { trace } from "./trace.ts";

/** What the loop does with a re-read that threw, before the next round runs. */
export type RereadFailure = { action: "rethrow" } | { action: "continue"; reason: string };

/**
 * Decide a failed re-read: rethrow it, or record it and let the round continue
 * on the previous diff. See the module header for why the two owners get
 * different answers.
 *
 * The rethrow is the SAME error object the read raised — never a wrapper — so
 * the caller's own discriminant (`isDiffRereadError`) still recognises it after
 * it crosses back out of the loop.
 */
export function onRereadFailure(
  round: number,
  err: unknown,
  rereadIsLoopOwn: boolean,
): RereadFailure {
  if (!rereadIsLoopOwn) return { action: "rethrow" };
  const reason = (err as Error).message;
  trace(`adversarial: diff re-read failed for round ${round}: ${reason}`);
  return { action: "continue", reason };
}

/** The operator-facing record of a swallowed re-read failure. */
export function rereadStalenessNote(round: number, reason: string): string {
  return `note: round ${round} diff re-read failed (${reason}) — reviewed the previous diff`;
}
