/**
 * work-driver-fix-pass-revert-step — #1846: the fix pass's one-shot revert,
 * decided from state, executed through `work-driver-fix-pass-revert.ts`.
 *
 * Two modules rather than one because the two halves answer different questions
 * and are gated differently: the revert itself (`work-driver-fix-pass-strays.ts`)
 * is pure git work that needs a real repo to test, while this file is the driver
 * policy around it — *whether* a revert is allowed at all, which worktree and
 * head it targets, and what the caller parks on when it declines.
 *
 * The ATTEMPT COUNTER is read from the event log rather than stored on the
 * context: the revert's own `fix-pass-strays-reverted` event is the record that a
 * revert happened, so counting those events makes a SECOND stray set park without
 * any new state to keep in step — and a resumed cycle counts the revert it
 * already performed, which a counter field would have lost.
 *
 * ACCEPTED CRASH WINDOW (PM decision on #1849 item 6): the revert commits, and
 * the event that records it is persisted by the caller only once the revert has
 * returned, so a kill that lands between the commit and that write leaves a pass
 * which can revert a second time. This is accepted rather than closed, because
 * the alternative — a pre-commit marker — makes a revert that never ran look like
 * one that did; a double revert is recoverable from the preserved ref and patch
 * each attempt writes before it touches the tree.
 */

import { neutraliseMarkdownField } from "./comment-evidence.ts";
import { tickSafe } from "./plan-fence-render.ts";
import { trace } from "./trace.ts";
import { runGit } from "./work-develop-git.ts";
// #1849 — the revert's git transport is pinned to the executor whose argv form is
// its ONLY form, the same one `work-driver-adversarial-fix.ts:269` hands the
// pass's develop git calls. `runGit` always calls with `opts.argv`, so the
// fallback decides what production runs (`verifyExecFn` is a test-only injection
// that production callers leave unset). `defaultExec` is `execp`, which does
// honour argv today — measured, see the note in
// /tmp/pi-ensemble-developer/item1-FINDING.md — but its SHELL branch is live for
// every other call site and kills a process tree / scrubs driver knobs on that
// path. A destructive transport should not be one `opts` field away from a shell:
// #1279 is the record of exactly this shape (`runGit(<bare promisify(exec>)`)
// running a bare `git` and printing usage, and the only thing that kept the
// revert out of it was the fallback never being passed `killGroup`. The argv-only
// executor makes that structural rather than accidental, and
// test-fix-pass-strays-transport.ts pins the production shape (no `verifyExecFn`,
// a real repo under `.worktrees/`) so a future fallback swap that drops argv fails
// the gate instead of killing the feature in the field.
import type { PassPlan, PostPass } from "./work-driver-adversarial-fix-scope.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { nextStrayAttempt, revertFixPassStrays } from "./work-driver-fix-pass-strays.ts";
// #1849 — the ARGV executor. `runGit` always calls with `opts.argv`, so the
// fallback decides what PRODUCTION runs (`verifyExecFn` is a test-only injection
// callers leave unset): the same one `work-driver-adversarial-fix.ts:269` hands
// the pass's develop git calls. `defaultExec` is `execp`, which honours argv
// today (measured — the brief's "ignores argv" claim did not reproduce; see
// /tmp/pi-ensemble-developer/item1-FINDING.md), but it is the SAME function whose
// shell branch kills a process tree and scrubs driver knobs, so a destructive
// transport sat one `opts` field away from a shell. #1279 is the record of this
// exact shape running a bare `git` and printing usage; the argv-only executor
// makes the guarantee structural instead of accidental, and
// test-fix-pass-strays-transport.ts pins the production shape (no `verifyExecFn`,
// a real repo under `.worktrees/`).
import { execp as argvExecp } from "./work-driver-verify.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { FixPassStraysRevertedEvent } from "./workflow-state-events-fix-pass-strays.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** What the caller does with the outcome: continue and re-check, park on the
 *  reason, or (when `secondSet`) park on the reason *with* the second-set wording
 *  so the handoff does not tell the operator to revert by hand what the driver
 *  already reverted. `undefined` means a revert is not the right answer at all —
 *  the workstream had no recorded worktree, so there is no tree to revert. */
