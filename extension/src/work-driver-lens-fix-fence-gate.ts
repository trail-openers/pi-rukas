/**
 * work-driver-lens-fix-fence-gate — #1852: the scope fence the lens-fix step
 * never had, run ONCE per lens-fix round at the adversarial step BEFORE any
 * landing arm can push.
 *
 * Until now the lens-fix step was the only place in the cycle where a developer
 * wrote code with no scope fence on it: `inlineLensFixPrompt` printed no declared
 * paths and no `outOfScope` list, the child write fence covered the whole tree
 * (so anything inside it was permitted), and `integrateLensFix`,
 * `handleNoCommittedFix`/`landCommittedFix` and `commitLensFixChanges` each
 * commit and push whatever they found. The adversarial fix pass got its fence in
 * #1846; a lens round's delta is the same shape of work and had none. On one
 * field cycle that cost ~287M tokens of lens-fix work that the next round
 * rejected for widening past the issue's fence.
 *
 * THE ONE CHOKE POINT. Every lens-fix push in the driver is reached from
 * `runAdversarial` on the approval whose `lastCompletedStep` is `lens-fix`
 * (work-driver-adversarial.ts) — the worktree arm, the repoRoot arm, the
 * no-committed-fix re-land, and the bound-kill conversion (which routes through
 * the same step). So the gate runs there, once, before the arms are chosen, and
 * no arm needs to know it exists.
 *
 * WHAT IT READS. The delta is the lens round's own: `committedChanges(roundTip,
 * head)` PLUS the tree's uncommitted and untracked changes — both reads, because
 * a file the fixer created and never staged appears only in the untracked list
 * (the exact defect `postPassFault` records for the fix pass). `roundTip` is the
 * plan-time value the prompt's fence was built from, not a fresh read: the fence
 * and the delta must be measured from one tip.
 *
 * THE LADDER IS THE FIX PASS'S. Every file goes through `admitFixPassEntry` with
 * the same `FixPassFileGate` the fix pass builds (absolute refusals, declared set,
 * spec slot, coupled test, anchored helper) and the same pass-level ceiling —
 * `postPassFault` itself is what runs, on a plan whose `headBefore` is the round
 * tip. An absolute refusal (outOfScope / protected) is never revertible and
 * never pushed. Revertible strays are reverted once per round through
 * `revertStraysOnce`, whose counter for this caller counts
 * `fix-pass-strays-reverted` events whose `source` is `"lens-fix"`, in this
 * round, for this workstream (PM decision #1852-5).
 *
 * THE REPO-ROOT ARM IS STRICTER, because there is nothing to revert into: when
 * the lens tree IS the repo root, ANY stray parks (PM decision #1852-1) and the
 * reason says the revert was unavailable because the tree is the repo root.
 */

import { trace } from "./trace.ts";
import {
  type FixExec,
  type GitRead,
  committedChanges,
  headOf,
  treeChanges,
} from "./work-driver-adversarial-fix-git.ts";
import {
  type PassPlan,
  type PostPass,
  postPassFault,
} from "./work-driver-adversarial-fix-scope.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { fenceMatches } from "./work-driver-declared-path.ts";
import { anchorDirs } from "./work-driver-declared-path.ts";
import { specPatternSlots } from "./work-driver-spec-slot-admission.ts";
import type { FixPassStraysRevertedEvent } from "./workflow-state-events-fix-pass-strays.ts";
import type { LensFixFenceSnapshot } from "./workflow-state-schema.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** What the caller's revert hook returns; `undefined` = a revert is not possible. */
export type LensFixRevertOutcome =
  | { ok: true; event: FixPassStraysRevertedEvent }
  | { ok: false; reason: string };

/** What the gate decided. `notes` is what the operator must see. */
export type LensFixFenceVerdict =
  | { ok: true; notes: string[]; revert?: FixPassStraysRevertedEvent }
  | {
      ok: false;
      reason: string;
      notes: string[];
      /** The revert this round performed before the second refusal. */
      revert?: FixPassStraysRevertedEvent;
    };

