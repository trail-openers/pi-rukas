/**
 * work-driver-lens-fix-fence — #1852: the fence the lens-fix step runs under,
 * built by the SAME builder the adversarial fix pass uses.
 *
 * Until now the lens-fix step had no fence at all. `inlineLensFixPrompt` printed
 * no declared paths and no `outOfScope` list, and `integrateLensFix` /
 * `commitLensFixChanges` / `landCommittedFix` committed and pushed whatever the
 * fixer wrote anywhere in the tree. On one field cycle that cost ~287M tokens of
 * lens-fix work that the next review round rejected for widening past the issue's
 * fence. The adversarial fix pass got its fence in #1846; this module gives the
 * lens fix the same one, from the same functions, so the two cannot disagree
 * about what "inside the fence" means.
 *
 * PM decision #1852-2 is the whole design: the lens-fix fence is built through
 * the fix pass's own fence builder with
 *
 *   - `headBefore` = the round tip (the lens tree's HEAD read before the fixer
 *     was dispatched) — the lens-fix delta is measured from the round tip, never
 *     from the cycle base, because a lens round's own earlier work is not a
 *     stray;
 *   - `findings` = the lens findings JSON, which is also what feeds `named`
 *     through the same `namedPaths` widening the fix pass applies;
 *   - `candidates` = files tracked at the cycle base ∪ files the cycle already
 *     committed (base..round tip) — the fix pass's own provenance reading;
 *   - `anchors` = declared ∪ cycle-changed, so the widening is anchored in work
 *     the cycle actually owns;
 *   - `helperDirs`, the fan-out ceiling and the spec-pattern slots are computed
 *     by `fixPassFence` / `specPatternSlots` exactly as for a fix pass, so the
 *     no-declared-paths shape behaves the same here as it does there.
 *
 * The gate is built ONCE, before the dispatch. `buildLensFixFence` is the ONE
 * call site of `lensFixPassPlan` the lens-fix step uses — `runLensFix` calls it
 * twice per round (pre-dispatch, and again after the #981 reposition gate has
 * moved the tree) and both arms therefore render and record the same way.
 * `lensFixFenceLines` renders the fence into both lens-fix prompts and
 * `lensFixPassPlan` carries the same object to the gate at the adversarial step;
 * `test-lens-fix-prompt-fence.ts` pins that the prompt prints the fence the gate
 * reads. The permitted asymmetry is the fix pass's own: the gate fills
 * `passChanged` / `helperDirs` / `admittingSlots` in through `gateFenceView`,
 * which the prompt never sees.
 */

import {
  type FixExec,
  committedChanges,
  trackedPaths,
  treeChanges,
} from "./work-driver-adversarial-fix-git.ts";
import { entryPath } from "./work-driver-declared-path.ts";
import {
  type FixPassFence,
  fixPassFence,
  fixPassFenceLines,
} from "./work-driver-fix-pass-admission.ts";
import { namedPaths } from "./work-driver-fix-pass-named.ts";
import { lensFixPlanRefusalRecords } from "./work-driver-lens-fix-fence-gate.ts";
import { fenceSnapshot, refusalReason } from "./work-driver-lens-fix-records.ts";
import { fanoutLimitFor } from "./work-driver-scope-fanout.ts";
import type { LensFixFenceSnapshot, PipelineState } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";

/** What one build of the lens-fix fence yields: the record the gate reads, the
 *  block the prompt prints, and whether the build FAILED in a way the gate must
 *  treat as a refusal (`record`, PM decision #1852 review 1a). */
export interface LensFixFenceBuild {
  /** The plan-time snapshot carried on `pipelineState.lensFixFence`, or
   *  undefined when no fence exists for this round. */
  snapshot: LensFixFenceSnapshot | undefined;
  /** The fence block the prompt prints, or undefined when there is none. */
  lines: string[] | undefined;
  /** Set when the build failed and the failure is a fence FAILURE rather than a
   *  statement about the state: the caller records it, because a prompt with no
   *  fence block must not be the quiet half of a fence the gate then enforces
   *  from a value nobody built. */
  record?: string;
}

/**
 * Build the lens-fix fence for one round tip (#1852) — the ONE place the step's
 * fence is planned, rendered and judged.
 *
 * ONE builder for the two places `runLensFix` needs a fence: before the prompt is
 * rendered, and again after the #981 reposition gate has MOVED the tree. The two
 * call sites used to spell the same plan call, the same render and the same
 * record-or-trace decision twice, and a rule that lives in two copies is a rule
 * that drifts — which arm records and which only traces is exactly the #1852
 * fail-closed decision, and it must not have two answers.
 *
 * The tree is built from the tip the caller passes; the tip is never read here,
 * because which tip the fence is measured from is the caller's decision
 * (pre-dispatch vs the verified tip) and one tip must appear in both the prompt
 * and the gate.
 */
