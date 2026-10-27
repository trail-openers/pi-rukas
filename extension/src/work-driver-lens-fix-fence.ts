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
 * The gate is built ONCE, before the dispatch. `lensFixFenceLines` renders it
 * into both lens-fix prompts and `lensFixPassPlan` carries the same object to
 * the gate at the adversarial step; `test-lens-fix-prompt-fence.ts` pins that
 * the prompt prints the fence the gate reads. The permitted asymmetry is the
 * fix pass's own: the gate fills `passChanged` / `helperDirs` / `admittingSlots`
 * in through `gateFenceView`, which the prompt never sees.
 */

import { resolve } from "node:path";
import {
  type FixExec,
  type GitRead,
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
import { fanoutLimitFor } from "./work-driver-scope-fanout.ts";
import { specPatternSlots } from "./work-driver-spec-slot-admission.ts";
import type { PipelineState } from "./workflow-state-schema.ts";

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
 * The workstream id whose recorded worktree IS the lens tree (#1852-8):
 * `default` when the cycle records one, else the first recorded tree that names
 * the same directory. The revert's recorded-tree gate is keyed on this id, so a
 * lens round whose tree is recorded under an id nobody reads has no id to build
 * a fence with, and `undefined` says so rather than inventing one.
 */
export function lensFixWorkstreamId(
  worktrees: Record<string, string> | undefined,
  tree: string,
): string | undefined {
  const entries = Object.entries(worktrees ?? {});
  if (entries.some(([id, p]) => id === "default" && resolve(p) === resolve(tree))) return "default";
  return entries.find(([, p]) => resolve(p) === resolve(tree))?.[0];
}

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
 */
export async function lensFixPassPlan(
  execFn: FixExec,
  repoRoot: string,
  ps: PipelineState,
  input: LensFixFenceInput,
): Promise<GitRead<LensFixPassPlan>> {
  const tracked = await trackedPaths(execFn, repoRoot, ps.baseSha);
  if (!tracked.ok) return tracked;
  const cycle = await committedChanges(execFn, input.worktree, ps.baseSha ?? "", input.roundTip);
  if (!cycle.ok) return cycle;
  const before = await treeChanges(execFn, input.worktree, ps.baseSha ?? "");
  if (!before.ok) return before;
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

/** The spec-pattern slots the lens-fix fence admits new files from. */
export function lensFixSpecSlots(ps: PipelineState) {
  return specPatternSlots(ps.normalisedSpec);
}
