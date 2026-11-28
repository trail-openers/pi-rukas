/**
 * specify-preserves — the RULE a `specify` child may declare against: a criterion whose behaviour must
 * KEEP working, rather than be newly built.
 *
 * What the declaration does, and what it never does:
 *
 *   - a declared row whose test is GREEN at the base freezes as a must-pass file and is not a coverage gap,
 *     because a criterion that states behaviour the base already has has no red test to write;
 *   - a declared row whose test is RED at the base is an ordinary red test and the declaration changes
 *     nothing about it;
 *   - an UNDECLARED green file, a criterion with no file, and a file that cannot fail keep the coverage rule
 *     untouched and hand back with the same stable reason;
 *   - at least one criterion must be red at the base. A spec whose every test criterion is preserved is a
 *     run with nothing to build, and it hands back too: the exemption never becomes a way to freeze a
 *     contract made of guards alone.
 *
 * The honest limit, stated in the docs and here: a preserved test that asserts nothing is indistinguishable
 * from a genuine guard at specify. What mitigates it is that the file is frozen — so the existing frozen test
 * check in `verify` runs it at head — and that the ids are disclosed by name in the handback and the PR body.
 *
 * The step half (which files a run must actually freeze) lives outside this directory, in
 * `../lean-preserved-step.ts`, under the lean line cap; this file states the rule and holds the wording.
 */

/** The sentence the gap's second reading gains for the undeclared-green case. */
export const PRESERVES_HINT =
  "If this criterion must keep holding, declare it as preserved when submitting.";

/**
 * The stable reason a spec whose every test criterion is preserved earns. It names the criteria, so an
 * operator reading the handback sees which ids the child claimed and why the run still stopped.
 */
export function allPreservedReason(preserved: readonly string[]): string {
  return `every test criterion is preserved (${preserved.join(", ")}); at least one criterion must be red on the base, or there is nothing to build`;
}

/**
 * The committed reason's own clause, or `""` when nothing was preserved. The must-pass files are frozen
 * beside the red ones, so the reason names the criteria it froze rather than leaving a reader to diff them.
 */
export function preservedReasonClause(preserved: readonly string[]): string {
  return preserved.length === 0
    ? ""
    : `preserved ${String(preserved.length)} criterion/criteria (${preserved.join(", ")}), frozen as must-pass at head`;
}
