/**
 * work-driver-plan-coupling-pass — the plan step's coupling pass, in one call.
 *
 * #819 round-3 — extracted from `runPlan` (work-driver-plan.ts) for the
 * AGENTS.md §12 500-line gate. The body is byte-identical to the closure it
 * replaces, including the two facts the closure captured and this function now
 * takes as arguments: the port reference the #1322 fold reads, and the
 * worktrees map the coupling grep resolves each workstream's paths against
 * (empty at plan time in production — the branch step populates it later, so
 * the merge runs at `repoRoot`).
 *
 * Why a module and not a helper inside work-driver-plan.ts: the plan step
 * itself is the file at the cap, and this pass is a distinct concern (it owns
 * the fold + the contract-derived edges + the merge loop), so it splits along
 * the same seam as `work-driver-plan-coupling.ts` and
 * `work-driver-plan-contract.ts` rather than adding a fourth responsibility to
 * the step handler.
 */

import { trace } from "./trace.ts";
import { foldPortPlan, mergeWithContract } from "./work-driver-plan-contract.ts";
import { mergeCoupledWorkstreams } from "./work-driver-plan-coupling.ts";
import { execp } from "./work-driver-verify.ts";
import type { Workstream } from "./workflow-state-schema.ts";

/** The argv-form grep seam (planner-controlled paths, no shell) — the same
 * shape `mergeCoupledWorkstreams` takes; declared here because the coupling
 * module keeps it private. */
type GrepExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; argv?: string[] },
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * Fold a port plan into one workstream, then merge workstreams the coupling
 * rules say cannot be built independently. A single-workstream plan is a
 * no-op; a plan with no port reference and no coupling is returned unchanged.
 *
 * `execFn` is the rule-3 grep executor: `ctx.verifyExecFn` when a test supplies
 * one, `execp` otherwise (it honours `opts.argv` via execFile). The merge runs
 * at plan time, before the branch step, so the grep's cwd is `repoRoot`.
 */
export async function runPlanCouplingPass(
  raw: Record<string, Workstream>,
  opts: {
    port?: string;
    repoRoot: string;
    worktrees?: Record<string, string>;
    execFn?: GrepExecFn;
  },
): Promise<Record<string, Workstream>> {
  const ws = foldPortPlan(raw, opts.port);
  if (Object.keys(ws).length <= 1) return ws;
  const planExecFn = opts.execFn ?? execp;
  const coupling = await mergeWithContract(ws, (w) =>
    mergeCoupledWorkstreams(w, planExecFn, opts.worktrees, opts.repoRoot),
  );
  if (coupling.changed) {
    for (const m of coupling.merges) {
      trace(`work-driver: plan coupling merge — ${m.from} → ${m.into} (${m.reason})`);
    }
    return coupling.workstreams;
  }
  return ws;
}
