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

import fs from "node:fs/promises";
import { trace, traceWarn } from "./trace.ts";
import { foldPortPlan, mergeWithContract } from "./work-driver-plan-contract.ts";
import { mergeCoupledWorkstreams } from "./work-driver-plan-coupling.ts";
import {
  unfenceDocsTestPaths,
  unfenceDocsTestsEnabled,
} from "./work-driver-plan-unfence-docs-tests.ts";
import {
  type UnfenceRecord,
  type UnfenceResult,
  unfenceIssueNamedPaths,
  unfenceSummary,
} from "./work-driver-plan-unfence.ts";
import { execp } from "./work-driver-verify.ts";
import type { PlanUnfenceSummary, Workstream } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";

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
): Promise<{ workstreams: Record<string, Workstream>; selfFenceDrops: UnfenceRecord[] }> {
  const ported = foldPortPlan(raw, opts.port);
  const ws = ported.workstreams;
  if (Object.keys(ws).length <= 1)
    return { workstreams: ws, selfFenceDrops: ported.selfFenceDrops };
  const planExecFn = opts.execFn ?? execp;
  const coupling = await mergeWithContract(ws, (w) =>
    mergeCoupledWorkstreams(w, planExecFn, opts.worktrees, opts.repoRoot),
  );
  if (coupling.changed) {
    for (const m of coupling.merges) {
      trace(`work-driver: plan coupling merge — ${m.from} → ${m.into} (${m.reason})`);
    }
    return {
      workstreams: coupling.workstreams,
      selfFenceDrops: [...ported.selfFenceDrops, ...(coupling.selfFenceDrops ?? [])],
    };
  }
  return { workstreams: ws, selfFenceDrops: ported.selfFenceDrops };
}

/**
 * #1167 round-4 — the plan step's normalisation, in the ONE order that is
 * correct: fold → coupling merge → unfence.
 *
 * The three plan paths (the primary plan, the #290 quality corrective and the
 * #754 kill-recovered corrective) each need both passes over the map they end
 * up keeping, and each used to compose them by hand. That is how the unfence
 * came to be missing from the kill-recovered path — the quality tail had it
 * (round-3) and `runPlan`'s kill branch did not, so a plan recovered after a
 * killed primary reached develop with fences the primary plan would have had
 * removed, and the develop gate parked on a file the issue itself names. One
 * helper, one order, three callers.
 *
 * The order is load-bearing (see `runPlanUnfencePass`): the fold and the merge
 * both UNION fence lists, so an unfence that ran before them can have its work
 * reintroduced.
 */
export async function runPlanNormalisationPass(
  raw: Record<string, Workstream>,
  state: WorkState,
  opts: {
    port?: string;
    repoRoot: string;
    worktrees?: Record<string, string>;
    execFn?: GrepExecFn;
  },
): Promise<{
  workstreams: Record<string, Workstream>;
  summary?: PlanUnfenceSummary;
  selfFenceDrops: UnfenceRecord[];
}> {
  const merged = await runPlanCouplingPass(raw, {
    port: opts.port,
    repoRoot: opts.repoRoot,
    worktrees: opts.worktrees,
    execFn: opts.execFn,
  });
  const unfenced = await runPlanUnfencePass(merged.workstreams, state, {
    repoRoot: opts.repoRoot,
    execFn: opts.execFn,
  });
  // #1862 — the fold's self-fence removals are counted APART from the issue-
  // named pass (they answer to the merge, not to the issue), but they ride in
  // the SAME record so the operator sees one `planQuality.unfence` per plan
  // step. `unfenceSummary` does not count them (their note begins with none of
  // the prefixes it keys on); they reach the persisted `notes` list.
  const foldNotes = merged.selfFenceDrops.map((r) => r.note);
  const summary = unfenced.summary
    ? {
        ...unfenced.summary,
        ...(foldNotes.length > 0
          ? {
              notes: [...(unfenced.summary.notes ?? []), ...foldNotes].slice(0, 10),
              selfFences: merged.selfFenceDrops.length,
            }
          : {}),
      }
    : merged.selfFenceDrops.length > 0
      ? {
          ran: true as const,
          removed: 0,
          kept: 0,
          rolledBack: 0,
          unresolved: 0,
          selfFences: merged.selfFenceDrops.length,
          notes: foldNotes.slice(0, 10),
        }
      : undefined;
  return { workstreams: unfenced.workstreams, summary, selfFenceDrops: merged.selfFenceDrops };
}

