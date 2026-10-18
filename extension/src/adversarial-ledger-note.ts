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
 * the guard will look?" is knowable only once the write resolves, so the write's
 * outcome is routed through `onLedgerOutcome` in
 * `makeLedgerWrite` (adversarial-ledger-capture.ts), which renders it with
 * `misdirectedLedgerNote` here and appends it to the live result. It is a
 * no-op for `{ recorded: true }` with no `landedAtPath` (the normal case), for a
 * `recorded: false` skip (the by-design skips name their own reason and are NOT
 * misdirections), and when the branch never resolved — that run already carries
 * the not-recorded note, and two notes about no row would be noise.
 */

import type { AdversarialLedgerOutcome } from "./adversarial-ledger.ts";
import { execp } from "./exec.ts";
import { NOT_RECORDED_NOTE, resolveReviewBranch } from "./review-branch.ts";
import { MISDIRECTED_LEDGER_NOTE } from "./review-ledger-path.ts";
import type { DispatchResult } from "./types.ts";

/**
 * #1449 — the note a loop result carries when its row landed OUTSIDE the
 * per-clone ledger.
 *
 * Lives here (rather than being inlined at the one call site) so the two
 * notes the adversarial path can emit — `NOT_RECORDED_NOTE` above and this one
 * — sit together with the rule that keeps them apart. The rule is the whole
 * design: a redirect is `recorded: true` WITH a path (see
 * `AdversarialLedgerOutcome`), while a `recorded: false` skip is one of the
 * by-design no-writes (no branch, no patch id) which name their own reason and
 * are NOT misdirections. Reporting a skip as a misdirection would cry wolf on
 * every detached-head run; reporting a redirect as a skip would hand the next
 * run a round the ledger already consumed.
 *
 * The parameter is `AdversarialLedgerOutcome | undefined` because its caller
 * cannot promise the shape it receives: `makeLedgerWrite` tolerates ANY return
 * from the writer (#1449 — a writer that hands back nothing must not cost a
 * review), so `undefined` reaches here and reads as "nothing to report", which
 * is the same answer as a by-design skip. The guard is written as a positive
 * requirement (`recorded === true`) rather than a negative one precisely so an
 * absent value falls on the silent side.
 */
export function misdirectedLedgerNote(
  outcome: AdversarialLedgerOutcome | undefined,
): string | undefined {
  if (!outcome || outcome.recorded !== true || !outcome.landedAtPath) return undefined;
  return `${MISDIRECTED_LEDGER_NOTE}\n\nWrote to: ${outcome.landedAtPath}`;
}

export interface LedgerNoteHelpers {
  /** The branch the loop's ledger write and note are keyed on — the SAME
   * shared resolution (explicit `branch` → branch-named `head` → rev-parse);
   * undefined when nothing resolved. Threaded into the ledger write (#988)
   * so it does not re-resolve. */
  branch: string | undefined;
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
  return { branch: resolution.branch, withLedgerNote };
}
