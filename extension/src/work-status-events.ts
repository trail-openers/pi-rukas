/**
 * work-status-events — event-log formatting for the `/work-status` snapshot.
 *
 * Split (§12 file-size limit) from `work-status.ts`: the `fmtEvent`
 * one-liner-per-event renderer plus the compact number formatters
 * (`fmtElapsed` / `fmtTokens`) it depends on, and the per-step
 * `stepTotals` aggregation that the two renderers in `work-status.ts`
 * share. Pure formatting — no state, no I/O; the renderers and command
 * registration stay in `work-status.ts`.
 */

import type { WorkEvent } from "./workflow-state.ts";

export function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Per-step totals from the event log: elapsed-ms across all
 * dispatch-completed events, plus tokens (input+output+cacheRead+
 * cacheWrite) when the completion events carry usage. #534 — `tokens` was
 * a documented v2 reservation (the `void fmtTokens;` line below); it is
 * populated now, matching the async-jobs-report.ts totalTokens definition.
 * Dispatches without usage (pre-#534 state files) leave the column absent
 * rather than printing a misleading zero.
 */
export function stepTotals(events: WorkEvent[]): Record<string, { ms: number; tokens?: number }> {
  const out: Record<string, { ms: number; tokens?: number }> = {};
  for (const e of events) {
    if (e.kind !== "dispatch-completed") continue;
    if (!out[e.step]) out[e.step] = { ms: 0 };
    const slot = out[e.step];
    if (slot) slot.ms += e.ms;
    const usage = (
      e as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }
    ).usage;
    const t = usage
      ? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
      : 0;
    if (slot && t > 0) {
      slot.tokens = (slot.tokens ?? 0) + t;
    }
  }
  return out;
}

