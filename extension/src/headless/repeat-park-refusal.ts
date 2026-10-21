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
import type { DriverOutcome } from "../work-driver-outcome.ts";
import { repeatParkVerdictReason } from "../work-driver-park-memory.ts";
import { REPEAT_PARK_REFUSAL_PREFIX, isRepeatParkRefusal } from "../work-driver-state-guards.ts";
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
  // The guard's own RECORD reading, carried on the refusal outcome: the arming
  // issue, the cap, the reason and the count are read from STRUCTURED fields,
  // never parsed back out of the sentence the guard wrote for a human. The
  // reason string stays what `isRepeatParkRefusal` recognises (the driver's
  // `{started:false}` carries only that), so a refusal whose verdict did not
  // reach the outcome — an older caller, a replayed outcome — still projects.
  const verdict =
    outcome !== "expired" && "started" in outcome && !outcome.started
      ? outcome.repeatPark
      : undefined;
  const detail = verdict
    ? repeatParkVerdictReason(verdict)
    : reason.slice(REPEAT_PARK_REFUSAL_PREFIX.length);
  // The guard checked every issue in the group and stopped on the first that
  // armed it. Only THAT issue carries the `repeat-park` cap and the count; a
  // sibling is reported as not evaluated, naming the primary. Reporting each
  // member as its own repeat-park would tell the host that #11 had already
  // parked twice when nothing had ever looked at #11.
  const armed = verdict?.issue ?? refusalIssue(reason);
  const codes: number[] = [];
  for (const issue of group) {
    codes.push(EXIT.refused);
    results.push(
      armed !== undefined && issue !== armed
        ? repeatParkRefusalResult(
            issue,
            workStateFile(repoRoot, issue),
            `not evaluated: the group was refused because #${armed} ${detail.replace(/^#\d+\s/, "")}`,
            { notEvaluated: true },
          )
        : repeatParkRefusalResult(issue, workStateFile(repoRoot, issue), detail),
    );
  }
  trace(
    `headless: issue group [${group.join(", ")}] refused by the repeat-park guard${armed === undefined ? "" : ` (armed on #${armed})`}`,
  );
  return codes;
}

/**
 * The arming issue read out of the reason — the FALLBACK only, used when the
 * refusal reached here without its structured verdict. Anchored on the leading
 * `#N ` the guard's own sentence builder writes.
 */
function refusalIssue(reason: string): number | undefined {
  const m = reason.slice(REPEAT_PARK_REFUSAL_PREFIX.length).match(/^#(\d+)\s/);
  return m ? Number(m[1]) : undefined;
}