export type RevertStraysOutcome =
  | { ok: true; event: FixPassStraysRevertedEvent }
  | { ok: false; secondSet: boolean; reason: string };

/**
 * An optional hook, called by `revertStraysOnce` at the instant the revert's
 * destructive work is finished and its outcome is in hand.
 *
 * It exists for one reason: a test that wants to prove the revert's event is
 * durable BEFORE the post-pass gate next reads the tree has to know when the
 * revert ended, and no other seam says so. The emit sink is too late —
 * `writeState` serialises through a per-file promise chain, so the snapshot reaches
 * the sink well after the rename is ordered, by which time the gate has already
 * made every read worth observing. The pass's own call site is the only point that
 * both knows the revert is over and runs before the gate's next git call.
 *
 * Optional, and production callers never set it: the driver records what it needs
 * through the event, not through a callback.
 */
export type RevertBoundary = () => void;

/**
 * `PI_ENSEMBLE_FIX_PASS_STRAY_REVERT=0` — the escape hatch for the driver's
 * one-shot stray revert. Off, a first stray set parks on its refusal exactly as
 * it did before #1849, with the operator reverting by hand; nothing else about
 * the pass changes. The other gate kill-switches set "0" or "false".
 *
 * #1849 item 9 — it lives next to `revertStraysOnce`, which is the only function
 * that consults it, so the switch and the rule it switches cannot be edited
 * apart.
 */
export function fixPassStrayRevertEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_FIX_PASS_STRAY_REVERT;
  return v !== "0" && v !== "false";
}

/**
 * Preserve and revert one stray set, at most once per pass.
 *
 * Only a refusal the fence itself reached is offered here: `postPassFault` omits
 * `straysFor` for a fenced or protected stray, so a file the protected-path gate
 * refused never reaches this module — taking that decision away from the gate is
 * not what a revert is for.
 */
