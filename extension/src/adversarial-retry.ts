/**
 * adversarial-retry — the adversarial loop's phase retry loop (#308) and
 * the infra-failure result shaper, extracted from adversarial.ts (the
 * 500-line gate headroom for the #799 slow-watch wiring).
 */
import { classifyDispatchOutcome } from "./adversarial-classify.ts";
import { abortableSleep } from "./dispatch-retry.ts";
import type { DispatchResult } from "./types.ts";
import { retryLadderKillCause } from "./work-driver-adversarial-fanout-capkill.ts";
import { jitteredMs } from "./work-driver-failure-taxonomy.ts";

/**
 * Wall-clock budget for all retry attempts in a single adversarial phase. When
 * elapsed time reaches this limit no further retries start, preventing a
 * repeated watchdog kill from consuming its full attempt budget. Set 0 to
 * disable. Override: PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS. Default: 30 min.
 */
export function adversarialPhaseBudgetMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return 30 * 60_000;
}

type PhaseRole = "adversarial-developer" | "developer";

export type RunPhaseFn = (
  role: PhaseRole,
  tag: string,
  prompt: string,
  cwd?: string,
) => Promise<DispatchResult>;

export interface RetryCtx {
  runPhase: RunPhaseFn;
  accumulate: (r: DispatchResult) => void;
  signal: AbortSignal;
  /** Injected in tests so a provider-stated wait does not really elapse. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface InfraCtx {
  start: number;
  usage: DispatchResult["usage"];
  lastTranscript: string | undefined;
  lastModel: string | undefined;
  toRoundRecords: (rounds: never[]) => DispatchResult["adversarialRounds"];
}

/**
 * #308 — retry loop that respects cause-specific depth.
 * Provider severances get deeper retries (up to maxRetries) unless the same
 * error repeats (#79). Self-kills, quota-window/undated 429s and a missing
 * model get none; a burst 429 waits its stated delay first. Inactivity gets one.
 */
export const runPhaseWithInfraRetry = async (
  role: PhaseRole,
  tag: string,
  prompt: string,
  cwd: string | undefined,
  c: RetryCtx,
): Promise<DispatchResult> => {
  const phaseStart = Date.now();
  let current = await c.runPhase(role, tag, prompt, cwd);
  c.accumulate(current);
  let cls = classifyDispatchOutcome(current);
  if (cls.cause === "success" || c.signal.aborted) return current;
  if (!cls.shouldRetry || cls.maxRetries === 0) return current;

  // Retry up to maxRetries, subject to the aggregate wall-clock budget.
  const budget = adversarialPhaseBudgetMs();
  for (let attempt = 1; attempt <= cls.maxRetries; attempt++) {
    if (c.signal.aborted) return current;
    // Budget exhausted — stop retrying before starting another watchdog window.
    if (budget > 0 && Date.now() - phaseStart >= budget) return current;
    // #79 — a burst 429 stated how long to wait; re-spawning sooner earns the next one.
    if (cls.waitMs) await (c.sleep ?? abortableSleep)(jitteredMs(0, cls.waitMs), c.signal);
    const retry = await c.runPhase(
      role,
      `${tag}-retry${attempt > 1 ? `-${attempt}` : ""}`,
      prompt,
      cwd,
    );
    c.accumulate(retry);
    cls = classifyDispatchOutcome(retry);
    if (cls.cause === "success") return retry;
    if (!cls.shouldRetry) return retry; // cause changed (e.g. severance → self-kill)
    // #79 — two children in a row severed on the identical provider error
    // (a timeout chain): the provider is still failing the same way, and the
    // next child would too. The count travels on the result so no outer
    // layer re-dispatches it. A burst 429 is not counted — its wait is above.
    const same =
      cls.cause === "provider-severed" &&
      current.errorStop !== undefined &&
      retry.errorStop?.message === current.errorStop.message;
    if (same) return { ...retry, providerRepeats: 2 };
    current = retry;
  }
  return current;
};

/**
 * The kill cause the synthesized loop result carries: a cap kill (loop /
 * token-budget) or a watchdog kill. Both travel on the same field because both
 * are read there downstream — `capKillOutcomeFields` narrows to the two cap
 * kills for PARKING, `retryLadderKillCause` narrows to the watchdog five for
 * the LADDER — so this projection has to keep both sets and neither consumer
 * has to guess. `undefined` when the child died of anything else.
 */
function capKillOrWatchdogKillCause(r: DispatchResult): DispatchResult["killCause"] | undefined {
  const cause = r.killCause;
  if (cause === undefined) return undefined;
  // #1313 — and the stall kill, so the driver parks it instead of reading a provider fault.
  return cause === "loop" ||
    cause === "token-budget" ||
    cause === "no-progress" ||
    retryLadderKillCause(r)
    ? cause
    : undefined;
}

export const infraFailureResult = (
  round: number,
  phase: string,
  r: DispatchResult,
  cls: ReturnType<typeof classifyDispatchOutcome>,
  c: InfraCtx,
): DispatchResult => {
  // #79 — name the cause the reviewer children died of, and carry their
  // provider error out: without `errorStop` the step event is a bare
  // `dispatch-failed` the router reads as a crash, and the taxonomy never
  // sees the timeout / 429 / missing model that actually happened.
  const repeats = r.providerRepeats ? ` ×${r.providerRepeats} in a row` : "";
  const cause = cls.cause === "success" ? "" : ` (cause=${cls.cause})`;
  return {
    role: "adversarial-loop",
    ok: false,
    text: `Adversarial loop infrastructure failure: round ${round} ${phase} dispatch ${cls.headline}${repeats}${cause}. No verdict was produced — this is NOT a review rejection.`,
    ...(r.errorStop && !r.killCause ? { errorStop: r.errorStop } : {}),
    ...(r.providerRepeats ? { providerRepeats: r.providerRepeats } : {}),
    toolUses: [],
    ms: Date.now() - c.start,
    exitCode: 1,
    usage: c.usage,
    model: c.lastModel,
    transcriptPath: c.lastTranscript,
    loopOutcome: "infra-failure",
    adversarialRounds: c.toRoundRecords([] as never),
    roundsExecuted: round,
    // #543 / #1243 — thread the kill cause through the synthesized loop result.
    // Two DIFFERENT projections, both read off the same field by the fan-out:
    //  - `loop` / `token-budget` are cap kills: the aggregate parks with the
    //    fixed-literal cap INSTEAD of the generic infra cap (#543).
    //  - the watchdog causes (timeout / inactivity / tool-inactivity / abort /
    //    plan-timeout) are NOT cap kills and must not become caps — but if this
    //    projection drops them, `runOne` has no cause to thread, the outcome
    //    reaches the ladder with no structured signal, and
    //    `classifyAdversarialOutcome` falls through every `self-killed:*` branch
    //    to the `dispatch-failed-provider` default. That is #1243's own bug in
    //    the opposite direction: a self-kill buys the 60 s provider floor.
    //    `retryLadderKillCause` is the single list of which causes qualify.
    ...(capKillOrWatchdogKillCause(r) ? { killCause: capKillOrWatchdogKillCause(r) } : {}),
  };
};
