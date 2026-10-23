/**
 * workflow-state-cap-helpers — the read-only event-log scans and the verbatim
 * `evidence` / failure-string markers that used to sit in
 * `workflow-state-cap.ts` (#1696; split for the AGENTS.md §12 file-size gate).
 *
 * Why its own module rather than more exports in the types module:
 * `workflow-state-cap.ts` is imported by `workflow-state-schema.ts`, which
 * `workflow-state.ts` and `workflow-state-update.ts` import. A VALUE export
 * there — a function, or one of these string constants — is a runtime edge back
 * into the schema module from anywhere that wants to read an event log, and that
 * is the TDZ shape #1362 recorded (`CAP_TEMPLATES` uninitialised at
 * `workflow-state-validate-caps.ts:117`, from a runtime edge through
 * `headless/caps.ts`). This module's imports are BOTH type-only, so it is safe
 * to reach for from anywhere. `workflow-state-cap.ts` re-exports everything here
 * so every existing importer keeps its path.
 */

import type { WorkEvent } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state-schema.ts";

/**
 * #1137 — the `evidence` prefix a fix-pass park writes on its cap-hit
 * (`fix-pass-park`; `verify-failed:develop` before #1349). The explain
 * renderer keys on it to prefer that evidence over the gate's failure
 * bullets; the fix pass writes it. One constant, both sides.
 */
export const FIX_PASS_EVIDENCE_PREFIX = "adversarial fix pass: ";

/**
 * #1543 — the `evidence` prefix of an `integration-worktree-violation` cap the
 * commit-pr fallback raises when it could not CREATE the integrate worktree.
 * The same cap also reports the post-dispatch branch-holder audit (#861), and
 * the renderers told the audit's story — an ops child in the wrong tree — for a
 * `git worktree add` that failed before any ops child existed. One constant,
 * both sides.
 */
export const INTEGRATE_CREATE_FAILED_PREFIX = "integrate worktree could not be created: ";

/** Leads the failure string of a commit-pr re-entry refused on a PR that is not open. */
export const PR_NOT_OPEN_MARKER = "[pr-not-open]";

/** A `cap-hit` event — the one shape both scans below return. */
export type CapHitEvent = Extract<WorkEvent, { kind: "cap-hit" }>;

/**
 * The most recent `cap-hit` event with the given `cap`, or `undefined`.
 * #830 — the handoff surfaces used to each write their own
 * `[...state.eventLog].reverse().find(…)` scan; this is the shared one.
 */
export function lastCapHit(state: WorkState, cap: string): CapHitEvent | undefined {
  return [...state.eventLog]
    .reverse()
    .find((e): e is CapHitEvent => e.kind === "cap-hit" && e.cap === cap);
}

/**
 * The most recent `cap-hit` event of ANY cap, or `undefined` — the no-cap
 * variant of `lastCapHit`, same scan and same rule (#830): one reader of the
 * event log, so a caller asking "what capped this cycle" cannot disagree with
 * one asking "did THIS cap fire". #1696 — the host park signal's row identity
 * reads the last cap-hit, and a hand-rolled reverse-find there was a second
 * implementation of this scan.
 */
export function lastCapHitAny(state: WorkState): CapHitEvent | undefined {
  return [...state.eventLog].reverse().find((e): e is CapHitEvent => e.kind === "cap-hit");
}
