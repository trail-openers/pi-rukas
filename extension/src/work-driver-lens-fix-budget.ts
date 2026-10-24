/**
 * work-driver-lens-fix-budget — enforce the review-loop wall clock DURING the
 * fixer dispatch, not only at the next verdict boundary.
 *
 * The 90-minute budget was printed every second and never acted on. Measured on
 * A measured cycle: the status line ticked `cap 93m21s/90m`
 * … `cap 100m11s/90m`, and the cycle ended only because the operator quit Pi —
 * `session_shutdown … aborted 2 in-flight async jobs — work-driver,
 * developer:lens-fix-1`. No `cap-hit` anywhere in the stream, no handoff, and
 * `cycle.json` recorded `"cap": null, "capReason": null`.
 *
 * The reason is structural: `appendReviewCapHit` (the only writer of the
 * `lens-review-timeout` cap) is reached from `applyLensVerdict`, i.e. only AFTER a lens
 * review has returned, and `runLensFix` itself checked nothing at all. The
 * driver was awaiting a fixer that had already outlived its budget, while the
 * slow-run notice told the PM the driver "retries or parks by itself when it
 * fails". A displayed number nobody enforces is worse than no number: it
 * advertises a bound the harness does not honour.
 *
 * What changed: the cap is checked when the fix loop ENTERS a fixer. A fixer
 * started while time remains is bound to what remains, so it is killed at the
 * bound with the structured `timeout` killCause and the step fails the same way
 * any dispatch failure fails — through the step router — so no new failure mode
 * is introduced. A fixer the budget has already outlived is never dispatched at
 * all: the cycle parks with a `lens-review-timeout` cap-hit routed to handoff, which is
 * the comment + label + notification the budget always promised and never
 * produced.
 *
 * Semantics kept deliberately narrow:
 *  - The bound is only ever APPLIED to the fix loop's dispatches: `lens-fix`,
 *    and the develop pass the adversarial gate requests after a lens-fix (the
 *    one carrying `fixFindings`). No other step inherits it — an ordinary first
 *    develop pass runs uncapped.
 *  - The bound never extends a dispatch: `timeoutMs` is the MINIMUM of the
 *    caller's own bound and what the loop budget leaves.
 *  - Too little budget left to be useful (`MIN_USEFUL_MS`: 15 min for a
 *    lens-fix, 10 min for a lens round — #1567 item 6, #1242): the step is
 *    never started and a `lens-review-timeout` cap-hit routes to handoff. A
 *    lens round started at 84 of 90 min ran 27 min and its findings were
 *    never fixed; that round is now refused, and so is the fixer.
 *  - #1742 — the fixer's bound is the budget left MINUS the owed lens round's
 *    floor (`lensRoundReserveMs()`, default `MIN_USEFUL_MS["lens-review"]`).
 *    A committed fix owes a re-review; a fixer free to spend everything but
 *    the re-review broke the loop's contract at its worst moment. The refused
 *    owed round reuses the round-cap's disclosure route: adversarial approved
 *    + non-critical residuals POSTED to the PR ⇒ `ci`, anything else ⇒
 *    `handoff`. The route is additionally bound to the HEAD: it is taken only
 *    when the owed findings' verdict was produced against the commit the branch
 *    carries now (the lens round records the head it read; a lens-fix commits
 *    between the verdict and the refusal, so an H1 verdict must never license a
 *    route that merges H2). A verdict from an earlier round that a later
 *    `lens-approved` superseded is not disclosed either. By construction the
 *    owed round is refused AFTER a fix commit, so in practice this route parks;
 *    the `ci` route remains for the case where nothing moved since the verdict.
 *    The refused step and the knob are named in the cap evidence (#1695).
 *  - #1644 — the develop fix pass the adversarial gate requests is PARKED,
 *    not merely bound, when the loop has less than `MIN_USEFUL_MS.develop`
 *    PLUS the owed round's reserve left: zero dispatches with a named cap,
 *    instead of a dispatch armed at the 60-second floor and killed to produce
 *    nothing. (The pass's bound subtracts the reserve, so the fit gate must
 *    demand it too — 15m "fitting" while the bound arms 5m was the defect.)
 *  - `handoff` and `merged` are never capped: the comment is the whole point of
 *    a handoff, and merging a green PR is the cycle's payoff.
 *  - The clock itself is unchanged — `pipelineState.reviewCapStartedAt`, set
 *    on entering lens-review and persisted, so the budget survives a resume.
 *    A state file with no clock is a review that has not run: nothing to cap.
 *  - Escape hatch: `PI_ENSEMBLE_REVIEW_ENFORCE=0` restores the previous shape
 *    (budget displayed, never enforced).
 */

