/**
 * work-driver-lens-cap — what the review cap records, where it routes, and
 * what it discloses on the way.
 *
 * `nextStep` is a pure function of state and cannot write, so it routes a
 * cap-hit by reading the event itself (`lastEvent.nextStep`). That makes this
 * module the only place a capped review's destination is decided.
 *
 * **The round cap used to park work that was merge-worthy.** Measured: two of
 * six outcomes in one overnight run died at
 * `lens-issues-found → cap-hit{round-cap} → handoff`. A human then judged #457
 * merge-as-is, and #680's PR merged unchanged. Each park cost a re-run plus
 * operator time, for a diff that was already fine.
 *
 * So a round cap now routes to `ci` when the review's verdict is
 * `ISSUES_FOUND`. Three conditions keep that from being a rubber stamp:
 *
 *  - `CRITICAL_ISSUES_FOUND` still parks. A critical finding is the case the
 *    cap exists for, and no amount of "the human agreed last time" applies.
 *  - The **lens-review-timeout** cap (the loop's own wall clock) still parks.
 *    A review that ran out of time is a
 *    different signal from one that ran out of rounds: it says nothing about
 *    how small the remaining findings are, only that the loop was slow.
 *  - The residual findings are posted to the PR **first**, and a disclosure
 *    that fails parks. A PR that silently swallows three rounds of unresolved
 *    findings is worse than a park, so the disclosure is the condition for
 *    routing on, not a courtesy alongside it.
 *
 * Routing to `ci` does not merge anything. The cycle still passes the CI gate
 * and then `runMerged`'s merge-authority gate, which is default-deny and needs
 * an operator grant plus executed `gh` evidence; without a grant it parks as
 * `awaiting-human-merge` with the PR open. This module changes where a capped
 * cycle goes, never what it is permitted to do when it gets there.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { adversarialGateApproved } from "./adversarial-findings.ts";
import { execp } from "./exec.ts";
import { FORGE_EXEC_TIMEOUT_MS } from "./forge-detect.ts";
import { renderLensFindings } from "./lens-findings-render.ts";
import { lensResidualsMarker } from "./merge-guard-round-cap.ts";
import { reviewWallClockMs } from "./review-budget.ts";
import { trace } from "./trace.ts";
import { type CycleContext, type DriverContext, MAX_REVIEW_ROUNDS } from "./work-driver-context.ts";
import { recordLensResidualsPosted } from "./work-driver-draft-disclosure.ts";
import { type PatchIdentity, currentPatchIdentity } from "./work-driver-draft-pr.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * The PR comment a round-capped cycle leaves behind.
 *
 * Deliberately the same renderer the handoff surfaces use: the operator reading
 * this on the PR and the operator reading a handoff comment should be looking
 * at the same list in the same order, worst first. Empty string when the stored
 * findings blob yields nothing renderable — the caller treats that as a failed
 * disclosure, because an empty comment discloses nothing.
 *
 * #1398 round 3 — the caller passes the patch identity in and the marker goes on
 * the END of the body, exactly as `lens-review-residuals.ts` appends it. The
 * disclosure is only a disclosure if the PR carries the identity the guard and
 * the draft gate both compare: a body without the marker is prose that reads
 * like a disclosure and is invisible to both readers, and the round-cap route
 * used to post precisely that while recording the `lens-residuals-posted` fact.
 * The fact then licensed a ready the PR itself could not show.
 */
export function renderResidualFindings(
  findingsBlob: string | undefined,
  round: number,
  verdict: string,
  marker?: string,
  wording?: { owedRound: true; budgetLeftMin: number },
): string {
  const rendered = renderLensFindings(findingsBlob, verdict);
  if (rendered.length === 0) return "";
  return [
    // #1742 — the owed-round route says what actually happened. A round-cap
    // text on this route told the operator the fix LOOP had stopped, when it
    // was the re-review that never started, and named the wrong round.
    ...(wording?.owedRound
      ? [
          `## Six-pass review — findings from round ${round} unverified against the current head`,
          "",
          `The re-review of round ${round}'s fix was refused with ${wording.budgetLeftMin}m of review`,
          `budget left; these findings from round ${round} are unverified against the current`,
          "head. None is CRITICAL and the adversarial gate passed the diff, so the cycle carried",
          "on to CI instead of parking — but nothing listed here has been verified since the fix.",
          "Decide them before merging.",
        ]
      : [
          "## Six-pass review — findings still open at the round cap",
          "",
          `The lens review ran its ${round}-round fix loop and stopped with these`,
          "outstanding. None is CRITICAL and the adversarial gate passed the diff, so the",
          "cycle carried on to CI instead of parking — but nothing listed here has been",
          "fixed. Decide them before merging.",
        ]),
    "",
    ...rendered,
    // The marker is the renderer's own line (never passed through the
    // neutraliser, never sourced from a finding) and is what
    // `prCarriesDisclosure` / `mergeGuardRoundCap` substring-match.
    ...(marker ? ["", marker, ""] : []),
  ].join("\n");
}

