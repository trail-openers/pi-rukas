/**
 * work-status-index — the MULTI-cycle view of `/work`.
 *
 * Split from work-status.ts, which holds the single-cycle detail view and hit
 * the 500-line cap (AGENTS.md §12). The seam is real rather than arbitrary:
 * this file answers "what is the state of everything?" and that one answers
 * "what happened to issue N?".
 *
 * Both functions here existed with NO caller anywhere in `src/` until #382 —
 * `/work-status` only ever reported on one issue, so after a multi-issue
 * queue run the operator had no way to see the whole picture, and no way at
 * all to see groups that never started (they leave no state file behind).
 */

import fs from "node:fs/promises";
import { MAX_REVIEW_ROUNDS, STEP_ORDINAL } from "./work-driver-context.ts";
import { terminalPathOf } from "./work-driver-handoff-message.ts";
import { humanActionFor } from "./work-queue.ts";
import { lastInterruptReason } from "./work-status-interrupted.ts";
import { isProviderPark } from "./workflow-state-events-interrupted.ts";
import { type WorkState, readState, workStateDir } from "./workflow-state.ts";

/**
 * #288 — every cycle with a state file, not just the most recently written.
 *
 * `discoverActiveIssue` picks `max(updatedAt)`, which is biased AGAINST the
 * cycle you care about: a handed-off cycle writes its final state and stops,
 * while a running one can go 15+ minutes between writes. With concurrent
 * groups it also silently reports on one arbitrary cycle out of N.
 */
export async function discoverAllCycles(
  repoRoot: string,
): Promise<Array<{ issue: number; state: WorkState }>> {
  const dir = workStateDir(repoRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ issue: number; state: WorkState }> = [];
  for (const entry of entries) {
    const match = entry.match(/^(\d+)\.json$/);
    if (!match) continue;
    const issue = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(issue)) continue;
    try {
      const state = await readState(repoRoot, issue);
      if (state) out.push({ issue, state });
    } catch {
      // Same tolerance as discoverActiveIssue: a malformed file surfaces via
      // the explicit-issue path rather than breaking the index.
    }
  }
  return out;
}

/**
 * The three-bucket index. `running` / `needs your input` / `done` is a total
 * mapping over the status enum — handoff and aborted both mean "a human has
 * to decide something", which is the distinction the operator actually acts
 * on. Sorted running-first, then most-recent.
 */
export function renderCycleIndex(
  cycles: Array<{ issue: number; state: WorkState }>,
  now = Date.now(),
  lastQueue?: { at: number; parked: number; notStarted: string[] },
): string {
  const running = cycles.filter((c) => c.state.pipelineState.status === "running");
  const needsInput = cycles.filter(
    (c) => c.state.pipelineState.status === "handoff" || c.state.pipelineState.status === "aborted",
  );
  const interrupted = cycles.filter((c) => c.state.pipelineState.status === "interrupted");
  const done = cycles.filter((c) => c.state.pipelineState.status === "merged");
  const interruptedNote = interrupted.length > 0 ? `${interrupted.length} interrupted, ` : "";
  const lines = [
    `/work — ${running.length} running, ${interruptedNote}${needsInput.length} needs your input, ${done.length} done`,
  ];
  // S4a (#1162) — resumable, not terminal: `/work N` re-enters the cycle.
  // #1243 fix round — a provider park keeps its own wording in the index too:
  // "interrupted" invites a reader to look for a signal, when the row is
  // really a park waiting on the endpoint. Same glyph, same resume action.
  for (const c of interrupted) {
    const reason = lastInterruptReason(c.state.eventLog);
    const park = isProviderPark(c.state);
    lines.push(
      `  ⏸ #${c.issue}  ${park ? "parked (provider unavailable) at" : "interrupted at"} ${c.state.pipelineState.currentStep}${reason ? ` (${reason})` : ""}`,
    );
    lines.push(`      → /work ${c.issue} resumes it`);
  }
  for (const c of [...running].sort((a, b) => b.state.updatedAt - a.state.updatedAt)) {
    const ps = c.state.pipelineState;
    const ord = STEP_ORDINAL[ps.currentStep];
    const stale = now - c.state.updatedAt > 30 * 60 * 1000 ? "  (no update in 30m+)" : "";
    lines.push(
      `  ⏳ #${c.issue}  step ${ord ? `${ord.num}/${ord.total}` : "?"} ${ps.currentStep}${ps.reviewRound > 0 ? ` · round ${ps.reviewRound}/${MAX_REVIEW_ROUNDS}` : ""}${stale}`,
    );
  }
  for (const c of needsInput) {
    const cap = [...c.state.eventLog].reverse().find((e) => e.kind === "cap-hit");
    // #398 — the suffix `work-queue.ts` attaches was dropped here, so every
    // intent-park hit `humanActionFor`'s `?? "underspecified"` default and
    // every parked cycle showed the same (often wrong) action.
    const parkReason =
      cap?.kind === "cap-hit" && cap.cap === "intent-park"
        ? c.state.pipelineState.normalisedSpec?.parkReason
        : undefined;
    const reason =
      cap?.kind === "cap-hit"
        ? `cap ${cap.cap}${parkReason ? `:${parkReason}` : ""}`
        : c.state.pipelineState.status;
    lines.push(`  ⏸ #${c.issue}  ${reason} at ${terminalPathOf(c.state).step ?? "?"}`);
    lines.push(`      → ${humanActionFor(reason, c.issue)}`);
  }
  if (done.length > 0) {
    lines.push(`  ✓ ${done.map((c) => `#${c.issue}`).join(" ")} merged`);
  }
  // #382 — the last queue run's outcome, read back from disk. Groups that
  // never started leave no state file at all, so without this they are
  // invisible to every later session: the run that parked them is the only
  // place they were ever named.
  if (lastQueue && lastQueue.notStarted.length > 0) {
    const mins = Math.round((now - lastQueue.at) / 60_000);
    lines.push(
      `  Last queue run (${mins}m ago) left ${lastQueue.notStarted.length} group(s) never started: ${lastQueue.notStarted.join(", ")}`,
    );
  }
  return lines.join("\n");
}
