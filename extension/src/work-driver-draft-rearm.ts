/**
 * work-driver-draft-rearm — the PR is a draft again once a review runs a
 * second time, and the fact that says a review's findings reached the PR.
 *
 * #1292 made the cycle's PR a draft until the driver's review finished, and
 * `markDraftPrReady` is the only writer of `ready`. Its short-circuit
 * (`if (!draft || draft.status === "ready") return current`) makes ready
 * permanent: a PR marked ready entering `ci` stays mergeable through the whole
 * `ci → develop → adversarial → commit-pr → lens-review → ci` loop every
 * failing CI run takes (`nextStep` routes `ci-status:failure` and
 * `verify-full-status:failure` back to `develop` while `ciRetryCount <
 * MAX_CI_RETRIES`). For those hours the PR sat mergeable while the review was
 * re-running — exactly the window #1292 exists to close.
 *
 * **One rule, stated once here:** a cycle whose review has to run again after
 * it was already marked ready is a cycle whose PR is a draft again before that
 * review runs. It fires at the one mark point both loop-backs pass through —
 * entering `lens-review` — and is keyed on the event log rather than re-derived
 * from step names: after a CI loop the log ends `lens-approved → ci-status:
 * failure → step-started{develop} → … → step-started{lens-review}`, so
 * `reviewConcluded` alone is already true here and a fresh review of a
 * re-armed PR needs no re-arm (it was never marked ready).
 *
 * Three things keep it from being a blunt instrument:
 *
 *  - **Only a draft the driver knows about.** `prDraft` absent = the driver
 *    never opened this PR as a draft: an interactive `/work` (drafts off) and
 *    an ops-fallback PR opened ready are both left exactly as they are
 *    (docs/configuration.md's contract for the latter — "the driver does not
 *    convert it back").
 *  - **The forge is consulted, not the cached fact.** Nothing ever ADDS a
 *    `draft` fact after the ready was recorded, so after a loop the stale
 *    `ready` is all the state holds — the forge's real state and
 *    `pipelineState` can diverge silently and no mark point notices. The
 *    decision reads the live `isDraft` and acts only when it says the PR
 *    really is mergeable; an `undefined` (the view did not say) is not
 *    evidence and re-arms nothing. The SAME read runs again AFTER the draft
 *    command: a successful re-arm is recorded only when the forge confirms the
 *    PR is a draft, because the command's exit code is not evidence and a
 *    silently-unconfirmed re-arm is the same hole the module closes.
 *  - **Identity first, same rule as every other write.** The PR must be this
 *    cycle's own OPEN PR (`judgePrIdentity`, the develop gate's check) before
 *    a forge command is issued, and nothing is recorded on an unreadable view.
 *    The number came from a child's reply; `--undo` on someone else's PR is
 *    not a mistake the driver gets to make.
 *
 * A re-arm that is needed and fails HALTS the cycle rather than continuing
 * with a mergeable PR — same shape as `runMerged`'s draft hold (`cap-hit` with
 * the reason on `evidence`, routed to `handoff`), so the operator sees a named
 * reason instead of a silent no-op and a review that passes on a PR nobody can
 * merge.
 *
 * The other half of this module is the fact the draft gate reads. There was
 * none: `appendReviewCapHit` posts the residual findings and records only its
 * `cap-hit`, `recordResidualsPost` emits an event ONLY on a failed PR post, and
 * `readyHoldReason` re-inferred "were the findings disclosed?" from which cap
 * NAME appeared — so any `ISSUES_FOUND` followed by something other than a
 * round/wall-clock cap that parks (`dispatch-failed`, `verify-failed:*`, a kill
 * cause, `ci-retry`) read as "nothing to hold for" and the PR was marked ready
 * over findings nobody ever posted. `lens-residuals-posted` is the positive
 * fact, recorded by the ordinary disclosure path and the round-cap route alike,
 * keyed on the PATCH IDENTITY the disclosure carries — so a fact recorded for a
 * pre-fix patch never licenses marking the new patch ready. A decline the driver
 * cannot act on (no forge, an unverifiable PR identity, or a forge that will not
 * say whether the PR is a draft) is recorded as a plumb-report so it reaches the
 * A cycle that cannot name its forge cannot re-arm, cannot read the PR back,
 * and cannot hand the operator a command to run: a ready PR under a re-running
 * review with no route to a draft is the exact window #1292 exists to close, so
 * the forge-undetectable decline HALTS. The three the forge itself causes — an
 * unreadable view, a view that will not say, an identity that cannot be
 * verified — are transient-blip shapes: they proceed (the pre-#1398 code made
 * the same single read and proceeded) and are recorded as plumb-reports so the
 * decline reaches the handoff rather than vanishing.
 */

