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

/**
 * A test fixture's short head → the 40 hex chars the evidence gatherer
 * demands. The filler goes at the FRONT (`000…0abc123`), leaving the fixture's
 * own characters as the trailing identity of the OID.
 *
 * The filler goes at the FRONT (`000…0abc123`), which keeps the widening
 * INJECTIVE for the fixture heads these matrices use: two different fixture
 * heads never widen to the same 40 chars, so an arm that names
 * `evidenceHeadOid` and means "another commit" cannot be silently reconciled
 * with the verified head. Trailing filler (`abc123aaa…`) does agree with a
 * prefix comparison, but it collides — `abc123` and `abc123a` would be the same
 * OID — and a harness that quietly makes a mismatch agree is the failure mode
 * this whole fixture exists to rule out. The price is that a fixture head must
 * be widened ONCE for every reader (see `makeHook`), which is what `widenOid`
 * is exported for.
 */
function widenOid(oid: string): string {
  const hex = oid.toLowerCase().replace(/[^0-9a-f]/g, "") || "a";
  return hex.padStart(40, "0").slice(-40);
}

/** Exported so the stub's identity read, its `rev-parse` answer and its
 * evidence read all report ONE head, widened by the same rule (#2107): three
 * answers that name the same commit, derived from the fixture's own head. */
export { widenOid };

/**
 * Is `x` a prefix of `y`, or `y` of `x`, at the length the guard's own pin
 * accepts (>= 7 hex)? The same rule `sameOid` in merge-guard-reads.ts applies
 * to the two OIDs: the guard compares its `git rev-parse` answer to the
 * forge's by PREFIX, because either side may be abbreviated. Shared with the
 * fixture so the fixture's answer and the guard's comparison cannot drift.
 */
function samePrefixHex(x: string, y: string): boolean {
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/**
 * The head the forge's evidence read reports for a fixture: the OID the guard
 * fetched with `git rev-parse` and compared to the PR's `headOid`, rendered
 * the way `gh` really renders `headRefOid` — the FULL 40 hex chars, and the
 * SAME COMMIT as the value the guard compares.
 *
 * Deriving the answer from the very field the guard compares (`fetchedHead`,
 * which it has just verified equals the PR's `headOid`) is what makes a matrix
 * that is not testing the pin immune to it: the two cannot disagree by
 * accident, which is the difference between an arm that tests the CI verdict
 * and an arm that silently tests the head pin instead.
 *
 * Both constraints have to hold at once, and that is what the widening is for:
 * the GATHERER demands 40 hex (`work-driver-merge-evidence.ts` refuses an
 * abbreviated `headRefOid`), while the GUARD matches by prefix, so a 40-char
 * answer that shares no leading characters with the fixture's abbreviated head
 * is read as another commit. A fixture head that is ALREADY 40 hex — the
 * round-cap matrices use `a`.repeat(40) — is returned verbatim, so the guard's
 * prefix check is an exact match there and every non-pin matrix passes by
 * construction. An arm that IS testing the pin names `evidenceHeadOid` — a
 * different commit's OID, which shares no leading characters with the verified
 * head — and opts out of the derivation.
 */
export function evidenceHeadFor(head: string): string {
  if (isFullCommitSha(head)) return head;
  const full = widenOid(head);
  return samePrefixHex(full, head) ? full : head.padEnd(40, "0").slice(0, 40);
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
   * #2226 — answer the origin-URL read with a remote no parser claims, instead of
   * a parsable one. The witness for the guard's FORGE THREADING: the gatherer is
   * handed the target's forge rather than left to re-detect one. A parsable remote
   * is NOT enough for that witness — detection's first precedence is the harness's
   * `PI_ENSEMBLE_FORGE` pin, which answers whatever the target already carries, so
   * with it in place a regression that dropped the threaded argument could not
   * change any outcome. Pair it with {@link unsetForgeEnv}, which withholds that
   * pin so detection has only the (unusable) remote to classify, as it does in
   * production where the variable is never set.
   */
  failRemoteUrl?: boolean;
  /**
   * #2226 — with {@link failRemoteUrl}, withhold the harness's `PI_ENSEMBLE_FORGE`
   * pin for the duration of this decision, so the gatherer's last-resort detection
   * has only the (unusable) remote to classify. Set only by the arm that sets
   * `failRemoteUrl`; every other arm keeps the pin, because the matrices about the
   * CHECK verdicts drive both forges through it.
   *
   * The guard's OWN reads stay on the target's forge: the stub classifies this
   * clone from `target.forge` rather than from the variable (see the origin-URL
   * arm in `merge-guard-stub.ts`), which is the property this arm needs — an arm
   * that withheld the pin also from the identity read would fail on the harness
   * rather than on the gatherer.
   */
  unsetForgeEnv?: boolean;
  /**
   * #2226 — the MR row the gatherer's GitLab arm reads, verbatim JSON. Absent,
   * the stub answers a green MR (`can_be_merged`, no conflicts, discussions
   * resolved, no approvals outstanding) carrying the head the guard verified.
   */
  glMr?: string;
  /**
   * #2226 — the `detailed_merge_status` of that row, for an arm that varies the
   * readiness rather than replacing the whole payload (`can_be_merged` when
   * unset).
   */
  glMrStatus?: string;
  /**
   * #2226 — the MR's pipelines list, verbatim JSON (one row for the MR's
   * `head_pipeline` — id 5001, sha the verified head — when unset).
   */
  glPipelines?: string;
  /**
   * #2226 — what the SECOND pipelines page answers, verbatim JSON (`[]` when
   * unset: a full first page with nothing after it, which is the whole list).
   * Only ever read when the first page filled its requested size.
   */
  glPipelinesPage2?: string;
  /** #2226 — the pipeline's job rows, verbatim JSON (one `success` row when unset). */
  glJobs?: string;
  /**
   * #2226 — what the SECOND jobs page answers, verbatim JSON (`[]` when unset:
   * a full first page with nothing after it, which is the whole pipeline). Only
   * ever read when the first page filled its requested size.
   */
  glJobsPage2?: string;
  /**
   * #2106/#2107 — the head the evidence read reports.
   *
   * - `undefined` (the default) — "the head the guard verified", derived from
   *   `fetchedHead`, so a matrix about the CHECK verdicts cannot fail the head
   *   pin by accident.
   * - a full or short OID — an arm testing the pin: a different commit.
   * - `null` — the read answered but reported no head at all (the field is left
   *   out of the payload), the shape that must refuse as an absent head.
   */
  evidenceHeadOid?: string | null;
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
  /**
   * #1529 — what the merge-time protected-path read prints: NUL-separated
   * `diff -z --name-status` records. Absent is an EMPTY change set, i.e. a clean
   * PR, which is what every pre-#1529 arm expects and why those matrices still
   * pass unchanged. An arm that wants a protected diff builds the stream with
   * `nulNameStatus` and names it here.
   */
  protectedDiff?: string;
  /**
   * #1529 — the protected-path read throws. The guard must refuse, not merge:
   * "could not read the diff" and "nothing protected changed" are different
   * answers to a gate that merges on the difference.
   */
  protectedDiffThrows?: boolean;
}
