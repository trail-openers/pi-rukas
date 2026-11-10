/**
 * work-driver-adversarial-fix — #1114: the adversarial gate reviews, the
 * develop step fixes.
 *
 * The adversarial step no longer edits anything. Each driver round is one
 * reportOnly review per workstream (adversarial.ts `reportOnly`). A parsed
 * ISSUES_FOUND / CRITICAL_ISSUES_FOUND at a non-terminal round routes that
 * workstream back to develop as a FIX PASS: the findings travel into the
 * developer prompt as data, the pass reuses the workstream's worktree, and
 * every develop gate runs on the result exactly as on a first pass. Then the
 * workstream returns to adversarial for a re-review. Approved workstreams are
 * neither re-developed nor re-reviewed.
 *
 * This module owns the event-log reading (round counts, pending fixes), the
 * per-round interpretation of a reportOnly result, and the fix pass itself.
 * The fence (scope, git reads) lives in work-driver-adversarial-fix-scope.ts.
 * Leaf for the adversarial step: it imports develop's topological core but
 * never the adversarial handlers, so there is no import cycle.
 */

import { type LoopAction, decideLoopAction } from "./adversarial-verdict.ts";
import { MAX_ROUNDS } from "./adversarial.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { runDevelopTopological } from "./work-develop-topological.ts";
import { defaultExec } from "./work-driver-adversarial-fix-git.ts";
import {
  type FixRequest,
  type PassPlan,
  type PostPass,
  overlayWorkstreams,
  planFixPass,
  postPassFault,
} from "./work-driver-adversarial-fix-scope.ts";
import {
  FIX_FINDINGS_MAX,
  NO_CHANGE_REASON,
  capWithMarker,
  freshPlumbQuestion,
  noChangeProven,
  parkFixPass,
  withDeveloperPlumbReplies,
  withFixPassReport,
} from "./work-driver-adversarial-plumb.ts";
import type { AdversarialOutcome, PendingFix } from "./work-driver-adversarial-types.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { correctiveRoundsOf } from "./work-driver-corrective-admission.ts";
import { cycleDispatch } from "./work-driver-cycle-entry.ts";
import { runFixPassRetention } from "./work-driver-fix-pass-retention.ts";
import {
  type RevertBoundary,
  fixPassRevertNote,
  revertStraysOnce,
} from "./work-driver-fix-pass-revert-step.ts";
import { beginDispatch } from "./work-driver-resume.ts";
import { execp as argvExecp } from "./work-driver-verify.ts";
import { activeIssuesOf } from "./work-driver-workspace.ts";
import type { PipelineState } from "./workflow-state-schema.ts";
import { type WorkEvent, type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";

export { namedPaths } from "./work-driver-fix-pass-named.ts";
export { plumbQuestion, withParsedSiblings } from "./work-driver-adversarial-plumb.ts";

export { FIX_FINDINGS_MAX };
/** A workstream id as the event log keys it (N=1 rounds carry no workstreamId). */
const keyOf = (workstreamId: string | undefined): string => workstreamId ?? "default";

/**
 * The one verdict → action mapping for the review track. Both the live
 * interpretation of a reportOnly result and the rebuild of a single-workstream
 * verdict from the log consume it, so the thresholds cannot drift apart.
 */
export function actionFor(
  status: Parameters<typeof decideLoopAction>[0],
  round: number,
): LoopAction {
  return decideLoopAction(status, round, MAX_ROUNDS, true);
}

/**
 * The review track of one workstream, read from the cycle's event log:
 * `rounds` counts PARSED reviews only (an infra-failed round never counts
 * toward the cap). `needsReview` is true before the first parsed review, and
 * after a fix pass has been applied since the last review.
 */
export function reviewTrack(
  eventLog: readonly WorkEvent[],
  workstreamId: string,
): { rounds: number; needsReview: boolean } {
  let rounds = 0;
  let lastRound = -1;
  let lastApplied = -1;
  eventLog.forEach((e, i) => {
    if (e.kind === "adversarial-round" && keyOf(e.workstreamId) === workstreamId) {
      if (e.verdictParsed) {
        rounds++;
        lastRound = i;
      }
    } else if (e.kind === "adversarial-fix-applied" && e.workstreamId === workstreamId) {
      lastApplied = i;
    }
  });
  return { rounds, needsReview: rounds === 0 || lastApplied > lastRound };
}

/**
 * The workstreams this adversarial invocation reviews. A lens-fix re-review
 * reviews everything (the lens-fix changed the diff), and carries the final
 * round so the gate is decided rather than routed back into a fix loop.
 */
export function workstreamsToReview(state: WorkState, ids: readonly string[]): string[] {
  if (state.pipelineState.lastCompletedStep === "lens-fix") return [...ids];
  return ids.filter((id) => reviewTrack(state.eventLog, id).needsReview);
}

/** The round a workstream's next reportOnly review carries. */
export function reviewRoundFor(state: WorkState, workstreamId: string): number {
  if (state.pipelineState.lastCompletedStep === "lens-fix") return MAX_ROUNDS;
  return reviewTrack(state.eventLog, workstreamId).rounds + 1;
}

/** Fix requests not yet followed by an applied fix pass, in log order. */
export function pendingFixes(eventLog: readonly WorkEvent[]): PendingFix[] {
  const pending = new Map<string, PendingFix>();
  for (const e of eventLog) {
    if (e.kind === "adversarial-fix-requested") {
      pending.set(e.workstreamId, {
        workstreamId: e.workstreamId,
        round: e.round,
        findings: e.findings,
      });
    } else if (e.kind === "adversarial-fix-applied") {
      pending.delete(e.workstreamId);
    }
  }
  return [...pending.values()];
}

export interface ReviewReading {
  /** Whether this workstream's review produced a usable outcome (infra and rejections are not). */
  ok: boolean;
  /** The reviewer dispatch died or produced no readable verdict. */
  infra: boolean;
  /** A parsed non-terminal verdict: route this workstream to a fix pass. */
  fixRequested: boolean;
  /** Non-blocking findings this passing review carries forward. */
  passFindings?: string;
}

/**
 * Interpret one reportOnly review. Every review carries its round record
 * (#1114), so a successful dispatch without a parsed verdict is infra, never
 * an approval. The decision is `actionFor`, the same table the log rebuild uses.
 *
 * #1863 M4 — `noVerdictAs`: the caller's structural account of a result that
 * produced NO verdict. When the caller passes `"infra-failure"` the reading is
 * unconditionally the no-verdict reading, and a verdict embedded in the text of
 * a result the loop itself declared dead cannot re-read as a rejection. The
 * caller supplies it from `DispatchResult.loopOutcome` — the loop's own account
 * of why it stopped — never from the reviewer's prose. It is a discriminant,
 * not a string to pattern-match, and an absent value is today's behaviour.
 */
export function interpretReview(
  result: DispatchResult,
  reviewRound: number,
  noVerdictAs?: "infra-failure",
): ReviewReading {
  // A result the loop declared infrastructure-dead has no verdict, whatever it
  // says; that account outranks the text, which is the dead child's last words
  // and may quote any verdict at all.
  if (noVerdictAs === "infra-failure") return { ok: false, infra: true, fixRequested: false };
  const ok = result.ok && !result.errorStop;
  if (!ok) return { ok: false, infra: false, fixRequested: false };
  const rec = result.adversarialRounds?.[0];
  if (!rec?.verdictParsed) return { ok: false, infra: true, fixRequested: false };
  const action = actionFor(rec.status, reviewRound);
  // A fix request with no findings gives the developer nothing to act on: infra.
  if (action === "fix" && !result.text?.trim())
    return { ok: false, infra: true, fixRequested: false };
  if (action === "fix") return { ok: true, infra: false, fixRequested: true };
  if (action === "reject") return { ok: false, infra: false, fixRequested: false };
  return {
    ok: true,
    infra: false,
    fixRequested: false,
    passFindings: rec.status === "APPROVED" ? undefined : result.text,
  };
}

/** The fix-requested events for the workstreams a review round routed back. */
export function fixRequestEvents(
  outcomes: ReadonlyArray<{
    id: string;
    fixRequested?: boolean;
    fixFindings?: string;
    records: Array<{ round: number }>;
  }>,
  at: number,
): WorkEvent[] {
  return outcomes
    .filter((o) => o.fixRequested)
    .map((o) => ({
      kind: "adversarial-fix-requested" as const,
      at,
      workstreamId: o.id,
      round: o.records[0]?.round ?? 0,
      findings: capWithMarker(o.fixFindings ?? "", FIX_FINDINGS_MAX),
    }));
}

/**
 * Workstreams that keep a FINAL verdict from an earlier invocation: not run
 * again, their outcome re-emitted so the log stays complete. A single-workstream
 * cycle keeps no per-workstream outcome event, so its approval is recovered
 * from the rounds it already ran.
 */
/**
 * The develop fix pass for the pending workstreams. Reuses their worktrees;
 * named finding paths widen a declared fence for this pass only; all develop
 * gates run unchanged. Parks like a first develop failure: a failed gate or
 * dispatch, a no-op pass, a change outside the fence, or an origin/main comment
 * the pass removed and did not replace. Every pre-pass read fails closed (see
 * the scope module).
 */
export async function runAdversarialFixPass(
  ctx: CycleContext,
  state: WorkState,
  pending: PendingFix[],
  now: number,
  /** Threaded to `revertStraysOnce` unchanged: the instant the stray revert is
   *  over. Production callers omit it; see `RevertBoundary` for why a caller can
   *  need it and why the driver itself never does. */
  onRevertBoundary?: RevertBoundary,
): Promise<WorkState> {
  const ps: PipelineState = state.pipelineState;
  const execFn = ctx.verifyExecFn ?? defaultExec;
  const requests: FixRequest[] = pending.map((p) => ({
    workstreamId: p.workstreamId,
    findings: p.findings,
  }));
  const planned = await planFixPass(execFn, ctx.repoRoot, ps, requests);
  if (!planned.ok)
    // The fence never ran, so it admitted nothing: the empty array is the
    // truthful disclosure, not a defaulted one.
    return parkFixPass(state, pending, planned.reason, now, []);
  const plans = planned.value;
  for (const p of plans) {
    if (p.widened.length > 0)
      trace(`work-driver: fix pass ${p.id} widened by ${p.widened.join(", ")}`);
  }
  const ids = plans.map((p) => p.id);
  const passWorkstreams = overlayWorkstreams(ps.workstreams, plans);

  // The develop step receives the overlay as a parameter; the write-ahead and
  // the persisted pipeline carry the ORIGINAL workstreams.
  const startLen = state.eventLog.length;
  const priorPlumbBodies = new Set((ps.plumbReports ?? []).map((r) => r.body));
  const stepped = appendEvent(
    { ...state, pipelineState: { ...ps, currentStep: "develop" } },
    { kind: "step-started", step: "develop", at: now },
  );
  const begun = await beginDispatch(
    ctx,
    stepped,
    "develop",
    "developer",
    ids.length > 1 ? `developer×${ids.length}` : "developer",
    Date.now(),
  );
  const develop = await runDevelopTopological(
    ctx,
    begun.state,
    ids,
    passWorkstreams,
    activeIssuesOf(state),
    cycleDispatch(ctx),
    // Develop's git checks pass argv: the shell-string executor drops it.
    ctx.verifyExecFn ?? argvExecp,
    now,
    begun.jobId,
  );
  // #1137 — record the fix developer's plumb reply (from this pass's develop
  // events) before any gate reads the state. The develop step's workstreams
  // overlay is undone before anything persists.
  const restored = withDeveloperPlumbReplies(
    { ...develop, pipelineState: { ...develop.pipelineState, workstreams: ps.workstreams } },
    startLen,
    priorPlumbBodies,
  );
  const failed = restored.eventLog
    .slice(startLen)
    .some(
      (e) =>
        e.kind === "cap-hit" ||
        e.kind === "dispatch-failed" ||
        (e.kind === "branch-completed" && !e.ok) ||
        (e.kind === "branches-converged" && e.verdicts.some((v) => !v.ok)),
    );
  // A failed gate that already recorded its own cap routes through that cap.
  // Any other failed tail (a bare branches-converged verdict, say) would fall
  // through nextStep to the linear table, so it parks explicitly here.
  if (failed) {
    // #1137 — a no-change fix pass whose developer asked a plumb question is a
    // question, not a failed gate. Checked before the tail so it holds whichever
    // gate tripped; noChangeProven keeps a pass that changed files out of it.
    const question = freshPlumbQuestion(restored, priorPlumbBodies);
    if (question && (await noChangeProven(execFn, plans, ps.baseSha ?? ""))) {
      return parkFixPass(
        restored,
        pending,
        `the developer returned a plumb report and changed nothing — answer the question: ${question}`,
        now,
        [],
      );
    }
    const tail = restored.eventLog[restored.eventLog.length - 1];
    if (tail?.kind === "cap-hit")
      return withFixPassReport(restored, pending, "a develop gate failed on the fix pass", now, []);
    return parkFixPass(restored, pending, "a develop gate failed on the fix pass", now, []);
  }

  const post = await postPassFault(
    execFn,
    plans,
    ps.baseSha ?? "",
    // #1698(b) — the corrective round dispatched inside this pass edits the
    // files its own evidence named; those are driver-ordered, not strays. The
    // pass-scoped window, and the gate derives the evidence from the records.
    correctiveRoundsOf(restored.eventLog.slice(startLen)),
  );
  // #1846 — one stray set is now the driver's job, not the operator's. Preserve
  // and revert those paths, re-run the pass's own checks on the post-revert tree,
  // and continue when the pass is clean. A SECOND stray set, a fenced or
  // protected stray, or any preservation failure parks exactly as before — the
  // revert is one attempt per pass, not a loop, and it never touches a file an
  // admission rule was refused for. #1849 item 9 — the operator's kill switch is
  // no longer a conjunct here: `revertStraysOnce` checks it itself, so the switch
  // cannot be bypassed by a caller and reads beside the rule it governs.
  // #2156 — the revert's outcome is not a verdict on the pass: ANY refusal to
  // rewind fails the round, so the pass never continues with files still outside
  // its fence. The earlier shape continued when a rewind succeeded and re-ran the
  // no-op check on the post-revert tree, which is how a pass ended up judged on
  // half its own edits.
  const reverted =
    post.reason !== undefined && post.straysFor !== undefined && post.strays !== undefined
      ? await revertStraysOnce(ctx, restored, plans, post, now, onRevertBoundary)
      : undefined;
  // A rewind the driver PERFORMED leaves the tree byte-identical to what the pass
  // found, so the no-op check — which exists to catch a fixer that fixed nothing —
  // must not re-judge that tree: it would answer "nothing was fixed" about a pass
  // the driver just deliberately took back. The existing `noOp` seam says exactly
  // that, and it is asked HERE, at the one call site that knows why; the lens
  // caller has passed it for the same reason since #1852. The scope judgement is
  // unchanged, so a pass that somehow still holds a stray parks on it.
  const cleared =
    reverted?.ok === true
      ? await postPassFault(
          execFn,
          plans,
          ps.baseSha ?? "",
          correctiveRoundsOf(restored.eventLog.slice(startLen)),
          { noOp: true },
        )
      : post;
  // #1846 — a revert the driver PERFORMED is recorded whatever happens next. The
  // event used to be appended only on the green path, so a pass that reverted a
  // stray set and then parked on the comment-retention check (or on a second
  // gate) handed off with a driver commit in its history that no event
  // explained: the operator saw files deleted from their worktree and a state
  // file that said nothing about it. Appending here covers every park below,
  // because they all read this state.
  const afterRevert = reverted?.ok === true ? appendEvent(restored, reverted.event) : restored;
  // PERSISTED NOW, not at the next step boundary. The revert is a real commit
  // that has already deleted files from the worktree, and the window between it
  // and the next write is exactly where a crash, a kill or a provider timeout
  // lands. A state file that says `running` at `develop` with a revert commit in
  // the branch and no event for it is worse than no revert at all: a resume, a
  // `--restart` or an operator reading the state finds files gone with nothing to
  // explain them, and the preserved ref is undiscoverable. `appendEvent` is pure,
  // so this is the one call that makes the record durable; every branch below
  // re-persists the same bytes, which is idempotent.
  if (reverted?.ok === true) await persistCycle(ctx, afterRevert);
  if (cleared.reason) {
    // #1137 — a no-change fix pass whose workstream carried a plumb report
    // (a structural question, e.g. scope-ambiguity) is a question to answer,
    // not a failed gate. The plumb report is already in pipelineState (the
    // develop step recorded the developer's reply); the handoff's plumb
    // section renders it, and the evidence names the plumb question so the
    // operator answers it instead of re-dispatching the same no-op.
    if (NO_CHANGE_REASON.test(cleared.reason)) {
      const question = freshPlumbQuestion(restored, priorPlumbBodies);
      if (question) {
        return parkFixPass(
          afterRevert,
          pending,
          `the developer returned a plumb report and changed nothing — answer the question: ${question}`,
          now,
          cleared.admissions,
        );
      }
    }
    return parkFixPass(
      afterRevert,
      pending,
      // #2156 R3 — there is no second path-scoped revert any more, so this branch
      // is reached when `revertStraysOnce` returned no refusal of its own: the
      // driver DECLINED to rewind (the operator's kill switch is off, or the
      // workstream has no recorded tree — the step answers `undefined`), or it
      // ATTEMPTED the rewind and refused (an empty pass delta, an untracked copy
      // that did not verify, a failed `revertPaths`/commit after rollback). In the
      // second case this is the step's own reason, not a silent pass. The wording
      // that told the operator the driver had already reverted a first set is gone
      // with the partial revert it described: a pass that rewound everything parks
      // below, on the fence's own refusal.
      cleared.reason,
      now,
      cleared.admissions,
    );
  }
  // #2156 R3 — the round FAILS on any rewind, and it fails here, on the fence's
  // own refusal, with the stray(s), the preserved ref and the patch path named.
  // The path that rewound the pass leaves the tree byte-identical to what the
  // pass found, so the comment-retention reads in the pass tail would judge the
  // pass on origin/main comments its own rewind removed: a pass would park for a
  // deletion the driver made. Every other park here re-persists `afterRevert`
  // (each `parkFixPass` here and in the tail reads it), so appending the rewind
  // record here covers them all — and the rewind is already durable on disk from
  // the `persistCycle` above, which is what makes it discoverable after a crash.
  // The rewind is itself the failure, so the park names the refusal the rewind
  // was made for (`post.reason`) rather than asking the post-revert re-judge:
  // that read compares the tree to `plan.headBefore`, and a rewind the driver
  // completed leaves it byte-identical there, so it answers "nothing was fixed"
  // about a tree the driver took back deliberately — i.e. it CLEARS. Requiring
  // its reason here was a condition that cannot hold for the case it gated, and
  // the pass sailed past the park to `adversarial-fix-applied` with the whole
  // fix reverted: an applied round that fixed nothing, which is the exact shape
  // the no-op check exists to refuse. `post.reason` is not re-tested here: a
  // rewind is only ever attempted on a refusal (`reverted` is undefined unless
  // `post.reason` was already set above).
  if (reverted?.ok === true)
    return parkFixPass(afterRevert, pending, post.reason ?? "", now, [
      ...cleared.admissions,
      fixPassRevertNote(reverted.event),
    ]);
  if (reverted?.ok === false)
    return parkFixPass(afterRevert, pending, reverted.reason, now, cleared.admissions);
  // The operator's kill switch is NOT a failed check: a disabled check reads
  // NOT CHECKED (as every other reader renders it) and the pass proceeds with
  // that disclosed on the handoff, never parked. Only a check that was asked
  // for and could not run parks.
  // #1725 round 3 (admission disclosures) and the origin/main comment-retention
  // check live in `runFixPassRetention`, which owns the pass tail: it reads only
  // what the develop gates and the stray handling above produced, and parks on
  // `afterRevert` so the rewind record rides every handoff it can produce.
  return runFixPassRetention(ctx, afterRevert, pending, plans, post, cleared, now);
}