export async function buildLensFixFence(
  execFn: FixExec,
  repoRoot: string,
  state: WorkState,
  fenceId: string | undefined,
  fixTree: string,
  roundTip: string,
  findings: string,
): Promise<LensFixFenceBuild> {
  // THREE shapes, and only two of them leave the round with no fence.
  //
  //   - no `pipelineState.worktrees` entry names the lens tree: `fixTree` is the
  //     tree the fixer is dispatched into (`lensWorktree` falls back to
  //     `ctx.repoRoot` when no tree is recorded at all), so nothing has claimed
  //     its strays, `revertStraysOnce` refuses it for want of a recorded tree,
  //     and the gate has no workstream to judge the delta against. RECORDED
  //     (#1852 round 3 item 1): with no snapshot and nothing on the log, the
  //     gate's "no fence record, skip" branch was the answer — the pre-#1852 hole
  //     reached not by a broken git read but by the ordinary shape of the state.
  //   - a lens tree that IS the repo root AND names no workstream: same hole, and
  //     the driver never reverts there (PM decision #1852-1), so a stray parks
  //     with nothing reverted — but a park still has to be REACHED, which needs a
  //     record for the gate to run on at all.
  //
  //   - a lens tree that IS the repo root but IS a recorded workstream's tree:
  //     NOT a refusal. This is the N=1 cycle whose workstream works in the checkout,
  //     and `fixPassFence` bounds it completely — `declared`, `named`, `candidates`
  //     and the round tip are all readable there. Recording it would park every
  //     N=1 repo-root lens round on `lens-fix-scope` with an in-fence fix in hand,
  //     which is a worse outcome than the hole it closes. #1852-1's rule is about
  //     REVERTS at the repo root, not about judging one: the fence is built, the
  //     gate runs, and a stray in a repo-root tree with a fence still parks on it.
  //
  // A missing base SHA stays UNRECORDED: that really is a state which never had a
  // fence to require, and recording it would make #1852 a schema break.
  if (fenceId === undefined) {
    return {
      snapshot: undefined,
      lines: undefined,
      record: refusalReason({ kind: "unrecorded-tree" }),
    };
  }
  const planned: LensFixPlanned = await lensFixPassPlan(execFn, repoRoot, state.pipelineState, {
    id: fenceId,
    worktree: fixTree,
    roundTip,
    findings,
  });
  if (planned.ok) {
    return {
      snapshot: fenceSnapshot(state, planned.value, fixTree),
      lines: lensFixFenceLines(planned.value),
    };
  }
  // Fail closed on the reads that MEAN a fence existed, and say so in a way that
  // survives the step: a trace alone cannot tell the gate "this round never had a
  // fence" from "the fence was lost", because a trace is not in the state file
  // after a resume.
  //
  // But the planner's pre-git refusal — "the state records no base SHA" — is not
  // that. A state written by an older driver, or one that never set the field, is
  // in the same shape and had no fence to require. Recording it would turn "no
  // fence" into a recorded fence failure and park every such cycle, which makes
  // #1852 a schema break rather than a fence. So it is traced, not recorded, and
  // the gate — which reads records — does not run. The decision is made on the
  // planner's TYPED discriminant, never on its wording (#1852 review 1b).
  const reason = refusalReason(planned.refusal);
  return lensFixPlanRefusalRecords(planned.refusal)
    ? { snapshot: undefined, lines: undefined, record: reason }
    : { snapshot: undefined, lines: undefined };
}

/** The workstream id of the lens-fix round (PM decision #1852-8). */
export interface LensFixFenceInput {
  /** The workstream whose `worktrees` entry IS the lens tree. */
  id: string;
  /** The lens-fix tree the fixer works in — the tree the delta is read from. */
  worktree: string;
  /** The lens tree's HEAD read BEFORE the fixer was dispatched (40-hex). */
  roundTip: string;
  /** The lens findings JSON — the text the fixer's prompt carries verbatim. */
  findings: string;
}

/**
 * Why the planner could not build a fence (#1852 review item 1b).
 *
 * The gate has to tell the refusals apart, and it must not do it by comparing
 * prose: `runLensFix` records some of these as a fence FAILURE (and the gate
 * parks on them) while others only say the STATE cannot support a fence — a
 * state file written before the field existed, or by an older driver. Both
 * arrived as the same string (`"no valid base SHA is recorded"`), and a worded
 * match silently becomes a no-match whenever the sentence is reworded: the
 * recorded-failure branch goes quiet and the round lands unchecked, which is
 * the hole #1852 exists to close. A discriminant is not rewordable.
 *
 * `lensFixPlanRefusalRecords` is the single answer to "does this record?", so
 * the split lives in one function rather than in each caller's memory.
 */
