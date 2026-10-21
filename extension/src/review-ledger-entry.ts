/**
 * review-ledger-entry — the ledger's row record and file shape.
 *
 * Split out of review-ledger.ts (AGENTS §12 file-size gate: that module sat
 * exactly at the 500-line cap and the #1557 row-nonce field had nowhere to be
 * documented). This is the DATA half of the ledger — what a row IS; the
 * write/read/lock machinery stays in review-ledger.ts and its read/path/
 * merge/round siblings. `review-ledger.ts` re-exports these types so every
 * existing importer keeps importing them from the ledger's public surface.
 */

/** The two review kinds the ledger tracks — and what a merge needs of each. */
export type ReviewKind = "adversarial" | "lens";

export interface LedgerEntry {
  /** The branch the review covered. */
  branch: string;
  kind: ReviewKind;
  /** Merge-base patch id of the changes at review time (adversarial entries must
   * MATCH the current patchId; a passing lens entry may carry an earlier one). */
  patchId: string;
  /** Computed by the shared predicates at write time — the guard trusts it. */
  passed: boolean;
  /** Unix ms; the "latest entry per kind" the guard reads is the max `at`. */
  at: number;
  /** One line of what the review concluded, for the operator's audit. */
  detail?: string;
  /** #973 — lens entries only: the branch-scoped round number this review
   * ran as (the previous latest lens entry's round + 1; a legacy entry
   * without `round` counts as round 1). Stored because the per-(branch, kind)
   * dedupe below keeps only ONE lens row per branch, so the round must live
   * on the entry, not in the file. */
  round?: number;
  /** #973 — lens entries only: whether the reviewed verdict carried a
   * CRITICAL finding. The round-cap merge rule (merge-guard-round-cap.ts)
   * requires `hasCritical === false` on the latest lens entry; a legacy
   * entry without this field cannot satisfy it (conservative refusal). */
  hasCritical?: boolean;
  /** #973 — lens entries only: the commit hash reviewed. Two consumers:
   * the delta-review auto-base (the `since` of a follow-up review defaults
   * to the latest lens entry's `headSha` when it is an ancestor of HEAD) and
   * the disclosure marker's provenance. Always a resolved 40-char SHA when
   * present (#1039); absent when the head could not be resolved; a non-SHA
   * value is malformed and refused by the round-cap path. */
  headSha?: string;
  /** #1127 — lens entries only: the operator passed `overrideCap: true` to
   * dispatch_lens_review, so this run was allowed past the tool-side round
   * budget. Recorded so an audit can see which rounds were forced. */
  overrideCap?: boolean;
  /** #1127 — lens entries only: consecutive REVIEW_INCOMPLETE runs since the
   * last completed round. An incomplete run does not advance `round`, so this
   * is the budget's only record that the branch keeps spending six-lens runs. */
  incompleteRuns?: number;
  /** #1176 — lens entries only: sha256 of the whitespace-sensitive `git diff --binary`
   * against the merge-base (review-patch-identity.ts). An empty-delta carry needs an
   * exact match; absent → no carry (a full review runs). */
  diffSha256?: string;
  /** #1176 — carried entries only: the head whose recorded verdict this entry carries.
   * Its presence is the ONLY signal bumpLensRound uses to skip the round advance. */
  carriedFrom?: string;
  /** #1176 round 2 — carried entries only: the trust assumption the row states (mainline changes merged in were not re-reviewed by this branch). */
  carryNote?: string;
  /** #1449 — the path this row's write resolved to. #1449 round 2 changed the
   * contract: the stamp is now written on EVERY row (by `appendLedgerEntry`, the
   * one function that holds the resolved path), so a new writer cannot forget it
   * and an ordinary row is evidence of where it landed rather than of nothing.
   *
   * **Presence is therefore NOT the misdirection signal** — the misdirection is
   * DERIVED, by comparing the stamp against the clone's own ledger path
   * (`cloneLedgerPathFor`, the override-blind answer) with `sameResolvedPath`.
   * A row stamped with the clone's own path is an ordinary row. The only
   * consumer, `misdirectedWriteOf` (merge-guard-provenance.ts), is a
   * DIAGNOSTIC: it changes the refusal's TEXT, never a verdict — no path in the
   * guard reads this field to decide whether a merge happens, and none may
   * (see that module's failure contract). Rendered consumers sanitise it
   * (`sanitiseLedgerProvenancePath`) because the value names a file the
   * environment chose. */
  writtenTo?: string;
  /** #1360 — adversarial entries written from the `adversarial_loop` TOOL only:
   * the base SHA the review resolved, and the head SHA it reviewed. Stored so
   * an audit can see what range a row actually covers (the row's `patchId` is
   * the working-tree identity against the mainline merge-base, which a narrowed
   * `base` did not change). Absent on the /work driver's rows, which never ran
   * the range check. */
  reviewedBase?: string;
  /** #1360 — see `reviewedBase`: the reviewed head SHA (a resolved 40-char OID). */
  reviewedHead?: string;
  /** #1557 — TEST-FACING PROVENANCE, not a guard key: the id of the
   * `runAdversarialLoop` call whose exit caused this write (its
   * `orchestratorJobId`, threaded through `makeLedgerWrite` →
   * `writeAdversarialLedgerEntry`, which bounds it to a job-id shape).
   * The adversarial smoke arms select THEIR OWN row by this identity
   * instead of a `Date.now()` floor or a positional index — the
   * fire-and-forget writer stamps `at` at write-START, so a straggler can
   * stamp itself past any floor and be misread (the #1557 flake). Guard
   * readers must never consult it: `latestEntry` / `dedupeLatest` keep
   * selecting on (branch, kind, max `at`). That is a GATE, not a comment:
   * `test-adversarial-ledger-row-identity.ts` fails if any source outside
   * the writer-side allowlist mentions this field.
   *
   * Optional on purpose — hand-built rows and every pre-#1557 row carry
   * none and stay valid. */
  rowNonce?: string;
}

export interface LedgerFile {
  entries: LedgerEntry[];
}
