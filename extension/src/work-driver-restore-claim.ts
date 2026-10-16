/**
 * work-driver-restore-claim — the shape a restore reports and the one sentence
 * it produces for the operator, split out of work-driver-restore.ts when the
 * #1362 baseline plumbing pushed that file past the AGENTS.md §12 500-line
 * gate. Behaviour did not move; the two declarations beside the restores that
 * build them did.
 *
 * They live together because they are one contract: `restoreClaim` is the only
 * reader of `VerifiedRestoreResult`, and every restore site emits exactly one
 * of its three shapes. Splitting the pair across files is how an unqualified
 * "restored" claim gets re-introduced — a caller invents a fourth shape the
 * renderer never anticipated.
 */

/** The verified post-condition of a restore attempt. */
export interface VerifiedRestoreResult {
  /** True only when `git status --porcelain` at repoRoot was empty of
   *  tracked dirt after the reset + checkout. Callers MUST NOT claim
   *  "restored" unless this is true. */
  restored: boolean;
  /** When `restored` is false: the distinct failure, naming the paths still
   *  dirty (or the command that could not run). */
  detail?: string;
  /** Where the discarded state was preserved, if it was captured. */
  preservedAt?: string;
  /** #1093 — true when the checkout itself succeeded (HEAD moved), even if
   *  tracked dirt then remained and `restored` is false. */
  checkedOut?: boolean;
  /** #1093 — untracked files present at repoRoot after a successful restore.
   *  They do not make `restored` false (the restore never sweeps them), but
   *  the claim must name them rather than say "verified restored".
   *
   *  #1362 — the list is built by `isClaimCountedEntry`, which spares an
   *  untracked file under a configured exempt prefix ONLY when the cycle-start
   *  baseline already listed it. A file the cycle wrote under that same prefix
   *  is named here, because a claim that said "verified restored" over it would
   *  be claiming a result the tree does not have. */
  untracked?: string[];
}

/** How many untracked paths a restore claim names before it counts the rest. */
export const UNTRACKED_SHOWN = 10;

/**
 * The claim text for the operator. Every caller emits one of exactly three
 * shapes — the verified post-condition, the explicit not-restored failure
 * with the preserved diff location, or the aborted-batch marker (`r ===
 * undefined`: the restore never ran because no originalRef was captured)
 * — so no site can re-introduce an unqualified "restored" claim. `label`
 * prefixes the post-condition for the caller's own wording (integrate,
 * consolidated verify, handoff consolidation each say slightly different
 * things before the claim); `trailing` appends a hint after the not-restored
 * failure (the handoff's not-restored variant tells the operator to run git
 * status).
 */
export function restoreClaim(
  r: VerifiedRestoreResult | undefined,
  opts: { label?: string; trailing?: string } = {},
): string {
  const { label, trailing } = opts;
  if (r === undefined) return "the batch was aborted";
  if (r.restored) {
    const untracked = r.untracked ?? [];
    const more =
      untracked.length > UNTRACKED_SHOWN ? ` (+${untracked.length - UNTRACKED_SHOWN} more)` : "";
    const restored =
      untracked.length > 0
        ? `repoRoot checkout was restored, but ${untracked.length} untracked file(s) remain in the checkout — they may be yours or left by the cycle: ${untracked.slice(0, UNTRACKED_SHOWN).join(", ")}${more}`
        : "repoRoot was verified restored";
    if (!label) return restored;
    return label.endsWith(" ") ? `${label}${restored}` : `${label} ${restored}`;
  }
  const preserved = r.preservedAt ? ` (discarded state preserved at ${r.preservedAt})` : "";
  const tail = trailing ? ` ${trailing}` : "";
  return `repoRoot was NOT restored: ${r.detail ?? "unknown error"}${preserved}${tail}`;
}
