/**
 * work-driver-lens-policy — #1537: the driver-side half of the review loop.
 *
 * `lens-review-policy.ts` states the policy as data (what a round IS, what a
 * scoped round may block on). This module is the half that touches a cycle:
 *
 *  - `lensFixFindingsFor` narrows the blob the ONE fix wave is given, so the
 *    fixer is handed every blocking finding and nothing else. The disclosure
 *    still carries the MEDIUM and LOW rows: disclosed is the policy's word for
 *    them, and a fixer paid to write prose is a fixer with less time for the
 *    findings that block. The blob's shape is the fixer's contract
 *    (`inlineLensFixPrompt` prints it as a JSON array of `{path, line, severity,
 *    title, suggestion}`) and the same field carries the round-cap disclosure, so
 *    the narrowing happens on a COPY of the array and never on the event or the
 *    state's own record.
 *  - `lensRoundOverBudget` is the stop that replaces the round counter. Under the
 *    policy a cycle gets one full review, one fix wave and one re-review, so the
 *    third round of the loop is the last one any route may take: it ends the
 *    review either way — to `ci` when the policy's conditions hold, to `handoff`
 *    when they do not. A round PAST it has no route, because there is nothing
 *    left for a review to conclude that the policy has not already priced; the
 *    caller that would have started one parks with the cause named. The
 *    wall-clock gate in `work-driver-lens-fix-budget.ts` still owns every time
 *    bound and is unchanged; this owns the SHAPE bound only.
 *
 * Reading it is one function over the event log, so the answer cannot depend on
 * a counter a crash, a resume or a retry might have left out of step.
 */

import { notifyAgent } from "./agent-message.ts";
import type { Finding } from "./lens-review-types.ts";
import { blockingFindings, lensPolicyOf } from "./lens-review-policy.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";

/** The rounds a policy-conforming cycle runs: one full review, one re-review. */
export const POLICY_ROUNDS = 2;

/** The cap a cycle parks under when it asks for the round past the policy's. */
export const POLICY_EXHAUSTED_CAP = "lens-policy-exhausted" as const;

/** The severity vocabulary, in rank order worst-first. A row whose severity is
 * not one of these is not a finding the policy can classify, and is left alone. */
const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

/** A row of the fixer's blob: `{path, line, severity, title, suggestion}` as
 * `inlineLensFixPrompt` prints it, i.e. a `Finding` with its non-severity fields
 * untyped. `blockingFindings` reads `severity` and nothing else, and the rows are
 * copied through untouched, so every field the fixer's prompt promises survives
 * the narrowing. */
type BlobRow = { severity: Finding["severity"] } & Record<string, unknown>;

/**
 * The findings blob the ONE fix wave is dispatched with: blocking rows only.
 *
 * A blob that cannot be parsed is passed through unchanged — a fixer that
 * receives everything is a worse outcome than a fixer that receives everything,
 * and a parse failure is the driver's, not the fixer's to suffer.
 */
export function lensFixFindingsFor(blob: string): string {
  if (!blob.trim() || blob.startsWith("(")) return blob;
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return blob;
  }
  if (!Array.isArray(parsed)) return blob;
  const rows = parsed.filter(
    (f): f is BlobRow =>
      typeof f === "object" &&
      f !== null &&
      (SEVERITIES as readonly string[]).includes((f as BlobRow).severity),
  );
  // Cast, not a re-type: the blob rows are the same JSON the review produced
  // (`Finding` objects serialised into the event), and `blockingFindings` reads
  // `severity` alone. Re-declaring `Finding` here would let the two drift.
  const blocking = blockingFindings(rows as unknown as Finding[]);
  // A blob with no blocking rows is what the policy never dispatches (no
  // blocking finding means no fix wave), so this arm is defensive: keep the
  // original text rather than send a fixer an empty list.
  if (blocking.length === 0) return blob;
  return JSON.stringify(blocking);
}

/**
 * Is the round about to start past the policy's budget?
 *
 * `round` is the number `runLens` would stamp on this round (`reviewRound + 1`).
 * Rounds 1 and 2 are the full review and its re-review; anything higher is the
 * third review a fix wave does not buy. Read from the event log's SHAPE as well
 * as the counter: a log that has already recorded the re-review has spent the
 * budget whatever the counter says, which is what keeps a resumed or retried
 * cycle from reopening a review the policy closed.
 */
export function lensRoundOverBudget(state: WorkState, round: number): boolean {
  if (round > POLICY_ROUNDS) return true;
  // `closed` — a blocking verdict whose fix wave has already been dispatched, so
  // the re-review it owes has been spent. Starting a round then is the third
  // review, and the counter can lag the log after a re-dispatch.
  return lensPolicyOf(state.eventLog).phase === "closed";
}

/**
 * Park a cycle that asked for the round past the policy's budget.
 *
 * Appends the named cap-hit, moves `currentStep` to `handoff`, persists, and
 * notifies — the same shape every other review-loop park has, so the router,
 * the handoff renderers and the headless result all read one event rather than
 * a new failure mode. Returns `state` unchanged when the round is in budget.
 */
export async function parkLensPolicyExhausted(
  ctx: CycleContext,
  state: WorkState,
  round: number,
  now: number,
): Promise<WorkState> {
  if (!lensRoundOverBudget(state, round)) return state;
  const blocking = lensPolicyOf(state.eventLog).blockingRound;
  const evidence = `a third lens round is not in the policy: one full review, one fix wave and one scoped re-review is the whole review budget (PI_ENSEMBLE_REVIEW_ROUNDS does not exist; see lens-review-policy.ts). Round ${blocking?.round ?? "?"} verdict ${blocking?.verdict ?? "?"} is the loop's final word${blocking?.headSha === undefined ? ", recorded without a head" : ` on head ${blocking.headSha.slice(0, 8)}`}.`;
  trace(`work-driver: lens-review — the policy's one re-review is spent — parking round ${round}`);
  const next = appendEvent(state, {
    kind: "cap-hit",
    at: now,
    cap: POLICY_EXHAUSTED_CAP,
    reviewRound: round,
    evidence,
    nextStep: "handoff",
  });
  const parked = {
    ...next,
    pipelineState: { ...next.pipelineState, currentStep: "handoff" as const },
  };
  await persistCycle(ctx, parked);
  notifyAgent(
    ctx.host,
    `pi-rukas: /work for issue #${ctx.issue} parked — the review budget is spent (one full review, one fix wave, one re-review) and round ${round} would be a third review. The round-${blocking?.round ?? "?"} findings are the loop's last verdict; they are in the state file.`,
  );
  return parked;
}
