/**
 * work-driver-integrate-verify — #777 commit-pr twin: run the project's
 * verify command against the CONSOLIDATED tree after the branch has the
 * cherry-picked commit, and — on failure — classify it instead of parking
 * on the generic "the consolidated tree fails the project's verify command".
 *
 * The develop-time twin lives in `work-driver-consolidated-verify.ts` and
 * returns a structured `{status, detail}`; this module runs on the
 * commit-pr path, where the consolidated tree IS the branch at repoRoot
 * (not a scratch probe) and the caller (`integrate()` step 4) needs a
 * fail-closed verdict plus the classification to name the handoff.
 *
 * The classification is delegated to the shared classifier
 * (`work-driver-consolidation-classify.ts`) — the same one the develop
 * seam uses — so the two call sites cannot drift. The `failureTail` we
 * hand to it is the raw stderr/stdout of the verify run, bounded to the
 * same 800 chars the develop seam uses via `extractAttributedTail`; the
 * classifier re-extracts the specific assertion from that tail, which is
 * the same contract the develop path relies on.
 *
 * The N=1 invariant is honoured by the classifier itself (it takes the
 * workstream count and refuses `consolidation-created` at N=1) — this
 * module just threads the count through.
 *
 * The restore claim is NOT mixed into `failureTail`: `consolidateCommitPrVerifyFailure`
 * composes the final `reason` from the classified message + the claim, so
 * the assertion the classifier parses is the assertion the verify command
 * emitted, not the restore post-condition. The develop seam keeps the
 * claim in the detail because its message builder reads the whole detail
 * verbatim; the commit-pr seam builds the reason itself and can keep the
 * two concerns separate.
 */

import {
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
} from "./work-driver-consolidation-classify.ts";
import type { ConsolidationFailureVerdict } from "./work-driver-consolidation-classify.ts";
import { extractAttributedTail } from "./work-driver-exec-error.ts";
import type { ExecFn } from "./worktree.ts";

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
  | { ok: true }
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
    };

/**
 * Run the project's verify command against the CONSOLIDATED tree at
 * repoRoot (which `integrate()` has already put on the integration
 * branch with the cherry-picked commit). On failure, classify via the
 * shared classifier and return the structured result.
 *
 * The caller is responsible for the restore claim — it composes the
 * final `reason` string from `classifiedMessage` + its own claim, which
 * keeps the restore concern (this module has no knowledge of the
 * original ref) out of the classification input.
 *
 * @param execFn — shell executor (injection seam for tests).
 * @param verifyCmd — the project's verify command (from `.pi/verify-cmd`).
 * @param repoRoot — the repoRoot the consolidated tree is checked out at.
 * @param workstreamCount — the number of workstreams in the cycle (N).
 * @param workstreamIds — all workstream ids in order.
 * @param perWorktreeFailuresByWs — per-worktree verify failure texts
 *   keyed by workstream id. In the commit-pr seam this is always `{}` —
 *   the develop gate ran per-worktree verify in a previous step and the
 *   results live in the state file's `verifyEvidence`, not here — the
 *   classifier's per-workstream-defect branch simply does not fire,
 *   which is correct: at commit-pr, a per-workstream defect would have
 *   been caught (or parked) in the develop step and never reach the
 *   push. The N=1 invariant is still honoured by the classifier.
 */
export async function runCommitPrConsolidatedVerify(
  execFn: NonNullable<ExecFn>,
  opts: {
    verifyCmd: string;
    repoRoot: string;
    workstreamCount: number;
    workstreamIds: string[];
    perWorktreeFailuresByWs?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<CommitPrConsolidatedVerifyResult> {
  let failure: string | undefined;
  try {
    await execFn(opts.verifyCmd, {
      cwd: opts.repoRoot,
      maxBuffer: 8 * 1024 * 1024,
      timeout: opts.timeoutMs,
    });
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    failure = (e.stderr || e.stdout || e.message || "").toString().trim();
  }
  if (failure === undefined) return { ok: true };

  // The tail we hand to the classifier: anchored at the FAILED: marker when
  // present, last 800 chars otherwise (the biome/tsc shape emits no marker).
  // The same `extractAttributedTail` the develop seam uses, so the assertion
  // extraction path is identical across both seams.
  const { tail, attributed } = extractAttributedTail(failure, 800);
  // The restore claim is NOT in this tail — the caller composes it from
  // the classified message + its own claim. Passing the raw tail (with
  // the unattributed marker when applicable) keeps the classifier's
  // assertion extraction clean.
  const failureTail = tail || "verify command exited non-zero";
  const verdict = classifyConsolidatedVerifyFailure(
    opts.workstreamCount,
    opts.workstreamIds,
    failureTail + (attributed ? "" : " (unattributed — best-effort tail)"),
    opts.perWorktreeFailuresByWs ?? {},
  );
  const classifiedMessage = consolidatedFailureMessage(verdict, opts.verifyCmd);
  return { ok: false, failureTail, attributed, verdict, classifiedMessage };
}
