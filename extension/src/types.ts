export interface DispatchSpec {
  role: string;
  prompt: string;
  cwd?: string;
  /**
   * Short tag (≤16 chars) disambiguating same-role parallel members in the
   * live dispatch deck (#136). Used by dispatch_parallel only — single
   * dispatch_specialist calls render with the bare role and ignore this.
   * When set: deck row becomes "⏳ developer[task-A] 8s bash". When
   * omitted: dispatch_parallel falls back to "developer#1", "developer#2".
   */
  label?: string;
  /**
   * Internal-only Pi model id of the form "<provider>/<model>[:thinking]"
   * or a Pi-supported glob like "*sonnet*". Reserved for future internal
   * callers. Agent-callable dispatch tools strip this field at the boundary
   * (see dispatch.ts:stripModelOverride and issue #92) — model choice for
   * subagents is user-authority-only via /ensemble-model and PI_ENSEMBLE_*
   * env vars.
   */
  model?: string;
}

export interface DispatchUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface DispatchResult {
  role: string;
  ok: boolean;
  text: string;
  toolUses: unknown[];
  ms: number;
  exitCode: number | null;
  usage?: DispatchUsage;
  /** Model id as reported by Pi (e.g. "zai-glm-4.7", "claude-sonnet-4"). */
  model?: string;
  /** Provider as reported by Pi (e.g. "cerebras", "anthropic"). */
  provider?: string;
  /** API surface as reported by Pi (e.g. "openai-completions", "anthropic-messages"). */
  api?: string;
  /**
   * Path to the child's session file (Pi native session JSON). Open with
   * `pi --session <path>` to resume/replay, or just read the file directly.
   */
  transcriptPath?: string;
  /** Where the spawn picked its model from. */
  modelSource?: "spec" | "config" | "config-default" | "role-env" | "subagent-env" | "default";
  /**
   * Set when the child exited with `stopReason: "error"` on its final
   * assistant message (provider HTTP timeout, transport failure, etc).
   * Pi turns these into a synthetic empty-content assistant message that
   * looks like a normal completion at the process level (exit 0). Without
   * this signal, the dispatch report mistakes the child's last successful
   * thinking block for the actual reply. When present, the report renders
   * as FAILED-PROVIDER-ERROR (see async-jobs.ts) and the scrollback shows
   * a distinct "terminated mid-stream" warning (see lifecycle-events.ts).
   */
  errorStop?: {
    /** stopReason from the synthetic final assistant message. */
    reason: string;
    /** errorMessage from the synthetic final assistant message, if any. */
    message?: string;
  };
  /**
   * Set when pi-ensemble itself ended the child (#296): "timeout" = per-role
   * wall-clock cap, "inactivity" = no child stdout for the inactivity window,
   * "abort" = user cancel / driver abort propagated. Downstream classification
   * MUST branch on this before errorStop/exitCode — a self-kill is never a
   * provider failure and must never be reported as one.
   */
  killCause?: "timeout" | "inactivity" | "abort";
  /**
   * #298 — set only on the SYNTHESIZED adversarial-loop result (role
   * "adversarial-loop"): "rejected" is a COMPLETED reviewer verdict (must be
   * recorded as a completion + adversarial-rejected, never as a dispatch
   * failure), "infra-failure" means a round's dispatch errored twice and no
   * verdict exists (must route through the dispatch-failure/retry machinery,
   * never be read as findings).
   */
  loopOutcome?: "approved" | "rejected" | "infra-failure";
  /** The budget (ms) that expired for killCause "timeout"/"inactivity". */
  killBudgetMs?: number;
}

/**
 * #314 — Single source of truth for 429 rate-limit detection.
 *
 * Used by: adversarial.ts (classifyDispatchOutcome), async-jobs.ts
 * (formatSingleReport + startJob lifecycle), work-driver.ts (isRateLimit429).
 *
 * Observed text: "Provider request error: Server requested 86399s retry delay (max: 60s). 429 status code (no body)"
 */
export const RATE_LIMIT_429_PATTERN = /429\s*status|retry delay.*429/i;

/** Check whether a message string indicates a 429 rate-limit. */
export function isRateLimit429Msg(msg: string | undefined): boolean {
  return msg ? RATE_LIMIT_429_PATTERN.test(msg) : false;
}

/**
 * #314 — Shared cause union for dispatch failure classification.
 * Both classifyDispatchOutcome (adversarial.ts) and classifyFailureCause
 * (work-driver.ts) must use these same names so the operator taxonomy
 * is consistent across async-jobs, adversarial loop, and work-driver.
 */
export type DispatchFailureCause =
  | "success"
  | "self-killed:timeout"
  | "self-killed:inactivity"
  | "self-killed:abort"
  | "rate-limited:429"
  | "provider-severed"
  | "crashed"
  | "crashed-unknown";

/**
 * #314 — Named constant for the adversarial loop's transient (provider-severed)
 * retry depth. Deliberately 3 (not work-driver's TRANSIENT_MAX_RETRIES=2)
 * because adversarial reviews are short-lived and the cost of a wasted retry
 * is lower than the cost of a false handoff.
 */
export const ADVERSARIAL_TRANSIENT_MAX_RETRIES = 3;

export interface AdversarialVerdict {
  status: "APPROVED" | "ISSUES_FOUND" | "CRITICAL_ISSUES_FOUND";
  findings: string;
  raw: string;
}
