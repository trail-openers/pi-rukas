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

import path from "node:path";
import { trace } from "./trace.ts";
import {
  type FixExec,
  committedChanges,
  headOf,
  isAncestor,
  treeChanges,
} from "./work-driver-adversarial-fix-git.ts";
import {
  type PassPlan,
  type PostPass,
  postPassFault,
} from "./work-driver-adversarial-fix-scope.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { anchorDirs } from "./work-driver-declared-path.ts";
import type { LensFixPlanRefusal } from "./work-driver-lens-fix-fence.ts";
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
  /**
   * Perform the one revert this round may have. The caller wires this to
   * `revertStraysOnce` so the destructive path keeps its single owner; `undefined`
   * means a revert is not available (the kill-switch is off, or the caller is a
   * read-only probe) and the strays then park on their refusal.
   */
  onRevertible?: (post: PostPass, plan: PassPlan) => Promise<LensFixRevertOutcome | undefined>;
}

/**
 * The workstream this lens-fix round belongs to — the key the revert record, its
 * one-revert allowance and this gate all read.
 *
 * The snapshot's own id wins (it is what the fence was built for); otherwise the
 * workstream whose RECORDED tree is this lens tree, by resolved path. A round
 * with no attributable workstream gets `undefined`, which is the token the step
 * records as its no-workstream refusal (`LENS_FIX_NO_WORKSTREAM`).
 */