import { execp } from "./exec.ts";
import type { NormalizedPullRequest } from "./forge-types.ts";
import type { Forge } from "./forge.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { CRITICAL_HOLD, readyHoldReason } from "./work-driver-draft-hold.ts";
import {
  MAX_DRAFT_REARM_ATTEMPTS,
  currentPatchIdentity,
  withPrDraft,
} from "./work-driver-draft-pr.ts";
import {
  DRAFT_REARM_CAP,
  declineUndisclosedRearm,
  rearmHold,
} from "./work-driver-draft-rearm-hold.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import { netRefProblem } from "./work-driver-net-git.ts";
import { WORK_DRIVER_REVIEW_LOOP_STEPS } from "./work-driver-review-loop-steps.ts";
import { judgePrIdentity } from "./work-driver-verify-pr17.ts";
import type { EmitSink } from "./work-state-emit.ts";
import type { WorkStep } from "./workflow-state.ts";
import { type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";

/**
 * Why a re-arm decided what it did — traced, and named in a halt.
 *
 * `{ halted: true }` is distinct from `{ skipped }`: a skip means the re-arm
 * had nothing to do and the cycle continues; a halt means the PR is mergeable,
 * the review is about to run, and the driver could not put it back — the
 * caller must stop (work-driver-lens.ts returns the state, the router reads the
 * cap and routes to handoff). Collapsing the two into one `skipped` shape is
 * what let a needed re-arm that failed be treated as a no-op.
 */
export type RearmDecision =
  | "re-armed"
  | "no-draft-fact"
  | "review-open"
  | "forge-says-draft"
  | "draft-unknown"
  | "critical-hold"
  | { skipped: "identity" | "unreadable" | "forge"; reason: string }
  | { halted: true; reason: string };

export type RearmOutcome = { state: WorkState; decision: RearmDecision };

/**
 * Re-arm the cycle's draft PR before a review round runs.
 *
 * Returns the state UNCHANGED (the same object) for every case that is not a
 * re-arming need, so a normal cycle pays one `prView` at lens entry and nothing
 * else. When the PR must become a draft again and cannot, the state carries
 * `prDraft.status = "ready-failed"` with the reason plus a `cap-hit` routed to
 * `handoff`: `markDraftPrReady` will not undo a failed ready (it only retries
 * at a concluded review) and `runMerged` refuses to merge on any non-`ready`
 * status, so the halt is reached from both directions.
 */
export async function rearmDraftForReview(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<RearmOutcome> {
  const draft = state.pipelineState.prDraft;
  // The gate is `status === "ready"`: a PR the driver never marked ready has
  // nothing to re-arm, and `ready-failed` is already a hold.
  if (!draft || draft.status !== "ready") return { state, decision: "no-draft-fact" };
  if (!reviewRerunPending(state)) return { state, decision: "review-open" };
  // #1398 adversarial (a) — a CRITICAL verdict is never marked ready over
  // (work-driver-draft-hold.ts), so a `ready` under a CRITICAL tail is a state
  // the ready path produced outside that hold, and the review that follows is
  // refused whatever the draft says. Checked WITHOUT a patch identity: with a
  // patchId the function consults the disclosure facts, which is the question
  // the ready gate answers, not this one — the CRITICAL branch short-circuits
  // before them either way. Re-arming would spend a forge round-trip to
  // manufacture a `draft-rearm-failed` handoff for a cycle that was holding
  // anyway. The CRITICAL hold wins; the re-arm stands down.
  if (readyHoldReason(state.eventLog) === CRITICAL_HOLD) {
    trace(
      "work-driver: the draft re-arm stands down — a CRITICAL finding holds the ready regardless",
    );
    return { state, decision: "critical-hold" };
  }
  const prNumber = state.pipelineState.prNumber;
  if (prNumber === undefined) return { state, decision: "no-draft-fact" };
  const forge = await resolveForge(ctx);
  if (!forge) {
    // #1398 item 3 — a cycle that cannot name its forge cannot re-arm, cannot
    // read the PR back, and cannot hand the operator a command to run: a ready
    // PR under a re-running review with no route to a draft is the exact window
    // #1292 exists to close, so this one HALTS. The record goes to the handoff
    // as well, because `explainCap` renders the cap's evidence but a plumb row
    // is what `/work-status` and the queue's own report show.
    const why =
      "the forge for this repo could not be determined, so the PR could not be made a draft again";
    // The cap-hit is the LAST event the router reads (`nextStep` routes on
    // `lastEvent.nextStep`), so the disclosure row is written FIRST and the halt
    // appends after it — tail-invariance (#533) outranks the prettier ordering.
    return rearmHold(ctx, declineUndisclosedRearm(state, now, { reason: why }), now, {
      reason: why,
    });
  }
  const own = await readOwnPr(forge, state.pipelineState.branchName, prNumber);
  if (!own.ok) {
    // #1398 adversarial (c) — the two declines are NOT the same shape. A forge
    // that cannot be determined at all (`skipped: "forge"`, below) leaves a
    // mergeable PR under a running review with no route to a draft, so it
    // halts. An unreadable PR view is the SAME read that already gates the
    // cached-fact path, and a transient `gh` blip must not park a cycle whose
    // review would otherwise run: it proceeds, with a plumb-report so the
    // decline reaches the handoff rather than vanishing (the #408 lesson — a
    // signal the driver produces and nobody reads).
    if (own.kind === "unreadable") {
      return {
        state: declineUndisclosedRearm(state, now, {
          reason: `the re-arm could not read PR #${prNumber} to check whether it was mergeable, so it was left as it stands`,
        }),
        decision: { skipped: "unreadable", reason: own.reason },
      };
    }
    return { state, decision: { skipped: own.kind, reason: own.reason } };
  }
  if (own.pr.isDraft !== false) {
    // A forge that will not say is the same transient-blip shape as an
    // unreadable view: proceed and disclose, do not park.
    if (own.pr.isDraft === undefined) {
      return {
        state: declineUndisclosedRearm(state, now, {
          reason: `the forge would not say whether PR #${prNumber} is a draft, so the re-arm could not tell whether it had to run`,
        }),
        decision: "draft-unknown",
      };
    }
    return { state, decision: "forge-says-draft" };
  }
  // #1398 round 2 — the draft direction has its OWN counter. `attempts` counts
  // `pr ready` calls and is the budget the MERGE spends (work-driver-draft-pr.ts
  // bounds ready at MAX_READY_ATTEMPTS per mark point / per cycle); a re-arm that
  // charged itself to it drained the merge's retries, so a cycle that had
  // re-armed once could not afford to mark its PR ready when its review finally
  // concluded. The bound is still real — the draft direction is bounded at
  // MAX_DRAFT_REARM_ATTEMPTS.
  //
  // #1398 round 3 — the counter is scoped to THIS review round and is charged
  // BEFORE the command issues. Two defects closed at once:
  //  - per-CYCLE: a cycle that CI-looped four times, each re-arm succeeding,
  //    spent its whole budget on conversions that WORKED and then halted — the
  //    bound had become the bug it was guarding. Each review round gets its own.
  //  - charged-on-success: a forge that refused the command every time left the
  //    counter at zero, so the bound never closed and every lens entry issued
  //    another `pr draft`. `markDraftPrReady`'s `made++` charges before the
  //    call; this now matches it, so a refusal, a read-back that throws and an
  //    unconfirmed conversion all consume the bound.
  const round = state.pipelineState.reviewRound ?? 0;
  const drafted = draft.rearmRound === round ? (draft.draftAttempts ?? 0) : 0;
  const chargeDraft = (): WorkState => {
    const held = withPrDraft(state, {
      ...draft,
      draftAttempts: drafted + 1,
      rearmRound: round,
    });
    // Durable before anything long is awaited (the same rule as the confirmed
    // re-arm's own persist below): an attempt the crash lost is an attempt the
    // next run re-issues, which is the unbounded shape the counter exists for.
    return held;
  };
  if (drafted >= MAX_DRAFT_REARM_ATTEMPTS) {
    return rearmHold(ctx, state, now, {
      reason: `this review round has already made its ${MAX_DRAFT_REARM_ATTEMPTS} draft re-arm attempts, so the driver left PR #${prNumber} as it stands rather than keep issuing forge commands that have not taken`,
    });
  }
  // Charged first, then issued — see above. Every path below inherits the
  // charge, including the halts, so the bound is real on a hostile forge.
  const charged = chargeDraft();
  try {
    await forge.prDraft(prNumber);
  } catch (err) {
    const raw = rawErrorText(err);
    trace(`work-driver: pr draft #${prNumber} (re-arm) failed: ${raw}`);
    return rearmHold(ctx, charged, now, {
      reason: `converting PR #${prNumber} back to a draft failed (${forgeFailureReason(raw)})`,
    });
  }
  // #1398 round 2 — the command is not evidence. `prDraft` resolves whenever the
  // forge CLI exits 0, and an exit-0-without-effect is exactly the failure this
  // module exists for (the forge's own adapter comment says so). So the PR is
  // read back and the state records `draft` ONLY when the forge confirms it;
  // anything else halts, because a cycle that believes its PR is a draft while
  // the forge says otherwise is a cycle whose review runs on a mergeable PR.
  const confirmed = await readOwnPr(forge, state.pipelineState.branchName, prNumber);
  if (!confirmed.ok) {
    return rearmHold(ctx, charged, now, {
      reason: `the draft command on PR #${prNumber} ran, but the PR could not be read back to confirm it (${confirmed.reason})`,
    });
  }
  if (confirmed.pr.isDraft !== true) {
    const said =
      confirmed.pr.isDraft === false ? "it reports the PR is still ready" : "it did not say";
    return rearmHold(ctx, charged, now, {
      reason: `the forge did not confirm the draft conversion on PR #${prNumber} — the \`pr draft\` command succeeded and the read-back ${said}`,
    });
  }
  trace(
    `work-driver: PR #${prNumber} re-armed as a draft (verified by the forge) — the review runs again after the PR was marked ready`,
  );
  const rearmed = withPrDraft(state, {
    ...draft,
    status: "draft",
    draftAttempts: drafted + 1,
    holdReason:
      "the review was re-run after the PR was marked ready, so the driver made it a draft again",
  });
  // #1398 adversarial (c) — persisted HERE, not only at the next step boundary.
  // The caller's very next act is the six-way lens dispatch, which runs for
  // minutes and can be killed (cap, inactivity, provider). A crash before the
  // boundary write lost the only record that the PR was put back. Same rule as
  // `recordLensResidualsPosted`: a fact a step writes is durable before that
  // step awaits anything long. A write fault is traced and swallowed — the
  // in-memory state is correct and the boundary write retries — because a disk
  // fault is not a reason to leave the PR mergeable or skip the review.
  try {
    await persistCycle(
      {
        repoRoot: ctx.repoRoot,
        emitSink: ctx.emitSink ?? silentSink,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
      rearmed,
    );
  } catch (err) {
    trace(
      `work-driver: the re-arm could not be persisted — ${rawErrorText(err)} (the cycle's state carries it; the next step boundary writes it)`,
    );
  }
  return { state: rearmed, decision: "re-armed" };
}

/**
 * A verdict that concluded, followed by a review-loop step: the signal that the
 * review has to run again. The scan stops at the FIRST `step-started` walking
 * back from the end — that is the step the cycle is entering now — so a verdict
 * concluded in a PREVIOUS loop does not re-arm a review that has already
 * finished its own (`step-started{lens-review}` immediately after the verdict
 * has no loop step before it). `handoff` is deliberately not a loop step, which
 * is what stops every handoff re-drafting: `runHandoff` appends
 * `step-started{handoff}` itself.
 */
export function reviewRerunPending(state: WorkState): boolean {
  const log = state.eventLog;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.kind !== "step-started") continue;
    if (e.step !== "lens-review") return false;
    return WORK_DRIVER_REVIEW_LOOP_STEPS.some((step) =>
      log.slice(0, i).some((prior) => prior.kind === "step-started" && prior.step === step),
    );
  }
  return false;
}

/**
 * The steps a re-review passes through between two `lens-review` entries are
 * `WORK_DRIVER_REVIEW_LOOP_STEPS` (work-driver-review-loop-steps.ts), imported
 * above and read by `reviewRerunPending`. There used to be a re-export of it
 * here too, for no importer — a second name for one list is a second thing that
 * can drift from the question it answers.
 */

/**
 * Did the re-arm halt the cycle? True when the LAST event is this cycle's
 * re-arm cap — the shape `nextStep` routes on (an unhandled cap falls through
 * the linear table, so this cap must also be in the router; see
 * work-driver.ts).
 */
export function lastCapIsRearmFailure(state: WorkState): boolean {
  const last = state.eventLog[state.eventLog.length - 1];
  return last?.kind === "cap-hit" && last.cap === DRAFT_REARM_CAP;
}

/** The cycle's forge, or `undefined` (traced) when it cannot be determined. */
async function resolveForge(ctx: DriverContext): Promise<Forge | undefined> {
  try {
    return ctx.forge ?? (await forgeForCycle(ctx, ctx.verifyExecFn ?? execp));
  } catch (err) {
    trace(`work-driver: the forge for this repo could not be determined: ${rawErrorText(err)}`);
    return undefined;
  }
}

type OwnPrRead =
  | { ok: true; pr: NormalizedPullRequest }
  | { ok: false; kind: "identity" | "unreadable"; reason: string };

/** The PR's view — only when the forge reports it as THIS cycle's open PR. */
async function readOwnPr(
  forge: Forge,
  branch: string | undefined,
  prNumber: number,
): Promise<OwnPrRead> {
  let pr: NormalizedPullRequest;
  try {
    pr = await forge.prView(prNumber);
  } catch (err) {
    const raw = rawErrorText(err);
    trace(`work-driver: could not read PR #${prNumber} — ${raw}`);
    return { ok: false, kind: "unreadable", reason: forgeFailureReason(raw) };
  }
  // The draft commands take a NUMBER, so an unverified number is a command on
  // the wrong object. `judgePrIdentity` is the develop gate's own check —
  // OPEN, and the head is this cycle's branch — and it fails closed.
  const identity = judgePrIdentity(branch, {
    state: pr.state,
    headRefName: pr.headRefName,
  });
  if (!identity.ok) {
    trace(`work-driver: PR #${prNumber} ${identity.failure} — it is not re-armed`);
    return { ok: false, kind: "identity", reason: identity.failure };
  }
  return { ok: true, pr };
}

/** The raw text of a failure — for the trace only, never the public handoff. */
export function rawErrorText(err: unknown): string {
  const stderr =
    err instanceof Error && "stderr" in err && typeof err.stderr === "string" ? err.stderr : "";
  const message = err instanceof Error ? err.message : String(err);
  return (stderr || message).trim().slice(0, 300) || "(no error text)";
}

const FORGE_FAILURE_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /auth|credential|token|log ?in|permission|forbidden|\b403\b/i,
    "the forge refused the request (authentication or permission)",
  ],
  [
    /not found|could not find|could not resolve|no pull request|\b404\b/i,
    "the forge could not find the pull request",
  ],
  [
    /timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|network|socket|rate limit|HTTP 5\d\d|service unavailable/i,
    "the forge could not be reached (network or outage)",
  ],
];

/**
 * A short, public reason for a failed forge call. The raw text — which can
 * carry a URL, a path or a token fragment from the CLI's own output — stays in
 * the trace, never in the handoff.
 */
export function forgeFailureReason(raw: string): string {
  return FORGE_FAILURE_REASONS.find(([re]) => re.test(raw))?.[1] ?? "the forge command failed";
}

/** A sink that emits nothing — for a persist whose caller has no emit stream. */
const silentSink: EmitSink = { emit: () => undefined, fingerprints: [] };
