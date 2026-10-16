/**
 * work-develop-symbol-merge — #1323: merge and retry once when a
 * workstream's verify failure names a symbol a sibling workstream adds.
 *
 * A coupled split that slips through planning (#1322 is the planning side)
 * shows up after develop as a per-workstream verify failure: the consumer
 * half fails to compile because the symbol it uses lives in a sibling's
 * commit, which its worktree never saw (#1297: an export added in one
 * workstream, consumed in another). Re-running the same split fails the
 * same way, so the recovery is the fence merge-and-retry's shape (#1005):
 *
 *   1. Attribute each per-worktree verify failure to its workstream, and
 *      read the identifiers it says are missing (work-develop-symbol-scan.ts).
 *   2. For every sibling, the symbols it adds: its declared `introduces`
 *      (#1322) first, then the declarations its own diff adds. A sibling
 *      that adds a missing symbol is the producer; the failing one the
 *      consumer.
 *   3. Fold the consumer into the producer with the fence merge
 *      (runMergePrep: the shared fold, the consumer's worktree reset to the
 *      producer's tip, one re-dispatch), recording a
 *      `fence-recovery-started` event with `cause: "sibling-symbol"` that
 *      names both workstreams and the symbols.
 *      Unlike a fence merge, the consumer's own commits are then
 *      cherry-picked back on top (`carryCommits`): its work was sound apart
 *      from the missing symbol, so the re-dispatch is a fix-up of real work
 *      rather than a redo from a prompt. A conflict aborts the pick and
 *      leaves the plain reset, and the prompt says which one happened.
 *   4. Re-run the develop gate once. A pass continues to the converge gate;
 *      a failure parks as `verify-failed:develop` exactly as before, and the
 *      handoff explanation says the split was merged and still failed
 *      (`mergedSplitNote` in work-driver-explain-verify.ts).
 *
 * Bounded: one merge-and-retry per cycle (any earlier merge event in the
 * cycle's log — fence or symbol — disables it; the state file's event log
 * IS the cycle: a resume continues it, and a finished cycle only runs again
 * under `--restart`, which starts a fresh log), only on a multi-workstream
 * develop, and pairs are disjoint (a workstream is in at most one merge per
 * round). `PI_ENSEMBLE_SYMBOL_MERGE_RETRY=0` turns it off.
 */

import { recordCommentEvidence } from "./comment-evidence.ts";
import {
  type MergePrepPlan,
  applyMergedSafetyNet,
  runMergePrep,
} from "./work-develop-fence-merge.ts";
import { replaceDevelopConvergedVerdicts } from "./work-develop-fence-verdicts.ts";
import { type SymbolCoupling, findSymbolCouplings } from "./work-develop-symbol-couplings.ts";
import { appendDevelopVerifyFailure } from "./work-develop-verify-failure.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { runConvergeGateHandler } from "./work-driver-converge-gate.ts";
import { recordConsolidatedVerifySkip } from "./work-driver-verify-events.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import type { WorkState } from "./workflow-state.ts";

type DevelopVerifyGate = Awaited<ReturnType<typeof verifyStepOutcome>>;
type ExecFn = NonNullable<DriverContext["verifyExecFn"]>;

/** #1323 — kill switch (default on). */
export function symbolMergeRetryEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_SYMBOL_MERGE_RETRY;
  return v !== "0" && v !== "false";
}

const VALID_SHA = /^[0-9a-f]{40}$/;

/** The re-dispatch prompt for a sibling-symbol merge. */
export function symbolMergePrompt(
  mergedId: string,
  halves: string[],
  couplings: SymbolCoupling[],
  carried: boolean,
): string {
  const consumers = couplings.filter((c) => c.producer === mergedId).map((c) => c.consumer);
  const state = carried
    ? `The worktree now holds ${mergedId}'s commit with ${consumers.join(", ")}'s first-attempt commits replayed on top, so your earlier work is still there. Fix it up to use the symbols above as ${mergedId} defined them`
    : `The worktree now holds ${mergedId}'s commit; ${consumers.join(", ")}'s first-attempt commits did not replay cleanly on it and were set aside, so redo that half ON TOP of ${mergedId}'s work, using the symbols above as ${mergedId} defined them`;
  const named = couplings
    .filter((c) => c.producer === mergedId)
    .map(
      (c) =>
        `${c.consumer} failed its verify on ${c.symbols.map((s) => `\`${s}\``).join(", ")}, which ${c.producer} adds`,
    )
    .join("; ");
  return [
    `SIBLING-SYMBOL MERGE-AND-RETRY — workstream ${mergedId} (merged from: ${halves.join(", ")}).`,
    "",
    `Your first attempt was split across ${halves.length} workstreams that each started from the same base commit, so neither saw the other's symbols: ${named}. The halves are COUPLED, so the driver MERGED them into a single workstream: ${mergedId}.`,
    "",
    `This is your ONLY re-dispatch. The merged scope is the UNION of both halves' declared paths. ${state}. Do NOT re-implement those symbols, and do NOT touch any file outside the merged scope. Then run the project's verify command and commit.`,
  ].join("\n");
}

