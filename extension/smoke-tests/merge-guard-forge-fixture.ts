/**
 * merge-guard-forge-fixture.ts — the #2107 additions to the merge-guard
 * decision-matrix harness (merge-guard-helpers.ts): the knobs a CI-gate arm
 * needs (check rows, the head the verdict was read at, a hanging read, the
 * command's `-R <repo>`), and the one rule those knobs must agree on — what
 * head the forge's evidence read reports.
 *
 * Split out of merge-guard-helpers.ts for the 500-line gate (#12). The knobs
 * live here as ONE type that `makeHook` and `hookDecision` both accept, so
 * adding an arm never means editing two option lists.
 */

export { isFullCommitSha } from "../src/review-head-sha.ts";
import { isFullCommitSha } from "../src/review-head-sha.ts";

/** A test fixture's short head → the 40 hex chars the gatherer demands. */
function padOid(oid: string): string {
  const hex = oid.toLowerCase().replace(/[^0-9a-f]/g, "") || "a";
  return hex.padEnd(40, "0").slice(0, 40);
}

/**
 * The head the forge's evidence read reports for a fixture: the OID the guard
 * fetched with `git rev-parse` and compared to the PR's `headOid`, padded to
 * the 40 hex chars the gatherer demands. Deriving the answer from the SAME
 * value the guard compares is what makes a matrix that is not testing the pin
 * immune to it — the two cannot disagree by accident, which is the difference
 * between an arm that tests the CI verdict and an arm that silently tests the
 * head pin instead. A fixture's head may itself be abbreviated (`abc123`),
 * hence the padding here rather than at the comparison site; an arm that IS
 * testing the pin names `evidenceHeadOid` and opts out of the derivation.
 */
export function evidenceHeadFor(fetchedHead: string): string {
  return isFullCommitSha(fetchedHead) ? fetchedHead : padOid(fetchedHead);
}

/**
 * The #2107 knobs, shared by `makeHook` (the stub) and `hookDecision` (the
 * runner), so every arm can set them from one place.
 */
export interface MergeGateEnv {
  /**
   * #2106 — what `gh pr checks` answers: a JSON array of `{name,state,bucket}`
   * rows, the shape `gatherMergeEvidence` reads. Un-stubbed, the stub answers
   * with the ordinary one-passing-check board — every matrix that is actually
   * about the CI verdict names its own rows (test-merge-guard-ci-evidence.ts,
   * test-merge-guard-ci-holes-2107.ts) and pins the argv it expects, so the
   * default is only ever seen by matrices whose subject is not the checks.
   */
  prChecks?: string;
  /** #2106 — what `mergeStateStatus` reports (default CLEAN). */
  mergeStateStatus?: string;
  /** #2106 — make the PR-state read throw (the "gh is broken" arm). */
  failEvidence?: boolean;
  /** #2106 — make the check-row read throw. */
  failChecks?: boolean;
  /**
   * #2106/#2107 — the head the evidence read reports. Undefined (the default)
   * means "the head the guard verified", derived from `fetchedHead`; an arm
   * testing the pin names a full different OID, or `""` for a read that
   * reported no head at all.
   */
  evidenceHeadOid?: string;
  /**
   * #2107 — a CI read that never settles. The guard bounds the read with its
   * own timeout, so the stub hangs past every bound an unbounded caller would
   * have and never answers.
   */
  hangChecks?: boolean;
  /**
   * #2107 — the `-R <repo>` the merge command carries, verbatim (e.g.
   * `" -R o/r"`), appended to the command the hook is handed.
   */
  repoFlag?: string;
  /**
   * #2107 — the repo every `gh pr …` read must be scoped to, asserted as an
   * exact `… -R <repo>` suffix: a read that dropped it answers about a
   * different PR than the one the merge acts on.
   */
  targetRepo?: string;
  /**
   * #2107 — collects the `timeout` of every exec the hook issued, in call
   * order, so an arm can assert the CI reads were bounded at all.
   */
  timeouts?: number[];
}