import { adversarialGateApproved } from "./adversarial-findings.ts";
import { notifyAgent } from "./agent-message.ts";
import { execp } from "./exec.ts";
import { REVIEW_WALL_CLOCK_ENV, reviewWallClockMs } from "./review-budget.ts";
import { isFullCommitSha } from "./review-head-sha.ts";
import { childBoundGraceMs, lensChildBoundMs } from "./spawn-child-bound.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { LENS_REVIEW_MIN_USEFUL_MS, MIN_USEFUL_MS } from "./work-driver-deadline.ts";
import { type PatchIdentity, currentPatchIdentity } from "./work-driver-draft-pr.ts";
import { discloseResidualsAndRoute } from "./work-driver-lens-cap.ts";
import { isFixerBoundKill } from "./work-driver-lens-fix-bound-land.ts";
import { lensRoundReserveMs } from "./work-driver-lens-round-budget.ts";
import {
  type WorkEvent,
  type WorkState,
  type WorkStep,
  appendEvent,
  persistCycle,
} from "./workflow-state.ts";

/** The least bound armed on a fix-loop dispatch: with the budget spent, the
 *  develop fix pass (which has no park of its own) is not left unbounded —
 *  that is the bug — nor killed at once; it is killed with the structured
 *  `timeout` killCause and the step fails through the normal router. */
export const MIN_FIX_DISPATCH_MS = 60_000;

/** Why no bound was armed — two distinct states that used to share one silence:
 *  enforcement off, or no review clock stamped (no lens round has run). */
function unboundReason(): string {
  return reviewEnforceEnabled()
    ? "no review clock on the state (no lens round has stamped it yet)"
    : `enforcement is off (${REVIEW_ENFORCE_ENV})`;
}

/** The env var `reviewEnforceEnabled` reads, spelled once so the trace and the
 *  docs name the same knob. */
export const REVIEW_ENFORCE_ENV = "PI_ENSEMBLE_REVIEW_ENFORCE";

/** Enforce the review-loop budget, or only report it? Process env is read per
 *  call so tests can flip it, matching the other escape hatches. */
export function reviewEnforceEnabled(): boolean {
  return process.env[REVIEW_ENFORCE_ENV] !== "0";
}

/** How long the loop has been running, or `undefined` when no review clock has
 *  been started yet (a cycle that has not reached lens-review). */
export function reviewElapsedMs(state: WorkState, now: number): number | undefined {
  const started = state.pipelineState.reviewCapStartedAt;
  if (typeof started !== "number" || !Number.isFinite(started)) return undefined;
  return now - started;
}

/** Is the cycle inside the review loop? A clock is stamped on entering
 *  lens-review and never cleared, so its presence — not the current step — is
 *  what says the fix loop has begun. */
export function reviewLoopActive(state: WorkState): boolean {
  return reviewElapsedMs(state, 0) !== undefined;
}

/**
 * The loop budget left, or `undefined` when enforcement is off or no review
 * clock has started (a cycle that has not reached lens-review).
 */
export function reviewRemainingMs(state: WorkState, now: number): number | undefined {
  if (!reviewEnforceEnabled()) return undefined;
  const elapsed = reviewElapsedMs(state, now);
  return elapsed === undefined ? undefined : reviewWallClockMs() - elapsed;
}