export interface LensFixFenceGateOpts {
  execFn: FixExec;
  ctx: CycleContext;
  state: WorkState;
  /** The plan-time fence the fixer's prompt printed. Absent = never built. */
  snapshot: LensFixFenceSnapshot | undefined;
  /** True when the lens tree is a `.worktrees/` tree rather than the repo root. */
  inWorktree: boolean;
  /** The tree the delta is read from (the lens tree). */
  tree: string;
  /** The current lens review round. */
  round: number;
  /** The counter's answer: has this round already reverted once? */
  revertAlreadyUsed: boolean;
  /**
   * Perform the one revert this round may have. The caller wires this to
   * `revertStraysOnce` so the destructive path keeps its single owner; `undefined`
   * means a revert is not available (the kill-switch is off, or the caller is a
   * read-only probe) and the strays then park on their refusal.
   */
  onRevertible?: (post: PostPass, plan: PassPlan) => Promise<LensFixRevertOutcome | undefined>;
}

/**
 * Has this lens-fix round already spent its one revert? Counted across the WHOLE
 * event log, filtered on source + round + workstream (PM decision #1852-5). The
 * lens fix has no `adversarial-fix-requested` event to window on, so reusing the
 * fix pass's window would silently degenerate to the whole log and charge a fix
 * pass's revert against a lens round that had reverted nothing.
 */
export function lensFixRevertAlreadyUsed(
  events: readonly WorkEvent[],
  round: number,
  workstreamId: string,
): boolean {
  return events.some(
    (e) =>
      e.kind === "fix-pass-strays-reverted" &&
      e.source === "lens-fix" &&
      e.round === round &&
      e.workstreamId === workstreamId,
  );
}

/**
 * The persisted plan-time fence re-materialised as the `PassPlan` shape
 * `postPassFault` consumes.
 *
 * `headBefore` is the ROUND TIP — the whole point of the lens-fix fence: the
 * round's own earlier commits are not strays, so the delta is measured from the
 * tip the fixer started at. `candidates` / `dirs` are the same provenance and
 * anchor sets the fix pass hands its widening and its corrective route, kept on
 * the plan so one reading of "what this cycle owns" answers both.
 */
export function lensFixPlanFromSnapshot(
  snap: LensFixFenceSnapshot,
  tree: string,
  ps: { baseSha?: string; normalisedSpec?: unknown },
): PassPlan {
  const anchors = [...new Set([...snap.fence.declared, ...snap.candidates])];
  return {
    id: snap.workstreamId,
    worktree: tree,
    findings: snap.findings,
    headBefore: snap.roundTip,
    before: { names: snap.candidates, diff: "", untracked: [] },
    declared: snap.declared,
    named: snap.named,
    widened: snap.declared.length > 0 ? snap.named.filter((x) => !snap.declared.includes(x)) : [],
    outOfScope: snap.fence.outOfScope,
    specSlots: specPatternSlots(ps.normalisedSpec as never),
    candidates: new Set(snap.candidates),
    dirs: anchorDirs(anchors),
    fence: { ...snap.fence, helperDirs: new Set(snap.fence.helperDirs) },
  };
}

/**
 * Run the lens-fix fence once, before any landing arm. Every refusal leaves the
 * tree alone (the revert is the only write, and it is `revertStraysOnce`'s).
 */
