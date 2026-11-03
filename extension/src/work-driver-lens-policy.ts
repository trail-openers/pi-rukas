/**
 * work-driver-lens-policy — #1537: the driver-side half of the review loop.
 *
 * `lens-review-policy.ts` states the policy as data (what a round IS, what a
 * scoped round may block on, what a fix wave may be given). This module is the
 * half that touches a cycle — the two points where the loop could keep going and
 * the policy is what stops it:
 *
 *  - `lensRoundOverBudget` refuses a THIRD review: one full review, one fix wave
 *    and one re-review is the whole budget, so the step that would start another
 *    parks with the cause named.
 *  - `nextLensFixStep` stops the FIX side by the same shape: a re-review's own
 *    verdict does not buy a second fix wave. It is the counterpart of the first,
 *    and it is what the router calls — see `nextStep`'s `lens-issues-found` arm
 *    in `work-driver-context.ts`.
 *
 * Both read the event log, never a mutable round counter, so a crash, a resume or
 * a step retry cannot leave the cycle one increment away from an extra review.
 * The wall clock, the per-child bounds and the findings memory still own every
 * time and cost bound; nothing here loosens them.
 */

import { notifyAgent } from "./agent-message.ts";
import { blockingFindings, lensFixWaveDispatched, lensPolicyOf } from "./lens-review-policy.ts";
import type { Finding } from "./lens-review-types.ts";
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
 * `inlineLensFixPrompt` prints it. `blockingFindings` reads `severity` and
 * nothing else, and rows are copied through untouched, so every field the
 * fixer's prompt promises survives the narrowing. */
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
 * third review a fix wave does not buy.
 *
 * The phase is deliberately NOT consulted here, even though the same module
 * family reads it for the cap route: `closed` is the state in which the owed
 * re-review is *about to run*, so treating it as "over budget" would refuse the
 * very round the policy requires and no cycle would ever finish its review. The
 * counter is the budget; the shape decides what the counter's last value MEANS.
 * The two readers live apart on purpose — `appendReviewCapHit` reads the shape,
 * this refuses on the count.
 */
export function lensRoundOverBudget(_state: WorkState, round: number): boolean {
  return round > POLICY_ROUNDS;
}

/**
 * Where a `lens-issues-found` tail routes: another fix wave, or no fix at all.
 *
 * Returns `"lens-fix"` only while the cycle still owes the re-review its ONE fix
 * wave was bought for — i.e. a blocking verdict is outstanding and no fixer has
 * been dispatched for it (`lensFixWaveDispatched`, which reads the log the way
 * `lensPolicyOf` does). Once a wave has run, a further blocking verdict is the
 * re-review's own answer and the loop is over: dispatching a second fixer would
 * buy a third review, which `lensRoundOverBudget` then refuses, and the cycle
 * would end having paid for a fix nobody re-read. `"handoff"` is what the router
 * uses for that; `appendReviewCapHit` is the one that decides ci-vs-handoff.
 *
 * The wave's ground truth is the DISPATCH, not the `lens-fix-rereviewed` record:
 * that one is written only when the fixer committed (a fixer that committed
 * nothing leaves the head unchanged, and the round stays owed so the budget is
 * not spent), which is right for the review budget and wrong for the dispatch
 * gate — re-dispatching a fixer that already ran and committed nothing is the
 * spinning the dispatch bound exists to stop.
 *
 * The budget's other stop (a round the wall clock cannot fit) is unaffected:
 * `work-driver-lens-fix-budget.ts` owns the clock and is unchanged.
 */
export function nextLensFixStep(state: WorkState): "lens-fix" | "handoff" {
  return lensFixWaveDispatched(state.eventLog) ? "handoff" : "lens-fix";
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
  const evidence = `a third lens round is not in the policy: one full review, one fix wave and one scoped re-review is the whole review budget. Round ${blocking?.round ?? "?"} verdict ${blocking?.verdict ?? "?"} is the loop's final word${blocking?.headSha === undefined ? ", recorded without a head" : ` on head ${blocking.headSha.slice(0, 8)}`}.`;
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
