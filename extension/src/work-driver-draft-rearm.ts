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
 *    evidence and re-arms nothing.
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
 * pre-fix patch never licenses marking the new patch ready.
 */

import { execp } from "./exec.ts";
import type { NormalizedPullRequest } from "./forge-types.ts";
import type { Forge } from "./forge.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { MAX_READY_ATTEMPTS, currentPatchIdentity, withPrDraft } from "./work-driver-draft-pr.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import { judgePrIdentity } from "./work-driver-verify-pr17.ts";
import type { EmitSink } from "./work-state-emit.ts";
import { type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";

/** Why a re-arm decided what it did — traced, and named in a halt. */
export type RearmDecision =
  | "re-armed"
  | "no-draft-fact"
  | "review-open"
  | "forge-says-draft"
  | "draft-unknown"
  | { skipped: "identity" | "unreadable" | "forge"; reason: string };

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
  const prNumber = state.pipelineState.prNumber;
  if (prNumber === undefined) return { state, decision: "no-draft-fact" };
  const forge = await resolveForge(ctx);
  if (!forge) {
    return {
      state,
      decision: {
        skipped: "forge",
        reason: "the forge for this repo could not be determined",
      },
    };
  }
  const own = await readOwnPr(forge, state.pipelineState.branchName, prNumber);
  if (!own.ok) {
    return { state, decision: { skipped: own.kind, reason: own.reason } };
  }
  if (own.pr.isDraft !== false) {
    return { state, decision: own.pr.isDraft === undefined ? "draft-unknown" : "forge-says-draft" };
  }
  const used = draft.attempts ?? 0;
  if (used >= MAX_READY_ATTEMPTS) {
    return halt(ctx, state, now, {
      reason: `this cycle has already made its ${MAX_READY_ATTEMPTS} \`pr ready\` attempts and re-arming the draft would need another, so the driver left PR #${prNumber} as it stands rather than spend the merge's retries`,
    });
  }
  try {
    await forge.prDraft(prNumber);
  } catch (err) {
    const raw = rawErrorText(err);
    trace(`work-driver: pr draft #${prNumber} (re-arm) failed: ${raw}`);
    return halt(ctx, state, now, {
      reason: `converting PR #${prNumber} back to a draft failed (${forgeFailureReason(raw)})`,
    });
  }
  trace(
    `work-driver: PR #${prNumber} re-armed as a draft — the review runs again after the PR was marked ready`,
  );
  return {
    state: withPrDraft(state, {
      ...draft,
      status: "draft",
      attempts: used + 1,
      holdReason:
        "the review was re-run after the PR was marked ready, so the driver made it a draft again",
    }),
    decision: "re-armed",
  };
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
    return REVIEW_LOOP_STEPS.some((step) =>
      log.slice(0, i).some((prior) => prior.kind === "step-started" && prior.step === step),
    );
  }
  return false;
}

/** The steps a re-review passes through between two `lens-review` entries. */
const REVIEW_LOOP_STEPS = [
  "develop",
  "adversarial",
  "commit-pr",
  "lens-fix",
  "lens-review",
] as const;

/**
 * The cap a failed re-arm records. Exported so the router, the explainer and
 * the tests name the same string the writer writes — the same discipline
 * `REVIEW_INCOMPLETE_CAP` enforces on the lens cap.
 */
export const DRAFT_REARM_CAP = "draft-rearm-failed";

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

/**
 * The halt a failed re-arm produces, in `runMerged`'s draft-hold shape: the
 * reason on `evidence` (the handoff prints it) and on `prDraft.holdReason` (so
 * `draftPrHandoffLines` says the PR is a draft and why). The cap routes to
 * `handoff`, so the cycle never advances to `ci` on this failure.
 */