export async function revertStraysOnce(
  ctx: CycleContext,
  state: WorkState,
  plans: readonly PassPlan[],
  post: PostPass,
  now: number,
  /** Called the instant the revert's destructive work is done and its outcome is
   *  known — the boundary a durability test observes from. See `RevertBoundary`. */
  onReverted?: RevertBoundary,
): Promise<RevertStraysOutcome | undefined> {
  const id = post.straysFor;
  const strays = post.strays;
  if (id === undefined || strays === undefined || strays.length === 0) return undefined;
  // #1849 item 9 — the operator's kill switch is checked HERE, next to the rule
  // it switches off, rather than as one more conjunct in the caller's `reverted`
  // expression. Two places deciding one switch is how a later caller reaches the
  // revert without asking: any caller of this function now gets the same answer,
  // and a reader of the one-shot rule sees the switch beside it. An off switch is
  // still "no revert, park on the refusal", so it returns `undefined` exactly as
  // a refusal the fence reached does — the caller's park path is unchanged.
  if (!fixPassStrayRevertEnabled()) {
    trace(`work-driver: stray revert disabled for ${id} (PI_ENSEMBLE_FIX_PASS_STRAY_REVERT)`);
    return undefined;
  }
  const plan = plans.find((p) => p.id === id);
  if (plan === undefined) return undefined;
  // #1849 item 7 — the plan's `worktree` is a field every caller fills, and the
  // one that has been wrong is the one whose destructive calls land in someone
  // else's tree. `assertInsideWorktrees` proves the path is A driver worktree,
  // not THIS workstream's, and `postPassFault` judges the pass in the tree from
  // the same field — so a plan built from a stale or cross-wired state reverts a
  // sibling's files while reporting a revert of this workstream's strays. The
  // recorded tree is `pipelineState.worktrees[id]`, the value Step 3 wrote and
  // every later step reads. Compared by realpath, so a symlinked or differently
  // spelled root does not refuse a revert that targets the right tree; an
  // unreadable path refuses rather than trusting the lexical form, because the
  // failure this closes is a deletion in the wrong tree, not a park.
  const recorded = state.pipelineState.worktrees?.[id];
  if (recorded === undefined) {
    // Absent is a mismatch for this purpose: with nothing recorded there is no
    // tree the driver would accept a revert into. The gate itself lives with the
    // destructive calls (`assertInsideRecordedWorktree`) so its refusal reads the
    // same whichever side is missing; this trace only says the gate did not get a
    // value to compare.
    trace(`work-driver: no recorded worktree for ${id}; the stray revert is refused`);
  }
  // The counter is scoped to THIS pass and THIS workstream: `passWindow` starts
  // at the pass's own `adversarial-fix-requested` event, and the filter keeps
  // another workstream's revert out of this workstream's budget. Reading the
  // whole eventLog made a pass whose sibling had already reverted (or a second
  // fix pass in the same cycle) park on a first stray set it had never reverted
  // — a "second set" the driver had actually reverted in a different pass.
  const alreadyReverted = passWindow(state).some(
    (e) => e.kind === "fix-pass-strays-reverted" && e.workstreamId === id,
  );
  if (alreadyReverted) {
    // One stray set per pass is the driver's job; a second is a pass that will
    // not stay inside its fence, and reverting again would be looping on it.
    return {
      ok: false,
      secondSet: true,
      reason: `${id} produced a SECOND set of out-of-fence files after the driver reverted the first (${strays.map((s) => s.file).join(", ")}) — the pass is not staying inside its fence`,
    };
  }
  // One record pair per revert, ever: the number comes from the scratch dir, so
  // a revert in a LATER pass of the same cycle writes `-2` rather than
  // overwriting the first pass's patch with `wx` and refusing (or, without the
  // `wx` flag, silently replacing the only record of what the earlier revert
  // deleted).
  const scratch = scratchDir(ctx.repoRoot, ctx.issue);
  // The transport is built first so the attempt counter can read the REF
  // namespace too, not only the patch directory — see `nextStrayAttempt`.
  const git = runGit(ctx.verifyExecFn ?? argvExecp);
  const attempt = await nextStrayAttempt(scratch, ctx.issue, id, git, plan.worktree);
  // The plan's `worktree` names the tree, and `revertFixPassStrays` compares it
  // against the tree the DRIVER recorded for this workstream
  // (`pipelineState.worktrees[id]`, the value Step 3 wrote and every later step
  // reads) before a single destructive call runs. The plan field is caller- and
  // test-filled, and `assertInsideWorktrees` alone only proves it is A driver
  // worktree — so a stale or cross-wired plan would revert a SIBLING's files
  // while reporting a revert of this workstream's strays. A mismatch (or either
  // path failing to resolve) is a refusal that leaves both trees untouched, and
  // it reaches the operator as the park reason naming both paths.
  const result = await revertFixPassStrays({
    git,
    worktree: plan.worktree,
    recordedWorktree: recorded,
    repoRoot: ctx.repoRoot,
    issue: ctx.issue,
    workstreamId: id,
    attempt,
    // The revert target is the PASS's OWN recorded pre-pass head — never a
    // corrective round's `headAtRound`. The strays are computed on the pass's
    // delta from `headBefore` (`treeChanges(worktree, plan.headBefore)`), while
    // `headAtRound` is recorded AFTER the round's commits landed: restoring a
    // stray to its `headAtRound` content would keep the very lines the fence just
    // refused. A per-path revert touches ONLY the stray paths, so it cannot undo
    // the pass's fix or a corrective round's admitted files — those are not in
    // the path list. See `revertTarget`.
    headBefore: revertTarget(state, id, plans),
    strays: strays.map((s) => s.file),
    untracked: new Set(post.untracked ?? []),
    scratchDir: scratch,
  });
  // The boundary is raised for BOTH outcomes, before either is returned: the
  // caller's next git call is the post-pass gate either way, and a test that only
  // observed the success path could not tell "nothing was persisted" from "nothing
  // was reverted".
  onReverted?.();
  if ("reason" in result) return { ok: false, secondSet: false, reason: result.reason };
  return {
    ok: true,
    event: {
      kind: "fix-pass-strays-reverted",
      at: now,
      workstreamId: id,
      paths: result.paths,
      preservedRef: result.preservedRef,
      patchPath: result.patchPath,
    },
  };
}

