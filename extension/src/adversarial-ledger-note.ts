/**
 * adversarial-ledger-note — the #980 "review not recorded in the merge
 * ledger" note for the adversarial loop, split from adversarial.ts (the
 * 500-line gate).
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
 */

import { execp } from "./lens-exec.ts";
import { NOT_RECORDED_NOTE, resolveReviewBranch } from "./review-branch.ts";
import type { DispatchResult } from "./types.ts";

export interface LedgerNoteHelpers {
  /** The "not recorded" note, or undefined when the branch resolved. */
  ledgerNote: string | undefined;
  /** Thread the note into a result's text at every return (all seven exits
   * share the same wording; a no-op when the branch resolved). */
  withLedgerNote: (r: DispatchResult) => DispatchResult;
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
  return { ledgerNote, withLedgerNote };
}
