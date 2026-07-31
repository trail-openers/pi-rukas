/**
 * Report-formatting helpers for async dispatch jobs — pure functions, no
 * ExtensionAPI coupling. Renders the bounded single/failure/batch reports
 * that async-jobs.ts pushes back to the parent agent via
 * `pi.sendUserMessage(report, { deliverAs: "steer" })`.
 */
import { type DispatchResult, isRateLimit429Msg } from "./types.ts";

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
export function formatSingleReport(jobId: string, label: string, result: DispatchResult): string {
  const turns = result.usage?.turns ?? 0;
  const elapsed = fmtElapsed(result.ms);
  // Five-way status: killCause (#296) is checked first — pi-ensemble's own
  // kill is never a provider failure. Then 429 rate-limit. Then errorStop
  // (provider error-stop, transport severance). Then process-level FAILED.
  // See DispatchResult.errorStop and DispatchResult.killCause.
  let status: string;
  let bodyPrefix: string | null = null;

  // #309 — killCause wins over errorStop. A self-kill is never reported
  // as a provider error.
  if (result.killCause === "timeout") {
    status = `FAILED (self-killed: wall-clock timeout, ${result.killBudgetMs ? `${Math.round(result.killBudgetMs / 1000)}s` : "budget exceeded"})`;
  } else if (result.killCause === "inactivity") {
    status = "FAILED (self-killed: inactivity watchdog)";
  } else if (result.killCause === "abort") {
    status = "FAILED (cancelled: abort signal)";
  } else if (result.errorStop && isRateLimit429Msg(result.errorStop.message)) {
    status = "FAILED (rate-limited: 429 — retrying cannot help)";
    bodyPrefix = result.errorStop.message
      ? `Provider request error: ${result.errorStop.message}`
      : "Provider request error: 429 retry delay requested";
  } else if (result.errorStop) {
    status = "FAILED-PROVIDER-ERROR";
    bodyPrefix = result.errorStop.message
      ? `Provider request error: ${result.errorStop.message}`
      : "Provider request error: (no error message captured from pi-ai)";
  } else if (result.ok) {
    status = "finished";
  } else {
    status = `FAILED (exit ${result.exitCode ?? "?"})`;
  }

  const head = `[ensemble:async] Subagent \`${label}\` (job ${jobId}) ${status} — ${turns} turns, ${elapsed}${fmtUsage(result)}`;
  let body = result.text?.trim() || "(no output)";
  if (bodyPrefix) {
    body = [
      bodyPrefix,
      result.errorStop && !isRateLimit429Msg(result.errorStop.message)
        ? "Last text below is the agent's pre-failure activity — VERIFY DIRECTLY before assuming progress (worktree may be unchanged)."
        : "Retrying cannot help; the provider explicitly asked for a wait period.",
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
    const status = m.result.ok ? "ok" : `fail (exit ${m.result.exitCode ?? "?"})`;
    const body = m.result.text?.trim() || "(no output)";
    return `=== ${m.label} (job ${m.jobId}) — ${status} · ${turns} turns · ${elapsed}${fmtUsage(m.result)} ===\n${body}`;
  });
  const footer = "---\nYou started this async batch earlier. Continue the workflow.";
  return `${head}\n\n${sections.join("\n\n")}\n\n${footer}`;
}
