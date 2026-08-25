/**
 * workflow-state-validate — discriminant validation for /work state files.
 *
 * #533 — the reader used to hit an unrecognised event kind or step value and
 * silently carry it: `readState` passed an untyped cast, `nextStep`'s linear
 * table returned `undefined` on an unknown `currentStep`, and the while-loop's
 * 64-iteration safety counter fired with a generic message naming no field.
 *
 * dsh's persistence rule (DeepSeek Harness, 2026-08-13): a reader hitting an
 * unrecognized event type MUST refuse to reconstruct rather than silently
 * drop. This module is pi-ensemble's half of that rule — one validator that
 * checks every discriminant at read:
 *
 *   - `eventLog[].kind`
 *   - `pipelineState.currentStep`
 *   - `pipelineState.status`
 *   - `pipelineState.lastCompletedStep`
 *   - every `WorkStep`-typed event field: `step-started.step`,
 *     `dispatch-started.step`, `dispatch-completed.step`,
 *     `dispatch-failed-provider.step`, `dispatch-failed.step`,
 *     `plumb-report.step`, `branches-fanned-out.step`,
 *     `branch-completed.step`, `branches-converged.step`,
 *     `memory-inject.step`, plus `cap-hit.nextStep`.
 *
 * **Resume-path-only.** The driver (`runWorkDriver`) runs the validator on
 * every read; `/work-status`, the queue and other renderers do NOT. A
 * TERMINAL state file (merged/handoff/aborted) with an unknown kind must
 * still load — a parked cycle's history has to stay observable, and a future
 * additive event kind on a terminal file must not stop `/work-status` from
 * rendering. The versioning doc in `workflow-state.ts` pre-resolved the
 * consequence: schemaVersion stays 1 — a bump would break every live file on
 * upgrade, contradicting the documented "rm to start fresh" recovery story.
 */

import type { WorkStep } from "./workflow-state-events.ts";
import { WORK_STATE_SCHEMA_VERSION, WORK_STEPS } from "./workflow-state-schema.ts";

/**
 * Known event kinds. The union type is the source of the vocabulary; this
 * tuple exists only so the validator can test membership (types are erased
 * at runtime).
 */
export const KNOWN_EVENT_KINDS: readonly unknown[] = [
  "step-started",
  "dispatch-started",
  "dispatch-completed",
  "dispatch-failed-provider",
  "dispatch-failed",
  "adversarial-approved",
  "adversarial-rejected",
  "adversarial-round",
  "adversarial-workstream-outcome",
  "adversarial-skipped-empty-diff",
  "lens-approved",
  "lens-issues-found",
  "lens-skipped-empty-diff",
  "cap-hit",
  "plumb-report",
  "step-back-triggered",
  "step-back-completed",
  "handoff-emitted",
  "ci-status",
  "merged",
  "branches-fanned-out",
  "branch-completed",
  "branches-converged",
  "verify-full-status",
  "widening-scan",
  "memory-write",
  "memory-inject",
];

/** `pipelineState.status` vocabulary. */
export const KNOWN_STATUSES: readonly unknown[] = ["running", "merged", "handoff", "aborted"];

/**
 * #540 — `pipelineState.incompleteConsolidation.verdicts[].status`
 * vocabulary. Legacy PR14 entries carry no `status` field at all (they
 * identify themselves by `paths`); the validator tolerates the absent-
 * status + `paths` shape and refuses everything else it does not
 * recognize — the same "extend the union, don't smuggle a field" rule
 * this module applies to event kinds and steps.
 */
export const KNOWN_CONSOLIDATION_STATUSES: readonly unknown[] = [
  "complete",
  "uncovered",
  "unverifiable",
];

/** `cap-hit.nextStep` vocabulary. */
const CAP_HIT_NEXT_STEPS: readonly unknown[] = ["handoff", "step-back", "ci"];

/**
 * Human-readable findings; empty when every discriminant is a known value.
 * Each finding names the field AND the offending value — the driver halts
 * on a non-empty result and the message surfaces verbatim.
 */
