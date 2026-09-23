/**
 * work-develop-fence-verdicts — #814: flip branches-converged verdicts for
 * fence violators.
 *
 * Extracted from work-develop-topological.ts so the smoke tests exercise the
 * REAL function instead of a test-local re-implementation (test-copy defect).
 * Pure: the caller keeps the `ids.length > 1` guard; this function does no
 * fanout-size checks of its own.
 */
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";

/** #814 — a per-workstream develop verdict entry (see runDevelopTopological). */
export type FenceVerdictEntry = { id: string; ok: boolean; reason?: string };

/**
 * #814 — a workstream that violated its fence must not report a bare "ok"
 * in the branches-converged verdicts (the #792 dishonesty: fence violations
 * recorded, fan-out reported 5/5 ok). The structured records name the
 * violating workstream ids for BOTH blocking kinds (`sibling-declared` and
 * `issue-fenced`); replace the affected entries in `verdicts` with fresh
 * objects — the branches-converged event holds the same array by reference
 * (appendEvent does a shallow spread of the log, not of the verdicts
 * array), so replacing an entry (not mutating it in place) is what makes
 * the corrected verdict visible in the logged event. The immutability
 * contract no longer depends on appendEvent's spread depth: the replacement
 * happens on the live array, before any persist. `undeclared` records are
 * warnings, never a flip.
 *
 * Mutates `verdicts` in place (entry replacement, byte-identical to the
 * previous inline implementation) and returns the same array.
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
      fv.kind === "sibling-declared" && fv.declaredById
        ? `${fv.file} (declared by ${fv.declaredById})`
        : fv.file,
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