/**
 * The dispatch bound the remaining loop budget leaves, if any: `undefined`
 * when the dispatch runs uncapped (enforcement off, no review clock, or a step
 * outside the review loop), otherwise what the budget leaves — never less than
 * `MIN_FIX_DISPATCH_MS`, never more than `requestedTimeoutMs` (the cap only ever
 * shortens a dispatch). #1242 removed the band (~9 min) where this returned
 * `undefined` and a fixer ran unbound at the loop's tightest moment; every
 * fixer that is dispatched is bounded, and either outcome is traced once.
 */
export function reviewFixDispatchBoundMs(
  state: WorkState,
  step: WorkStep,
  now: number,
  requestedTimeoutMs?: number,
  /** #1789 — WHICH fixer this dispatch is, so the armed trace names the
   *  right step. Defaults to the lens-fix half of the loop. */
  /** #1789 — WHICH fixer this dispatch is, so the armed trace names the
   *  right step. Defaults to the lens-fix half of the loop. */
  fixer: FixerIdentity = "lens-fix",
): number | undefined {
  if (step !== "lens-fix") return undefined;
  const remaining = reviewRemainingMs(state, now);
  // (e) One bound line per fixer dispatch, including the un-armed case: a
  // fixer that ran with NO loop bound is exactly the fact an operator needs to
  // attribute a long kill afterwards, and previously it produced no line at all.
  if (remaining === undefined) {
    trace(`work-driver: ${fixerStepName(fixer)} fixer ran UNBOUND — ${unboundReason()}`);
    return undefined;
  }
  // #1742 — the owed lens round's floor is withheld from the fixer's bound:
  // a fixer that consumes the whole budget leaves a round that must be
  // refused at its own start gate, which is the cap the loop could not shed.
  const bound = Math.min(
    Math.max(remaining - lensRoundReserveMs(), MIN_FIX_DISPATCH_MS),
    boundCeiling(requestedTimeoutMs),
  );
  // Production attribution: a fixer killed AT its bound used to be
  // indistinguishable in the log from one killed by the role backstop, so a
  // park caused by the review budget could not be attributed to it. One line
  // per armed dispatch, naming the ceiling the caller passed, the reserve the
  // budget withheld and what the loop had left when the bound was resolved.
  trace(
    `work-driver: ${fixerStepName(fixer)} fixer armed — bound ${Math.round(bound / 60_000)}m (ceiling ${Math.round(boundCeiling(requestedTimeoutMs) / 60_000)}m, reserve ${Math.round(lensRoundReserveMs() / 60_000)}m, budget left ${Math.max(0, Math.round(remaining / 60_000))}m)`,
  );
  return bound;
}

/** Which half of the fix loop armed this bound. `reviewFixDispatchBoundMs` is
 *  called with `step: "lens-fix"` for BOTH of them (the lens-fix dispatch and
 *  the adversarial develop fix pass — `work-develop-run.ts`), because the
 *  second inherits the lens-fix bound by design. So the caller that owns the
 *  dispatch STATES its identity; it is never inferred from
 *  `pipelineState.currentStep`, which is whatever the last step left there — a
 *  develop fix pass dispatched straight after a lens-fix read as `lens-fix`
 *  and its traces named the wrong step. */
export type FixerIdentity = "lens-fix" | "develop-fix-pass";

/** The identity the adversarial develop fix pass declares (its call site spells
 *  `step: "lens-fix"`, so naming the fixer is what keeps the trace honest). */
export const FIXER_DEVELOP_PASS: FixerIdentity = "develop-fix-pass";

/** The step name a fixer trace carries, from the identity its caller declared. */
export function fixerStepName(fixer: FixerIdentity): string {
  return fixer === "develop-fix-pass" ? "develop (fix pass)" : "lens-fix";
}

/** #1779 (a): a develop fix pass killed BY the bound the review budget armed is
 *  traced with the fact the dispatch-failed event lacks — the bound. Other kills
 *  need no extra trace; the completion event already names the cause. An
 *  un-armed bound (no review clock, or enforcement off) says so rather than
 *  printing a bound of `0m` the dispatch never had. */