/** Format an event for the "last N" trailing log. Compact one-liner per event. */
export function fmtEvent(e: WorkEvent): string {
  switch (e.kind) {
    case "step-started":
      // #657 — a step-started with round > 1 is a loop re-entry (adversarial /
      // lens-review / ci): render the round. First entries render unchanged.
      return `  step-started · ${e.step}${
        e.round !== undefined && e.round > 1 ? ` (round ${e.round})` : ""
      }${e.note ? ` · ${e.note}` : ""}`;
    case "dispatch-started":
      return `  dispatch-started · ${e.step} · ${e.label}`;
    case "dispatch-completed":
      return `  dispatch-completed · ${e.step} · ${e.label} · ${fmtElapsed(e.ms)}`;
    case "dispatch-failed":
      return `  dispatch-failed · ${e.step} · ${e.label} · exit=${e.exitCode ?? "?"}${e.errorTail ? ` · ${e.errorTail.slice(0, 50)}` : ""}`;
    case "dispatch-failed-provider":
      return `  dispatch-failed-provider · ${e.step} · ${e.label} · ${fmtElapsed(e.ms)}${e.providerMessage ? ` · ${e.providerMessage.slice(0, 50)}` : ""}`;
    case "adversarial-approved":
      return `  adversarial-approved · ${e.rounds} round(s)`;
    case "adversarial-rejected":
      return `  adversarial-rejected · ${e.rounds} round(s)`;
    case "adversarial-round":
      return `  adversarial-round · round ${e.round} · ${e.status}${e.workstreamId ? ` · [${e.workstreamId}]` : ""}${e.verdictParsed ? "" : " · (unparsed — parser default, not a reviewer verdict)"}`;
    case "adversarial-workstream-outcome":
      return `  adversarial-workstream-outcome · [${e.workstreamId}] · ${e.outcome} · ${e.roundsExecuted} round(s)`;
    case "lens-approved":
      return `  lens-approved · round ${e.round}`;
    case "lens-issues-found":
      return `  lens-issues-found · round ${e.round} · ${e.verdict}`;
    case "cap-hit": {
      // #657 — an intent-park cap-hit carrying the machine-readable reason
      // renders it: "intent-park (contradicted-by-code)". Absent → unchanged.
      const capLabel =
        e.cap === "intent-park" && e.parkReason ? `${e.cap} (${e.parkReason})` : e.cap;
      return `  cap-hit · ${capLabel} · → ${e.nextStep}`;
    }
    case "plumb-report":
      return `  plumb-report · ${e.step} · ${e.role}`;
    case "step-back-triggered":
      return `  step-back-triggered · theme: ${e.theme.slice(0, 60)}`;
    case "step-back-completed":
      return `  step-back-completed · ${e.sddElement}`;
    case "handoff-emitted":
      return `  handoff-emitted → ${e.targetType ?? "?"} #${e.targetNumber ?? "?"}${e.commentUrl ? ` · ${e.commentUrl}` : ""}${e.consolidated ? ` · onto ${e.consolidatedBranch ?? "?"}` : ""}`;
    case "handoff-consolidated":
      return `  handoff-consolidated · ${e.branchName} · ${e.workstreams.join(", ")}`;
    case "ci-status":
      return `  ci-status · ${e.status}${e.runUrl ? ` · ${e.runUrl}` : ""}`;
    case "merged":
      return `  merged · PR #${e.prNumber}`;
    case "branches-fanned-out":
      return `  branches-fanned-out · ${e.step} · ${e.workstreams.length} branches: ${e.workstreams.join(", ")}`;
    case "branch-completed":
      return `  branch-completed · ${e.step}[${e.workstreamId}] · ${e.ok ? "ok" : "FAIL"} · ${fmtElapsed(e.ms)}${e.error ? ` · ${e.error.slice(0, 40)}` : ""}`;
    case "branches-converged": {
      const okN = e.verdicts.filter((v) => v.ok).length;
      return `  branches-converged · ${e.step} · ${okN}/${e.verdicts.length} ok`;
    }
    case "lens-skipped-empty-diff":
      return `  lens-skipped-empty-diff · round ${e.round}`;
    case "lens-fix-empty-resend":
      return `  lens-fix-empty-resend · round ${e.round} · ${e.worktree}`;
    case "converge-redispatch":
      return "  converge-redispatch · develop · corrective dispatch for missing deliverable(s)";
    case "adversarial-skipped-empty-diff":
      return `  adversarial-skipped-empty-diff · workstream ${e.workstreamId}`;
    case "verify-full-status":
      return `  verify-full-status · ${e.status}${e.recovered ? " (recovered)" : ""}${e.ms ? ` · ${fmtElapsed(e.ms)}` : ""}${e.evidenceTail ? ` · ${e.evidenceTail.slice(0, 50)}` : ""}`;
    case "verify-flake-recovered":
      return `  verify-flake-recovered · ${e.step}${e.evidenceTail ? ` · ${e.evidenceTail.slice(0, 50)}` : ""}`;
    case "widening-scan":
      return `  widening-scan · ${e.findings.length} finding(s)`;
    case "memory-write":
      return `  memory-write · ${e.outcome}${e.detail ? ` · ${e.detail}` : ""}`;
    case "memory-inject":
      // Empty is called out rather than rendered as "0 hits": a leg that
      // silently returns nothing forever is the failure this event exists to make visible.
      return e.emptyBrief
        ? `  memory-inject · ${e.step} · EMPTY BRIEF · ${e.queries.length} quer${e.queries.length === 1 ? "y" : "ies"}`
        : `  memory-inject · ${e.step} · ${e.hits} hit(s)`;
    case "worktree-provisioned":
      return `  worktree-provisioned · [${e.worktreeId}] · ${e.outcome}${e.problem ? ` · ${e.problem.slice(0, 60)}` : ""}`;
    case "safety-net-commit":
      return `  safety-net-commit · [${e.workstreamId}] · ${e.filesCommitted} file(s) · ${e.commitSha.slice(0, 7)}`;
    case "worktree-leftover-handled":
      return `  worktree-leftover-handled · ${e.path.split("/").pop()} · ${e.action}${e.refs.length ? ` · refs: ${e.refs.join(", ")}` : ""}${e.salvageDir ? ` · salvage: ${e.salvageDir}` : ""}`;
    case "branch-reset":
      // #844 — the old tip is the recovery handle; both are rendered so the
      // operator can `git checkout <oldSha>` without reading the state file.
      return `  branch-reset · ${e.branch} · ${e.oldSha.slice(0, 8)} → ${e.newSha.slice(0, 8)}`;
    case "dispatch-heartbeat":
      // #799 task-a — a bounded mid-flight snapshot of a single dispatch.
      // The `zeroState` flag names the "no deck snapshot yet" shape rather
      // than rendering a misleading "0 turns · 0 tok".
      return `  dispatch-heartbeat · ${e.step} · ${e.label} · ${fmtElapsed(e.elapsedMs)} · ${e.turns} turn${e.turns === 1 ? "" : "s"}${e.lastToolName ? ` · last=${e.lastToolName}` : ""}${e.totalTokens > 0 ? ` · ${fmtTokens(e.totalTokens)} tok` : ""}${e.zeroState ? " · (no snapshot yet)" : ""}`;
  }
}
