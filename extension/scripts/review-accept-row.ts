/**
 * review-accept-row — the operator script's adapter onto the store's acceptance
 * transition (#1105).
 *
 * Imported by extension/scripts/review-accept.ts and by nothing under src/ (a
 * smoke test asserts it). The rules — the reason's length and secret shape, the
 * CRITICAL and resolved refusals — live in the store's `acceptFinding`, the only
 * module that writes an acceptance, so a caller that skips this file still
 * cannot record a bad one. Every refusal is `{ ok: false, reason }`, writes nothing.
 */

import { type AcceptOutcome, acceptFinding } from "../src/review-findings-store.ts";

export { MIN_REASON_CHARS, reasonProblem } from "../src/review-findings-file.ts";

/** Mark one recorded row accepted, through the store's validated transition. */
export async function acceptRow(opts: {
  cwd: string;
  branch: string;
  rowId: string;
  reason: string;
  by: string;
  now?: number;
}): Promise<AcceptOutcome> {
  return acceptFinding(opts.cwd, opts.branch, opts.rowId, {
    by: opts.by,
    reason: opts.reason,
    now: opts.now,
  });
}
