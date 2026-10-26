/**
 * async-jobs-batch-report — the batch report (#543 split, AGENTS.md §12).
 *
 * `formatBatchReport` renders one section per member of a `dispatch_parallel`
 * batch and a single shared footer. It shares every judgement with the
 * single-job report — the outcome headline, the truncation badge, the usage
 * and observed-work tags, and the developer gate line — by importing them
 * from async-jobs-report.ts rather than restating them, which is the property
 * that matters: a batch row and a single row must never describe the same
 * result differently.
 */

import {
  GATE_LINE,
  describeOutcome,
  fmtElapsed,
  fmtObservedWork,
  fmtTokens,
  fmtUsage,
  isFinishedDeveloper,
  isTruncatedNarration,
  truncationBadge,
} from "./async-jobs-report.ts";
import type { DispatchResult } from "./types.ts";

export interface BatchReportInput {
  batchLabel: string;
  batchId: string;
  startedAt: number;
  members: Array<{
    jobId: string;
    label: string;
    result: DispatchResult | { failed: true; error: string };
    /** #1015 — pre-computed git-state line for developer/ops members. */
    gitLine?: string;
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
    // #546 — the same truncation tag the single-job report earns, so a
    // narration-tail child cannot hide inside a batch.
    const truncated =
      !m.result.killCause &&
      !m.result.errorStop &&
      text !== "" &&
      isTruncatedNarration(text, turns);
    const badge = truncated ? truncationBadge(m.result) : "";
    const gitTail = m.gitLine ? `\n${m.gitLine}` : "";
    return `=== ${m.label} (job ${m.jobId}) — ${status} · ${turns} turns · ${elapsed}${fmtObservedWork(m.result)}${fmtUsage(m.result)}${badge} ===\n${body}${gitTail}`;
  });
  // #911 — the gate line appears at most once in the shared footer: any
  // developer member that actually finished ("finished" via the shared
  // describeOutcome, not raw ok) is enough, and a batch of non-developers or
  // failed developers gets no gate line at all.
  const anyDeveloperFinished = input.members.some(
    (m) => !("failed" in m.result) && isFinishedDeveloper(m.label, m.result),
  );
  const footer = anyDeveloperFinished
    ? `---\n${GATE_LINE}\n\nYou started this async batch earlier. Continue the workflow.`
    : "---\nYou started this async batch earlier. Continue the workflow.";
  return `${head}\n\n${sections.join("\n\n")}\n\n${footer}`;
}
