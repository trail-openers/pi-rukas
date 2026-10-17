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
 *  - The **wall-clock** cap still parks. A review that ran out of time is a
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
import { renderLensFindings } from "./lens-findings-render.ts";
import { lensResidualsMarker } from "./merge-guard-round-cap.ts";
import { trace } from "./trace.ts";
import {
  type CycleContext,
  type DriverContext,
  MAX_REVIEW_ROUNDS,
  REVIEW_WALL_CLOCK_MS,
} from "./work-driver-context.ts";
import { recordLensResidualsPosted } from "./work-driver-draft-disclosure.ts";
import { currentPatchIdentity } from "./work-driver-draft-pr.ts";
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
): string {
  const rendered = renderLensFindings(findingsBlob, verdict);
  if (rendered.length === 0) return "";
  return [
    "## Six-pass review — findings still open at the round cap",
    "",
    `The lens review ran its ${round}-round fix loop and stopped with these`,
    "outstanding. None is CRITICAL and the adversarial gate passed the diff, so the",
    "cycle carried on to CI instead of parking — but nothing listed here has been",
    "fixed. Decide them before merging.",
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
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const prNumber = state.pipelineState.prNumber;
  if (!prNumber) return { ok: false, reason: "no PR number was captured at commit-pr" };
  const body = renderResidualFindings(findingsBlob, round, verdict, marker);
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
  const file = path.join(scratchDir(ctx.repoRoot, ctx.issue), `lens-residual-round-${round}.md`);
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
    await execFn(cmd, { cwd: ctx.repoRoot, maxBuffer: 256 * 1024 });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message?.slice(0, 200) ?? "unknown error" };
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
  const wallClockExceeded = Boolean(
    ps.reviewCapStartedAt && Date.now() - ps.reviewCapStartedAt > REVIEW_WALL_CLOCK_MS,
  );
  if (round >= MAX_REVIEW_ROUNDS) {
    let next = state;
    let nextStep: "ci" | "handoff" = "handoff";
    if (
      !wallClockExceeded &&
      verdict === "ISSUES_FOUND" &&
      adversarialGateApproved(state.eventLog)
    ) {
      // #1398 round 3 — the identity is computed HERE and passed to both the
      // post and the fact, so the comment the PR carries and the record the
      // ready gate reads are keyed on the same string by construction. When it
      // cannot be computed the disclosure FAILS (no marker ⇒ no disclosure ⇒
      // park) and `recordLensResidualsPosted` records the decline as a
      // plumb-report, so the handoff explains the hold it is about to cause.
      const branch = state.pipelineState.branchName;
      const execFn = ctx.verifyExecFn ?? execp;
      const identity = branch
        ? await currentPatchIdentity(execFn, ctx.repoRoot, branch)
        : ({ ok: false, reason: "the cycle has no branch name" } as const);
      const marker =
        identity.ok && branch ? lensResidualsMarker(branch, identity.patchId) : undefined;
      if (!identity.ok) {
        trace(`work-driver: round-cap — no patch identity for the disclosure (${identity.reason})`);
      }
      const disclosed = await discloseResidualFindings(
        ctx,
        state,
        round,
        findingsBlob,
        verdict,
        marker,
      );
      if (disclosed.ok) {
        nextStep = "ci";
        // #1398 — the route that DOES disclose now records that it did. This
        // route posted the findings and recorded only its own `cap-hit`, so the
        // draft gate could not tell a disclosed cap from an undisclosed one and
        // had to guess from the cap's NAME. The fact is keyed on the patch
        // identity, so a later fix push does not inherit it. `step` names this
        // route so the recorded row says which disclosure path produced it.
        next = await recordLensResidualsPosted(ctx, next, {
          round,
          step: "lens-review",
          ...(state.pipelineState.prNumber !== undefined
            ? { prNumber: state.pipelineState.prNumber }
            : {}),
        });
      } else {
        trace(`work-driver: round-cap — residual findings undisclosed (${disclosed.reason})`);
        // #1398 round 3 — on BOTH the event log and `plumbReports`: the field is
        // what `plumbReportSection` in work-driver-handoff-markdown.ts renders,
        // so an event-only note is the #408 shape — a signal the driver produces
        // and the handoff never shows. The operator reading a parked round cap
        // has to be told it parked for want of a disclosure, not for want of a
        // converging fix loop.
        next = appendEvent(next, {
          kind: "plumb-report",
          at: Date.now(),
          step: "lens-review",
          role: "driver",
          body: ROUND_CAP_DISCLOSURE_PREFIX + disclosed.reason,
        });
        const prior = next.pipelineState.plumbReports ?? [];
        const dup = prior.some(
          (r) =>
            r.step === "lens-review" &&
            r.role === "driver" &&
            r.body === ROUND_CAP_DISCLOSURE_PREFIX + disclosed.reason,
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
                  body: ROUND_CAP_DISCLOSURE_PREFIX + disclosed.reason,
                  at: Date.now(),
                },
              ],
            },
          };
        }
      }
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
    return appendEvent(state, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "wall-clock",
      reviewRound: round,
      nextStep: "handoff",
    });
  }
  return state;
}
