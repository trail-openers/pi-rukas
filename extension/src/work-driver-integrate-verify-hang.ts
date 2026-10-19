/**
 * work-driver-integrate-verify-hang — the killed-run clause of the commit-pr
 * consolidated verify, split out of `work-driver-integrate-verify.ts` for the
 * 500-line cap (AGENTS.md §12).
 *
 * A run killed at its bound produced no verdict, so it has no classification:
 * the whole deliverable at this seam is the hang clause naming the command, the
 * tree, the bound, and (when the executor reported a leader pid) the process
 * group that was still alive at the kill. Nothing else about a killed run is
 * evidence — which is why the attribution probe never runs on this path.
 *
 * #1427 fix round — the result carries no `runningTests` / `processes`: nothing
 * reads a structured tree at this seam, and there is no scratch dir to persist a
 * full report to, so the clause composed into `classifiedMessage` is what the
 * caller puts on the cap and what the handoff renders.
 *
 * #1064 — the tree half of that clause arrives from the caller as `where`
 * rather than being composed here: this seam has no workstream count, and the
 * single rule for CONSOLIDATED-vs-own-tree wording lives with the count that
 * decides it (`consolidatedRunWhere`, called by the caller).
 */

import type { ConsolidationFailureVerdict } from "./work-driver-consolidation-classify.ts";
import type { HangProcess } from "./work-driver-gate-hang.ts";
import type { CommitPrConsolidatedVerifyResult } from "./work-driver-integrate-verify-result.ts";
import { verifyHangFailure } from "./work-driver-verify-develop-helpers.ts";

/** The env knob that raises this seam's bound, named in the clause. */
const TIMEOUT_KNOB = "PI_ENSEMBLE_INTEGRATION_VERIFY_TIMEOUT_MS";

/**
 * The `ok: false` result for a consolidated run that was killed at its bound.
 *
 * The clause is APPENDED after the sentence, so the `[verify-timeout]` marker
 * always survives the 800-char tail bound the cap evidence applies — with a wide
 * clause it is the test names that get clipped, not the marker that makes the
 * cap (#1427 round 3).
 */
export function commitPrHangResult(opts: {
  ranCmd: string;
  repoRoot: string;
  bound: number;
  /**
   * The tree clause — `on the CONSOLIDATED tree at <repoRoot>` for N>1, `in
   * <tree>` for a single workstream (#1064). Composed by the caller via
   * `consolidatedRunWhere`, which owns the workstream count.
   */
  where: string;
  /** The killed run's combined stream, as captured at the kill. */
  output: string;
  /** The tree captured at the kill; absent when the executor said no pid. */
  tree?: { processes: HangProcess[]; treeUnavailable?: string };
  failureTail: string;
  attributed: boolean;
  verdict: ConsolidationFailureVerdict;
}): CommitPrConsolidatedVerifyResult {
  const classifiedMessage = verifyHangFailure(
    opts.ranCmd,
    // #1064 — the tree clause arrives from the caller, which owns the
    // workstream count (this seam has none): N>1 gets
    // `on the CONSOLIDATED tree at <repoRoot>`, N=1 gets `in <that
    // workstream's tree>` in the per-worktree wording. Marker and sentence
    // unchanged either way.
    opts.where,
    opts.bound,
    {
      output: opts.output,
      cmd: opts.ranCmd,
      cwd: opts.repoRoot,
      timeoutMs: opts.bound,
      ...(opts.tree === undefined ? {} : { tree: opts.tree }),
    },
    TIMEOUT_KNOB,
  );
  return {
    ok: false,
    failureTail: opts.failureTail,
    attributed: opts.attributed,
    verdict: opts.verdict,
    classifiedMessage,
    timedOut: true,
  };
}