export function lensFixWorkstreamId(
  snapshot: LensFixFenceSnapshot | undefined,
  ps: { workstreams?: Record<string, unknown>; worktrees?: Record<string, string> },
  tree: string,
): string | undefined {
  if (snapshot?.workstreamId !== undefined) return snapshot.workstreamId;
  return Object.keys(ps.workstreams ?? {}).find((id) => {
    const recorded = ps.worktrees?.[id];
    return recorded !== undefined && path.resolve(recorded) === path.resolve(tree);
  });
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
 * The lens-fix step's TYPED reason for not having a workstream to build a fence
 * with (#1852 review item 1b). `runLensFix` cannot build a fence when no
 * `pipelineState.worktrees` entry names the lens tree, and that — like a missing
 * base SHA — is a statement about the STATE, not a failed read: an older driver
 * or a pre-#1852 fixture is in the same shape and had no fence to require. The
 * planner spells the same thing as `LensFixPlanRefusal`'s `no-workstream` kind;
 * this is the token `runLensFix`'s own no-workstream branch records, so the
 * state file and this module name it the same way.
 */
export const LENS_FIX_NO_WORKSTREAM = "no-workstream";

/**
 * Does a planner refusal need recording as a fence failure? A refusal whose
 * `kind` is a property of the STATE (`no-base`, `no-workstream`) does not: there
 * was no fence to require, so standing down is right and recording it would
 * park every older-driver state. Every other refusal does, because a fence was
 * supposed to exist and does not — and a round that lands unchecked in that
 * shape is the pre-#1852 hole.
 */
export function lensFixPlanRefusalRecords(
  refusal: LensFixPlanRefusal | typeof LENS_FIX_NO_WORKSTREAM,
): boolean {
  return typeof refusal === "string"
    ? true // `LENS_FIX_NO_WORKSTREAM`: the token itself is the failure record
    : refusal.kind === "unavailable";
}

/**
 * Does this round RECORD a fence failure? `runLensFix` writes
 * `lens-fix-fence-unavailable` when a pre-dispatch git read failed (or when no
 * workstream records the lens tree), so the question is answerable from the
 * state file alone — the same answer on the first pass and after a resume.
 *
 * Two states must not be confused, and the record is what separates them:
 *
 *   - recorded failure -> the round HAD a fence (it was part of the prompt) and
 *     the record did not survive to the gate: fail closed, nothing pushes.
 *   - no record at all -> an older driver wrote this state, or a fixture predates
 *     the change: the gate does not run. Refusing there would make #1852 a
 *     breaking change to the persisted schema instead of a fence.
 *
 * Deliberately NOT keyed on "a fixer was dispatched": a fixer dispatched under a
 * fence the planner could not build already has the refusal on the log, and one
 * dispatched by a driver with no fence at all has nothing to be judged against.
 */
export function lensFixFenceRecorded(events: readonly WorkEvent[], round: number): boolean {
  return events.some((e) => e.kind === "lens-fix-fence-unavailable" && e.round === round);
}

/**
 * Run the lens-fix fence once, before any landing arm. Every refusal leaves the
 * tree alone (the revert is the only write, and it is `revertStraysOnce`'s).
 */
export async function lensFixFenceCheck(opts: LensFixFenceGateOpts): Promise<LensFixFenceVerdict> {
  // Both facts are read from the state the gate is given, never handed to it by
  // the caller (#1852 round 2 MEDIUM): a caller that got the round, the log or
  // the workstream id wrong produced a verdict from a different round's records,
  // and nothing downstream could tell. The workstream the fence judges is the
  // snapshot's own, so the counter reads the same key the revert stamps.
  const fenceRecorded = lensFixFenceRecorded(opts.state.eventLog, opts.round);
  // The id is resolved the same way the caller resolves it, so the allowance the
  // gate applies and the stamp on the revert name one workstream.
  const wsId = lensFixWorkstreamId(opts.snapshot, opts.state.pipelineState, opts.tree);
  const revertAlreadyUsed =
    wsId !== undefined && lensFixRevertAlreadyUsed(opts.state.eventLog, opts.round, wsId);
  const snap = opts.snapshot;
  if (snap === undefined) {
    // No fence is recorded for this round, and that is NOT the same as a fence
    // that was built and then broken. The two cannot be treated alike:
    //
    //   - A round whose step TRIED to build the fence and could not — a
    //     pre-dispatch git read failed, or no workstream records the lens tree —
    //     has that refusal on the event log (`lens-fix-fence-unavailable`). It is
    //     fail-closed: the fence was part of this round, the fixer's prompt was
    //     built beside it, and the record did not survive to the gate. Landing
    //     unchecked is the pre-#1852 hole.
    //   - A round with NO fence record at all — an older driver wrote the state,
    //     a fixture from before this change, a resume whose file predates the
    //     field — has nothing to be judged against and the gate DOES NOT RUN.
    //     Refusing it would make #1852 a breaking change to the persisted schema
    //     rather than a fence, and would park every resumed cycle on a field its
    //     file never had.
    //
    // The rule keys on what the ROUND RECORDS, never on whether a fixer was
    // dispatched: a fixer dispatched under a fence the planner could not build
    // belongs to the first case (the refusal is on the log), and one dispatched
    // by a driver that never had a fence belongs to the second.
    if (!fenceRecorded)
      return {
        ok: true,
        notes: [
          "the lens-fix fence did not run: this round records no fence and no fence failure (an older driver wrote this state)",
        ],
      };
    return {
      ok: false,
      notes: [],
      reason:
        "this round recorded that its lens-fix fence could not be built (a pre-dispatch git read failed, or no workstream records the lens tree), so the round cannot be cleared — nothing was pushed",
    };
  }
  if (snap.round !== opts.round) {
    return {
      ok: false,
      notes: [],
      reason: `the recorded lens-fix fence belongs to round ${snap.round}, not the round being gated (${opts.round}) — the gate refuses to judge this delta against a fence built for another round`,
    };
  }
  // A record that is PRESENT but incomplete cannot judge anything (#1852 review
  // item 1d). Absence is the older-driver case and stands down; presence is the
  // round's claim that it HAD a fence, so a half-record parks rather than being
  // filled in with defaults — `lensFixPlanFromSnapshot` on a partial record
  // would build a fence from `undefined` arrays and refuse nothing, which is a
  // pass manufactured from corruption.
  const corrupt = lensFixFenceFindings(snap);
  if (corrupt.length > 0) {
    return fail(
      `the recorded lens-fix fence is not a complete record, so this round cannot be cleared: ${corrupt.join("; ")} — nothing was pushed`,
    );
  }
  const plan = lensFixPlanFromSnapshot(snap, opts.tree, opts.state.pipelineState);
  // Both reads, both required (the fix pass's own lesson, recorded in
  // `postPassFault`): a file the fixer created and never staged is in git's
  // untracked list and in NO commit range.
  //
  // A read that FAILS PARKS (PM decision #1852, review item 1c). The gate used
  // to trace-and-skip here, on the reasoning that a cycle must not die because
  // the driver's own git read broke. That reasoning inverted the failure: a
  // transient `git diff --name-only` failure is exactly as likely as the one
  // that stops the STEP from building a fence at all — and the step's version
  // of that failure parks, while this one pushed whatever the fixer had written
  // with nothing judged. So "could not measure the round's delta" is not a pass
  // when the round HAD a fence: the fence is never left unchecked, and the only
  // way a round lands is with its delta actually judged. `unavailable` on the
  // step side and `skip` here were the same event producing two outcomes, which
  // is the half of the hole the reviewer found.
  const head = await headOf(opts.execFn, opts.tree);
  if (!head.ok) return fail(`the lens tree's HEAD could not be read: ${head.reason}`);
  const range = await committedChanges(opts.execFn, opts.tree, snap.roundTip, head.value);
  if (!range.ok) return fail(`the round's commit range could not be read: ${range.reason}`);
  const delta = await treeChanges(opts.execFn, opts.tree, snap.roundTip);
  if (!delta.ok) return fail(`the lens tree could not be read: ${delta.reason}`);
  const passFiles = [...new Set([...range.value, ...delta.value.names, ...delta.value.untracked])];
  // An EMPTY delta is not automatically "the fixer changed nothing": it is also
  // what an unreachable `roundTip` produces, because `git diff <tip>..HEAD`
  // against a SHA that is not an ancestor of HEAD reports nothing useful rather
  // than failing. So the empty pass is earned by proving the tip the fence was
  // built from is actually in this tree's history — the same read every other
  // gate here makes, through the same argv exec, and it parks when it cannot.
  if (passFiles.length === 0) {
    const ancestor = await emptyDeltaIsReal(opts.execFn, opts.tree, snap.roundTip, head.value);
    if (!ancestor.ok)
      return fail(
        `the round's delta read empty, but the recorded round tip ${snap.roundTip} could not be confirmed as an ancestor of the lens tree's HEAD ${head.value} (${ancestor.reason}) — an empty range against a tip that is not in this tree's history is not evidence that the fixer changed nothing`,
      );
    return { ok: true, notes: [] };
  }

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
  if (!revertible || opts.onRevertible === undefined || revertAlreadyUsed) {
    return fail(
      // The counter is scoped to a workstream, so a round whose workstream cannot
      // be named is judged by the caller's hook alone (`revertLensFixStrays`
      // refuses without one): the allowance question is not answerable here and
      // must not be answered "no".
      revertAlreadyUsed
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

/**
 * The empty-delta pass is EARNED, not assumed.
 *
 * `git diff <tip> <head>` against a tip that is not in this tree's history reads
 * as "nothing changed", so an empty range plus an empty tree is also what a stale
 * or corrupt `roundTip` produces — and the fence would clear a round it never
 * measured. The ancestor probe is what separates "the fixer changed nothing" from
 * "the tip I was told to measure from is not here", and neither answer passes:
 * `no` is a stale tip and `unknown` is a broken read, and the handoff says which.
 */
async function emptyDeltaIsReal(
  execFn: FixExec,
  tree: string,
  roundTip: string,
  head: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const verdict = await isAncestor(execFn, tree, roundTip, head);
  if (verdict === "yes") return { ok: true };
  return {
    ok: false,
    reason:
      verdict === "no"
        ? "it is not an ancestor of HEAD — the recorded tip is not in this tree's history"
        : "the ancestry probe could not be run (the tip is not a SHA, or git could not answer)",
  };
}

function fail(reason: string, notes: string[] = []): LensFixFenceVerdict {
  trace(`work-driver: lens-fix fence refused the round — ${reason.slice(0, 200)}`);
  return { ok: false, reason, notes };
}

/**
 * The shape of a `LensFixFenceSnapshot` that got into the state file whole
 * enough to be an object but is missing a field, or carries one of the wrong
 *
 * `pipelineState.lensFixFence` is read through an untyped cast in `readState`,
 * so the type is a compile-time claim only: a hand edit, a truncated write, or
 * an older build's partial record reaches the gate as `undefined` fields, and
 * `lensFixPlanFromSnapshot` turns a missing `fence` into a crash and a missing
 * `declared` into a fence that admits nothing and refuses nothing at once. The
 * #533 rule applies here as it does to `prDraft` and `commitPrRoot`: the cast
 * is the only runtime gate, so a partial record is a confident wrong answer and
 * must be reported, not executed. Absent validates (see `lensFixFenceCheck` —
 * no record at all is the older-driver case and is not judged).
 */
export function lensFixFenceFindings(snapshot: unknown): string[] {
  if (snapshot === undefined || snapshot === null) return [];
  if (typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return ["pipelineState.lensFixFence is not an object"];
  }
  const out: string[] = [];
  const s = snapshot as Record<string, unknown>;
  for (const field of ["roundTip", "workstreamId", "worktree", "findings"] as const) {
    if (typeof s[field] !== "string" || s[field] === "") {
      out.push(`pipelineState.lensFixFence.${field} is missing or not a string`);
    }
  }
  for (const field of ["round"] as const) {
    if (typeof s[field] !== "number" || !Number.isFinite(s[field] as number)) {
      out.push(`pipelineState.lensFixFence.${field} is missing or not a finite number`);
    }
  }
  for (const field of ["declared", "named", "candidates"] as const) {
    if (!Array.isArray(s[field]) || !s[field].every((x) => typeof x === "string")) {
      out.push(`pipelineState.lensFixFence.${field} is missing or not an array of strings`);
    }
  }
  const fence = s.fence;
  if (typeof fence !== "object" || fence === null || Array.isArray(fence)) {
    out.push("pipelineState.lensFixFence.fence is missing or not an object");
  } else {
    const f = fence as Record<string, unknown>;
    if (typeof f.id !== "string" || f.id === "") {
      out.push("pipelineState.lensFixFence.fence.id is missing or not a string");
    }
    if (typeof f.ceilingBasis !== "string") {
      out.push("pipelineState.lensFixFence.fence.ceilingBasis is missing or not a string");
    }
    for (const field of [
      "admits",
      "declared",
      "helperDirs",
      "passChanged",
      "outOfScope",
    ] as const) {
      if (!Array.isArray(f[field]) || !f[field].every((x) => typeof x === "string")) {
        out.push(`pipelineState.lensFixFence.fence.${field} is missing or not an array of strings`);
      }
    }
    for (const field of ["ceiling", "admittingSlots"] as const) {
      if (typeof f[field] !== "number" || !Number.isFinite(f[field] as number)) {
        out.push(`pipelineState.lensFixFence.fence.${field} is missing or not a finite number`);
      }
    }
  }
  return out;
}
