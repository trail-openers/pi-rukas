/**
 * work-driver-intent-park-text — the operator-facing words for each park reason (#1187).
 *
 * Split from work-driver-intent.ts, which sits at the 500-line cap. Keyed on
 * ParkReason; work-driver-intent.ts re-exports both functions, so importers are unchanged.
 */

import type { ParkReason } from "./work-driver-intent.ts";

/** Operator-facing sentence for a park. */
export function explainPark(reason: ParkReason, issue: number): string {
  switch (reason) {
    case "underspecified":
      return `#${issue} does not say enough to build from — the driver could not resolve a concrete intent, and writing code from a guess is how the wrong thing gets shipped confidently. Add acceptance criteria or a concrete description and re-run.`;
    case "contradicted-by-code":
      return `#${issue}'s central claim is contradicted by the code as it actually is. The issue may be stale, or describe a bug that was already fixed. Check the evidence below before re-running.`;
    case "already-implemented":
      return `#${issue} appears to be already implemented. Close it if you agree, or say what is still missing and re-run.`;
    case "too-large":
      return `#${issue} is too large to execute as one cycle. Split it into separate issues; each should be a diff a reviewer can hold in their head.`;
    case "unresolved-critical-open-point":
      return `#${issue} has unresolved CRITICAL open points in its Open points section (listed below). The driver will not choose the answer for you. Answer each one in the issue body and mark it [RESOLVED] right after its severity tag on the first line; an emphasised **[RESOLVED]** does not count. Then re-run.`;
    case "blank-issue-body":
      return `#${issue}'s body is blank, so the driver could not check its Open points section. Add the issue body and re-run.`;
    case "premise-unsound":
      return `#${issue} rests on a premise the driver could not substantiate — typically an API or behaviour that does not exist as described. Confirm the premise and re-run.`;
  }
}

/** The human action for a park, for the queue summary. */
export function parkAction(reason: ParkReason, issue: number): string {
  switch (reason) {
    case "underspecified":
      return `add acceptance criteria or a concrete description to #${issue}`;
    case "contradicted-by-code":
      return `check #${issue} against the current code — it may be stale or already fixed`;
    case "already-implemented":
      return `confirm and close #${issue}`;
    case "too-large":
      return `split #${issue} into separate issues`;
    case "unresolved-critical-open-point":
      return `answer each unresolved CRITICAL open point in #${issue}'s body (mark it [RESOLVED] right after its severity tag, unemphasised) and run /work ${issue} --restart`;
    case "blank-issue-body":
      return `add a body to #${issue} and run /work ${issue} --restart`;
    case "premise-unsound":
      return `confirm the premise of #${issue} — the driver could not substantiate it`;
  }
}
