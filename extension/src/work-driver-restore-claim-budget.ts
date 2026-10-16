/**
 * work-driver-restore-claim-budget — the ceiling of `restoreClaim`'s
 * not-restored wording, as a sum of the constants that produce it.
 *
 * `CAUSE_BUDGET` in work-driver-conflict-evidence.ts has to reserve room for
 * the worst claim `restoreClaim` can emit, and that reservation cannot be a
 * guess: a budget sized for one fixture passes the day the claim widens and
 * silently cuts the conflicting-path list, which is the one thing the
 * operator needs. So the ceiling is DERIVED here, from `restoreClaim`'s own
 * exported constants plus the longest strings its producers build, and
 * `test-work-driver-restore-claim-budget.ts` measures every shape the real
 * producers emit against it.
 *
 * Split from work-driver-restore.ts (500-line gate, AGENTS.md §12).
 */
import { UNTRACKED_SHOWN } from "./work-driver-restore.ts";

/** How many still-dirty paths `verifiedRestoreRoot` names before the rest go uncounted. */
export const DIRT_SHOWN = 10;
/** How long `preserveDiscardedState` lets one git error run inside a `detail`. */
export const SAVE_ERROR_CHARS = 160;
/** Where a path can realistically land in a preserved-diff path. */
export const PRESERVED_PATH_CHARS = 256;
/** The prose `restoreClaim` wraps around the dirt list / untracked list. */
const CLAIM_PROSE_CHARS = 220;
/** Each name in a list is separated by ", ". */
const SEPARATOR_CHARS = 2;
/** Slack for wording the producers add around the claim. */
const WORDING_SLACK = 120;

/**
 * The worst-case length of
 * `restoreClaim(r, { trailing: MANUAL_REPAIR_HINT })` over any
 * `VerifiedRestoreResult` whose fields came from the real producers
 * (`verifiedRestoreRoot`, `restoreRootToRef{,Preserving}`, `saveFailedRestore`).
 */
export function restoreClaimCeiling(hintLength: number): number {
  const longestName = Math.max(PRESERVED_PATH_CHARS, SAVE_ERROR_CHARS);
  return (
    CLAIM_PROSE_CHARS +
    hintLength +
    UNTRACKED_SHOWN * (longestName + SEPARATOR_CHARS) +
    WORDING_SLACK
  );
}