export function traceFixPassBoundKill(
  isReviewFixPass: boolean,
  killCause: DispatchResult["killCause"],
  boundMs: number | undefined,
): void {
  if (!isReviewFixPass || !isFixerBoundKill(killCause)) return;
  const bound =
    boundMs === undefined
      ? "ran unbound (no review clock, or PI_ENSEMBLE_REVIEW_ENFORCE=0)"
      : `${Math.round(boundMs / 60_000)}m`;
  trace(`work-driver: develop (fix pass) killed at its bound — ${killCause}, ${bound}`);
}

/** Never lengthen a dispatch the caller already bounded. */
function boundCeiling(requestedTimeoutMs?: number): number {
  return requestedTimeoutMs ?? Number.POSITIVE_INFINITY;
}

/**
 * Park before a review-loop step the loop budget cannot fit (#1567 item 6
 * applied to the loop's own clock): append a `lens-review-timeout` cap-hit,
 * move `currentStep` to `handoff`, persist, notify — and do NOT dispatch.
 * `nextStep` routes a trailing `cap-hit` on its own `nextStep`.
 *
 * Returns `state` unchanged when the step fits (enforcement off, no clock,
 * at least `MIN_USEFUL_MS[step]` of the budget left).
 */
async function parkReviewNoFit(
  ctx: CycleContext,
  state: WorkState,
  step: "lens-fix" | "lens-review" | "develop",
  now: number,
): Promise<WorkState> {
  const remaining = reviewRemainingMs(state, now);
  // #1742 — a lens-fix AND the adversarial develop fix pass each need their own
  // floor PLUS the owed round's reserve: both are bounded by
  // `reviewFixDispatchBoundMs` (which subtracts the reserve), so a step that
  // "fits" without demanding it is dispatched at a bound that cannot do useful
  // work — the 15m-fits-but-arms-5m defect. A fixer that can only run by eating
  // the re-review's floor is the #1742 shape, refused here rather than at the
  // round's own start gate.
  const base = MIN_USEFUL_MS[step] ?? 0;
  const reserve = step === "lens-review" ? 0 : lensRoundReserveMs();
  const need = base + reserve;
  if (remaining === undefined || remaining >= need) return state;
  const capMs = reviewWallClockMs();
  const elapsedMin = Math.round((capMs - remaining) / 60_000);
  const round = state.pipelineState.reviewRound;
  const what =
    step === "lens-fix"
      ? "lens-fix not dispatched"
      : step === "develop"
        ? "the adversarial fix pass (develop) was not dispatched"
        : `lens-review round ${round + 1} not started`;
  const why =
    remaining <= 0
      ? "so the step was stopped before it started rather than left running past its own printed budget"
      : `and ${Math.round(remaining / 60_000)}m of it is left — ${step} needs at least ${base / 60_000}m${reserve > 0 ? ` and ${reserve / 60_000}m of the budget is reserved for the owed lens round` : ""} to do useful work`;
  const evidence = `${what}: the review loop has run ${elapsedMin}m (round ${round}) against the ${capMs / 60_000}-minute cap (${REVIEW_WALL_CLOCK_ENV}), ${why}.`;
  trace(`work-driver: ${step} — the review loop cannot fit the step — ${evidence}`);
  // #1695 — a REFUSED owed round is not the same event as an overrun round:
  // the fix already landed, the adversarial gate has since re-checked the
  // diff, and the only thing missing is the round that would have re-flagged
  // it. That is the round-cap's own merge-worthy shape, so it takes the
  // round-cap's own route: disclose the residuals to the PR, and only if the
  // post lands does the cycle carry on to CI (a refused round whose findings
  // went undisclosed parks — same rule as work-driver-lens-cap.ts).
  let next: WorkState = state;
  let nextStep: "ci" | "handoff" = "handoff";
  let declined: string | undefined;
  if (step === "lens-review") {
    const owed = lastOwedRoundFindings(state);
    // Same bar as the round cap: non-critical findings, adversarial gate
    // approved on the current diff. A CRITICAL_ISSUES_FOUND or an unreadable
    // gate parks — the round being refused is the round that would have
    // caught it.
    if (owed && owed.verdict === "ISSUES_FOUND" && adversarialGateApproved(state.eventLog)) {
      // #1742 CRITICAL — and the verdict must describe the head the branch
      // carries NOW. The owed round is refused after a fix commit, so the
      // finding blob in hand was written against the PRE-fix head while the
      // disclosure, the ready gate and the merge all key on the post-fix one:
      // routing on it would merge a head no lens ever read. A verdict that
      // cannot be tied to the current head parks, exactly as before.
      const current = await owedVerdictOnCurrentHead(ctx, next, owed);
      if (current.ok) {
        const routed = await discloseResidualsAndRoute(ctx, next, owed.verdict, owed.findings, {
          kind: "owed-round",
          // #1774 — the round rides on the route, so the posted comment and the
          // `lens-residuals-posted` fact name the SAME round by construction.
          round: owed.round,
          budgetLeftMin: Math.max(0, Math.round(remaining / 60_000)),
          identity: current.identity,
        });
        nextStep = routed.nextStep;
        next = routed.state;
      } else {
        declined = current.reason;
        trace(
          `work-driver: lens-review-timeout — the owed round's findings are not disclosed and the cycle parks — ${current.reason}`,
        );
      }
    }
  }
  next = appendEvent(next, {
    kind: "cap-hit",
    at: now,
    cap: "lens-review-timeout",
    reviewRound: round,
    // #1742 — when the ci route was refused because the verdict belongs to a
    // head that is gone, the handoff has to say so: the findings are not merely
    // undisclosed, they are UNVERIFIED against what the PR now carries.
    evidence: declined ? `${evidence} The residuals were not disclosed: ${declined}.` : evidence,
    nextStep,
  });
  next = {
    ...next,
    pipelineState: { ...next.pipelineState, currentStep: nextStep },
  };
  await persistCycle(ctx, next);
  notifyAgent(
    ctx.host,
    `pi-rukas: /work for issue #${ctx.issue} hit the ${capMs / 60_000}-minute review-loop cap (${elapsedMin}m elapsed, round ${round}) — ${what}. ${
      nextStep === "ci"
        ? "The adversarial gate approved the fix and the outstanding findings were disclosed to the PR, so the cycle carries on to CI."
        : "Routing to handoff so the comment posts."
    }`,
  );
  return next;
}

