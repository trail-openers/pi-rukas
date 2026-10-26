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
import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";
import { type WorktreeDiff, readWorktreeDiff } from "./work-driver-diff-read.ts";

/**
 * Read one workstream's diff, or return the NO-VERDICT outcome the fan-out
 * records instead — which is never `skipped`.
 *
 * The outcome is `infra: true` with a `dispatch-failed` event and
 * `diffUnreadable: true`: nobody judged the diff, so it is not a rejection. The
 * #486 in-step ladder retries it (`isTransientAdversarialOutcome` → the
 * taxonomy's `crashed` → shouldRetry) and the step router's RETRY_ONCE path
 * takes it from there; when both budgets are spent the gate parks with
 * `adversarial-diff-unreadable` rather than approving.
 *
 * `recordWhy` threads the git error to `pipelineState.adversarialDiffError` so
 * the handoff names the failure (the `lensDiffError` shape, #384).
 */
export async function readDiffOrFailureOutcome(args: {
  id: string;
  cwd: string;
  baseSha?: string;
  multi: boolean;
  label: string;
  jobId: string;
  startedAt: number;
  priorOutcomes: Map<string, string>;
  execFn?: Parameters<typeof readWorktreeDiff>[2];
  recordWhy: (why: string) => void;
}): Promise<{ ok: true; diff: string } | { ok: false; outcome: AdversarialOutcome }> {
  const { id, cwd, multi, label, jobId, startedAt, priorOutcomes } = args;
  const r: WorktreeDiff = await readWorktreeDiff(cwd, args.baseSha, args.execFn);
  if (r.ok) return { ok: true, diff: r.diff };
  const reason = `adversarial could not read the diff for workstream ${id} at ${cwd || "(no worktree)"}: ${r.reason}`;
  trace(`work-driver: ${reason} — NOT approving on an unreadable diff`);
  args.recordWhy(reason);
  return {
    ok: false,
    outcome: {
      id,
      ok: false,
      rounds: 0,
      records: [],
      infra: true,
      threw: false,
      skipped: false,
      priorInfra: priorOutcomes.get(id) === "infra-failure",
      // Distinguishes "the reviewer could not be run" from "the diff could not
      // be read", so the aggregate parks with the cap that names the read.
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
    },
  };
}