/**
 * The round cap's undisclosed-disclosure plumb line, as one constant: the
 * event body and the `plumbReports` row are the same string, and the dedupe
 * compares against it. Kept prefix + reason so a test can pin the prefix while
 * the reason stays whatever the post actually reported.
 */
export const ROUND_CAP_DISCLOSURE_PREFIX =
  "Round cap with non-critical findings: could not post them to the PR (";

/**
 * #1742 — the owed round's own prefix. The step that was refused is the
 * re-review a fix owed, not the round cap, so the plumb report the handoff
 * renders must name the gate that actually refused it (a "Round cap" line on a
 * wall-clock refusal sends the operator to the wrong gate — the #398 class of
 * bug).
 */
export const OWED_ROUND_DISCLOSURE_PREFIX =
  "Refused lens re-review with non-critical findings: could not post them to the PR (";

/**
 * How one disclosure route words its comment, its trace lines and its plumb
 * report. Both routes share the mechanics (identity, marker, fact, decline);
 * only the prose differs, and the prose is what the operator reads. #1774 —
 * a DISCRIMINATED union: `kind` selects every wording/label/suffix in one
 * derivation (`routeShape`), so a field cannot arrive on the wrong route and
 * no caller can assemble a half-owed route by omission.
 */
export type ResidualDisclosureRoute =
  | {
      kind: "round-cap";
      /** #1774 — the round the comment names and the fact records. On BOTH arms
       *  now: the round used to be a positional argument beside the route, so
       *  the loop counter and the round the findings came from could disagree
       *  between the posted comment and the recorded fact. */
      round: number;
      /** The identity already computed by the caller's own gate, so the
       *  disclosure is keyed on the SAME string the route was licensed on
       *  rather than a second git read that could disagree with the first
       *  (#1742). Absent ⇒ computed here. */
      identity?: PatchIdentity;
    }
  | {
      kind: "owed-round";
      /** Minutes of review budget left at the refusal — the owed-round wording
       *  names it, so it must not be omissible. */
      budgetLeftMin: number;
      /** The round whose findings are disclosed: the comment names it, so the
       *  route carries it rather than trusting a positional argument. */
      round: number;
      /** Required: the owed route is only reachable after
       *  `owedVerdictOnCurrentHead` computed it — the disclosure keys on the
       *  SAME string the head gate licensed on (#1742). */
      identity: PatchIdentity;
    };

/** Everything the two routes differ on, derived from `kind` in ONE place
 *  (#1774): prefix, trace label, comment wording, scratch-file suffix, and the
 *  round both the comment and the fact name. A new route-shape field is added
 *  here or not at all. */
function routeShape(route: ResidualDisclosureRoute): {
  prefix: string;
  traceLabel: string;
  scratchSuffix: string;
  commentRound: number;
  wording?: { owedRound: true; budgetLeftMin: number };
} {
  if (route.kind === "owed-round") {
    return {
      prefix: OWED_ROUND_DISCLOSURE_PREFIX,
      traceLabel: "lens-review-timeout",
      // The owed-round post is a different comment on a different subject (one
      // round's unverified findings, not the loop's residuals) — it must not
      // overwrite the round-cap file of the same round number.
      scratchSuffix: "-owed",
      commentRound: route.round,
      wording: { owedRound: true, budgetLeftMin: route.budgetLeftMin },
    };
  }
  return {
    prefix: ROUND_CAP_DISCLOSURE_PREFIX,
    traceLabel: "round-cap",
    scratchSuffix: "",
    commentRound: route.round,
  };
}

/**
 * The one disclosure path the two cap routes share (#1742).
 *
 * `appendReviewCapHit`'s round-cap branch and `parkReviewNoFit`'s refused-owed-
 * round branch answer the same question — *can these findings be disclosed, and
 * what does the answer license?* — and must not drift: same patch identity
 * computed here and passed to both the post and the fact, same marker rule (no
 * marker ⇒ failed disclosure), same `lens-residualsPosted` fact on success, same
 * plumb-report on failure. The owed round the fixer starved is the round-cap's
 * merge-worthy shape once the adversarial gate has since re-checked the diff
 * AND the verdict still describes the current head, so it earns the same `ci`
 * route — under the same disclosure precondition.
 *
 * Returns the route the caller's cap-hit should carry and the state carrying
 * the fact (or the decline). It does NOT append the cap-hit: the caller owns
 * the cap kind, evidence, and its own routing rules (wall-clock still parks).
 */