/**
 * #1167 round-3 — the escape hatch, beside `PI_ENSEMBLE_PLAN_QUALITY` and read
 * the same way (`0`/`false` disables). `0` leaves the planner's fences exactly
 * as written — the pre-#1167 behaviour, develop gate included — and says so in
 * the trace, so an operator who turns the pass off can tell from the state
 * file that it was OFF rather than that it ran and found nothing.
 */
export function planUnfenceEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_PLAN_UNFENCE;
  return v !== "0" && v !== "false";
}

/**
 * #1167 — the plan-time unfence pass, in the same position in the step as the
 * coupling pass above and for the same reason: both rewrite `outOfScope`, and
 * the order between them is load-bearing. This one runs SECOND because the
 * fold and the merge union fence lists (`foldTwo` drops the merged half's
 * paths from the fence, and the ceiling fold unions them) — an unfence that
 * ran before them can have its work reintroduced.
 *
 * It reads the issue body the explore step cached. A missing or unreadable
 * artifact is an EMPTY body: no decision sections, so nothing is extracted and
 * nothing is unfenced. A lost cache file must never widen a scope — but it is
 * NOT the same fact as "the issue named no path", so it is traced as a warning
 * and carried on the returned summary for the operator (#1167 round-3).
 *
 * `defaultToSingle` is the N=1 shape (the sole workstream owns the whole
 * issue, so a path the issue names belongs to it even with no shared
 * directory). With N>1 placement needs a real shared prefix — a path sharing
 * no directory with any workstream is left fenced rather than handed to an
 * arbitrary developer, which is how a removed fence becomes a scope fanout.
 */