/**
 * The SHA this pass must revert TO: the pass's own `plan.headBefore`, positively
 * recorded at plan time and nothing else.
 *
 * WHY not the corrective round's `headAtRound`, which looks tempting because a
 * round dispatched inside the pass committed work on the driver's own order:
 * `headAtRound` is the HEAD the round FOUND, which by then already contains the
 * pass's commits — including the strays the fence is refusing. Restoring a stray
 * path to its `headAtRound` content therefore RESTORES the stray. `headBefore` is
 * the single referent the fence's own judgement uses (`postPassFault` reads
 * `treeChanges(worktree, plan.headBefore)`), so a revert that targets anything
 * else and a fence that judges by it are two different trees — which is exactly
 * the drift #1846 PM decision 2 forbids.
 *
 * And a per-path revert cannot undo the pass's legitimate work: the only paths it
 * touches are the strays, so the fix and a corrective round's admitted files are
 * never in the path list, whichever head a round later committed them on top of.
 *
 * Never a guess. `HEAD~1`, `base` or the current HEAD are each a way to delete
 * the pass's real work, so when the recorded head is not a usable SHA this
 * returns `undefined` and `revertFixPassStrays` refuses rather than picking one.
 */
function revertTarget(
  _state: WorkState,
  workstreamId: string,
  plans: readonly PassPlan[],
): string | undefined {
  return usable(plans.find((p) => p.id === workstreamId)?.headBefore);
}

/** The event-log window this pass produced — everything from its own request
 *  event on. The caller and this module must agree on what "this pass" means,
 *  because both bound their reads (rounds here, strays there) to it. */
export function passWindow(state: WorkState): WorkEvent[] {
  const events = state.eventLog;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.kind === "adversarial-fix-requested") return events.slice(i);
  }
  return events;
}

/** A recorded head is usable only as a full SHA — the same rule the develop paths
 *  apply (`isValidBaseSha`), so a truncated or empty field never becomes a rev. */
const usable = (sha: string | undefined): string | undefined =>
  sha !== undefined && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;

/** The disclosure line the pass's notes and the PR body carry for a revert. A
 *  revert whose ref and patch the operator cannot find is a driver commit that
 *  quietly deleted their fixer's work.
 *
 *  Every path is run through `neutraliseMarkdownField`: the file names in this line
 *  were chosen by the fixer, and the line is rendered into the PR body and the
 *  handoff. A path containing a fence, a marker token, or a line break is the
 *  developer speaking into a report the operator reads as the driver's — the
 *  same reason the diff-cap module neutralises a path before printing it.
 *
 *  `tickSafe` runs after the neutraliser at each wrapped site. A single backtick
 *  survives `neutraliseMarkdownField` (it collapses only runs of three or more,
 *  which are code FENCES), and in a line that wraps a path in backticks one such
 *  backtick closes the driver's span — so everything after the developer's
 *  backtick in a file name leaves the code span and reads as the driver's prose.
 *  The ref and the patch path are printed bare, not wrapped, so they take the
 *  neutraliser alone. */
export function fixPassRevertNote(event: FixPassStraysRevertedEvent): string {
  const paths = event.paths.map((p) => `\`${tickSafe(neutraliseMarkdownField(p))}\``).join(", ");
  // The ref and the patch path are built by the driver from the issue number, the
  // workstream id and the attempt — but the WORKSTREAM ID is not driver-chosen
  // (it comes from the plan, and a grouped cycle's ids come from the issue body),
  // and `patchPath` embeds the scratch dir, which embeds `repoRoot`. Both are
  // therefore rendered through the same neutraliser as the paths: a field this
  // line prints is a field somebody upstream influenced, and the line lands in the
  // PR body. #1849 item 9 — the ref used to print raw, so the one token in the
  // line that named where to recover the content was the one token unescaped.
  const ref = neutraliseMarkdownField(event.preservedRef);
  return `reverted ${event.paths.length} out-of-fence file(s) (${paths}) — preserved at ${ref}, patch ${neutraliseMarkdownField(event.patchPath)}`;
}