export function validateDiscriminants(state: unknown): string[] {
  const out: string[] = [];
  if (typeof state !== "object" || state === null) {
    return ["state file is not an object"];
  }
  const s = state as Record<string, unknown>;

  if (s.schemaVersion !== WORK_STATE_SCHEMA_VERSION) {
    return [`schemaVersion=${String(s.schemaVersion)} (expected ${WORK_STATE_SCHEMA_VERSION})`];
  }

  const ps = s.pipelineState as Record<string, unknown> | null | undefined;
  if (typeof ps !== "object" || ps === null) {
    out.push("pipelineState is missing or not an object");
  } else {
    if (!WORK_STEPS.includes(ps.currentStep as WorkStep)) {
      out.push(`pipelineState.currentStep has unknown value ${JSON.stringify(ps.currentStep)}`);
    }
    if (
      ps.lastCompletedStep !== undefined &&
      !WORK_STEPS.includes(ps.lastCompletedStep as WorkStep)
    ) {
      out.push(
        `pipelineState.lastCompletedStep has unknown value ${JSON.stringify(ps.lastCompletedStep)}`,
      );
    }
    if (!KNOWN_STATUSES.includes(ps.status)) {
      out.push(`pipelineState.status has unknown value ${JSON.stringify(ps.status)}`);
    }
    // #539 review — the untyped cast in `readState` is the only runtime gate
    // for the record, so check it here: `commitPrRoot`, when present, must
    // be a complete `CommitPrRootState`. A partial object (a hand edit or a
    // corrupt write) would otherwise flow to the handoff renderers' arithmetic
    // as if every field were present, and render a confident wrong number.
    if (ps.commitPrRoot !== undefined) {
      const r = ps.commitPrRoot;
      if (typeof r !== "object" || r === null) {
        out.push("pipelineState.commitPrRoot is not an object");
      } else {
        const ro = r as Record<string, unknown>;
        if (typeof ro.branch !== "string" || Array.isArray(ro.branch)) {
          out.push("pipelineState.commitPrRoot.branch is missing or not a string");
        }
        if (!Array.isArray(ro.unmergedPaths)) {
          out.push("pipelineState.commitPrRoot.unmergedPaths is missing or not an array");
        }
        for (const field of ["stagedCount", "totalEntries", "capturedAt"] as const) {
          if (typeof ro[field] !== "number" || !Number.isFinite(ro[field] as number)) {
            out.push(`pipelineState.commitPrRoot.${field} is missing or not a finite number`);
          }
        }
      }
    }
    if (ps.incompleteConsolidation !== undefined) {
      const ic = ps.incompleteConsolidation;
      if (Array.isArray(ic)) {
        ic.forEach((e, i) => {
          const v = e as Record<string, unknown> | null;
          if (typeof v !== "object" || v === null) {
            out.push(`pipelineState.incompleteConsolidation[${i}] is not an object`);
          } else if (typeof v.id !== "string") {
            out.push(`pipelineState.incompleteConsolidation[${i}].id is missing or not a string`);
          }
        });
      } else if (typeof ic !== "object" || ic === null) {
        out.push("pipelineState.incompleteConsolidation is not an object or array");
      } else {
        const ico = ic as Record<string, unknown>;
        const verdicts = ico.verdicts;
        if (verdicts === undefined) {
          out.push("pipelineState.incompleteConsolidation has no verdicts field");
        } else if (!Array.isArray(verdicts)) {
          out.push("pipelineState.incompleteConsolidation.verdicts is not an array");
        } else {
          verdicts.forEach((v, i) => {
            const e = v as Record<string, unknown> | null;
            if (typeof e !== "object" || e === null) {
              out.push(`pipelineState.incompleteConsolidation.verdicts[${i}] is not an object`);
              return;
            }
            if (e.status === undefined) {
              if (!Array.isArray(e.paths)) {
                out.push(
                  `pipelineState.incompleteConsolidation.verdicts[${i}] has neither status nor paths`,
                );
              }
              return;
            }
            if (!KNOWN_CONSOLIDATION_STATUSES.includes(e.status)) {
              out.push(
                `pipelineState.incompleteConsolidation.verdicts[${i}].status has unknown value ${JSON.stringify(e.status)}`,
              );
              return;
            }
            if (e.status === "uncovered" && !Array.isArray(e.uncoveredPaths)) {
              out.push(
                `pipelineState.incompleteConsolidation.verdicts[${i}].uncoveredPaths is missing or not an array (required when status is 'uncovered')`,
              );
            }
            if (e.status === "unverifiable" && typeof e.reason !== "string") {
              out.push(
                `pipelineState.incompleteConsolidation.verdicts[${i}].reason is missing or not a string (required when status is 'unverifiable')`,
              );
            }
          });
          if (ico.filesPresent !== undefined && !Array.isArray(ico.filesPresent)) {
            out.push("pipelineState.incompleteConsolidation.filesPresent is not an array");
          }
        }
      }
    }
  }

  const log = s.eventLog;
  if (!Array.isArray(log)) {
    out.push("eventLog is missing or not an array");
  } else {
    log.forEach((entry, i) => {
      const e = entry as Record<string, unknown> | null | undefined;
      if (typeof e !== "object" || e === null) {
        out.push(`eventLog[${i}] is not an object`);
        return;
      }
      if (!KNOWN_EVENT_KINDS.includes(e.kind)) {
        out.push(`eventLog[${i}].kind has unknown value ${JSON.stringify(e.kind)}`);
        return; // an unrecognised kind's other fields are not worth parsing
      }
      if ("step" in e && e.step !== undefined && !WORK_STEPS.includes(e.step as WorkStep)) {
        out.push(`eventLog[${i}].step has unknown value ${JSON.stringify(e.step)}`);
      }
      if (e.kind === "cap-hit" && !CAP_HIT_NEXT_STEPS.includes(e.nextStep)) {
        out.push(`eventLog[${i}].nextStep has unknown value ${JSON.stringify(e.nextStep)}`);
      }
    });
  }
  return out;
}