export async function runPlanUnfencePass(
  workstreams: Record<string, Workstream>,
  state: WorkState,
  opts: { repoRoot: string; execFn?: GrepExecFn },
): Promise<{ workstreams: Record<string, Workstream>; summary?: PlanUnfenceSummary }> {
  if (!planUnfenceEnabled()) {
    trace("work-driver: plan unfence disabled by PI_ENSEMBLE_PLAN_UNFENCE=0 — plan left untouched");
    return { workstreams };
  }
  const read = await readIssueBody(state);
  // #1250 change 1 — the N=1 docs/test rule, decided HERE rather than inside
  // the pass, because this is where N is already computed (`defaultToSingle`),
  // where the issue body has just been read, and where the escape hatch for the
  // pass is read. Two workstreams means the fence is the #572 cross-declaration
  // contract and stays exactly as written.
  //
  // An UNREADABLE body switches the rule off entirely, and this is the reason:
  // the rule's one hard precondition is that the issue must not forbid the
  // path, and it judges that from the body's prose. A lost cache file leaves it
  // unable to honour a prohibition it cannot read, so opening fences on an empty
  // body would be a scope widening manufactured by a memory problem — the exact
  // class of failure `readIssueBody` exists to refuse. The issue-named half of
  // the pass still runs (an empty body extracts nothing, so it removes nothing),
  // and the trace below says which rule did not run and why.
  //
  // A MISSING artifact is treated exactly like an unreadable one for THIS rule
  // (#1250 round 4). `readIssueBody` reports it as `{ body: "", unreadable:
  // false }` — honestly, because a cycle that cached no body never had a cache
  // file to lose — and that `false` is what the issue-named half wants: an empty
  // body extracts nothing, so it removes nothing, and the operator must not be
  // told a file went missing when none did. But it is the SAME epistemic state
  // for this rule — an absent artifact means the issue's refusals cannot be read
  // either — so the precondition fails closed here too, with the same trace.
  // `unfenceSummary` below still reports `issueBodyUnreadable` only for a real
  // read failure, so the two facts stay apart for the operator.
  const single = Object.keys(workstreams).length === 1;
  const docsTestsBlocked = read.unreadable || !state.pipelineState.issueBodyArtifact;
  const docsTestsOn = single && !docsTestsBlocked && unfenceDocsTestsEnabled();
  const result: UnfenceResult = await unfenceIssueNamedPaths(workstreams, read.body, {
    execFn: opts.execFn ?? execp,
    repoRoot: opts.repoRoot,
    ref: state.pipelineState.baseSha ?? "HEAD",
    defaultToSingle: single,
  });
  // The docs/test rule runs on the map the issue-named pass returned, so a
  // fence that pass restored (the no-owner rollback) is still visible to it and
  // a fence it already removed is not double-counted.
  // #1250 change 1 round-2 — the rule's prohibition scan strips the issue's
  // code blocks (an example block quotes a path to show what the change must
  // NOT become; it is not a refusal) and matches the fence key on path-segment
  // boundaries, both inside the rule. It reads the WHOLE body rather than only
  // the extraction's three requirement sections, because a refusal lives
  // precisely in the sections extraction drops — see the module header of
  // work-driver-plan-unfence-docs-tests.ts.
  const opened: UnfenceResult = docsTestsOn
    ? unfenceDocsTestPaths(result.workstreams, read.body)
    : { workstreams: result.workstreams, notes: [], warnings: [], placed: [], removed: [] };
  if (single && !docsTestsOn) {
    // Three reasons a single-workstream plan keeps its docs/test fences are
    // different facts an operator needs apart: an operator who turned the knob
    // off wants to see that it was OFF, and one whose explore cache went missing
    // — or was never written — wants to see that the rule declined to run
    // without the issue. Read per call, like every other hatch in this file.
    trace(
      docsTestsBlocked
        ? "work-driver: plan unfence docs/test rule skipped — the issue body could not be read, so the rule cannot honour a prohibition it cannot read; docs and test fences left as written"
        : "work-driver: plan unfence docs/test rule disabled by PI_ENSEMBLE_UNFENCE_DOCS_TESTS=0 — docs and test fences left as written",
    );
  } else if (!single && unfenceDocsTestsEnabled()) {
    trace("work-driver: plan unfence docs/test rule skipped — not a single-workstream plan");
  }
  const merged: UnfenceResult = {
    workstreams: opened.workstreams,
    notes: [...result.notes, ...opened.notes],
    warnings: [...result.warnings, ...opened.warnings],
    placed: [...result.placed, ...opened.placed],
    removed: [...result.removed, ...opened.removed],
  };
  for (const note of [...merged.notes, ...merged.warnings]) trace(`work-driver: ${note}`);
  return {
    workstreams: merged.workstreams,
    summary: unfenceSummary(merged, read.unreadable),
  };
}

/**
 * #1167 — the issue body the unfence pass reads, from the artifact explore
 * cached. An unreadable or missing artifact is an EMPTY body: no sections,
 * so nothing is extracted and nothing is unfenced. A memory problem or a
 * lost cache file must never widen a scope.
 *
 * #1167 round-3 — "unreadable" and "empty" are reported apart. Before this
 * both looked identical to the operator (and to the pass): a lost cache file
 * read as "the issue named no fence", which is the wrong diagnosis for a
 * cycle whose fences all stayed. `unreadable` is true only when an artifact
 * WAS named and the read failed — a cycle with no cached artifact at all is
 * the honest empty case.
 */
async function readIssueBody(state: WorkState): Promise<{ body: string; unreadable: boolean }> {
  const artifact = state.pipelineState.issueBodyArtifact;
  if (!artifact) return { body: "", unreadable: false };
  try {
    return { body: await fs.readFile(artifact, "utf8"), unreadable: false };
  } catch (err) {
    traceWarn(
      `work-driver: plan unfence could not read issue body artifact — the pass runs on an empty body and fences NOTHING (this is not the same as the issue naming no path): ${(err as Error).message?.slice(0, 120)}`,
    );
    return { body: "", unreadable: true };
  }
}
