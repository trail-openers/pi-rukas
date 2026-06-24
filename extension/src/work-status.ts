/**
 * `/work-status` command (PR2 O4).
 *
 * Reads the workflow state file at `<repoRoot>/.pi/work-state/<issue>.json`
 * and renders a compact, terminal-friendly status snapshot via
 * `ctx.ui.notify`. Intended for the user's "I came back, where are we?"
 * moment without making them open the JSON.
 *
 * Mirrors Restate UI's "no progress in last hour" query semantics but
 * scoped to a single issue + session: a quick at-a-glance summary plus
 * the most recent few events, so the user can decide whether to
 * intervene, wait, or run /work again with PI_ENSEMBLE_WORK_DRIVER=0
 * as the legacy fallback.
 *
 * Inputs:
 *   /work-status               — auto-resolves the issue: if a state file
 *                                exists in the cwd's project, picks the
 *                                most-recently-updated one (running > recent).
 *   /work-status <issue>       — explicit issue number.
 *   /work-status N --json      — emit raw JSON (handy for piping to jq).
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";
import {
  MAX_CI_RETRIES,
  MAX_REVIEW_ROUNDS,
  REVIEW_WALL_CLOCK_MS,
  explainCap,
} from "./work-driver.ts";
import { type WorkEvent, type WorkState, readState, workStateDir } from "./workflow-state.ts";

const execp = promisify(exec);

/** Resolve project repo root via `git rev-parse --show-toplevel`. */
async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execp("git rev-parse --show-toplevel", { cwd });
    return stdout.trim();
  } catch {
    return cwd;
  }
}

/**
 * Pick the most-recently-updated state file when the caller didn't pass
 * an issue number. "Most recent" = max(pipelineState.updatedAt). Rare to
 * have more than one running cycle per project but the search handles it
 * gracefully.
 */
