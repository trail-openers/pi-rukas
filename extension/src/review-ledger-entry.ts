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

import type { ReviewSeverity } from "./review-threshold.ts";

/** The two review kinds the ledger tracks — and what a merge needs of each. */
export type ReviewKind = "adversarial" | "lens";

/** The per-severity shape of a lens row's blocking-finding counts — the ONE
 * spelling of it, so a writer and its reader cannot drift apart. */
export type LedgerBlockingCounts = Partial<Record<"CRITICAL" | "HIGH" | "MEDIUM", number>>;

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
  /** #1537 — lens entries only: how many BLOCKING findings the reviewed verdict
   * carried, per severity (`LOW` is never blocking, so it is not recorded).
   * The round-cap merge rule's second arm reads it: a row below the round cap
   * still merges when the counts show nothing at or above the blocking bar, so
   * no fix wave was owed. Written from `bySeverityCounts` on the BLOCKING half
   * of the round's findings — the same list `hasCritical` comes from. Absent on
   * every pre-#1537 row, where the rule falls back to `hasCritical` alone. */
  blockingCounts?: LedgerBlockingCounts;
  /** #1537 — the bar those counts were scored against: the RESOLVED review
   * threshold of the round that wrote the row, NOT a bar the merge guard
   * re-reads later. The bar is a property of the review, so the row records the
   * one it was decided with — a bar that moved between the review and the merge
   * must not silently re-score a row the lenses never scored that way. A row
   * with counts but no bar cannot be read at any bar and fails closed (see
   * `nothingBlocking` in merge-guard-round-cap.ts). */
  blockingBar?: ReviewSeverity;
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
  /** #1934 — the FINDINGS row an independent confirmation proves, and the JOIN
   * KEY that decides which row a confirmation retires. A ledger row written by
   * an adversarial round that confirms a fix carries the id of the findings row
   * it vouches for; `confirmedRowId` (review-confirmation.ts) is its ONLY
   * reader and accepts ONLY the store's own row-id shape — 8 lowercase hex, the
   * `ROW_ID` rule in review-findings-store.ts / `newRowId` in
   * review-findings-file.ts — so a row carrying anything else joins nothing.
   * Declared here rather than reached through a cast: the field decides which
   * row gets retired, and a join key the type does not name is a join key no
   * compiler can check. WRITTEN by the confirmation producer (the writer that
   * records an adversarial round alongside the findings row it reviewed), never
   * by `appendLedgerEntry`'s ordinary callers, and read by NO guard: the merge
   * guard selects on (branch, kind, max `at`), and a confirmation only ever
   * changes whether a findings row is `open` — never a verdict, never
   * `hasCritical`. Optional: every pre-#1934 row and every ordinary row carries
   * none and stays valid, and an absent field is the ordinary "no confirmation"
   * answer, which is the same answer as "there is none". */
  rowId?: string;
}

export interface LedgerFile {
  entries: LedgerEntry[];
}
