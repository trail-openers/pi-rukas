/**
 * work-develop-fence-verdicts — #814: flip branches-converged verdicts for
 * fence violators + the operator-facing sibling-declared attribution prose.
 *
 * Extracted from work-develop-topological.ts so the smoke tests exercise the
 * REAL function instead of a test-local re-implementation (test-copy defect).
 * Pure: the caller keeps the `ids.length > 1` guard; this function does no
 * fanout-size checks of its own.
 */
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** #814 — a per-workstream develop verdict entry (see runDevelopTopological). */
export type FenceVerdictEntry = { id: string; ok: boolean; reason?: string };

/**
 * #814 — the SIBLING-DECLARED attribution sentence, shared by every site
 * that reports the fence materialising at consolidation: runVerifyCommandGate's
 * conflict failure string and explainConsolidation's fence attribution (the
 * `consolidated-verify-conflict` cap). One home for the wording — the two
 * sites name the violating workstream, the file, and the declaring sibling
 * with identical prose.
 */
export function describeSiblingFenceViolations(
  records: FenceViolationRecord[],
): string | undefined {
  const violations = records.filter((v) => v.kind === "sibling-declared");
  if (violations.length === 0) return undefined;
  return violations
    .map(
      (v) =>
        `workstream ${v.workstreamId} touched ${v.file}, declared by workstream ${v.declaredById}`,
    )
    .join("; ");
}

/**
 * #814 — a workstream that violated its fence must not report a bare "ok"
 * in the branches-converged verdicts (the #792 dishonesty: fence violations
 * recorded, fan-out reported 5/5 ok). The structured records name the
 * violating workstream ids for BOTH blocking kinds (`sibling-declared` and
 * `issue-fenced`); replace the affected entries in `verdicts` with fresh
 * objects. The caller keeps the `ids.length > 1` guard; this function does
 * no fanout-size checks of its own.
 *
 * Mutates the array it is given in place (entry replacement) and returns the
 * same array. The caller passes a fresh COPY of its own verdicts so the flip
 * does not leak into live state (see work-develop-topological.ts).
 * `undeclared` records never flip (warn-only).
 */
export function applyFenceVerdicts(
  verdicts: FenceVerdictEntry[],
  fenceViolations: FenceViolationRecord[],
): FenceVerdictEntry[] {
  const blocking = new Map<string, string[]>();
  for (const fv of fenceViolations) {
    if (fv.kind === "undeclared") continue;
    const files = blocking.get(fv.workstreamId) ?? [];
    files.push(
      fv.kind === "sibling-declared" ? `${fv.file} (declared by ${fv.declaredById})` : fv.file,
    );
    blocking.set(fv.workstreamId, files);
  }
  if (blocking.size > 0) {
    for (let i = 0; i < verdicts.length; i++) {
      const entry = verdicts[i];
      if (!entry) continue;
      const files = blocking.get(entry.id);
      if (!files || !entry.ok) continue;
      verdicts[i] = {
        id: entry.id,
        ok: false,
        reason: `fence violation: ${files.join(", ")}`,
      };
    }
  }
  return verdicts;
}

/**
 * #814 — the in-place verdict replacement of the develop branches-converged
 * event. #814's single invariant: when the develop verify gate records fence
 * violations, the persisted branches-converged verdicts carry the FLIPPED
 * verdicts — one event, replaced immutably (a new eventLog array; the original
 * event object is never mutated), never a second branches-converged. The last
 * develop branches-converged in the log is replaced with a fresh event carrying
 * a copy of the new verdicts; narrowing on `kind` keeps the spread typed. The
 * state is returned unchanged when no develop branches-converged exists.
 */
export function replaceDevelopConvergedVerdicts(
  state: WorkState,
  verdicts: FenceVerdictEntry[],
): WorkState {
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e && e.kind === "branches-converged" && e.step === "develop") {
      const updated: WorkEvent = {
        ...e,
        verdicts: verdicts.map((v) => ({ ...v })),
      };
      return {
        ...state,
        eventLog: state.eventLog.map((ev, j) => (j === i ? updated : ev)),
      };
    }
  }
  return state;
}
