/**
 * lean/repair — the step that buys ONE adversary round to correct a frozen oracle the driver proved wrong.
 *
 * When a builder's blocked report survives the anti-forgery gate (`build-blocked.ts`), the driver has itself
 * watched a frozen acceptance test come back red at the builder's head. The release's answer was to hand back.
 * This step is the other answer, available only under `PI_ENSEMBLE_LEAN_ORACLE_REPAIR`: the adversary that
 * wrote the tests is paid once to correct the named file, in a tree at the run's base where the implementation
 * it must not copy is not present, and its replacement is judged mechanically before it may replace anything.
 *
 * What makes the round safe is not the child's good sense but four facts about how it is run:
 *
 *   - **it is one-shot, and billed before it is spent.** The table moves `repairsSpent` on the edge that
 *     ENTERS this state, so a round that is refused, crashes, or is never judged has still been bought. A
 *     builder cannot earn a second round by filing another provable conflict, and a resumed run reads the
 *     same counter a crashed one left.
 *   - **the seat is blind.** Its brief is built by `oracle-repair-evidence.ts` from the spec, the named file
 *     paths, the driver's one-line reason for each, and the output the DRIVER watched the runner print. No
 *     build diff, no build session, no builder prose beyond the names it filed. A seat that could read the
 *     builder's code would write the test that code already passes — which is the oracle this run was trying
 *     to repair. The blindness is also performed in git: the tree is reset to `baseSha` before the child is
 *     paid.
 *   - **its submission is judged, not believed.** `oracle-repair-judge.ts` requires every replaced file to be
 *     named by the blocked report, requires a case of it to be RED at the run's base under the project's own
 *     runner, and requires that red to be a case the frozen file never printed. Any refusal ends the round.
 *   - **the replacement is frozen by the release's own primitive** (`oracle-repair-dispatch.ts`), so the run's
 *     tamper evidence describes committed bytes, and `verify` holds the corrected oracle to the same standard
 *     it holds the original to. `landEarned` is not widened: a repaired run still needs a decided green.
 *
 * The step owns no child-spawning code and no judgement code — both live outside `src/lean/`, and this file
 * reads the run's record, calls the round, and turns its verdict into the kinds the table routes.
 */
import { traceWarn } from "../trace.ts";
import { runRepairRound, type RepairRoundDeps } from "../oracle-repair-dispatch.ts";
import { blockedEvidenceLines, headEvidenceFromStep } from "../oracle-repair-evidence.ts";
import { frozenFromLog } from "../lean-log.ts";
import { buildWriteFence } from "./build-dispatch.ts";
import type { WorkConfig } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { SpecifyInfraError } from "./specify-reset.ts";
import { specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import { type Outcome, type Step, newestDecided } from "./state.ts";
import { rereadSpec } from "./spec-for.ts";
import type { DispatchUsageRow } from "./step-budget.ts";
import { joinNotes } from "./text-fence.ts";

/** What the step needs from the outside world; `command.ts` wires the production values. */
export interface RepairDeps extends Omit<RepairRoundDeps, "baseTree" | "ensureTree"> {
  /** A throwaway detached checkout of the run's base, created for this step and removed after it. */
  withBaseTree: <T>(fn: (tree: string) => Promise<T>) => Promise<T>;
  /** The specify step's tree primitive, injected so a test sees the reset the seat is judged in. */
  ensureTree: RepairRoundDeps["ensureTree"];
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
}

/** The `repair` step. A refusal is a `refused` kind, routed by the table — never a throw. */
export async function repairOutcome(
  ctx: HandlerCtx,
  deps: RepairDeps,
  headless: boolean,
): Promise<Outcome> {
  const { repoRoot, issue } = ctx;
  const blocked = blockedStep(ctx.steps);
  if (blocked === undefined)
    // The table only sends a run here from a honoured blocked verdict, so this is a record that cannot
    // account for itself. Infrastructure, naming the fact that is missing.
    throw new SpecifyInfraError("no proven blocked report behind this repair round");
  const named = Object.keys(blocked.outcome?.blockedBy ?? {});
  if (named.length === 0) throw new SpecifyInfraError("the blocked report named no file to repair");

  const base = ctx.run.baseSha;
  const config = await deps.loadConfig(repoRoot, base).catch((err: unknown) => {
    throw new SpecifyInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  // The seat writes tests against a contract, so it reads the same one `specify` wrote: the block's
  // `pi-spec v1`, or the derived contract the run holds. Never a paraphrase of the builder's brief.
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
      headless,
      childOpts: repairChildOpts,
      repoRoot,
      issue,
      baseSha: base,
      headBefore: blocked.outcome?.headBefore ?? base,
      wt,
      branch: specifyBranch(ctx.run.branch, issue),
      frozen: frozenFromLog(ctx.steps),
      named,
      claims: blockedEvidenceLines(ctx.steps),
      evidence: headEvidenceFromStep(blocked),
      scratch: buildWriteFence(wt, repoRoot, issue).scratch,
    });
    if (result.kind === "refused") return refusedVerdict(result, blocked);
    return {
      kind: "repaired",
      reason: repairedSentence(result),
      // The step's `frozen` is the run's WHOLE map with the replaced paths re-hashed: `frozenFromLog` unions
      // every freeze in order, so a later step's map wins and the corrected oracle is the contract from here
      // on. `verify` reads the same union and holds the replacement to the same standard.
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

/** The one statement of the arms this step's seat carries, shared with the harness's assertions. */
function repairChildOpts(headless: boolean): { workCycleTrust: boolean } {
  return { workCycleTrust: headless };
}

/** The newest decided `build` step whose blocked report the driver honoured. */
function blockedStep(steps: Step[]): Step | undefined {
  const b = newestDecided(steps, "build");
  return b?.outcome?.kind === "blocked" ? b : undefined;
}

/** Rows only when the step paid for a child: `[]` would say "zero children" for a step that never
 *  dispatched, which is what an absent key means. */
function rowsKey(rows: DispatchUsageRow[]): { dispatches?: DispatchUsageRow[] } {
  return rows.length === 0 ? {} : { dispatches: rows };
}

/** The verdict a refused round leaves: the builder goes again against the same contract, and the reason says
 *  both what the round settled and what it was called to settle. */
function refusedVerdict(
  r: { why: string; rows: DispatchUsageRow[] },
  blocked: Step,
): Outcome {
  return {
    kind: "refused",
    reason: joinNotes([
      `the repair round was refused: ${r.why}`,
      // Kept visible because the handback two steps later reads this step's reason, and a reader must see
      // which oracle the run argued about.
      blocked.outcome?.reason ?? "",
    ]),
    ...rowsKey(r.rows),
  };
}

/** What the run now holds, in the record's own words: the files, and whether each passes where the code stands. */
function repairedSentence(r: {
  paths: string[];
  passedAtHead: Record<string, boolean>;
}): string {
  const list = r.paths
    .slice(0, 8)
    .map((p) => `${p} (${r.passedAtHead[p] === true ? "passes at head" : "does NOT pass at head"})`)
    .join(", ");
  traceWarn(`lean repair: ${list}`);
  return `repaired ${String(r.paths.length)} frozen test file(s): ${list}`;
}