/**
 * Replay `base..sha` (the consumer's first attempt) onto the producer's tip
 * the worktree was just reset to. True when every commit applied; on any
 * failure the pick is aborted and the worktree is put back on that tip.
 */
async function carryCommits(
  execFn: ExecFn,
  cwd: string,
  base: string | undefined,
  sha: string,
): Promise<boolean> {
  if (!base || !VALID_SHA.test(base) || !VALID_SHA.test(sha)) return false;
  const opts = { cwd, maxBuffer: 1024 * 1024 };
  let tip = "";
  try {
    tip = (await execFn("git rev-parse HEAD", opts)).stdout.trim();
    await execFn(`git cherry-pick --allow-empty ${base}..${sha}`, opts);
    return true;
  } catch {
    await execFn("git cherry-pick --abort", opts).catch(() => undefined);
    if (VALID_SHA.test(tip)) await execFn(`git reset --hard ${tip}`, opts).catch(() => undefined);
    return false;
  }
}

/** One merge-and-retry per cycle: any earlier merge event disables it. */
function alreadyMerged(state: WorkState): boolean {
  return state.eventLog.some((e) => e.kind === "fence-recovery-started");
}

/**
 * #1323 — the entry point, called by the develop step when its gate failed
 * without a recoverable fence violation. Returns `undefined` when no
 * sibling-symbol coupling applies (the caller then parks as today), else
 * the state after the merge, the single re-dispatch and the gate re-run.
 */
export async function runSymbolMergeRetry(
  ctx: CycleContext,
  stateIn: WorkState,
  stateRef: { current: WorkState },
  ids: string[],
  verdicts: Array<{ id: string; ok: boolean; reason?: string }>,
  gate: DevelopVerifyGate,
  execFn: ExecFn,
  dispatch: NonNullable<DriverContext["dispatchFn"]>,
): Promise<WorkState | undefined> {
  if (!symbolMergeRetryEnabled() || ids.length < 2 || alreadyMerged(stateIn)) return undefined;
  const worktrees = stateIn.pipelineState.worktrees ?? {};
  const workstreams = stateIn.pipelineState.workstreams ?? {};
  const baseShas = stateIn.pipelineState.workstreamBaseShas ?? {};
  const couplings = await findSymbolCouplings(
    gate.failures,
    worktrees,
    (id) => workstreams[id]?.introduces,
    async (id) => {
      const base = baseShas[id] ?? stateIn.pipelineState.baseSha;
      const cwd = worktrees[id];
      if (!base || !VALID_SHA.test(base) || typeof cwd !== "string") return "";
      const { stdout } = await execFn(`git diff ${base}..HEAD`, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    },
  );
  if (couplings.length === 0) return undefined;
  // The first attempt's failures stay on verifyEvidence, so a park inside
  // the merge (a git failure) still shows what the gate found.
  let next: WorkState = {
    ...stateIn,
    pipelineState: {
      ...stateIn.pipelineState,
      verifyEvidence: {
        step: "develop",
        failures: gate.failures,
        at: Date.now(),
        origin: "outcome-gate",
      },
    },
  };
  stateRef.current = next;
  const plan: MergePrepPlan = {
    pairs: couplings.map((c) => ({
      violator: c.consumer,
      owner: c.producer,
      symbols: c.symbols,
    })),
    prompt: (mergedId, halves, carried) => symbolMergePrompt(mergedId, halves, couplings, carried),
    cap: "verify-failed:develop",
    afterReset: (cwd, base, sha) => carryCommits(execFn, cwd, base, sha),
  };
  const prep = await runMergePrep(ctx, next, stateRef, ids, execFn, dispatch, plan);
  next = prep.state;
  if (prep.outcome.parked) return next;
  const { mergedIds, merges, mergeHeads } = prep.outcome;
  // The merged worktree is judged against its post-merge HEAD (#1343).
  next = await applyMergedSafetyNet(ctx, next, mergedIds, mergeHeads, execFn);
  const gate2 = await verifyStepOutcome(ctx, next, "develop");
  // #1240 — the merged re-run's skip is recorded here too: this path owns its
  // appends, so a skip on this path would otherwise read as a run.
  next = recordConsolidatedVerifySkip(next, gate2);
  next = recordCommentEvidence(next, gate2.commentEvidence);
  // The surviving (producer) id carries the re-run's verdict; the absorbed
  // consumer id is no longer a workstream.
  const absorbed = new Set(merges.map((m) => m.from));
  next = replaceDevelopConvergedVerdicts(
    next,
    verdicts
      .filter((v) => !absorbed.has(v.id))
      .map((v) => (mergedIds.includes(v.id) ? { id: v.id, ok: gate2.ok } : { ...v })),
  );
  stateRef.current = next;
  if (gate2.ok) return runConvergeGateHandler(ctx, next, dispatch);
  return appendDevelopVerifyFailure(next, gate2);
}
