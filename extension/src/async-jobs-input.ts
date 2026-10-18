/**
 * async-jobs-input — the type contract for starting a single async job.
 *
 * `startJob` (async-jobs.ts) owns the lifecycle: the registry entry, the abort
 * controller, the deck row, the slow watch, and the settle that hands the
 * report to Pi. What the CALLER of `startJob` fills in is a separate contract —
 * how a work function receives its hooks, who consumes the result, which report
 * shape it gets, and where the run's durable output lives if the report never
 * lands. Those three interfaces are the whole of it, and none of them is
 * behaviour, so they live here rather than padding the lifecycle module that
 * already carries the settle paths AGENTS.md §12 keeps a size cap on.
 *
 * `WorkHooks` has an importer outside the lifecycle module
 * (async-jobs-batch.ts's member spec uses it directly), so this is also the
 * narrower dependency for a batch to have: it needs the hook shapes, not the
 * job registry.
 */
import type { Writable } from "node:stream";
import type { GitLineFor } from "./git-state.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import type { RunningState } from "./progress.ts";
import type { OnSlowCallback } from "./slow-notice.ts";
import type { DispatchResult } from "./types.ts";

/** Live-progress hooks passed to a job's work function. */
export interface WorkHooks {
  /**
   * Forward a child's RunningState update. Wired to the dispatch deck so the
   * footer can render live activity (#117). Work functions should pass this
   * straight through to spawnSpecialist's onProgress option.
   */
  onProgress: (state: RunningState) => void;
  /**
   * #839 — raw-event observer for the dispatch deck's live view. Work
   * functions pass this through to spawnSpecialist's onRawEvent option
   * (OPTIONAL there); it feeds the job's ring buffer (dispatch-deck-live.ts).
   */
  onRawEvent: (event: PiJsonEvent) => void;
  /**
   * Stdin-handle callback (#153). Called once after the child is spawned,
   * before the kickoff prompt is written. Work functions pass this through
   * to spawnSpecialist's onStdin option so the async-jobs registry can
   * record the handle for dispatch_steer lookups.
   */
  onStdin: (stdin: Writable) => void;
  /**
   * Orchestrator-shaped work functions (adversarial_loop) need to know their
   * own job id so they can register the currently-running inner child via
   * `setOrchestratorActiveChild`. Provided to every work function for
   * symmetry; single dispatches ignore it.
   */
  jobId: string;
}

