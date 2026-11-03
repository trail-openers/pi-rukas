/**
 * headless/work-lean-handoff — the run's report, projected through the SAME
 * reader `work`'s result uses (#1920 slice B, item 3).
 *
 * Split from `work-lean-result.ts` at AGENTS.md §12's line cap along the seam the
 * projection already had: that file answers "what did the run achieve" (status,
 * cap, `prState`, usage), this one answers "who was told, and with what words".
 * They meet at one call.
 *
 * The projection reports only what the run OBSERVED. `handback` and `decline`
 * post their comment themselves and never throw, so the only account of whether
 * it reached the forge is the typed `posted` on their outcome — and a step that
 * recorded no claim at all is NOT delivered either. So:
 *
 *   - `delivery`/`channel` are `dispatch`/`forge` only when `posted === true`:
 *     `delivery` records where a post that HAPPENED came from, so its absence is
 *     "nobody posted", and `channel` stays `forge` because the report was
 *     addressed to the forge and never got there;
 *   - on `PI_ENSEMBLE_HANDOFF_CHANNEL=host` the report was ADDRESSED to the host
 *     (#1920 item 3): `delivery: "host"`, `labelSkipped: "host-channel"`, and the
 *     body published whatever `posted` says, because on that channel the body in
 *     the result IS the delivery — nothing was ever meant to reach the forge, so
 *     `posted: false` there is the contract rather than the not-delivered pair
 *     `bodyError: "not-recorded"`, which stays the answer for a forge post that
 *     failed (`handback`'s own reason says which of the two happened);
 *   - `labelApplied` is false on every path — lean has no label step, so `true`
 *     would be a claim the run has no step to make (and `labelSkipped:
 *     "host-channel"` is set only on the host channel, where a false label is the
 *     contract rather than an outage);
 *   - no `handoffBodyPath`: nothing in `lean/` writes a report file, and
 *     `handoffOf` turns one into `bodyFile` — a path a person would open to find
 *     no file there.
 *
 * `body` is the run's OWN record (the marker line, then the reason the step left
 * on the log), never a re-read of a file — #1327's rule — clipped ONCE, after
 * redaction, to the room the composed body has left, because the reason is a
 * child's text and a host prints this document.
 *
 * A report with text reaches `handoffOf` through `makeHandoffEmittedEvent`, the
 * driver's own producer of that event, so it is a real `WorkEvent`; the state
 * around it is `initialState`'s own value with its `eventLog` replaced by that one
 * event. Only a forge post that FAILED is built directly: the event type REQUIRES
 * a `body` (#1820) and this projection has nothing to put in one when the report
 * was addressed to the forge and the forge took nothing.
 */

import { redactClip } from "../decision-log.ts";
import { type Outcome, type Step, newestDecided } from "../lean/state.ts";
import type { LeanRun } from "../lean/state.ts";
import { handoffChannel, handoffMarker } from "../work-driver-handoff-channel.ts";
import { makeHandoffEmittedEvent } from "../work-driver-handoff-post.ts";
import { initialState } from "../workflow-state.ts";
import type { HeadlessCap } from "./caps.ts";
import { type HandoffResult, handoffOf } from "./result.ts";

/** How long one piece of the run's own prose may be on the host's document. Same
 * bound and seam as `headless/failure.ts`: redaction happens BEFORE the clip, so
 * a cut cannot leave a fragment no pattern recognises. */
const TEXT_MAX = 500;

/** The gap between the marker line and the reason. */
const BODY_GAP = "\n\n";

/** The run's own words for why it ended, preferring the outcome's reason. */
function outcomeText(outcome: Outcome | undefined): string | undefined {
  if (outcome === undefined) return undefined;
  // `Outcome`'s two prose fields are optional strings, and the log this
  // projection reads is a `Step[]` the loader is not the only thing that hands
  // over — so both are re-checked rather than trusted.
  for (const text of [outcome.reason, outcome.message]) {
    if (typeof text === "string" && text.trim() !== "") return text.trim();
  }
  return undefined;
}

/** The newest decided step of a reporting state — the run's last own words. */
function reportedStep(steps: Step[]): Step | undefined {
  return newestDecided(steps, "handback") ?? newestDecided(steps, "decline");
}

export function leanHandoff(run: LeanRun, cap: HeadlessCap | undefined): HandoffResult | undefined {
  const reported = reportedStep(run.steps);
  const reason = outcomeText(reported?.outcome);
  if (reason === undefined) return undefined;
  const at = reported?.endedAt ?? reported?.startedAt ?? 0;
  const marker = handoffMarker(run.issue, cap);
  const posted = reported?.outcome?.posted === true;
  const host = handoffChannel() === "host";
  // ONE clip, sized so the COMPOSED body fits `TEXT_MAX`; clipping the reason to
  // the whole budget and bounding the body again cut the reason away once the
  // marker was added.
  const clip = Math.max(0, TEXT_MAX - marker.length - BODY_GAP.length);
  if (!posted && !host) {
    // Nothing reached the forge: no delivery provenance and no text —
    // `HandoffResult`'s own not-delivered pair.
    return { channel: "forge", marker, labelApplied: false, bodyError: "not-recorded" };
  }
  const event = makeHandoffEmittedEvent({
    at,
    // Lean posts through no driver seam that returns a URL, so there is no
    // comment address to record — only whether the post happened.
    commentUrl: undefined,
    // Lean has no label step, so it never claims one — posted or not.
    labelApplied: false,
    handoffBodyPath: "",
    // The text the forge took, redacted then clipped to the room the body has
    // left (`redactClip` scrubs BEFORE it clips, so a cut cannot leave a
    // fragment no pattern recognises).
    body: `${marker}${BODY_GAP}${redactClip(reason, clip)}`,
    // The host channel's delivery fields are a different answer to the same
    // question ("who has this report now"), so one spread per channel rather
    // than a forge event whose provenance is then overwritten.
    ...(host
      ? {
          delivery: "host" as const,
          labelSkipped: "host-channel" as const,
        }
      : {
          delivery: "dispatch" as const,
          targetType: "issue" as const,
          targetNumber: run.issue,
        }),
    consolidated: false,
  });
  return handoffOf({ ...initialState(run.issue), eventLog: [event] }, cap);
}