/** The last lens round's verdict + findings blob, with the round and the head
 *  it was produced on — or `undefined` when nothing is owed to disclose. The
 *  verdict keeps the event's own narrow type (#1774): the caller's
 *  `=== "ISSUES_FOUND"` bar must not silently widen to `string`, or a renamed
 *  verdict token becomes a prose comparison nobody can see failing. */
function lastOwedRoundFindings(state: WorkState):
  | {
      verdict: Extract<WorkEvent, { kind: "lens-issues-found" }>["verdict"];
      findings: string;
      round: number;
      headSha?: string;
    }
  | undefined {
  const log = state.eventLog;
  let idx = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]?.kind === "lens-issues-found") {
      idx = i;
      break;
    }
  }
  if (idx < 0) return undefined;
  const last = log[idx] as Extract<WorkEvent, { kind: "lens-issues-found" }>;
  if (!last.findings) return undefined;
  // #1742 — the event's OWN round, not the loop's current counter: the fix the
  // refused round owes is the fix that answered THAT round, and a disclosure
  // that says "round 2" while listing round 1's findings sends the operator to
  // a review that never happened.
  //
  // A `lens-approved` after these findings supersedes them: a later round read
  // the fix and came back clean, so the findings were verified and disclosing
  // them as unverified would resurrect what the loop resolved. Park, don't post.
  if (log.slice(idx + 1).some((e) => e.kind === "lens-approved")) return undefined;
  return {
    verdict: last.verdict,
    findings: last.findings,
    round: last.round,
    ...(last.headSha ? { headSha: last.headSha } : {}),
  };
}

/**
 * #1742 — was the owed verdict produced against the head the branch carries
 * now, and can that be shown rather than assumed?
 *
 * The `ci` route hands the cycle to CI on the strength of a review; a review of
 * a head that no longer exists licenses nothing. The comparison is head-sha
 * equality against `currentPatchIdentity`'s tip — the patch id cannot serve
 * (it is content-identity by design, so a rebased branch keeps it while its
 * commits move). Anything unreadable, unrecorded, or unequal answers `ok:
 * false` and the caller parks: the pre-#1742 behaviour, which is the safe one.
 */
