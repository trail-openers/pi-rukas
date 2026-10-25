/**
 * work-driver-diff-replies — the reply-parsing leaves that sat at the tail of
 * `work-driver-diff.ts` (AGENTS.md §12 file-size limit; #1634 pushed that module
 * past 500 lines with the `readWorktreeDiff` gate). Pure text helpers with no
 * git and no DriverContext dependency, kept out of the diff module so neither
 * file grows past the cap. `countPriorStepStarts` counts events, the two
 * parsers read an ops subagent's prose; all three are consumed by the step
 * handlers, none by the diff reads.
 */

import type { WorkState, WorkStep } from "./workflow-state.ts";

/**
 * Count prior `step-started` events for this step in the event log.
 * Used by the driver loop (PR4) to compute a `(round N)` suffix for the
 * scrollback lifecycle line on steps that iterate during a fix loop
 * (adversarial / lens-review / lens-fix / re-entered develop). First
 * entry returns 0 — the emit sites add 1 and pass `round` to lifecycle;
 * `formatLine` suppresses the suffix for `round <= 1` so single-entry
 * steps stay terse.
 */
export function countPriorStepStarts(state: WorkState, step: WorkStep): number {
  let n = 0;
  for (const e of state.eventLog) {
    if (e.kind === "step-started" && e.step === step) n++;
  }
  return n;
}

/**
 * Detect subagent ABORT markers.
 *
 * Ops's branch and commit-pr step prompts instruct the subagent to write
 * `ABORT: <reason>` (or `**ABORT...**` for markdown emphasis) when a
 * precondition fails (dirty working tree, --ff-only refusal, etc). The
 * subagent's PROCESS still exits 0 — it ran successfully, just refused
 * the requested action — so the driver can't rely on exit code. This
 * scans the LAST ~800 chars of the reply for the marker; that's the
 * "verdict zone" where ops doctrine places it.
 *
 * Returns the matched abort line trimmed if found, or undefined.
 *
 * On issue #553's live cycle: ops's branch step replied with
 * "**ABORT: Working tree is not clean**" but PR #239 recorded ok:true
 * and the driver continued develop without a feature branch. The fix:
 * treat an ABORT marker as a dispatch-failed regardless of exit code.
 */
export function parseAbort(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const tail = text.slice(-800);
  // Multiline scan — markers may be in their own paragraph or inside a
  // markdown ** bold ** wrapper. Match conservative: must START with the
  // word "ABORT" (or **ABORT) and be a fresh line, to avoid false
  // positives on prose discussing aborts.
  const m = tail.match(/^[ \t]*\*{0,2}ABORT[:\s].*$/m);
  return m ? m[0].replace(/^\*+|\*+$/g, "").trim() : undefined;
}

/**
 * Parse a `branch: <name>` line from an ops reply (Step 3 doctrine asks
 * for this verbatim). Used by runBranch to capture the feature branch
 * into pipelineState.branchName so downstream step prompts can reference
 * it without re-discovering via `git rev-parse`.
 *
 * Lenient: accepts surrounding whitespace, optional backticks, optional
 * `**branch**` markdown emphasis. Returns undefined if no marker line.
 */
export function parseBranchName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/^[ \t]*\*{0,2}branch\*{0,2}\s*:\s*`?([^\s`]+)`?\s*$/m);
  return m?.[1]?.trim();
}
