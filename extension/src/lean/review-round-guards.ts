/**
 * lean/review-round-guards — the two questions a lens round must answer before its
 * verdict means anything.
 *
 * Split from `review.ts`, which passed the size cap once the wave's decision
 * procedure carried its own verification. Both predicates here are *preconditions
 * on evidence*, in the same sense `assertFixAdvanced` is one for a fixer: they take
 * what a round reported and refuse it, or resolve names so the caller can compare
 * them, and neither reads a verdict or decides an outcome. Keeping them out of the
 * step is what makes each one readable on its own — the step decides; these say when
 * a round is not entitled to a decision.
 *
 * Both are called on BOTH passes. That symmetry is load-bearing rather than
 * tidiness: `review` has only clean passes as exits, so a guard applied to the first
 * round alone lets the second one's silence be read as "the fixer answered
 * everything" — which is a pass, arrived at by nobody.
 */

import type { LensRound, ReviewDeps } from "./review-args.ts";
import { ReviewInfraError } from "./review-errors.ts";
import { gitQuiet } from "./specify-reset.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/**
 * A round that did not complete is refused BEFORE its verdict is read, in both
 * directions: it is not a pass to walk on, and it is not a verdict to fix against.
 *
 * Two arms, because a round can fail to run in two ways the layer reports
 * differently, and each is a clean-looking answer with nothing behind it:
 *
 *  - `noReview` — the layer decided the range held nothing to review, so no lens ran
 *    and the "nothing outstanding" is the absence of an opinion rather than one.
 *    Reachable on the FIRST pass too, not only the re-review: the fix having moved
 *    the head makes a second empty round less likely, not impossible, and the wave's
 *    named no-change cause is a different claim (it is about what the FIXER changed,
 *    which this predicate cannot see).
 *  - no `usage` — the lenses ran but reported nothing, so the step would be told a
 *    round cost nothing and produced a verdict.
 *
 * Checking the clean bar before this one would let `REVIEW_INCOMPLETE` fall through
 * the non-blocking branch into a `done`: a head nobody reviewed, certified by the
 * same round that should have thrown.
 */
export function assertRan(round: LensRound & { head: string }, rows: DispatchUsageRow[]): void {
  if (round.noReview === true)
    throw new ReviewInfraError(
      `the six-lens review ran no lens (nothing changed since the last recorded run${
        round.note === undefined ? "" : `: ${round.note}`
      }) — a head nobody re-reviewed is not a pass`,
      rows,
    );
  if (round.usage === undefined)
    throw new ReviewInfraError(
      `the six-lens review reported ${round.verdict} with no usage from any lens child — that is not a pass: ${round.findings.slice(0, 300)}`,
      rows,
    );
}

/**
 * Do these two revisions name the SAME commit?
 *
 * Both sides are resolved with `git rev-parse` before they are compared, because the
 * layer records the `since` it was handed — which may be an abbreviation or a ref —
 * while the step holds a 40-hex sha. Either side that will not resolve is NOT the
 * same commit: an unresolvable bound is a range nobody can account for, and the
 * caller refuses it. A `rev-parse` failure is also never read as "equal".
 */
export async function sameCommit(
  deps: ReviewDeps,
  repoRoot: string,
  a: string,
  b: string,
  rows: DispatchUsageRow[],
): Promise<boolean> {
  const left = await resolveCommit(deps, repoRoot, a, rows);
  const right = await resolveCommit(deps, repoRoot, b, rows);
  return left !== undefined && right !== undefined && left === right;
}

/** `git rev-parse <ref>` as a full sha, or undefined when it will not resolve. */
async function resolveCommit(
  deps: ReviewDeps,
  repoRoot: string,
  rev: string,
  rows: DispatchUsageRow[],
): Promise<string | undefined> {
  if (rev.trim() === "") return undefined;
  const out = await gitQuiet(deps.exec, repoRoot, ["rev-parse", "--verify", `${rev}^{commit}`]);
  const sha = (out?.stdout ?? "").trim();
  // A prefix match is enough for equality, but a garbage read is not: hold both
  // sides to the shape of an oid before comparing.
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : undefined;
}
