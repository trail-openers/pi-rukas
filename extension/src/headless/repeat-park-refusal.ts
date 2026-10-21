/**
 * headless/repeat-park-refusal — how a start the #1743 repeat-park guard
 * refused is reported (split from `run.ts` for the §12 file-size cap).
 *
 * The guard fires before the driver persists anything, so the state file on
 * disk still describes the EARLIER cycle it was left by. Projecting it would
 * hand the host that cycle's cap, handoff, usage and exit code as if this
 * start had produced them, and would take its exit code instead of 40. So a
 * refused start is projected from an empty state instead, per issue in the
 * group, and the state file is never read.
 */

import { trace } from "../trace.ts";
import { REPEAT_PARK_REFUSAL_PREFIX, isRepeatParkRefusal } from "../work-driver-state-guards.ts";
import type { DriverOutcome } from "../work-driver.ts";
import { workStateFile } from "../workflow-state.ts";
import { EXIT } from "./exit-code.ts";
import type { IssueResult } from "./result.ts";
import { repeatParkRefusalResult } from "./result.ts";

/** The guard's refusal reason, when this outcome is one. */
export function repeatParkRefusalReason(
  outcome: DriverOutcome | "expired" | { crashed: string },
): string | undefined {
  if (outcome === "expired" || !("started" in outcome) || outcome.started) return undefined;
  return isRepeatParkRefusal(outcome.reason) ? outcome.reason : undefined;
}

/**
 * Project one refused group. Returns the per-issue exit codes (all
 * `EXIT.refused`) and appends one result per issue — `not-started`, cap
 * `repeat-park`, no `handoff` field — or `undefined` when this outcome is not
 * a repeat-park refusal, in which case the caller proceeds with the normal
 * state-file projection.
 */
export function projectRepeatParkRefusal(
  group: number[],
  repoRoot: string,
  outcome: DriverOutcome | "expired" | { crashed: string },
  results: IssueResult[],
): number[] | undefined {
  const reason = repeatParkRefusalReason(outcome);
  if (reason === undefined) return undefined;
  const detail = reason.slice(REPEAT_PARK_REFUSAL_PREFIX.length);
  const codes: number[] = [];
  for (const issue of group) {
    codes.push(EXIT.refused);
    results.push(repeatParkRefusalResult(issue, workStateFile(repoRoot, issue), detail));
  }
  trace(`headless: issue group [${group.join(", ")}] refused by the repeat-park guard`);
  return codes;
}
