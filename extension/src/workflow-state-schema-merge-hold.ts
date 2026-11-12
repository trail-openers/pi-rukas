/**
 * #1533 — validation for `pipelineState.mergeHold`'s head-pin fields, and #2181's
 * author-gate field.
 *
 * `mergeHold` reaches the operator through four renderers (explain, the queue
 * action, the chat and markdown handoff), and since #1533 two of its fields
 * carry commit OIDs that a recovery command is built from. A hand-edited or
 * corrupt state file that put a non-OID in `reviewedHead` would render that
 * value into a `gh pr merge … --match-head-commit <garbage>` line the operator
 * is told to paste — so the shape is checked at read, the same #533 rule
 * `commitPrRoot`, `prDraft` and `dirtyRootExemptBaseline` follow: the untyped
 * cast in `readState` is the only runtime gate, so the validator is it.
 *
 * Absent validates: a pre-#1533 state file has none of these fields, and a
 * cycle held on CI evidence rather than on the head records none of them. Same
 * for #2181's field: every cycle that predates the author gate has none.
 */

const FULL_OID = /^[0-9a-f]{40}$/;

/** Findings for the three head-pin fields, or [] when each is absent or well-formed. */
export function mergeHoldHeadFindings(mergeHold: unknown): string[] {
  if (mergeHold === undefined) return [];
  if (typeof mergeHold !== "object" || mergeHold === null) {
    // The pre-#1533 renderers never validated the record's shape at all; this
    // module's contract is the three new fields, so a non-object is reported
    // once and the field checks are skipped rather than crashing on it.
    return ["pipelineState.mergeHold is not an object"];
  }
  const h = mergeHold as Record<string, unknown>;
  const out: string[] = [];
  for (const field of ["reviewedHead", "headAtMerge"] as const) {
    const v = h[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || !FULL_OID.test(v)) {
      out.push(
        `pipelineState.mergeHold.${field} is not a full 40-char commit SHA (${JSON.stringify(String(v).slice(0, 48))})`,
      );
    }
  }
  if (h.headCheckReason !== undefined && typeof h.headCheckReason !== "string") {
    out.push("pipelineState.mergeHold.headCheckReason is not a string");
  }
  // #2181 — the author gate's own mark. It reaches the operator through the same
  // four renderers as the head fields, and it is the only thing that says which
  // gate parked, so its type is checked rather than trusted.
  if (h.authorGateReason !== undefined && typeof h.authorGateReason !== "string") {
    out.push("pipelineState.mergeHold.authorGateReason is not a string");
  }
  return out;
}
