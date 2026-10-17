/**
 * adversarial-ledger-note — the #980 "review not recorded in the merge
 * ledger" note and the #1449 "recorded, but at a redirected path" note for the
 * adversarial loop, split from adversarial.ts (the 500-line gate).
 *
 * The branch is resolved ONCE, up front, via the shared `resolveReviewBranch`
 * helper (the same one the lens review and the ledger writer use): explicit
 * `branch` → a branch-named `head` ref (remote prefix stripped, ref must
 * exist) → `git rev-parse --abbrev-ref HEAD`. When the review CANNOT be
 * keyed to a branch (detached head, no derivable branch) the ledger write
 * skips — and every tool-path result carries the VISIBLE not-recorded note
 * (NOT_RECORDED_NOTE, review-branch.ts), computed synchronously from this
 * resolution rather than by inspecting the fire-and-forget write's outcome
 * after the fact. The note fires on EVERY exit — the review was going to be
 * recorded regardless of its verdict (unlike the lens disclosure note,
 * which fires only on ISSUES_FOUND).
 *
 * #1449 adds the second, LATER note, and the two are deliberately different
 * mechanisms because they answer different questions. "Was this review
 * recordable at all?" is knowable at loop entry, so the not-recorded note above
 * is computed synchronously and threads into every exit. "Did the row land where
 * the guard will look?" is knowable only once the write resolves, so
 * `withMisdirectedNote` is the threader the write's outcome is routed through
 * (`makeLedgerWrite` in adversarial-ledger-capture.ts calls it with the
 * resolved `AdversarialLedgerOutcome`). It is a no-op for `{ recorded: true }`
 * with no `landedAtPath` (the normal case), for a `recorded: false` skip (the
 * by-design skips name their own reason and are NOT misdirections), and when the
 * branch never resolved — that run already carries the not-recorded note, and
 * two notes about no row would be noise.
 */

import type { AdversarialLedgerOutcome } from "./adversarial-ledger.ts";
import { execp } from "./exec.ts";
import { NOT_RECORDED_NOTE, resolveReviewBranch } from "./review-branch.ts";
import { MISDIRECTED_LEDGER_NOTE } from "./review-ledger-path.ts";
import type { DispatchResult } from "./types.ts";

export interface LedgerNoteHelpers {
  /** The branch the loop's ledger write and note are keyed on — the SAME
   * shared resolution (explicit `branch` → branch-named `head` → rev-parse);
   * undefined when nothing resolved. Threaded into the ledger write (#988)
   * so it does not re-resolve. */
  branch: string | undefined;
  /** Thread the note into a result's text at every return (all seven exits
   * share the same wording; a no-op when the branch resolved). */
  withLedgerNote: (r: DispatchResult) => DispatchResult;
  /** #1449 — thread the misdirected-write note in, ONCE the write resolves.
   * No-op on every outcome but a row that landed outside the per-clone ledger. */
  withMisdirectedNote: (r: DispatchResult, outcome: AdversarialLedgerOutcome) => DispatchResult;
}

/**
 * Resolve the branch (shared helper) and build the note + the
 * `withLedgerNote` threader in one call, so `runAdversarialLoop` carries no
 * note-related code of its own — the resolution, the note constant and the
 * threading live together here.
 */
export async function buildLedgerNote(opts: {
  branch?: string;
  head?: string;
  workCwd?: string;
}): Promise<LedgerNoteHelpers> {
  const resolution = await resolveReviewBranch(
    { branch: opts.branch, head: opts.head, cwd: opts.workCwd ?? process.cwd() },
    execp,
  );
  const ledgerNote = resolution.branch ? undefined : NOT_RECORDED_NOTE;
  const withLedgerNote = (r: DispatchResult): DispatchResult =>
    ledgerNote ? { ...r, text: `${r.text}\n\n${ledgerNote}` } : r;
  const withMisdirectedNote = (
    r: DispatchResult,
    outcome: AdversarialLedgerOutcome,
  ): DispatchResult => {
    // A redirect is `recorded: true` WITH a path (see AdversarialLedgerOutcome).
    // A `recorded: false` skip is a by-design no-write, not a misdirection; the
    // branchless run already carries the not-recorded note.
    if (ledgerNote || outcome.recorded !== true || !outcome.landedAtPath) return r;
    return {
      ...r,
      text: `${r.text}\n\n${MISDIRECTED_LEDGER_NOTE}\n\nWrote to: ${outcome.landedAtPath}`,
    };
  };
  return { branch: resolution.branch, withLedgerNote, withMisdirectedNote };
}