export async function discloseResidualsAndRoute(
  ctx: CycleContext,
  state: WorkState,
  verdict: string,
  findingsBlob: string,
  route: ResidualDisclosureRoute,
): Promise<{ nextStep: "ci" | "handoff"; state: WorkState }> {
  // #1774 — every route-varying string (plumb prefix, trace label, comment
  // wording, scratch suffix, AND the round) comes from `routeShape`, keyed on
  // `kind`. The round is no longer a positional argument beside the route, so
  // the comment and the fact cannot name different rounds.
  const shape = routeShape(route);
  const label = shape.traceLabel;
  const prefix = shape.prefix;
  // #1398 round 3 — the identity is computed HERE and passed to both the post
  // and the fact, so the comment the PR carries and the record the ready gate
  // reads are keyed on the same string by construction. When it cannot be
  // computed the disclosure FAILS (no marker ⇒ no disclosure ⇒ park) and
  // `recordLensResidualsPosted` records the decline as a plumb-report, so the
  // handoff explains the hold it is about to cause.
  const branch = state.pipelineState.branchName;
  const execFn = ctx.verifyExecFn ?? execp;
  const identity: PatchIdentity =
    route.identity ??
    (branch
      ? await currentPatchIdentity(execFn, ctx.repoRoot, branch)
      : ({ ok: false, reason: "the cycle has no branch name" } as const));
  const marker = identity.ok && branch ? lensResidualsMarker(branch, identity.patchId) : undefined;
  if (!identity.ok) {
    trace(`work-driver: ${label} — no patch identity for the disclosure (${identity.reason})`);
  }
  const disclosed = await discloseResidualFindings(
    ctx,
    state,
    shape.commentRound,
    findingsBlob,
    verdict,
    marker,
    shape,
  );
  if (disclosed.ok) {
    // #1398 — the route that DOES disclose now records that it did. This route
    // posted the findings and recorded only its own `cap-hit`, so the draft
    // gate could not tell a disclosed cap from an undisclosed one and had to
    // guess from the cap's NAME. The fact is keyed on the patch identity, so a
    // later fix push does not inherit it. #1774: `step` is the step the
    // disclosure ran under — `lens-review` for BOTH routes (the owed-round
    // route refuses a lens round too), so the row distinguishes patches by
    // their identity, not disclosure paths by their step.
    return {
      nextStep: "ci",
      state: await recordLensResidualsPosted(ctx, state, {
        // #1774 — the SAME round the comment above names (`shape.commentRound`
        // is what `renderResidualFindings` was handed), so the operator and the
        // ready gate never read two different round numbers for one disclosure.
        round: shape.commentRound,
        step: "lens-review",
        // #1774 — the identity this disclosure was keyed on: the fact and the
        // marker on the posted comment come from ONE git read, so the ready
        // gate can never read a fact recorded against a tip the comment does
        // not carry.
        ...(identity.ok ? { identity } : {}),
        ...(state.pipelineState.prNumber !== undefined
          ? { prNumber: state.pipelineState.prNumber }
          : {}),
      }),
    };
  }
  trace(`work-driver: ${label} — residual findings undisclosed (${disclosed.reason})`);
  // #1398 round 3 — on BOTH the event log and `plumbReports`: the field is
  // what `plumbReportSection` in work-driver-handoff-markdown.ts renders, so an
  // event-only note is the #408 shape — a signal the driver produces and the
  // handoff never shows. The operator reading a parked cap has to be told it
  // parked for want of a disclosure, not for want of a converging fix loop.
  let next = appendEvent(state, {
    kind: "plumb-report",
    at: Date.now(),
    step: "lens-review",
    role: "driver",
    body: prefix + disclosed.reason,
  });
  const prior = next.pipelineState.plumbReports ?? [];
  const dup = prior.some(
    (r) => r.step === "lens-review" && r.role === "driver" && r.body === prefix + disclosed.reason,
  );
  if (!dup) {
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        plumbReports: [
          ...prior,
          {
            step: "lens-review",
            role: "driver",
            body: prefix + disclosed.reason,
            at: Date.now(),
          },
        ],
      },
    };
  }
  return { nextStep: "handoff", state: next };
}

/**
 * Post the residual findings to the PR.
 *
 * Fails rather than throws, and every failure mode ends the same way for the
 * caller: no disclosure, so no routing on.
 */