function halt(
  ctx: DriverContext,
  state: WorkState,
  now: number,
  opts: { reason: string },
): RearmOutcome {
  trace(`work-driver: the draft re-arm halted the cycle — ${opts.reason}`);
  const draft = state.pipelineState.prDraft;
  const held = withPrDraft(state, {
    ...(draft ?? { status: "draft" as const }),
    status: "ready-failed" as const,
    holdReason: opts.reason,
  });
  return {
    state: appendEvent(held, {
      kind: "cap-hit",
      at: now,
      cap: DRAFT_REARM_CAP,
      reviewRound: state.pipelineState.reviewRound,
      evidence: opts.reason,
      nextStep: "handoff",
    }),
    decision: { skipped: "unreadable", reason: opts.reason },
  };
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
function rawErrorText(err: unknown): string {
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

/**
 * The findings-posted fact: the residual findings of THIS patch were disclosed
 * ON the PR. An issue-only fallback post does not count — the merge guard reads
 * PR comments only (merge-guard-round-cap.ts), so a disclosure that landed on
 * the issue has not disclosed anything for ready purposes.
 *
 * The EVENT log is the record (it is what survives a resume and what
 * `/work-status` renders); `prDraft.findingsPosted` is its mirror on the state.
 * Both are checked: a cycle whose disclosure event was recorded before a crash
 * and whose `prDraft` was rewritten afterwards still holds.
 */
export function findingsPostedForCurrentPatch(state: WorkState, patchId: string): boolean {
  const branch = state.pipelineState.branchName;
  const posted = (state.pipelineState.prDraft?.findingsPosted ?? []).some(
    (fact) => fact.patchId === patchId,
  );
  if (posted) return true;
  return state.eventLog.some(
    (e) =>
      e.kind === "lens-residuals-posted" &&
      e.target === "pr" &&
      e.patchId === patchId &&
      (branch === undefined || e.branch === branch),
  );
}

/**
 * Record that a round's residual findings reached the PR.
 *
 * The ordinary disclosure goes through lens-review-residuals.ts, which posts
 * with the merge-guard marker and returns a note naming a failure (empty on
 * success); the round-cap route posts the findings itself. Both call this, so
 * the gate and the disclosure cannot disagree about what happened — that pair
 * used to be two independent inferences, which is how a failed post came to
 * look like nothing at all.
 *
 * The patch identity is computed here, against the refs the disclosure
 * compares, and the fact is written to `pipelineState` AND persisted before this
 * returns: the caller's next act is an awaited dispatch, and a re-arm or a ready
 * decided after a crash must see the fact the pre-crash run recorded. An
 * identity that cannot be computed records nothing — an unanchored fact would
 * license a ready for a patch nobody verified.
 */
export async function recordLensResidualsPosted(
  ctx: DriverContext,
  state: WorkState,
  opts: { round: number; prNumber?: number; note?: string },
): Promise<WorkState> {
  // A note means the disclosure FAILED (that is the convention of
  // postLensResidualDisclosure's return) — the failure event belongs to
  // recordResidualsPost, which also runs the issue fallback.
  if (opts.note) return state;
  const branch = state.pipelineState.branchName;
  if (!branch) return state;
  const execFn = ctx.verifyExecFn ?? execp;
  const identity = await currentPatchIdentity(execFn, ctx.repoRoot, branch);
  if (!identity.ok) {
    trace(`work-driver: the residual-disclosure fact was not recorded — ${identity.reason}`);
    return state;
  }
  const at = Date.now();
  const fact = {
    patchId: identity.patchId,
    at,
    round: opts.round,
    ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
  };
  const next = appendEvent(
    withPrDraft(state, {
      ...(state.pipelineState.prDraft ?? { status: "draft" as const }),
      findingsPosted: [...(state.pipelineState.prDraft?.findingsPosted ?? []), fact],
    }),
    {
      kind: "lens-residuals-posted",
      at,
      round: opts.round,
      ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
      branch,
      patchId: identity.patchId,
      target: "pr",
    },
  );
  // Persisted through `persistCycle` (never `writeState`, which the #1162 seam
  // reserves for workflow-state.ts so the emit watermark never sees a persist
  // outside the sink). This helper takes a DriverContext — a step handler may
  // have no sink of its own — so the sink is supplied only when the cycle has
  // one; the write is durable either way, which is the property it exists for.
  await persistCycle(
    {
      repoRoot: ctx.repoRoot,
      emitSink: ctx.emitSink ?? silentSink,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
    next,
  );
  return next;
}

/** A sink that emits nothing — for a persist whose caller has no emit stream. */
const silentSink: EmitSink = { emit: () => undefined, fingerprints: [] };