async function discoverActiveIssue(repoRoot: string): Promise<number | undefined> {
  const dir = workStateDir(repoRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  const candidates: Array<{ issue: number; updatedAt: number }> = [];
  for (const entry of entries) {
    const match = entry.match(/^(\d+)\.json$/);
    if (!match) continue;
    const issue = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(issue)) continue;
    try {
      const state = await readState(repoRoot, issue);
      if (state) candidates.push({ issue, updatedAt: state.updatedAt });
    } catch {
      // Skip files that don't parse cleanly — schema mismatch surfaces
      // via the explicit-issue path.
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates[0]?.issue;
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Sum elapsed-ms across all dispatch-completed events for a given step. */
function stepTotals(events: WorkEvent[]): Record<string, { ms: number; tokens?: number }> {
  const out: Record<string, { ms: number; tokens?: number }> = {};
  for (const e of events) {
    if (e.kind !== "dispatch-completed") continue;
    if (!out[e.step]) out[e.step] = { ms: 0 };
    const slot = out[e.step];
    if (slot) slot.ms += e.ms;
  }
  return out;
}

/** Format an event for the "last N" trailing log. Compact one-liner per event. */
function fmtEvent(e: WorkEvent): string {
  switch (e.kind) {
    case "step-started":
      return `  step-started · ${e.step}${e.note ? ` · ${e.note}` : ""}`;
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
    case "lens-approved":
      return `  lens-approved · round ${e.round}`;
    case "lens-issues-found":
      return `  lens-issues-found · round ${e.round} · ${e.verdict}`;
    case "cap-hit":
      return `  cap-hit · ${e.cap} · → ${e.nextStep}`;
    case "plumb-report":
      return `  plumb-report · ${e.step} · ${e.role}`;
    case "step-back-triggered":
      return `  step-back-triggered · theme: ${e.theme.slice(0, 60)}`;
    case "step-back-completed":
      return `  step-back-completed · ${e.sddElement}`;
    case "handoff-emitted":
      return `  handoff-emitted${e.commentUrl ? ` · ${e.commentUrl}` : ""}`;
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
  }
}

/**
 * Build the multi-line status report. Routes on `status`:
 *   - 'running' → renderRunningStatus (PR4 shape, unchanged)
 *   - 'handoff' | 'aborted' | 'merged' → renderTerminalStatus
 *     (PR5 postmortem layout)
 */
export function renderStatus(state: WorkState, repoRoot: string): string {
  if (state.pipelineState.status === "running") {
    return renderRunningStatus(state, repoRoot);
  }
  return renderTerminalStatus(state, repoRoot);
}

/** Build the running-cycle status (PR4 shape, unchanged). */
export function renderRunningStatus(state: WorkState, repoRoot: string): string {
  const ps = state.pipelineState;
  const elapsedTotal = Date.now() - state.startedAt;

  const lines: string[] = [];
  lines.push(`/work #${state.issue} — RUNNING`);
  lines.push(
    `  current step: ${ps.currentStep}${ps.lastCompletedStep ? ` (last completed: ${ps.lastCompletedStep})` : ""}`,
  );
  lines.push(`  total elapsed: ${fmtElapsed(elapsedTotal)}`);
  if (ps.branchName) lines.push(`  branch: ${ps.branchName}`);
  if (ps.prNumber) lines.push(`  PR: #${ps.prNumber}`);
  if (ps.inFlightJobIds.length > 0) {
    lines.push(`  in-flight: ${ps.inFlightJobIds.join(", ")}`);
  }
  if (ps.reviewRound > 0) {
    const capParts: string[] = [`review round ${ps.reviewRound}/${MAX_REVIEW_ROUNDS}`];
    if (ps.reviewCapStartedAt) {
      const capElapsed = Date.now() - ps.reviewCapStartedAt;
      capParts.push(`wall-clock ${fmtElapsed(capElapsed)}/${fmtElapsed(REVIEW_WALL_CLOCK_MS)}`);
    }
    lines.push(`  caps: ${capParts.join(" · ")}`);
  }
  if ((ps.ciRetryCount ?? 0) > 0) {
    lines.push(`  ci retries: ${ps.ciRetryCount}/${MAX_CI_RETRIES}`);
  }

  const totals = stepTotals(state.eventLog);
  if (Object.keys(totals).length > 0) {
    lines.push("", "step durations:");
    for (const [step, t] of Object.entries(totals)) {
      lines.push(`  ${step.padEnd(14)} ${fmtElapsed(t.ms)}`);
    }
  }

  if (state.eventLog.length > 0) {
    lines.push("");
    lines.push(
      `recent events (last ${Math.min(5, state.eventLog.length)} of ${state.eventLog.length}):`,
    );
    for (const e of state.eventLog.slice(-5)) {
      lines.push(fmtEvent(e));
    }
  }

  lines.push("");
  lines.push(`state file: ${path.join(workStateDir(repoRoot), `${state.issue}.json`)}`);

  void fmtTokens; // reserved for v2 per-step token column
  return lines.join("\n");
}

/**
 * PR5 — postmortem layout for terminal cycles (handoff / aborted /
 * merged). Consumes `handoffSnapshot` and `explainCap` to answer
 * WHAT/WHY/WHERE/NEXT inline, without making the user open the JSON.
 *
 * Uses the same explainCap source-of-truth as the in-chat handoff
 * sendUserMessage and the GitHub renderHandoffMarkdown, so all three
 * surfaces agree on what the cap means + what to do.
 */
export function renderTerminalStatus(state: WorkState, repoRoot: string): string {
  const ps = state.pipelineState;
  const elapsedTotal = Date.now() - state.startedAt;
  const issue = state.issue;
  const statusBadge =
    ps.status === "merged"
      ? "MERGED ✓"
      : ps.status === "handoff"
        ? "HANDOFF (cap-hit, needs human attention)"
        : "ABORTED (mid-flight failure, needs human attention)";

  const lines: string[] = [];
  lines.push(`/work #${issue} — ${statusBadge}`);
  lines.push(`Duration: ${fmtElapsed(elapsedTotal)}`);

  if (ps.status !== "merged") {
    const capHit = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
    const cap = capHit?.kind === "cap-hit" ? capHit.cap : ("adversarial-loop" as const);
    lines.push("", `Verdict: ${explainCap(cap, state)}`);
  }

  // Worktree state at handoff.
  const snap = ps.handoffSnapshot;
  if (snap || ps.branchName || ps.prNumber) {
    lines.push("", "Worktree state:");
    if (ps.branchName) {
      const pushedTag = snap ? (snap.branchPushed ? " (pushed)" : " (NOT pushed)") : "";
      const headTag = snap?.headSha ? ` · HEAD ${snap.headSha}` : "";
      lines.push(`  branch: ${ps.branchName}${pushedTag}${headTag}`);
    }
    lines.push(`  ${ps.prNumber ? `PR: #${ps.prNumber}` : "PR: none created"}`);
    if (snap) {
      const fileCount = snap.unstagedCount + snap.stagedCount;
      lines.push(
        `  uncommitted: ${fileCount} file(s)${fileCount > 0 ? ` (${snap.stagedCount} staged, ${snap.unstagedCount} unstaged)` : ""}`,
      );
      if (snap.modifiedFiles.length > 0) {
        const shown = snap.modifiedFiles.slice(0, 10);
        lines.push(
          `  modified (first ${shown.length} of ${snap.modifiedFiles.length}):`,
          ...shown.map((f) => `    ${f}`),
        );
      }
    }
  }

  // GitHub handoff outcome.
  const handoffEvt = [...state.eventLog].reverse().find((e) => e.kind === "handoff-emitted");
  if (handoffEvt?.kind === "handoff-emitted") {
    lines.push(
      "",
      "GitHub handoff:",
      `  comment: ${handoffEvt.commentUrl ?? "WARNING: NOT POSTED — see recovery #4 below"}`,
      `  label:   ${handoffEvt.labelApplied ? "needs-human-attention applied" : "WARNING: NOT applied"}`,
    );
  }

  // Per-step durations.
  const totals = stepTotals(state.eventLog);
  if (Object.keys(totals).length > 0) {
    lines.push("", "Step durations:");
    for (const [step, t] of Object.entries(totals)) {
      lines.push(`  ${step.padEnd(14)} ${fmtElapsed(t.ms)}`);
    }
  }

  // Last 5 events.
  if (state.eventLog.length > 0) {
    lines.push(
      "",
      `Recent events (last ${Math.min(5, state.eventLog.length)} of ${state.eventLog.length}):`,
    );
    for (const e of state.eventLog.slice(-5)) {
      lines.push(fmtEvent(e));
    }
  }

  // Artefacts.
  const scratchDirPath = path.join(repoRoot, "tmp", `issue-${issue}`);
  const handoffBodyPath = path.join(scratchDirPath, "handoff-comment.md");
  lines.push(
    "",
    "Artefacts to inspect:",
    `  rich body:   ${handoffBodyPath}`,
    `  state + log: ${path.join(workStateDir(repoRoot), `${issue}.json`)}`,
    `  transcripts: ${scratchDirPath}/`,
  );

  // Recovery commands (only for non-merged terminal states).
  if (ps.status !== "merged") {
    const branchForCmd = ps.branchName ?? "<branch>";
    const target = ps.prNumber ? `pr ${ps.prNumber}` : `issue ${issue}`;
    const objType = ps.prNumber ? "pr" : "issue";
    const targetId = ps.prNumber ?? issue;
    lines.push(
      "",
      "Recovery commands (pick one):",
      "  # 1. Inspect what survived:",
      "  git status && git diff --stat",
      "",
      "  # 2. Retry with longer per-spawn cap:",
      `  export PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER=5400000 && rm .pi/work-state/${issue}.json && pi`,
      "",
      "  # 3. Abandon the cycle, keep worktree:",
      `  rm .pi/work-state/${issue}.json`,
      "",
      "  # 4. Take over manually:",
      `  git add -p && git commit && git push -u origin ${branchForCmd}`,
    );
    if (handoffEvt?.kind === "handoff-emitted" && !handoffEvt.commentUrl) {
      lines.push(
        "",
        "  # 5. Manually post the handoff comment (the GitHub-side post FAILED above):",
        `  gh ${objType} comment ${targetId} --body-file ${handoffBodyPath}`,
        `  gh ${objType} edit ${targetId} --add-label needs-human-attention`,
      );
    }
    // Silence unused-var on `target` when commentUrl path doesn't fire.
    void target;
  }

  return lines.join("\n");
}

/** Register the `/work-status` command. Pi calls this from `index.ts:registerCommands`. */
export function registerWorkStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("work-status", {
    description:
      "[<issue>] [--json] — Inspect the /work driver's state for the given issue (auto-resolved if omitted)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const wantJson = tokens.includes("--json");
      const issueArg = tokens.find((t) => /^\d+$/.test(t));
      const cwd = process.cwd();
      const repoRoot = await resolveRepoRoot(cwd);

      let issue: number | undefined;
      if (issueArg) {
        issue = Number.parseInt(issueArg, 10);
      } else {
        issue = await discoverActiveIssue(repoRoot);
        if (issue === undefined) {
          ctx.ui.notify(
            `pi-ensemble: no /work state files found in ${workStateDir(repoRoot)}. Pass an explicit issue number: /work-status <N>.`,
            "info",
          );
          return;
        }
      }

      let state: WorkState | undefined;
      try {
        state = await readState(repoRoot, issue);
      } catch (err) {
        ctx.ui.notify(
          `pi-ensemble /work-status: failed to read state for issue #${issue}: ${(err as Error).message}`,
          "error",
        );
        trace(`work-status: readState failed: ${(err as Error).message}`);
        return;
      }
      if (!state) {
        ctx.ui.notify(
          `pi-ensemble /work-status: no state file for issue #${issue} (expected at ${path.join(workStateDir(repoRoot), `${issue}.json`)}).`,
          "info",
        );
        return;
      }

      if (wantJson) {
        ctx.ui.notify(JSON.stringify(state, null, 2), "info");
        return;
      }
      ctx.ui.notify(renderStatus(state, repoRoot), "info");
    },
  });
}
