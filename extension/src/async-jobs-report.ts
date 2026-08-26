/**
 * Report-formatting helpers for async dispatch jobs — pure functions, no
 * ExtensionAPI coupling. Renders the bounded single/failure/batch reports
 * that async-jobs.ts pushes back to the parent agent via
 * `pi.sendUserMessage(report, { deliverAs: "steer" })`.
 */
import { type DispatchResult, isRateLimit429Msg } from "./types.ts";
import { classifyFailureCause } from "./work-driver-failure-taxonomy.ts";

export function totalTokens(result: DispatchResult): number {
  const u = result.usage;
  if (!u) return 0;
  return (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

/** "12.3k" / "1.2M" / "456" — bounded to 4-5 chars regardless of input size. */
function fmtTokens(n: number | undefined): string {
  if (!n || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * "12.3k tokens · cerebras/zai-glm-4.7" — the in-context observables we
 * actually care about: how much context this run consumed and which model
 * produced it. Cost is omitted; for users on flat-rate plans (e.g. Cerebras
 * Coder) it's just noise, and per-token billing users can derive their own
 * cost from the token count if needed.
 */
function fmtUsage(result: {
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  model?: string;
  provider?: string;
}): string {
  const u = result.usage;
  const totalTokens = u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0;
  const tokens = totalTokens > 0 ? ` · ${fmtTokens(totalTokens)} tokens` : "";
  const modelTag = result.model
    ? ` · ${result.provider ? `${result.provider}/` : ""}${result.model}`
    : "";
  return `${tokens}${modelTag}`;
}

/**
 * Bounded report. The body is the child's final assistant text (same bytes
 * sync dispatch would have returned). The header is ~100 chars. NEVER includes
 * raw transcript content.
 */
/**
 * How a dispatch ended, in one place.
 *
 * Both report shapes need this and only the single-job one had it: the batch
 * report rendered `text || "(no output)"`, so a child killed by a 429 after 41
 * tool calls was announced as `fail (exit 0) · 1 turns · (no output)`. A PM read
 * that, concluded "a dispatch failure, not a research failure", and re-dispatched
 * with tighter prompts — a rate limit misdiagnosed as a prompting problem, and
 * ~136k characters of gathered research thrown away.
 */
/**
 * Report-facing wording for a 429, keyed off the shared classification.
 *
 * The taxonomy's own `failureCauseReason` is phrased for the driver, which is
 * about to act ("waiting it out and resuming"). Here the child is already dead,
 * so the wording differs — but the *judgment* is the same function, so the two
 * can never disagree about whether a wait would have helped.
 */
function rateLimitHeadline(cls: { cause: string; waitMs?: number }): string {
  switch (cls.cause) {
    case "rate-limited:burst":
      return `rate-limited: 429 — provider asked for a ${Math.round((cls.waitMs ?? 0) / 1000)}s wait`;
    case "rate-limited:quota-window":
      return `rate-limited: 429 — a ~${Math.round((cls.waitMs ?? 0) / 3600000)}h quota window, so retrying now cannot help`;
    case "rate-limited:quota-terminal":
      return "rate-limited: 429 — provider spend cap, waiting cannot help";
    default:
      return "rate-limited: 429 — no retry delay stated";
  }
}

/**
 * `· 41 tool calls` when the child worked but the replay lost it.
 *
 * Only rendered for a failed child, and only when the replay carried none:
 * that is precisely the case where the report otherwise implies nothing
 * happened. A successful child's activity is already evident from its output.
 */
function fmtObservedWork(result: DispatchResult): string {
  if (result.ok || !result.observedToolCalls) return "";
  return ` · ${result.observedToolCalls} tool calls before it died`;
}

function describeOutcome(result: DispatchResult): { status: string; bodyPrefix: string | null } {
  // #309 — killCause wins over errorStop. A self-kill is never reported
  // as a provider error.
  if (result.killCause === "timeout") {
    return {
      status: `FAILED (self-killed: wall-clock timeout, ${result.killBudgetMs ? `${Math.round(result.killBudgetMs / 1000)}s` : "budget exceeded"})`,
      bodyPrefix: null,
    };
  }
  if (result.killCause === "inactivity") {
    return { status: "FAILED (self-killed: inactivity watchdog)", bodyPrefix: null };
  }
  if (result.killCause === "abort") {
    return { status: "FAILED (cancelled: abort signal)", bodyPrefix: null };
  }
  // #543 — the F1/F6 cap kills are self-inflicted, reported distinctly from a
  // provider failure (the same five-way ordering the timeout/inactivity/abort
  // kills follow). A looped/budgeted child was killed BY the harness, so the
  // headline must not read as a provider fault or a bad prompt.
  if (result.killCause === "loop") {
    return {
      status: "FAILED (self-killed: loop detected)",
      bodyPrefix: null,
    };
  }
  if (result.killCause === "token-budget") {
    return { status: "FAILED (self-killed: token budget crossed)", bodyPrefix: null };
  }
  if (result.errorStop && isRateLimit429Msg(result.errorStop.message)) {
    // #366's distinction, not a second one. A per-minute token bucket and a
    // 24-hour quota exhaustion arrive as the same status code and differ only
    // in the delay they state. This branch used to say "retrying cannot help"
    // for both, which is true of the quota and precisely backwards for the
    // burst — there, waiting the stated delay is the whole remedy.
    const cls = classifyFailureCause({
      kind: "dispatch-failed-provider",
      providerMessage: result.errorStop.message,
    });
    return {
      status: `FAILED (${rateLimitHeadline(cls)})`,
      bodyPrefix: result.errorStop.message
        ? `Provider request error: ${result.errorStop.message}`
        : "Provider request error: 429 retry delay requested",
    };
  }
  if (result.errorStop) {
    return {
      status: "FAILED-PROVIDER-ERROR",
      bodyPrefix: result.errorStop.message
        ? `Provider request error: ${result.errorStop.message}`
        : "Provider request error: (no error message captured from pi-ai)",
    };
  }
  if (result.ok) return { status: "finished", bodyPrefix: null };
  return { status: `FAILED (exit ${result.exitCode ?? "?"})`, bodyPrefix: null };
}

export function formatSingleReport(jobId: string, label: string, result: DispatchResult): string {
  const turns = result.usage?.turns ?? 0;
  const elapsed = fmtElapsed(result.ms);
  // Five-way status: killCause (#296) is checked first — pi-ensemble's own
  // kill is never a provider failure. Then 429 rate-limit. Then errorStop
  // (provider error-stop, transport severance). Then process-level FAILED.
  // See DispatchResult.errorStop and DispatchResult.killCause.
  const { status, bodyPrefix } = describeOutcome(result);

  const head = `[ensemble:async] Subagent \`${label}\` (job ${jobId}) ${status} — ${turns} turns, ${elapsed}${fmtObservedWork(result)}${fmtUsage(result)}`;
  let body = result.text?.trim() || "(no output)";
  if (bodyPrefix) {
    body = [
      bodyPrefix,
      result.errorStop && !isRateLimit429Msg(result.errorStop.message)
        ? "Last text below is the agent's pre-failure activity — VERIFY DIRECTLY before assuming progress (worktree may be unchanged)."
        : "The provider asked for a wait before retrying — honour the delay it stated.",
      "",
      body,
    ].join("\n");
  }
  const footer = result.ok
    ? "---\nYou started this async dispatch earlier. Continue the workflow."
    : `---\n(See /runs for full transcript at ${result.transcriptPath ?? "ensemble-runs/"}.)`;
  return `${head}\n\n${body}\n\n${footer}`;
}

export function formatFailReport(jobId: string, label: string, err: Error): string {
  const tail = (err.message ?? "").slice(-200);
  return [
    `[ensemble:async] Subagent \`${label}\` (job ${jobId}) FAILED before producing output`,
    `error tail: ${tail}`,
    "",
    "(See /runs for any partial transcript.)",
  ].join("\n");
}

export interface BatchReportInput {
  batchLabel: string;
  batchId: string;
  startedAt: number;
  members: Array<{
    jobId: string;
    label: string;
    result: DispatchResult | { failed: true; error: string };
  }>;
}

export function formatBatchReport(input: BatchReportInput): string {
  const ms = Date.now() - input.startedAt;
  const totalTokens = input.members.reduce((acc, m) => {
    if ("failed" in m.result) return acc;
    const u = m.result.usage;
    return acc + (u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0);
  }, 0);
  const okCount = input.members.filter((m) => !("failed" in m.result) && m.result.ok).length;
  const tokenTag = totalTokens > 0 ? ` · ${fmtTokens(totalTokens)} tokens` : "";
  const head = `[ensemble:async] Batch \`${input.batchLabel}\` (batch ${input.batchId}) finished — ${okCount}/${input.members.length} ok, ${fmtElapsed(ms)}${tokenTag}`;
  const sections = input.members.map((m) => {
    if ("failed" in m.result) {
      return `=== ${m.label} (job ${m.jobId}) — FAILED ===\nerror: ${m.result.error.slice(-200)}`;
    }
    const turns = m.result.usage?.turns ?? 0;
    const elapsed = fmtElapsed(m.result.ms);
    // Same outcome description the single-job report uses. Before this, a child
    // killed by a 429 read as `fail (exit 0) · (no output)`, which hid the cause
    // completely and got the failure misdiagnosed as a bad prompt.
    const { status, bodyPrefix } = describeOutcome(m.result);
    const text = m.result.text?.trim();
    const body = bodyPrefix
      ? [bodyPrefix, ...(text ? ["", text] : [])].join("\n")
      : text || "(no output)";
    return `=== ${m.label} (job ${m.jobId}) — ${status} · ${turns} turns · ${elapsed}${fmtObservedWork(m.result)}${fmtUsage(m.result)} ===\n${body}`;
  });
  const footer = "---\nYou started this async batch earlier. Continue the workflow.";
  return `${head}\n\n${sections.join("\n\n")}\n\n${footer}`;
}
