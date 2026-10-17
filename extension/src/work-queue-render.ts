/**
 * work-queue-render — the end-of-queue report renderer, extracted from
 * work-queue.ts (AGENTS.md §12 500-line cap). Pure formatter over the
 * `QueueSummary` the queue loop builds: one entry per group (merged /
 * parked / not-started / halted), the parked entry's `failedStep` and
 * `humanAction` on their own lines.
 *
 * #1101 — the parked line has to say WHICH kind of park it is, because the two
 * kinds ask the operator for opposite things. A cycle that ran and parked has a
 * diff, a branch and findings to read; a group the queue never dispatched has
 * none of those, and the same `⏸ … cap …` line for both sends someone to look
 * for work that was never written. The glyph and the step suffix are therefore
 * derived from the reason, not assumed from the outcome — see `parkGlyph`.
 *
 * `parkReason` and `humanActionFor` stay in work-queue.ts / work-queue-cap.ts —
 * they are the queue's DECISION logic (which step died, what the operator must
 * do), not rendering; only this text builder moves.
 */

import { isQueueLevelPark } from "./work-queue-park-reason.ts";
import type { QueueSummary } from "./work-queue.ts";

/**
 * The mark in front of a parked group, and whether to name a step after it.
 *
 * A queue-level park has no `failedStep` because nothing failed: no dispatch was
 * made and no gate ran. Printing the group's last completed step there would
 * imply the cycle got somewhere, which is the same false report the `humanAction`
 * was fixed for. The distinct glyph is what makes the difference visible while
 * skimming — an operator scanning for `⏸` to find work to salvage should not be
 * shown groups that contain none.
 */
function parkMark(reason: string | undefined): { glyph: string; step: string } {
  if (isQueueLevelPark(reason)) return { glyph: "◌", step: "" };
  return { glyph: "⏸", step: "" };
}

/** Groups the queue parked without ever dispatching them (#1101). */
function neverDispatchedCount(s: QueueSummary): number {
  return s.entries.filter((e) => e.outcome === "parked" && isQueueLevelPark(e.reason)).length;
}

/** Render the end-of-queue report. One entry per group. */
export function renderQueueSummary(s: QueueSummary): string {
  // #1101 — `parked` alone hides the distinction that matters most here. Of
  // two parked groups, one may have a branch, a PR and three rounds of review
  // findings, and the other may have produced literally nothing. Counting them
  // together under one word is how an operator decides to go look for salvage
  // that is not there, so the headline breaks the number out when any of the
  // parks is the never-dispatched kind.
  const never = neverDispatchedCount(s);
  const lines = [
    `pi-rukas: /work queue finished — ${s.merged} merged, ${s.parked} parked${
      never > 0 ? ` (${never} never dispatched)` : ""
    }${s.refused > 0 ? `, ${s.refused} did not start` : ""}${
      s.notStarted.length > 0 ? `, ${s.notStarted.length} never reached` : ""
    }`,
  ];
  for (const e of s.entries) {
    const issues = `#${e.issues.join(", #")}`;
    if (e.outcome === "merged") {
      lines.push(`  ✓ ${e.groupId} (${issues}) — merged`);
    } else if (e.outcome === "parked") {
      const { glyph, step } = parkMark(e.reason);
      const queued = isQueueLevelPark(e.reason);
      lines.push(
        `  ${glyph} ${e.groupId} (${issues}) — ${e.reason}${
          queued ? step : e.failedStep ? ` at ${e.failedStep}` : ""
        }`,
      );
      if (e.humanAction) lines.push(`      → ${e.humanAction}`);
    } else if (e.outcome === "not-started") {
      // Not a failure, emphatically not a halt: the driver declined to run,
      // usually because a live cycle already owns the issue. Rendering it
      // through the `else` below reported a halt that never happened.
      lines.push(`  – ${e.groupId} (${issues}) — did not start: ${e.reason}`);
      if (e.humanAction) lines.push(`      → ${e.humanAction}`);
    } else {
      lines.push(`  ✗ ${e.groupId} (${issues}) — ${e.reason} · queue halted here`);
    }
  }
  if (s.notStarted.length > 0) {
    lines.push(`  Not started: ${s.notStarted.join(", ")}`);
  }
  return lines.join("\n");
}
