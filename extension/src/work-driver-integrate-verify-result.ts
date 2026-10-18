/**
 * work-driver-integrate-verify-result — the result contract of the commit-pr
 * consolidated-tree verify, split out of `work-driver-integrate-verify.ts`
 * for the 500-line cap (AGENTS.md §12).
 *
 * A pure type whose docstrings are most of it, which is exactly why it is the
 * right thing to move: the documentation IS the artifact, and every field here
 * is load-bearing for a PUSH decision. `preExistingOnly` in particular is the
 * difference between a cycle that parks and one that ships with a red gate, so
 * its "absence is the park, never an omission to read as approval" wording has
 * to stay next to the field rather than in a caller's head.
 */

import type { ConsolidationFailureVerdict } from "./work-driver-consolidation-classify.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";

/**
 * The caller's side of the commit-pr consolidated verify. Split from the
 * function so the seam's ~65 lines of per-field doctrine sit with the rest of
 * the contract rather than inside the entry point's signature (AGENTS.md §12).
 */
export interface CommitPrVerifyOpts {
  verifyCmd: string;
  repoRoot: string;
  workstreamCount: number;
  workstreamIds: string[];
  perWorktreeFailuresByWs?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Set when this consolidated run is NOT the first at commit-pr (i.e.
   * a prior ci-retry already ran the verify command and the caller bumped
   * ciRetryCount). When set, the single flake retry is skipped — the
   * retry precondition (issue #782 AC: "the retry fires ONLY when … the
   * FIRST consolidated run at commit-pr (ciRetryCount unset)") is not met.
   * Absent (undefined) is the first run; the retry fires when the other
   * preconditions hold.
   */
  isCiRetry?: boolean;
  /**
   * #782 — the re-run passed: the caller records the recovery on the PR
   * via the `verify-flake-recovered` event (the callback is where that
   * append happens, BEFORE the caller appends any failure cap).
   */
  onRecover?: (evidenceTail?: string) => void;
  /**
   * #1240 — the tree the develop gate last verified GREEN, established by
   * the CALLER, plus the worktree it came from (the trace names it). At
   * this seam the tree under verification is the integration branch's
   * committed tree, which no develop run ever judged in place — the caller
   * can only assert equality for the shape where the integration is that
   * one workstream's content and nothing else (one workstream, a
   * cherry-pick, no uncommitted residue: see `integrate()` step 4). When
   * the pair is supplied and the committed tree is read successfully and
   * equals it, the verify command is skipped and `skipped` reports the
   * identity. A read failure, a mismatch, or no pair → the run happens.
   */
  alreadyVerifiedTree?: AlreadyVerifiedTree;
  /**
   * #1404 — the cycle's ORIGINAL base commit, the commit this cycle's
   * commits were measured against. Required for the baseline probe: when it
   * is absent, or is not a 40-hex commit id, no probe runs and every
   * consolidated failure parks as before (fail-closed). The CALLER supplies
   * `ps.baseSha` and never a followup round's `followupBase` — that commit
   * already carries this cycle's earlier commits, which would excuse every
   * failure as pre-existing.
   */
  baseSha?: string;
  /**
   * #1404 — trees the change run's failing-test names may live under, on top
   * of `repoRoot` and the probe tree (which the seam always knows). The
   * caller passes the workstream worktrees: a committed gate script resolves
   * its own directory, so its printed paths follow the checkout the script
   * lives in. A name under none of them is unattributable, never excused.
   */
  changeRoots?: readonly string[];
  /**
   * #1427 round 3 — no `walkProcessTree` here, deliberately. It was declared
   * as a test seam and had no caller: neither `verifyIntegration` (its only
   * production caller) nor any smoke test passes one, so every commit-pr hang
   * report walked the host's `ps` regardless of what a test injected, and the
   * parameter's existence claimed a seam that did not work. The behaviour is
   * driven entirely by `treePid` on the executor's error — which is the real
   * signal, because the pid is what tells the reporter whether this run had a
   * group worth describing at all. If a test ever needs to control the walk
   * here, it injects `verifyExecFn` (which is where `treePid` comes from) and
   * the seam is added with a caller in the same change.
   */
}

/**
 * The result of running the commit-pr consolidated-tree verify.
 *
 * - `ok: true` — the consolidated tree passed verify; the caller may push.
 * - `ok: false` — the consolidated tree failed verify; the caller must
 *   NOT push. The `failureTail` is the raw (bounded) verify output, the
 *   `verdict` is the three-way classification, and the `classifiedMessage`
 *   is the handoff-ready text that names the classification, the specific
 *   assertion, and the workstream ids.
 */
export type CommitPrConsolidatedVerifyResult =
  | {
      ok: true /** #782 — the first run flaked and the single re-run passed. */;
      recovered?: boolean;
      /**
       * #1240 — the verify command was not run because the integration tree
       * is the tree the develop gate already verified green. The caller
       * renders the visible note from it. Absent on every real run.
       */
      skipped?: AlreadyVerifiedTree;
    }
  | {
      ok: false;
      /** Raw bounded (800-char) verify output, with attribution anchor. */
      failureTail: string;
      /** True when the tail starts at a `FAILED:` marker (smoke-loop shape). */
      attributed: boolean;
      /** Three-way classification (see the classifier module docstring). */
      verdict: ConsolidationFailureVerdict;
      /** Handoff-ready message naming classification + assertion + workstreams. */
      classifiedMessage: string;
      /** #1324 — the run was killed at its bound: no verdict, so no classification. */
      timedOut?: boolean;
      /**
       * #1404 — every consolidated failure the base-commit probe accounted
       * for: each failing test also fails at `baseSha`, so NONE is caused by
       * this change. The caller may continue (push, open the PR) and must
       * carry `preExistingFailures` as a visible note. Absent whenever the
       * probe did not run, could not establish a red base, or any failure is
       * change-caused / unattributable — absence is the park, never an
       * omission to read as approval.
       */
      preExistingOnly?: boolean;
      /**
       * #1404 — the failing test names the base run also produced. Present
       * whenever the probe ran and named them, including the mixed case
       * (some pre-existing, some change-caused) where the cycle still parks.
       */
      preExistingFailures?: string[];
      /**
       * #1404 — the failing test names the base run did NOT produce, i.e. the
       * ones this change caused. Set on a mixed verdict; the park reason
       * names these alone, so an operator is not sent to inspect tests that
       * were already red before the cycle started.
       */
      changeCausedFailures?: string[];
      /**
       * #1427 — commit-pr carries the hang CLAUSE only. The clause is composed
       * into `classifiedMessage` (see the timeout branch below), which is what
       * the caller puts on the cap and the handoff renders; the commit-pr seam
       * has no scratch dir of its own to persist a full report to, so unlike
       * the develop seams this result reports no `runningTests` / `processes`
       * and no caller ever read them (round 1: two dead fields).
       */
    };
