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
