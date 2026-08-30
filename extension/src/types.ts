export interface DispatchSpec {
  role: string;
  prompt: string;
  cwd?: string;
  /**
   * #573 — caller-supplied runId so the transcript path can be derived BEFORE
   * spawn, allowing crash-resume to locate the surviving session file.
   * spawn.ts mints a new runId when this is absent (default behaviour unchanged).
   */
  runId?: string;
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
  /**
   * Tool calls counted live from the event stream, when the replay carried
   * none. A child killed mid-flight reports `toolUses: []` because
   * `agent_end.messages` holds only the last retry segment — but it may well
   * have made dozens. Set only when it did, so "no tool calls" stays distinct
   * from "we could not tell".
   */
  observedToolCalls?: number;
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
  /**
   * #543 — "loop" = the F1 loop detector killed a repeating (tool, args) call;
   * "token-budget" = the F6 cumulative token budget was crossed. Both are
   * self-inflicted caps, never a provider fault — a looped/budgeted child is
   * retried exactly zero times (unlike "inactivity", which is a genuine hang).
   */
  killCause?: "timeout" | "inactivity" | "abort" | "loop" | "token-budget";
  /**
   * #298 — set only on the SYNTHESIZED adversarial-loop result (role
   * "adversarial-loop"): "rejected" is a COMPLETED reviewer verdict (must be
   * recorded as a completion + adversarial-rejected, never as a dispatch
   * failure), "infra-failure" means a round's dispatch errored twice and no
   * verdict exists (must route through the dispatch-failure/retry machinery,
   * never be read as findings).
   */
  loopOutcome?: "approved" | "rejected" | "infra-failure";
  /**
   * #485 — the reviews the loop actually ran, with each round's parsed
   * verdict (or its parse failure), plus the total rounds executed when the
   * loop exited without a verdict (infra-failure / incomplete). Threaded
   * from the loop as DATA instead of being recovered from the reply prose —
   * `parseAdversarialRounds` guessing 3 from an infra-failure string was
   * issue #478's "3 rounds, all rejected" handoff. The driver records
   * these verbatim per workstream (`adversarial-round` events) so the gate
   * is auditable from the state file without a transcript.
   */
  adversarialRounds?: Array<{
    round: number;
    status: AdversarialVerdictStatus;
    verdictParsed: boolean;
  }>;
  /** Total review rounds executed; present when the loop exited with no verdict. */
  roundsExecuted?: number;
  /** The budget (ms) that expired for killCause "timeout"/"inactivity". */
  killBudgetMs?: number;
  /**
   * #543 — set when killCause is "loop". The structured trigger evidence the
   * F1 detector had at kill time: the tool name and the streak count.
   * `buildCompletionEvent` uses this so the state-file errorTail names WHAT
   * looped, not just the cause. Absent for every other killCause.
   */
  loopEvidence?: { tool: string; count: number };
  /**
   * #543 — set when killCause is "token-budget". The F6 budget + the
   * cumulative tokens observed at the kill. Absent for every other killCause.
   */
  tokenBudget?: { budget: number; used: number };
  /**
   * What the child last emitted before we killed it. Present only on a kill.
   *
   * A bare cause cannot distinguish a child that went quiet after forty tool
   * calls — a genuine hang mid-work — from one that never said anything at all,
   * which is a provider stall, an auth failure or a bad model id. Those need
   * opposite responses. `linesSeen: 0` is the tell.
   */
  lastActivity?: { kind: string; agoMs: number; linesSeen: number };
  /**
   * Set when the model emitted thinking blocks but no text blocks (issue #5).
   * Some thinking-heavy models (e.g. cerebras/gpt-oss-120b on trivial prompts)
   * produce only thinking content without text output. This is informational —
   * the resolved text field contains a clear "(thinking content only - no text output)"
   * message to distinguish this from actual "no output".
   */
  thinkingOnly?: boolean;
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
 * #366 — the seconds the provider asked us to wait.
 *
 * The discriminator between "clears in a minute" and "clears tomorrow" is
 * right there in the message and was never read, so a per-minute token-bucket
 * 429 and a 24-hour quota exhaustion were handled identically: kill the cycle
 * and tell the operator "retrying cannot help". On the observed
 * `"Server requested 86399s retry delay (max: 60s)"` shape, note that the
 * SERVER-requested value is the one that matters — `max:` is Pi's own ceiling
 * and describes what it was willing to wait, not what the provider asked for.
 *
 * Returns undefined when no delay is stated, which keeps the conservative
 * pre-#366 handling for messages we cannot read.
 */
export function parseRetryDelaySeconds(msg: string | undefined): number | undefined {
  if (!msg) return undefined;
  const m = msg.match(/requested\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\s+retry\s+delay/i);
  const n = m?.[1] ? Number.parseFloat(m[1]) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Wording that means a spend cap, not a rate limit — waiting will not clear it. */
const SPEND_CAP_PATTERN = /spend (?:cap|limit)|billing|credit balance|quota exceeded for|payment/i;

export function isSpendCapMsg(msg: string | undefined): boolean {
  return msg ? SPEND_CAP_PATTERN.test(msg) : false;
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
  /** 429 with no parseable delay — conservative pre-#366 handling: halt. */
  | "rate-limited:429"
  /** #366 — 429 whose requested delay is short enough to wait out in-cycle. */
  | "rate-limited:burst"
  /** #366 — 429 whose requested delay is hours away (daily/org quota). */
  | "rate-limited:quota-window"
  /** #366 — spend cap. Waiting genuinely does not help. */
  | "rate-limited:quota-terminal"
  | "provider-severed"
  /** #543 — the F1 loop detector ended the child; a repeating call is not a provider fault. */
  | "self-killed:loop"
  /** #543 — the F6 cumulative token budget was crossed; spend cap, not a provider fault. */
  | "self-killed:token-budget"
  | "crashed"
  | "crashed-unknown";

/**
 * #314 — Named constant for the adversarial loop's transient (provider-severed)
 * retry depth. Deliberately 3 (not work-driver's TRANSIENT_MAX_RETRIES=2)
 * because adversarial reviews are short-lived and the cost of a wasted retry
 * is lower than the cost of a false handoff.
 */
export const ADVERSARIAL_TRANSIENT_MAX_RETRIES = 3;

/**
 * The verdicts `agents-base/adversarial-developer.md` offers the reviewer.
 * Two of them are documented there as non-blocking; see `adversarial-verdict.ts`
 * for what each costs the loop.
 */
export type AdversarialVerdictStatus =
  | "CRITICAL_ISSUES_FOUND"
  | "ISSUES_FOUND"
  | "MINOR_OBSERVATIONS"
  | "APPROVED";

export interface AdversarialVerdict {
  status: AdversarialVerdictStatus;
  findings: string;
  raw: string;
  /**
   * #408 — false when no VERDICT marker could be read and the status was
   * defaulted. `findings` then carries unstructured prose, not review output,
   * and callers must not present it to a fix-developer as a list of defects.
   */
  verdictParsed?: boolean;
}