export async function lensFixFenceCheck(opts: LensFixFenceGateOpts): Promise<LensFixFenceVerdict> {
  const snap = opts.snapshot;
  if (snap === undefined) {
    // No fence was built, so nothing bounded the fixer. Landing unchecked is the
    // failure this closes: an absent fence parks rather than skipping the check.
    return {
      ok: false,
      notes: [],
      reason:
        "the lens-fix fence was never built (its pre-dispatch git reads failed, or no workstream records the lens tree), so the round cannot be cleared — nothing was pushed",
    };
  }
  if (snap.round !== opts.round) {
    return {
      ok: false,
      notes: [],
      reason: `the recorded lens-fix fence belongs to round ${snap.round}, not the round being gated (${opts.round}) — the gate refuses to judge this delta against a fence built for another round`,
    };
  }
  const plan = lensFixPlanFromSnapshot(snap, opts.tree, opts.state.pipelineState);
  // Both reads, both required (the fix pass's own lesson, recorded in
  // `postPassFault`): a file the fixer created and never staged is in git's
  // untracked list and in NO commit range.
  const head = await headOf(opts.execFn, opts.tree);
  if (!head.ok) return fail(`the lens tree's HEAD could not be read: ${head.reason}`);
  const range = await committedChanges(opts.execFn, opts.tree, snap.roundTip, head.value);
  if (!range.ok) return fail(`the round's commit range could not be read: ${range.reason}`);
  const delta = await treeChanges(opts.execFn, opts.tree, snap.roundTip);
  if (!delta.ok) return fail(`the lens tree could not be read: ${delta.reason}`);
  const passFiles = [...new Set([...range.value, ...delta.value.names, ...delta.value.untracked])];
  if (passFiles.length === 0) return { ok: true, notes: [] };

  const post = await postPassFault(opts.execFn, [plan], snap.roundTip, [], { noOp: true });
  if (!post.reason) return { ok: true, notes: post.admissions };
  // The repo-root arm has no tree to revert INTO: `revertStraysOnce` refuses
  // anything outside `.worktrees/`, so the driver never reverts there and ANY
  // stray parks (PM decision #1852-1). Stated here rather than left to the
  // revert's own refusal so the reason says WHY nothing was attempted.
  if (!opts.inWorktree) {
    return fail(
      `${post.reason} — the revert was NOT attempted because the lens-fix tree is the repo root, where the driver never reverts; nothing was pushed`,
      post.admissions,
    );
  }
  const revertible =
    post.straysFor !== undefined &&
    post.strays !== undefined &&
    post.strays.every((s) => s.revertible);
  if (!revertible || opts.onRevertible === undefined || opts.revertAlreadyUsed) {
    return fail(
      opts.revertAlreadyUsed
        ? `${post.reason} — this round ALREADY had one out-of-fence set reverted by the driver (the \`fix-pass-strays-reverted\` record names the preserved ref and the patch), and a SECOND set in the same round means the fixer will not stay inside its fence; nothing was pushed`
        : post.reason,
      post.admissions,
    );
  }
  const reverted = await opts.onRevertible(post, plan);
  if (reverted === undefined) {
    return fail(
      `the driver could not revert ${post.strays?.map((s) => s.file).join(", ")}`,
      post.admissions,
    );
  }
  if (!reverted.ok) return fail(reverted.reason, post.admissions);
  // Re-read and re-judge: the fence decides what lands, not the intent to revert.
  const head2 = await headOf(opts.execFn, opts.tree);
  if (!head2.ok) return fail(`the lens tree's HEAD could not be re-read: ${head2.reason}`);
  const range2 = await committedChanges(opts.execFn, opts.tree, snap.roundTip, head2.value);
  if (!range2.ok) return fail(`the round's commit range could not be re-read: ${range2.reason}`);
  const delta2 = await treeChanges(opts.execFn, opts.tree, snap.roundTip);
  if (!delta2.ok) return fail(`the lens tree could not be re-read: ${delta2.reason}`);
  const again = await postPassFault(opts.execFn, [plan], snap.roundTip, [], { noOp: true });
  if (again.reason) {
    return {
      ok: false,
      reason: again.reason,
      notes: [...post.admissions, ...again.admissions],
      revert: reverted.event,
    };
  }
  return {
    ok: true,
    notes: [...post.admissions, ...again.admissions],
    revert: reverted.event,
  };
}

function fail(reason: string, notes: string[] = []): LensFixFenceVerdict {
  trace(`work-driver: lens-fix fence refused the round — ${reason.slice(0, 200)}`);
  return { ok: false, reason, notes };
}

/** The fix pass's ONE fence predicate, re-exported for the gate's own tests. */
export const fenceCovers = (entry: string, file: string): boolean => fenceMatches(entry, file);

/** `GitRead` is re-exported so a test can name the read shapes without a second import. */
export type { GitRead };