export interface StartJobInput {
  /** Human-readable subagent label (role + optional tag, e.g. "code-review-specialist[security]"). */
  label: string;
  /** #1015 — resolved dispatch cwd; the developer/ops report's git-state line is computed
   * against it. Absent → the line reads "unverified (no cwd)", never process.cwd(). */
  cwd?: string;
  /** Test seam for the git-state line; defaults to gitStateLine. */
  gitLineFor?: GitLineFor;
  /** Role name for telemetry. */
  role: string;
  /**
   * Work function. Receives an AbortSignal tied to our internal abort
   * controller (NOT the tool's exec signal — that one is gone the moment we
   * return from execute()). Should call spawnSpecialist internally and
   * forward `hooks.onProgress` to it.
   */
  work: (signal: AbortSignal, hooks: WorkHooks) => Promise<DispatchResult>;
  /**
   * Skip the automatic dispatch-deck entry. Set true for orchestrators that
   * fan out internally (lens-review, adversarial) and manage their own
   * per-child deck entries — otherwise the orchestrator's "synthetic" row
   * would mask the real children behind it.
   */
  skipDeck?: boolean;
  /** #838 — batch key the job's deck entry groups under (the driver's
   *  per-cycle header, "work:<issue>"); ignored when `skipDeck`. */
  batchKey?: string;
  /** #838 — display label for the deck entry (row + batch grouping); the
   *  job's own events keep `label` (the driver's cap checkpoint parses the
   *  workstream id out of it). Absent → the deck entry shows `label`. */
  deckLabel?: string;
  /**
   * Who consumes the result. Default "pm" — preserves the existing
   * send-as-steer behaviour every dispatch tool depends on. Set "driver"
   * when an in-process caller (e.g. the work-driver) will await the
   * `completion` promise directly; we then skip the sendUserMessage steer
   * so PM doesn't see a `[ensemble:async]` it didn't ask for.
   *
   * See SingleJobState.ownerKind for the full rationale.
   */
  ownerKind?: "pm" | "driver";
  /**
   * #1044 — the report shape. Default "subagent": `formatSingleReport`, which
   * renders the child's turn count, usage, kill-cause headline and (for a
   * finished developer) the hand-managed-work gate line. Set "driver" for an
   * in-process compiled pipeline (plan / research) whose work function
   * returns a pre-rendered `text` and no subagent observables: the report is
   * then `formatDriverReport` — the standard `[ensemble:async] … (job <id>)`
   * header plus the rendered text VERBATIM, with no turn count, no usage and
   * no developer footer, none of which a pipeline produces.
   */
  reportKind?: "subagent" | "driver";
  /**
   * #1541 review — what the "driver" report shape does when its steer never
   * reaches the host. `deliverReport` cannot throw but returns `false` when
   * `sendUserMessage` rejected, and only this branch reads that signal: the
   * driver report is the run's ONLY result, so a refused steer would otherwise
   * leave the promise PM was handed — "the result arrives later as one
   * `[ensemble:async]` steer" — evaporated: a killed or completed run, and
   * nothing in the session. The sibling PM paths deliberately keep the older
   * shape (only a build THROW falls back) — see `DeliverOrStandInOptions`.
   *
   * Test seam only. Production always runs the real stand-in fallback; a test
   * passes `false` to prove the branch actually reads the boolean rather than
   * assuming the send worked.
   *
   * #1541 review round 4 (HIGH): it is now threaded into `deliverOrStandIn` as
   * its `options.deliver` rather than called by the branch itself, so the
   * formatter-throw path and the refused-send path share one fallback — and a
   * test that injects it still exercises the real build-and-deliver sequence.
   */
  deliverForTest?: (report: string) => boolean;
  /**
   * #1541 review (HIGH) — where the run's result lives OUTSIDE the report, for
   * the delivery-failure stand-in to name (`driverReportStandIn`'s `where`).
   * Only meaningful with `reportKind: "driver"`, and only as an up-front hint:
   * the tool knows what the pipeline CAN write (a research artifact under
   * `outputs/`, a filed issue) before it runs; the run's own `reportWhere` on
   * the result says what it DID write and takes precedence. Absent in both → a
   * generic pointer at `dispatch_status`, never a fabricated path.
   */
  reportWhere?: string;
  /**
   * #1044 — the run's identifier as the operator names it (a plan descriptor,
   * a research topic). Used by the "driver" report shape so each report in a
   * concurrent pair names its OWN run; absent → `label`. Rendered into the
   * header UNTRUSTED and unescaped — it is a caller-supplied string that an
   * LLM wrote — so the same reasoning that keeps a work-driver label out of a
   * parsed field applies: read it as prose, never as a marker.
   */
  subject?: string;
  /**
   * #799 — invoked by the slow-run watch (slow-notice.ts) on each threshold
   * crossing, before the PM notice and the auto-steer. The driver threads
   * its `dispatch-slow` event appender through `dispatchCore`; PM jobs never
   * set it (their watch has no cycle state to append to). Must be sync and
   * must not throw (the watch catches, but the contract is synchronous).
   */
  onSlow?: OnSlowCallback;
}

export interface StartJobHandle {
  jobId: string;
  /**
   * Resolves with the DispatchResult when the work function settles. Always
   * returned. PM-owned callers normally ignore it (the steer is the
   * contract). Driver-owned callers await this to consume the result
   * directly — `deliverReport` is skipped for them so PM never sees an
   * `[ensemble:async]` it didn't initiate.
   *
   * Note: this promise resolves (not rejects) for both ok and failed
   * dispatches — failure is encoded in `result.ok === false` /
   * `result.errorStop`. It DOES reject if the work function throws
   * (transport / spawn-level errors before any DispatchResult is produced).
   * Driver code should catch that explicitly.
   */
  completion: Promise<DispatchResult>;
}
