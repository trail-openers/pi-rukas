/**
 * slow-notice-types — the public type surface of the slow-run watch
 * (slow-notice.ts), moved here verbatim so slow-notice.ts stays under the
 * 500-line limit. The watch itself (arm/feed/tick) stays in slow-notice.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SteerSource } from "./dispatch-steer.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";

/** The one place the driver's dispatch-slow events get appended: threaded
 * through `dispatchCore`'s opts (work-driver-event seam). Absent for PM
 * jobs (their notice is PM-only). */
export type OnSlowCallback = (info: {
  step: string;
  role: string;
  jobId: string;
  label: string;
  elapsedMs: number;
  turns: number;
  tokens: number;
  at: number;
  /** #907 — ms of wall time the child spent in an in-flight CI-watch
   * tool call (excluded from the elapsed dimension); present only when
   * nonzero. */
  ciWaitExcludedMs?: number;
}) => void;

export interface SlowWatchInput {
  /** Deck key / job id the PM sees (what dispatch_peek shows). */
  id: string;
  role: string;
  label: string;
  /** Injectable pi — the notifyAgent target. Defaults to the parent
   * extension api (async-jobs-registry) so children spawned without a pi in
   * scope (lens, adversarial) still notify the PM. Undefined in the suite →
   * the notice is skipped, never thrown. */
  pi?: Pick<ExtensionAPI, "sendUserMessage">;
  /** Injectable steer core — tests record instead of writing to a real
   * stdin. Defaults to `steerChild`. */
  steerFn?: (jobId: string, text: string, source: SteerSource) => unknown;
  /** Injectable clock — the elapsed dimension is computed from it (tests
   * drive it deterministically). */
  now?: () => number;
  /** #907 — raw-event seam: the caller passes its `onRawEvent` through so
   * the watch's own clock feeds the CI-wait span tracker (a toolCall block
   * opens a span, the matching toolResult closes it). When absent the watch
   * gets no exclusion (a site that cannot feed events simply does not). */
  onRawEvent?: (event: PiJsonEvent) => void;
  /** Injectable scheduler for the elapsed check — tests arm/tick without
   * waiting on a 20-minute wall. Returns the matching cancel. Defaults to an
   * unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
  onSlow?: OnSlowCallback;
}

/** The handle `watchSlowDispatch` returns: `stop` releases the watch, and
 * `onRawEvent` (when the caller passed an `onRawEvent` input) is the
 * watcher-side raw-event hook the caller threads into its work — the
 * span tracker is chained in front of the caller's hook, so the child's
 * events reach both the watch and the caller's own consumer (the deck's
 * live buffer). Absent when the caller passed no onRawEvent (no span
 * feed → no exclusion). */
export interface SlowWatchHandle {
  stop: () => void;
  onRawEvent?: (event: PiJsonEvent) => void;
}
