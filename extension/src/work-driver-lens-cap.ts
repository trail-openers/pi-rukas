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

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { adversarialGateApproved } from "./adversarial-findings.ts";
import { renderLensFindings } from "./lens-findings-render.ts";
import { trace } from "./trace.ts";
import {
  type DriverContext,
  MAX_REVIEW_ROUNDS,
  REVIEW_WALL_CLOCK_MS,
} from "./work-driver-context.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

const execp = promisify(exec);

/**
 * The PR comment a round-capped cycle leaves behind.
 *
 * Deliberately the same renderer the handoff surfaces use: the operator reading
 * this on the PR and the operator reading a handoff comment should be looking
 * at the same list in the same order, worst first. Empty string when the stored
 * findings blob yields nothing renderable — the caller treats that as a failed
 * disclosure, because an empty comment discloses nothing.
 */
export function renderResidualFindings(
  findingsBlob: string | undefined,
  round: number,
  verdict: string,
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
  ].join("\n");
}

/**
 * Post the residual findings to the PR.
 *
 * Fails rather than throws, and every failure mode ends the same way for the
 * caller: no disclosure, so no routing on.
 */
async function discloseResidualFindings(
  ctx: DriverContext,
  state: WorkState,
  round: number,
  findingsBlob: string,
  verdict: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const prNumber = state.pipelineState.prNumber;
  if (!prNumber) return { ok: false, reason: "no PR number was captured at commit-pr" };
  const body = renderResidualFindings(findingsBlob, round, verdict);
  if (!body) return { ok: false, reason: "the review recorded no renderable findings" };
  const file = path.join(scratchDir(ctx.repoRoot, ctx.issue), `lens-residual-round-${round}.md`);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, "utf8");
    await (ctx.verifyExecFn ?? execp)(
      `gh pr comment ${prNumber} --body-file ${JSON.stringify(file)}`,
      { cwd: ctx.repoRoot, maxBuffer: 256 * 1024 },
    );
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
  ctx: DriverContext,
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
      const disclosed = await discloseResidualFindings(ctx, state, round, findingsBlob, verdict);
      if (disclosed.ok) {
        nextStep = "ci";
      } else {
        trace(`work-driver: round-cap — residual findings undisclosed (${disclosed.reason})`);
        next = appendEvent(next, {
          kind: "plumb-report",
          at: Date.now(),
          step: "lens-review",
          role: "driver",
          body: `Round cap with non-critical findings: could not post them to the PR (${disclosed.reason}), so the cycle parks rather than carrying undisclosed findings into CI.`,
        });
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
