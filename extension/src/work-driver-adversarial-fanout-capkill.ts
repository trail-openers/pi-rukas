import type { DispatchResult } from "./types.ts";
import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";

/**
 * #543 — the cap-kill fields of an AdversarialOutcome: the killCause
 * (loop / token-budget) and its structured trigger evidence from
 * the inner spawn's DispatchResult. Empty when the result carries no cap
 * kill. Split from runOne's return (AGENTS.md §12 file-size limit).
 */
export function capKillOutcomeFields(result: DispatchResult): Partial<AdversarialOutcome> {
  if (result.killCause === "loop") {
    return {
      killCause: "loop",
      ...(result.loopEvidence ? { loopEvidence: result.loopEvidence } : {}),
    };
  }
  if (result.killCause === "token-budget") {
    return {
      killCause: "token-budget",
      ...(result.tokenBudget ? { tokenBudget: result.tokenBudget } : {}),
    };
  }
  return {};
}

/**
 * #1243 — the watchdog kill causes, threaded onto the outcome for the RETRY
 * LADDER alone. `capKillOutcomeFields` deliberately does NOT carry these: it
 * also drives `capHitForCapKill`, whose whole point is that a cap kill parks
 * with a FIXED-LITERAL cap instead of the generic infra cap, and promoting an
 * inactivity kill to that path would change what the operator's state file
 * says — a contract #543 settled. This is the narrower question "how long do we
 * sit out before re-dispatching?", which the ladder answers from the cause.
 *
 * Without it the ladder cannot see the kill at all. `runOne` sets `infra: true`
 * and leaves `errorTail` empty for a watchdog kill, so
 * `classifyAdversarialOutcome` fell through to the `dispatch-failed-provider`
 * default and returned `provider-severed` — a cause #1243's minutes floor is
 * keyed on. Measured on test-work-driver-adv-retry-357 T8: the four bounded
 * attempts slept 2 × 60 s + 2 × 120 s and the cycle's elapsed went from ~0.5 s
 * to ~130 s. That is the inverse of what the issue asked for — it is a SELF-KILL
 * (pi-rukas ended its own child for going silent), and the taxonomy's own rule
 * keeps a self-kill on the linear ladder precisely because waiting minutes does
 * not un-hang a hung child. The structured cause existed on the DispatchResult
 * the whole time; the projection dropped it.
 *
 * The union is DERIVED from `DispatchResult["killCause"]` rather than written
 * out: a new kill cause added to the spawn's union is then a compile error here
 * until this list says whether it belongs to the ladder. An inlined copy of the
 * vocabulary is exactly what drifts silently.
 */
type RetryLadderKillCause = Exclude<
  NonNullable<DispatchResult["killCause"]>,
  "loop" | "token-budget" | SupervisionKillCause
>;

/**
 * #1567 — the child-supervision kills are off the ladder: each ends a child
 * the driver judged done with its time or frozen, and retrying it buys the
 * same bound again. The piece that emits a cause moves it onto the ladder if
 * its policy says a retry helps.
 */
type SupervisionKillCause = "child-bound" | "no-progress" | "stuck-tool";

const RETRY_LADDER_KILL_CAUSES: readonly RetryLadderKillCause[] = [
  "timeout",
  "inactivity",
  "tool-inactivity",
  "abort",
  "plan-timeout",
] as const;

function isRetryLadderKillCause(cause: string): cause is RetryLadderKillCause {
  return (RETRY_LADDER_KILL_CAUSES as readonly string[]).includes(cause);
}

/**
 * The watchdog kill to put on the outcome for the ladder, or `undefined`.
 *
 * `loop` / `token-budget` are deliberately EXCLUDED rather than filtered by a
 * membership test alone: `runOne` spreads `capKillOutcomeFields` immediately
 * before this, and those two carry `loopEvidence` / `tokenBudget` alongside the
 * cause. Re-spreading a bare `killCause` for them would overwrite the
 * evidence-bearing entry with a thinner one, and `capHitForCapKill` reads that
 * evidence. A predicate over a string-typed array narrows where `Array.includes`
 * alone cannot.
 */
export function retryLadderKillCause(result: DispatchResult): RetryLadderKillCause | undefined {
  const cause = result.killCause;
  return cause !== undefined && isRetryLadderKillCause(cause) ? cause : undefined;
}
