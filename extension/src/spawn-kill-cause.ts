/**
 * spawn-kill-cause — the kill-cause priority of the child supervision stack
 * (#543, #951, #1567, #1827). Split out of spawn-caps.ts (AGENTS.md §12).
 *
 * `resolveKillCause` is the single place that decides WHICH cause a child that
 * tripped several caps is named for. The priority and its two surprising
 * entries are documented on the function; the reason it lives beside the caps
 * rather than inside one is that every cap contributes a fact and exactly one
 * answer comes out.
 */

import type { DispatchResult } from "./types.ts";

/**
 * #543 — killCause priority: loop > inactivity = tool-inactivity >
 * token-budget > stuck-tool > no-progress > child-bound (#1567) > timeout > abort (the most specific wins — the #296
 * invariant; #296's three values are untouched). The two silence kills rank
 * equal: same poll, one budget armed at a time (#951), so their relative
 * order cannot change an outcome.
 *
 * NOTE — ordering of token-budget vs timeout is a deliberate DEVIATION from
 * the literal spec sentence ("loop > inactivity > timeout > abort"): a
 * budget-killed child that ALSO tripped the wall-clock backstop must be
 * attributed to token-budget (its retry semantics and env override differ —
 * PI_ENSEMBLE_TOKEN_BUDGET_<ROLE>, not PI_ENSEMBLE_SPAWN_TIMEOUT_MS), and the
 * budget is the more specific diagnosis of what actually cost the money.
 */
export function resolveKillCause(facts: {
  loopKilled: boolean;
  inactivityKilled: boolean;
  toolInactivityKilled: boolean;
  timedOut: boolean;
  tokenBudgetKilled: boolean;
  /** #1567 — the child-supervision kills. Optional because each enforcing
   * piece passes only its own flag (`noProgressKilled`: the inactivity poll's
   * opt-in PI_ENSEMBLE_PROGRESS_SILENCE_MS arm). */
  stuckToolKilled?: boolean;
  noProgressKilled?: boolean;
  childBoundKilled?: boolean;
  /** #2644 — the inactivity poll's stall arm ended a child whose request went quiet past the
   *  window the caller armed. Optional, like the other supervisor causes, because each enforcing
   *  piece passes only its own flag. */
  stalled?: boolean;
  aborted: boolean;
}): DispatchResult["killCause"] {
  if (facts.loopKilled) return "loop";
  // #951 — the two silence kills are ranked equal (see module doc): a poll
  // sets at most one, so the order here cannot matter.
  if (facts.inactivityKilled) return "inactivity";
  if (facts.toolInactivityKilled) return "tool-inactivity";
  // C1 — token-budget is checked BEFORE timeout: a child killed by its
  // token budget that also outlived the wall-clock backstop is a
  // token-budget kill (see the module doc + the doc comment above).
  if (facts.tokenBudgetKilled) return "token-budget";
  // #1567 — below the structural caps, above the 2-h backstop: a child the
  // supervisor ended that also outlived the backstop is named for the
  // supervisor's reason. Most specific first: a second call-kill on one
  // command, then a frozen child, then the plain per-child time limit.
  // #2644 — a request the caller's hung-request lever ended is more specific than any wall clock
  // it also outlived, so it ranks with the poll's other silence kills.
  if (facts.stalled) return "stall";
  if (facts.stuckToolKilled) return "stuck-tool";
  if (facts.noProgressKilled) return "no-progress";
  if (facts.childBoundKilled) return "child-bound";
  if (facts.timedOut) return "timeout";
  if (facts.aborted) return "abort";
  return undefined;
}
