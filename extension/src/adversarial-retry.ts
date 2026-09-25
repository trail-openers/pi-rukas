/**
 * adversarial-retry — the adversarial loop's phase retry loop (#308) and
 * the infra-failure result shaper, extracted from adversarial.ts (the
 * 500-line gate headroom for the #799 slow-watch wiring).
 */
import { classifyDispatchOutcome } from "./adversarial-classify.ts";
import { adversarialPhaseBudgetMs } from "./adversarial.ts";
import type { DispatchResult } from "./types.ts";

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
 * Provider severances get deeper retries (up to maxRetries).
 * Self-kills and 429 get no retries. Inactivity gets one.
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
    current = retry;
  }
  return current;
};

export const infraFailureResult = (
  round: number,
  phase: string,
  r: DispatchResult,
  cls: ReturnType<typeof classifyDispatchOutcome>,
  c: InfraCtx,
): DispatchResult => {
  return {
    role: "adversarial-loop",
    ok: false,
    text: `Adversarial loop infrastructure failure: round ${round} ${phase} dispatch ${cls.headline}. No verdict was produced — this is NOT a review rejection.`,
    toolUses: [],
    ms: Date.now() - c.start,
    exitCode: 1,
    usage: c.usage,
    model: c.lastModel,
    transcriptPath: c.lastTranscript,
    loopOutcome: "infra-failure",
    adversarialRounds: c.toRoundRecords([] as never),
    roundsExecuted: round,
    // #543 — thread a loop / token-budget cap kill through the synthesized
    // loop result so the fan-out aggregate (work-driver-adversarial.ts) can
    // park with the fixed-literal cap INSTEAD of the generic infra cap.
    ...(r.killCause === "loop" || r.killCause === "token-budget" ? { killCause: r.killCause } : {}),
  };
};
