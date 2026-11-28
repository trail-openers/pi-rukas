import { frozenFromLog } from "../lean-log.ts";
import { runRepairRound } from "../oracle-repair-dispatch.ts";
import { blockedEvidenceLines, headEvidenceFromStep } from "../oracle-repair-evidence.ts";
/** lean/repair — ONE adversary round to correct a frozen oracle the driver proved unsatisfiable: read the
 * blocked report off the log, ask for the round, record its verdict. The safety facts (billing, blindness,
 * judgement, freeze) live with the round's own modules.
 */
import { leanChildOpts } from "./child-opts.ts";
import { buildWriteFence } from "./build-dispatch.ts";
import type { HandlerCtx } from "./engine.ts";
import { rereadSpec } from "./spec-for.ts";
import { SpecifyInfraError } from "./specify-reset.ts";
import { specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import type { Outcome } from "./state.ts";
import { blockedStep, refusedRepair, repairedSentence, rowsKey } from "../oracle-repair-verdict.ts";
import type { RepairDeps as RepairWiringDeps } from "../oracle-repair-wiring.ts";

/** The `repair` step. A refusal is a `refused` kind the table routes; only git it cannot account for throws. */
export async function repairOutcome(
  ctx: HandlerCtx,
  deps: RepairWiringDeps,
  /** Threaded to the seat's permission stamp, like every dispatching step. */
  headless: boolean,
): Promise<Outcome> {
  const { repoRoot, issue } = ctx;
  const blocked = blockedStep(ctx.steps);
  // The table only sends a run here from a honoured blocked verdict, so a record that cannot account for
  // itself is infrastructure, and the throw names the missing fact.
  if (blocked === undefined) throw new SpecifyInfraError("no proven blocked report behind this repair round");
  const named = Object.keys(blocked.outcome?.blockedBy ?? {});
  if (named.length === 0) throw new SpecifyInfraError("the blocked report named no file to repair");

  const base = ctx.run.baseSha;
  const config = await deps.loadConfig(repoRoot, base).catch((err: unknown) => {
    throw new SpecifyInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  // The same contract `specify` wrote, never a paraphrase of the builder's brief.
  const { spec } = await rereadSpec(
    () => deps.fetchIssueBody(repoRoot, issue),
    ctx.run,
    (m) => new SpecifyInfraError(m),
  );

  const wt = specifyWorktreePath(repoRoot, issue);
  return await deps.withBaseTree(async (baseTree) => {
    const result = await runRepairRound({
      deps: { ...deps, baseTree },
      ctx,
      config,
      spec,
      childOpts: leanChildOpts(headless),
      repoRoot,
      issue,
      baseSha: base,
      // The red's commit, and where the seat is reset.
      headBefore: blocked.outcome?.headBefore ?? base,
      wt,
      branch: specifyBranch(ctx.run.branch, issue),
      frozen: frozenFromLog(ctx.steps),
      named,
      claims: blockedEvidenceLines(ctx.steps),
      evidence: headEvidenceFromStep(blocked),
      scratch: buildWriteFence(wt, repoRoot, issue).scratch,
    });
    if (result.kind === "refused") return refusedRepair(result, blocked);
    return {
      kind: "repaired",
      reason: repairedSentence(result),
      // The whole map with the replaced paths re-hashed: `frozenFromLog` unions freezes in order, so the
      // corrected oracle is the contract from here on and `verify` reads the same union.
      frozen: result.frozen,
      repair: {
        round: 1,
        baseSha: result.head,
        originalHashes: result.originalHashes,
        passedAtHead: result.passedAtHead,
      },
      ...rowsKey(result.rows),
    };
  });
}

