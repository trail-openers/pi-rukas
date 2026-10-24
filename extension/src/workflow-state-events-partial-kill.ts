/**
 * /work workflow state — the `partialAfterKill` disclosure field on the
 * `dispatch-completed` event (#1779).
 *
 * A `lens-fix` child killed AT the bound the review budget arms is converted
 * into a completed dispatch when it had already committed, so the adversarial
 * gate reviews those commits and `integrateLensFix` lands them (see
 * `work-driver-lens-fix-bound-land.ts`). The conversion must be distinguishable
 * from a dispatch that finished normally, and not only in prose: `summary` is
 * text the operator reads, this field is what a reader of the event log checks.
 *
 * Absent = the dispatch finished normally. Split out of
 * workflow-state-events.ts for the 500-line gate (AGENTS.md §12); the event
 * union imports it from here.
 */
import type { WorkStep } from "./workflow-state-events.ts";

export type PartialAfterKill = {
  /** The kill cause the conversion accepted: `timeout` or `child-bound`. */
  killCause: string;
  /** The commits the fixer made on top of the round's starting tip, oldest first. */
  commitShas: string[];
  /** When the kill happened — the converted event's `at` carried verbatim. */
  at: number;
};

/**
 * #1593/#1789 — the marker saying a kill's `timeout` came from the CALLER's
 * cycle deadline (`PI_ENSEMBLE_CYCLE_DEADLINE`) tightening the child's own
 * bound, rather than from one the fixer was armed with. It is persisted because
 * the lens-fix partial-fix conversion must refuse such a kill: a cycle out of
 * time has to park, not advance. Absent = the bound was the child's own.
 */
export type CycleDeadlineKill = true;

/**
 * The write-ahead marker a dispatch appends BEFORE it awaits (#382), so a crash
 * mid-dispatch is visible on disk. `beginDispatch` is its only writer; the event
 * union references it rather than spelling the member, which keeps that union
 * inside the file-size gate.
 */
export type DispatchStartedEvent = {
  kind: "dispatch-started";
  step: WorkStep;
  role: string;
  jobId: string;
  label: string;
  at: number;
  transcriptPath?: string;
};