export type LensFixPlanRefusal =
  /** The state records no usable base SHA: there is no fence to require. */
  | { kind: "no-base" }
  /** The lens tree is named by no `pipelineState.worktrees` entry (#1852 round
   *  3): `revertStraysOnce` has no recorded tree to revert into and the gate has
   *  no workstream to judge the delta against, so the round cannot be cleared. */
  | { kind: "unrecorded-tree" }
  /** Every other refusal (an unreadable tree, base or round tip): a fence
   *  should exist and does not, so the round fails closed. */
  | { kind: "unavailable"; reason: string };

/** The planner's result: a fence, or a TYPED refusal (never a bare reason). */
export type LensFixPlanned =
  | { ok: true; value: LensFixPassPlan }
  | ({ ok: false; reason: string } & { refusal: LensFixPlanRefusal });

/** What the gate reads and the prompt renders: the fence, plus its basis. */
export interface LensFixPassPlan {
  id: string;
  worktree: string;
  findings: string;
  /** The round tip — the SAME value the gate measures the delta from. */
  headBefore: string;
  /** Declared paths of the fence workstream, normalised through `entryPath`. */
  declared: string[];
  /** The finding-named widening (provenance-checked by `namedPaths`). */
  named: string[];
  /** Files the cycle already committed (base..round tip). */
  cycleChanged: string[];
  /** Route (a)'s candidate set: tracked at base ∪ cycle-changed. */
  candidates: ReadonlySet<string>;
  /** The ONE fence value: the prompt renders it and the gate reads it. */
  fence: FixPassFence;
}

/**
 * Build the lens-fix fence. Every read fails closed: an unreadable tree, base or
 * round tip is a named reason, never an empty fence — a fence built from a read
 * that failed would refuse nothing and tell the fixer it was bounded.
 *
 * The refusal is TYPED (`LensFixPlanRefusal`), not a sentence: the caller
 * records `unavailable` as a fence failure and stays silent on `no-base`, and
 * the distinction decides whether a round lands unchecked.
 */
export async function lensFixPassPlan(
  execFn: FixExec,
  repoRoot: string,
  ps: PipelineState,
  input: LensFixFenceInput,
): Promise<LensFixPlanned> {
  // The ONE pre-git refusal, classified BEFORE the reads: `trackedPaths`
  // reports it in prose, and prose is what the caller must not switch on.
  if (!ps.baseSha) {
    return {
      ok: false,
      reason: "no valid base SHA is recorded",
      refusal: { kind: "no-base" },
    };
  }
  const tracked = await trackedPaths(execFn, repoRoot, ps.baseSha);
  if (!tracked.ok)
    return {
      ok: false,
      reason: tracked.reason,
      refusal: { kind: "unavailable", reason: tracked.reason },
    };
  const cycle = await committedChanges(execFn, input.worktree, ps.baseSha, input.roundTip);
  if (!cycle.ok)
    return {
      ok: false,
      reason: cycle.reason,
      refusal: { kind: "unavailable", reason: cycle.reason },
    };
  const before = await treeChanges(execFn, input.worktree, ps.baseSha);
  if (!before.ok)
    return {
      ok: false,
      reason: before.reason,
      refusal: { kind: "unavailable", reason: before.reason },
    };
  const ws = ps.workstreams?.[input.id];
  const declared = (ws?.paths ?? []).map(entryPath);
  // #1852-2 — one reading of "what this cycle owns", shared by the widening and
  // by the helper route's anchors, exactly as `planFixPass` keeps one for the
  // fix pass. Two readings of that phrase is how one fence gets two answers.
  const candidates = [...new Set([...tracked.value, ...cycle.value])];
  const anchors = [...new Set([...declared, ...before.value.names, ...cycle.value])];
  const named = namedPaths(input.findings, candidates, anchors);
  return {
    ok: true,
    value: {
      id: input.id,
      worktree: input.worktree,
      findings: input.findings,
      headBefore: input.roundTip,
      declared,
      named,
      cycleChanged: cycle.value,
      candidates: new Set(candidates),
      // The plan-time view: `passChanged` / `helperDirs` / the admitting-slot
      // term belong to the gate and are filled by `gateFenceView` after the
      // fixer has run (see work-driver-fix-pass-admission.ts).
      fence: fixPassFence(
        {
          id: input.id,
          declared,
          named,
          alreadyChanged: before.value.names,
          outOfScope: ws?.outOfScope ?? [],
          admittingSlots: 0,
        },
        fanoutLimitFor,
      ),
    },
  };
}

/**
 * The fence block the lens-fix prompt prints: `fixPassFenceLines` of the ONE
 * plan-time fence value, rendered with the LENS-fix nouns so the fixer is told
 * the cap its own strays park under (`lens-fix-scope`), not the fix pass's.
 */
export function lensFixFenceLines(plan: LensFixPassPlan): string[] {
  return fixPassFenceLines(plan.fence, "this lens fix", "lens-fix-scope");
}
