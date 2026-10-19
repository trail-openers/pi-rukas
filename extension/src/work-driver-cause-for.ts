/**
 * work-driver-cause-for — #1675: the one cause verdict for a cycle, computed
 * the same way for every surface. The headless result (headless/result.ts),
 * the issue comment and PR body (work-driver-handoff-markdown.ts), the in-chat
 * message (work-driver-handoff-message.ts) and the queue line
 * (work-queue-single-entry.ts) all call causeForCycle, so they cannot disagree.
 *
 * The verdict is scrubbed here, at the producer (causeSafeText): reason and
 * evidence are the text every surface prints. A verdict that cannot be computed
 * is not dropped: it becomes a pi-rukas verdict naming the internal error, with
 * the error as evidence, and the failure is traced. The handoff still lands.
 */

import { redactClip } from "./decision-log.ts";
import type { HeadlessCap } from "./headless/caps.ts";
import { lastCap } from "./headless/exit-code.ts";
import { failedStepOf } from "./headless/failed-step.ts";
import { failureOf } from "./headless/failure.ts";
import { traceWarn } from "./trace.ts";
import { type CauseVerdict, causeVerdictOf } from "./work-driver-cause-class.ts";
import { causeSafeText } from "./work-driver-cause-scrub.ts";
import type { WorkState } from "./workflow-state.ts";

const ERROR_LINE_MAX = 300;

/** The verdict for the cycle's last cap, scrubbed. Undefined only when the cycle merged. */
export function causeForCycle(state: WorkState): CauseVerdict | undefined {
  try {
    const cap = lastCap(state);
    // The cap name is the cycle's own record; failureOf takes the headless cap
    // union, which every recorded cap belongs to (the table covers the rest).
    const failure = failureOf(state, cap as HeadlessCap | undefined, failedStepOf(state));
    const verdict = causeVerdictOf(state, cap, failure);
    if (verdict === undefined) return undefined;
    return {
      ...verdict,
      causeReason: causeSafeText(verdict.causeReason),
      causeEvidence: verdict.causeEvidence.map(causeSafeText),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    traceWarn(`work-driver: cause could not be classified for issue ${state.issue} — ${message}`);
    return {
      causeClass: "pi-rukas",
      causeReason: "the cause could not be classified (internal error)",
      causeEvidence: [causeSafeText(redactClip(message, ERROR_LINE_MAX))],
      userAction: null,
    };
  }
}
