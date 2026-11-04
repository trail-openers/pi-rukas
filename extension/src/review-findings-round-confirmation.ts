/**
 * review-findings-round-confirmation — the confirmation types the round pass
 * takes, split out of review-findings-round.ts (AGENTS.md §12's 500-line gate).
 *
 * Two declarations, both of them a CONTRACT the round reads rather than logic it
 * runs, which is why they live here and not beside the pass: `HeadOf` is how the
 * round is told what a path looked like at head (the store reads it; the round
 * only asks), and `ConfirmationSource` is the commit identity a #1934
 * confirmation must bind to plus the ledger rows it is read from. The rules that
 * consume them — `rowFate`, the AC4 lapse pass, `confirmedFor` — stay with the
 * matched pass in review-findings-round.ts, where the round's single clock and
 * the ordering those rules depend on live.
 */

import type { HeadState } from "./review-findings-head.ts";
import type { LedgerEntry } from "./review-ledger-entry.ts";

/** The head state of one path, as read by the store before the round ran. */
export type HeadOf = (path: string) => HeadState | undefined;

/** The commit identity a confirmation must bind to, and the ledger rows the
 * confirmation is read from (#1934). */
export interface ConfirmationSource {
  /** The branch's ledger rows, as read by the store before the round ran. */
  ledger: readonly LedgerEntry[];
  /** The patch id of the range this round reviewed. */
  patchId: string;
  /** The full 40-char head this round reviewed. */
  headSha: string;
}
