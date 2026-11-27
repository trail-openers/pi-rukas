import { frozenFromLog } from "../lean-log.ts";
import { type RepairRoundDeps, runRepairRound } from "../oracle-repair-dispatch.ts";
import { blockedEvidenceLines, headEvidenceFromStep } from "../oracle-repair-evidence.ts";
/**
 * lean/repair — the step that buys ONE adversary round to correct a frozen oracle the driver proved wrong.
 *
 * A blocked report that survives the anti-forgery gate means the driver watched a frozen test come back red at
 * the builder's head. The release's answer was to hand back; this is the other answer, under
 * `PI_ENSEMBLE_LEAN_ORACLE_REPAIR`: the adversary that wrote the tests is paid once to correct the named file,
 * in a tree at the run's base, and judged before it may replace anything.
 *
 * Four facts, not the child's good sense, make it safe: billed before it is spent (the table moves
 * `repairsSpent` on the edge ENTERING this state, so a refused or crashed round cannot be re-bought); the seat
 * is blind (`oracle-repair-evidence.ts` builds its brief from the spec, the named paths, the driver's reasons
 * and the output the DRIVER watched; the tree is reset to `baseSha` before it is paid); its submission is
 * judged, not believed (`oracle-repair-judge.ts`); and the accepted bytes are frozen by the release's own
 * primitive, so `verify` holds the corrected oracle to the original's standard and `landEarned` is not widened.
 *
 * No child-spawning and no judgement code live here.
 */import { traceWarn } from "../trace.ts";
import { buildWriteFence } from "./build-dispatch.ts";
import type { WorkConfig } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { rereadSpec } from "./spec-for.ts";
import { SpecifyInfraError } from "./specify-reset.ts";
import { specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import { type Outcome, type Step, newestDecided } from "./state.ts";
import type { DispatchUsageRow } from "./step-budget.ts";
import { joinNotes } from "./text-fence.ts";

/** What the step needs from the outside world; `command.ts` wires the production values. */
export interface RepairDeps extends Omit<RepairRoundDeps, "baseTree" | "ensureTree"> {
  /** A throwaway detached checkout of the run's base, made for this step and removed after it. */
  withBaseTree: <T>(fn: (tree: string) => Promise<T>) => Promise<T>;
  /** The specify step's tree primitive — the reset the seat is judged in, and the freeze's tree. */
  ensureTree: RepairRoundDeps["ensureTree"];
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
}

/** The arms this step's seat carries. */
const repairChildOpts = (headless: boolean): { workCycleTrust: boolean } => ({
  workCycleTrust: headless,
});

/** The `repair` step. A refusal is a `refused` kind, routed by the table; only git it cannot account for throws. */
export async function repairOutcome(
  ctx: HandlerCtx,
  deps: RepairDeps,
  headless: boolean,
): Promise<Outcome> {
  const { repoRoot, issue } = ctx;
  const blocked = blockedStep(ctx.steps);
  if (blocked === undefined)
    // The table only sends a run here from a honoured blocked verdict, so this record cannot account for
    // itself: infrastructure, naming the missing fact.
    throw new SpecifyInfraError("no proven blocked report behind this repair round");
  const named = Object.keys(blocked.outcome?.blockedBy ?? {});
  if (named.length === 0) throw new SpecifyInfraError("the blocked report named no file to repair");

  const base = ctx.run.baseSha;
  const config = await deps.loadConfig(repoRoot, base).catch((err: unknown) => {
    throw new SpecifyInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  // The same contract `specify` wrote — never a paraphrase of the builder's brief.
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
      // The run's WHOLE map with the replaced paths re-hashed: `frozenFromLog` unions freezes in order, so
      // the corrected oracle is the contract from here on and `verify` reads the same union.
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

/** The newest decided `build` step whose blocked report the driver honoured. */
function blockedStep(steps: Step[]): Step | undefined {
  const b = newestDecided(steps, "build");
  return b?.outcome?.kind === "blocked" ? b : undefined;
}

/** Rows only when the step paid for a child: an absent key means "not a step that dispatches". */
function rowsKey(rows: DispatchUsageRow[]): { dispatches?: DispatchUsageRow[] } {
  return rows.length === 0 ? {} : { dispatches: rows };
}

/** The verdict a refused round leaves: the builder goes again against the same contract. */
function refusedVerdict(r: { why: string; rows: DispatchUsageRow[] }, blocked: Step): Outcome {
  return {
    kind: "refused",
    reason: joinNotes([
      `the repair round was refused: ${r.why}`,
      // Kept visible so the handback names which oracle the run argued about.
      blocked.outcome?.reason ?? "",
    ]),
    ...rowsKey(r.rows),
  };
}

/** What the run now holds: the files, and whether each passes where the builder's code stands. */
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