async function discloseResidualFindings(
  ctx: CycleContext,
  state: WorkState,
  round: number,
  findingsBlob: string,
  verdict: string,
  marker: string | undefined,
  shape: ReturnType<typeof routeShape>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const prNumber = state.pipelineState.prNumber;
  if (!prNumber) return { ok: false, reason: "no PR number was captured at commit-pr" };
  const body = renderResidualFindings(findingsBlob, round, verdict, marker, shape.wording);
  if (!body) return { ok: false, reason: "the review recorded no renderable findings" };
  if (!marker) {
    // item 1 — a body with no marker discloses nothing the guard or the draft
    // gate can see, so it is a failed disclosure and the cycle parks rather than
    // carrying findings into CI under a comment that only looks like a
    // disclosure. Fail closed, named.
    return {
      ok: false,
      reason:
        "the patch identity could not be computed, so the comment would carry no disclosure marker " +
        "(git merge-base against the branch/mainline refs is what failed)",
    };
  }
  const file = path.join(
    scratchDir(ctx.repoRoot, ctx.issue),
    // The suffix comes from the route shape (#1774): the owed-round post is a
    // different comment on a different subject and must not overwrite the
    // round-cap file of the same round number.
    `lens-residual-round-${round}${shape.scratchSuffix}.md`,
  );
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, "utf8");
    // The adapter has no PR-comment method (S2 named issue-comment, not
    // PR-comment), so this is one of the sites that stays a direct command:
    // the GitHub-shaped one the test suite pins, with the GitLab MR-note
    // equivalent as the forge-agnostic sibling.
    const execFn = ctx.verifyExecFn ?? execp;
    const forge = await forgeForCycle(ctx, execFn);
    const cmd =
      forge?.forge === "gitlab"
        ? `glab mr note ${prNumber} --body-file ${JSON.stringify(file)}`
        : `gh pr comment ${prNumber} --body-file ${JSON.stringify(file)}`;
    // #1774 — BOUNDED, and the bound is the disclosure's own: an unbounded
    // `gh pr comment` against a stalled API hangs the whole budget-park path
    // (this post is what licenses the `ci` route, so a hang is neither a
    // disclosure nor a refusal). A rejection — the timeout included — lands in
    // the catch below as `{ ok: false }`, which parks; it never routes on.
    // `FORGE_EXEC_TIMEOUT_MS` is the shared forge-exec bound (the merge guard
    // and the forge detector's remote resolution already pass it).
    await execFn(cmd, {
      cwd: ctx.repoRoot,
      maxBuffer: 256 * 1024,
      timeout: FORGE_EXEC_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: (err as Error).message?.slice(0, 200) ?? "unknown error",
    };
  }
}

/**
 * Record the review cap that is about to route this cycle, and route it.
 *
 * `nextStep` reads the same fields to do the routing, so the two cannot
 * disagree about whether a cap fired — but only this function can write, which
 * is why the destination is decided here and carried on the event.
 *
 * Returns the state unchanged when no cap applies; the caller's tail is then
 * still `lens-issues-found` and the loop goes round again into lens-fix.
 */
export async function appendReviewCapHit(
  ctx: CycleContext,
  state: WorkState,
  round: number,
  verdict: string,
  findingsBlob: string,
): Promise<WorkState> {
  const ps = state.pipelineState;
  // Both caps can be true at once, and when they are the stricter one must win.
  // Evaluated up front rather than in the `if` below it, because that branch
  // RETURNS: checking wall-clock afterwards would let a review that had ALSO
  // blown its time budget route to `ci`, which is precisely the case the
  // wall-clock cap exists for. Running out of rounds says the fix loop is not
  // converging; running out of time says nobody knows what it is doing.
  const now = Date.now();
  const capMs = reviewWallClockMs();
  const wallClockExceeded = Boolean(ps.reviewCapStartedAt && now - ps.reviewCapStartedAt > capMs);
  if (round >= MAX_REVIEW_ROUNDS) {
    let next = state;
    let nextStep: "ci" | "handoff" = "handoff";
    if (
      !wallClockExceeded &&
      verdict === "ISSUES_FOUND" &&
      adversarialGateApproved(state.eventLog)
    ) {
      const routed = await discloseResidualsAndRoute(ctx, next, verdict, findingsBlob, {
        kind: "round-cap",
        round,
      });
      nextStep = routed.nextStep;
      next = routed.state;
    }
    return appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "round-cap",
      reviewRound: round,
      nextStep,
    });
  }
  if (wallClockExceeded) {
    // #1384 — the reason rides on the event, not only in the handoff's prose:
    // the headless result's `failure.message` is the evidence's first line, and
    // a host records that as the cap's reason.
    const elapsedMin = Math.round((now - (ps.reviewCapStartedAt ?? now)) / 60_000);
    return appendEvent(state, {
      kind: "cap-hit",
      at: now,
      cap: "lens-review-timeout",
      reviewRound: round,
      evidence: `lens-review fix loop ran ${elapsedMin}m (round ${round}) against its ${capMs / 60_000}-minute budget (PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS); parked at the verdict.`,
      nextStep: "handoff",
    });
  }
  return state;
}
