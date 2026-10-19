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
import { CAP_TEMPLATES, FIXED_CAPS, type HeadlessCap } from "./headless/caps.ts";
import { lastCap } from "./headless/exit-code.ts";
import { failedStepOf } from "./headless/failed-step.ts";
import { failureOf } from "./headless/failure.ts";
import { traceWarn } from "./trace.ts";
import { type CauseVerdict, causeVerdictOf } from "./work-driver-cause-class.ts";
import { causeSafeText } from "./work-driver-cause-scrub.ts";
import type { WorkState } from "./workflow-state.ts";

const ERROR_LINE_MAX = 300;
const FIXED: ReadonlySet<string> = new Set<string>(FIXED_CAPS);

/**
 * Whether a recorded cap name is one the driver publishes: a fixed literal or a
 * `<family>:<param>` from a template family. An unknown name is not a headless
 * cap, so no failure is read for it (the verdict then names it as a driver gap).
 */
function isPublishedCap(cap: string): cap is HeadlessCap {
  if (FIXED.has(cap)) return true;
  const i = cap.indexOf(":");
  return i > 0 && Object.prototype.hasOwnProperty.call(CAP_TEMPLATES, cap.slice(0, i));
}

/** The verdict for the cycle's last cap, scrubbed. Undefined only when the cycle merged. */
export function causeForCycle(state: WorkState): CauseVerdict | undefined {
  try {
    const cap = lastCap(state);
    const failure = failureOf(
      state,
      cap !== undefined && isPublishedCap(cap) ? cap : undefined,
      failedStepOf(state),
    );
    const verdict = causeVerdictOf(state, cap, failure);
    if (verdict === undefined) return undefined;
    return {
      ...verdict,
      causeReason: causeSafeText(verdict.causeReason),
      causeEvidence: verdict.causeEvidence.map(causeSafeText),
    };
  } catch (err) {
    return internalErrorVerdict(state, err);
  }
}

/**
 * The verdict when classification itself threw. The trace and the redaction are
 * best-effort: neither may stop the pi-rukas verdict from being returned, or the
 * handoff would land with no cause at all.
 */
function internalErrorVerdict(state: WorkState, err: unknown): CauseVerdict {
  const message = err instanceof Error ? err.message : String(err);
  try {
    traceWarn(`work-driver: cause could not be classified for issue ${state.issue} — ${message}`);
  } catch {
    // Tracing is best-effort; the verdict below is what the handoff needs.
  }
  let evidence: string;
  try {
    evidence = causeSafeText(redactClip(message, ERROR_LINE_MAX));
  } catch {
    evidence = "the error text could not be read";
  }
  return {
    causeClass: "pi-rukas",
    causeReason: "the cause could not be classified (internal error)",
    causeEvidence: [evidence],
    userAction: null,
  };
}