async function owedVerdictOnCurrentHead(
  ctx: CycleContext,
  state: WorkState,
  owed: { round: number; headSha?: string },
): Promise<{ ok: true; identity: PatchIdentity } | { ok: false; reason: string }> {
  const branch = state.pipelineState.branchName;
  if (!branch) return { ok: false, reason: "the cycle recorded no branch name" };
  // #1774 — the verdict's OWN head, only. The old `?? lensReviewedHead`
  // fallback let a state-level stamp vouch for a verdict that never recorded
  // one: the stamp moves when a later round reads a different head, so the
  // comparison could pass while the findings described an entirely different
  // commit. An unrecorded or malformed head parks (the pre-#1742 behaviour).
  const reviewed = owed.headSha;
  if (!reviewed || !isFullCommitSha(reviewed)) {
    return {
      ok: false,
      reason: `round ${owed.round}'s verdict recorded no full commit head to compare (pre-#1742 state, or a review that never resolved one)`,
    };
  }
  const execFn = ctx.verifyExecFn ?? execp;
  const identity = await currentPatchIdentity(execFn, ctx.repoRoot, branch);
  if (!identity.ok) {
    return { ok: false, reason: `the current head could not be read (${identity.reason})` };
  }
  if (!identity.headSha) {
    return { ok: false, reason: `the tip of ${branch} could not be resolved to a commit` };
  }
  if (identity.headSha !== reviewed) {
    return {
      ok: false,
      reason: `round ${owed.round} reviewed ${reviewed.slice(0, 8)} but ${branch} is now at ${identity.headSha.slice(0, 8)} — those findings were never verified against this head`,
    };
  }
  return { ok: true, identity };
}

/** The pre-dispatch park for a fixer the loop budget cannot fit (#1416, #1242). */
export function parkLensFixOverrun(
  ctx: CycleContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  return parkReviewNoFit(ctx, state, "lens-fix", now);
}

/**
 * #1644 — the pre-dispatch park for the develop fix pass the adversarial gate
 * requests after a lens-fix. That pass was BOUND (it shares the lens-fix
 * bound) but never PARKED: with no budget left it dispatched anyway and the
 * bound killed it at 60s, burning a dispatch to produce nothing. Zero
 * dispatches with a named cap beats a dispatch guaranteed to be killed.
 */
export function parkDevelopFixOverrun(
  ctx: CycleContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  return parkReviewNoFit(ctx, state, "develop", now);
}

/**
 * #1644 — does the develop fix pass fit the budget the loop has left? The
 * dispatch closure asks this BEFORE the fan-out so the step can short-circuit
 * the safety-net/verify gates the same way the deferred-leftover park does;
 * `parkDevelopFixOverrun` then records the cap with those gates skipped.
 *
 * #1742 — the bar is the pass's floor PLUS the owed round's reserve, mirroring
 * `parkLensFixOverrun` exactly: the pass is bounded by
 * `reviewFixDispatchBoundMs(..., "lens-fix", ...)`, which subtracts the
 * reserve, so a fit test that ignored it armed a dispatch with less than its
 * own floor (15m "fit", bound 5m) and the step burned a dispatch to produce
 * nothing — the #1644 defect in a different clothes. Fits when enforcement is
 * off, there is no clock, or that much budget is left.
 */
export function developFixPassFits(state: WorkState, now: number): boolean {
  const remaining = reviewRemainingMs(state, now);
  return (
    remaining === undefined || remaining >= (MIN_USEFUL_MS.develop ?? 0) + lensRoundReserveMs()
  );
}

/**
 * #1242 — the pre-start park for a lens round the loop budget cannot fit. A
 * round started at 84 min of a 90-min loop ran 27 min, and its findings were
 * posted but never fixed. The first round has no clock yet and always runs.
 */
export function parkLensRoundNoFit(
  ctx: CycleContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  return parkReviewNoFit(ctx, state, "lens-review", now);
}
