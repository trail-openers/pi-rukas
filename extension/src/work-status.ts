/** `/work-status` command (PR2 O4) — compact terminal-friendly status snapshot. */
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
  STEP_ORDINAL,
} from "./work-driver-context.ts";
import { formatCycleTotal } from "./work-driver-cycle-total.ts";
import { explainCap } from "./work-driver-explain.ts";
import { readQueueSummary } from "./work-queue-summary.ts";
import { humanActionFor } from "./work-queue.ts";
import { fmtElapsed, fmtEvent, fmtTokens, stepTotals } from "./work-status-events.ts";
import { discoverAllCycles, renderCycleIndex } from "./work-status-index.ts";
import { isIssueNumberArg, resolveJobId } from "./work-status-jobid.ts";
import { type WorkState, readState, workStateDir } from "./workflow-state.ts";
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
      const tokens = t.tokens && t.tokens > 0 ? ` · ${fmtTokens(t.tokens)} tokens` : "";
      lines.push(`  ${step.padEnd(14)} ${fmtElapsed(t.ms)}${tokens}`);
    }
    const cycleTotal = formatCycleTotal(state.eventLog);
    if (cycleTotal) lines.push(`  ${"(cycle total)".padEnd(14)}${cycleTotal}`);
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
    // No "adversarial-loop" default: naming a gate that passed is worse than
    // naming none. `explainCap` handles an absent cap explicitly now.
    const cap = capHit?.kind === "cap-hit" ? capHit.cap : undefined;
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
      if (snap.retainedWorktrees?.length) {
        lines.push("  retained worktrees:", ...snap.retainedWorktrees.map((wt) => `    ${wt}`));
      }
    }
  }

  // GitHub handoff outcome.
  const handoffEvt = [...state.eventLog].reverse().find((e) => e.kind === "handoff-emitted");
  if (handoffEvt?.kind === "handoff-emitted") {
    const te = handoffEvt;
    // #798 — per-target fields present → label landed on (both) issue+PR;
    // the single-boolean pre-#798 shape renders as before.
    const dual = te.issueLabelApplied !== undefined || te.prLabelApplied !== undefined;
    const labelLine = dual
      ? `  label:   needs-human-attention${te.issueLabelApplied ? ` on issue #${issue}` : ` NOT verified on issue #${issue}`}${te.prLabelApplied !== undefined ? ` / ${te.prLabelApplied ? "on PR" : " NOT verified on PR"} #${ps.prNumber ?? "?"}` : ""}${te.labelApplied ? "" : " (partial failure)"}`
      : `  label:   ${te.labelApplied ? "needs-human-attention applied" : "WARNING: NOT applied"}`;
    lines.push(
      "",
      "GitHub handoff:",
      `  target:  ${te.targetType ? `${te.targetType} #${te.targetNumber ?? "?"}` : "?"} (explicit, #798)`,
      `  comment: ${te.commentUrl ?? "WARNING: NOT POSTED — see recovery #4 below"}`,
      labelLine,
    );
  }

  // Per-step durations + cycle total (#534 shared helper).
  const totals = stepTotals(state.eventLog);
  if (Object.keys(totals).length > 0) {
    lines.push("", "Step durations:");
    for (const [step, t] of Object.entries(totals)) {
      const tokens = t.tokens && t.tokens > 0 ? ` · ${fmtTokens(t.tokens)} tokens` : "";
      lines.push(`  ${step.padEnd(14)} ${fmtElapsed(t.ms)}${tokens}`);
    }
    const cycleTotal = formatCycleTotal(state.eventLog);
    if (cycleTotal) lines.push(`  ${"(cycle total)".padEnd(14)}${cycleTotal}`);
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
    // #398 — this block had NO cap branching at all, so every cap got
    // timeout-shaped recovery, including the pre-branch ones where nothing was
    // written and no branch exists.
    const lastCap = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
    const preBranch =
      lastCap?.kind === "cap-hit" &&
      (lastCap.cap === "intent-park" ||
        lastCap.cap === "existing-pr-detected" ||
        String(lastCap.cap).startsWith("explore-"));
    lines.push(
      "",
      "Recovery commands (pick one):",
      ...(preBranch
        ? [
            "  # Nothing was written — this cap fires before the branch step.",
            "  # Read the reasoning, then re-run:",
            `  cat .pi/work-state/${issue}/spec.txt`,
            `  /work ${issue} --restart`,
          ]
        : [
            "  # 1. Inspect what survived:",
            "  git status",
            "  git diff --stat",
            "",
            "  # 2. Discard the cycle and start over (worktree is kept):",
            `  rm .pi/work-state/${issue}.json`,
            "",
            "  # 3. Take over manually:",
            "  git add -p",
            "  git commit",
            `  git push -u origin ${branchForCmd}`,
          ]),
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
    description: "[<issue>|<jobId>] [--json] — Inspect /work driver state.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const wantJson = args.includes("--json");
      const issueArg = args.split(/\s+/).filter((t) => t !== "--json")[0];
      const repoRoot = await resolveRepoRoot(ctx.cwd);

      // Resolve arg → issue number.
      let issue: number | undefined;
      if (issueArg) {
        if (isIssueNumberArg(issueArg)) {
          issue = Number.parseInt(issueArg, 10);
        } else {
          const resolved = resolveJobId(repoRoot, issueArg);
          if (resolved === undefined) {
            ctx.ui.notify("pi-rukas /work-status: jobId not found. Pass issue #.", "info");
            return;
          }
          issue = resolved;
        }
      } else if (!wantJson) {
        // #382 — >1 cycle: show index.
        const all = await discoverAllCycles(repoRoot);
        if (all.length > 1) {
          const last = await readQueueSummary(repoRoot);
          ctx.ui.notify(
            renderCycleIndex(
              all,
              Date.now(),
              last ? { at: last.at, parked: last.parked, notStarted: last.notStarted } : undefined,
            ),
            "info",
          );
          return;
        }
        issue = await discoverActiveIssue(repoRoot);
        if (issue === undefined) {
          ctx.ui.notify("pi-rukas: no /work state found. Pass <N> or <jobId>.", "info");
          return;
        }
      } else {
        ctx.ui.notify(
          "pi-rukas /work-status --json: no issue or jobId. Pass <N> --json or <jobId> --json.",
          "info",
        );
        return;
      }

      // Read and display state.
      let state: WorkState | undefined;
      try {
        state = await readState(repoRoot, issue as number);
      } catch (err) {
        ctx.ui.notify(
          `pi-rukas /work-status: read error for #${issue}: ${(err as Error).message}`,
          "error",
        );
        trace(`work-status: readState failed: ${(err as Error).message}`);
        return;
      }
      if (!state) {
        ctx.ui.notify(
          `pi-rukas /work-status: no state for #${issue} at ${path.join(workStateDir(repoRoot), `${issue}.json`)}.`,
          "info",
        );
        return;
      }
      ctx.ui.notify(
        wantJson ? JSON.stringify(state, null, 2) : renderStatus(state, repoRoot),
        "info",
      );
    },
  });
}
