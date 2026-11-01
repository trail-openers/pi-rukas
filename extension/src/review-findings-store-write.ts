/**
 * review-findings-store-write — the write half of the findings store: the atomic
 * write, the read-modify-write under the ledger lock, and the record/accept
 * outcome shapes both entry points return (#1105, #1125; split out of
 * review-findings-store.ts for the AGENTS.md §12 size gate, which the #1934
 * confirmation fields pushed past 500 lines).
 *
 * Nothing here decides a row's fate and nothing here resolves a path: the store
 * owns the location (resolved ONCE per call and threaded in) and the round owns
 * the rules. This module is the mechanics of applying them to disk, which is why
 * `loc` and `writeFn` are the caller's — a second resolution between the read and
 * the write is exactly the split #1125 removed.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Finding } from "./lens-review-types.ts";
import type { ReviewKind } from "./review-findings-fate.ts";
import {
  type CorruptCopy,
  type Decision,
  type ResolvedNotice,
  type SetAsideNotice,
  type StoredFinding,
  capPerBranch,
  copyBytesAside,
  corruptDisclosure,
  parseFindingsFile,
} from "./review-findings-file.ts";
import type { ConfirmationLapse } from "./review-findings-store-types.ts";
import { acquireLedgerLock } from "./review-ledger-lock.ts";
import type { FindingsLocation } from "./review-state-path.ts";
import { trace } from "./trace.ts";

export interface FindingRun {
  cwd: string;
  branch: string;
  /** The full commit the round reviewed; identities are read from it. */
  headSha: string;
  /** Deduplicated findings, in the order the decisions must align with. */
  findings: Finding[];
  /** How this round reviewed the branch, computed once by the caller (lens-review.ts). */
  review: ReviewKind;
  /** The delta diff (`git diff since..head`); required when `review` is `delta`.
   * The changed line ranges are DERIVED from it here (`changedLineRanges`) and
   * never supplied by the caller: a diff is the round's evidence, and ranges
   * quoted separately could disagree with the diff they came from (#1125
   * decision 5). */
  deltaDiff?: string;
  /** When to stamp the rows (defaults to `Date.now()`). */
  now?: number;
  /**
   * The write to perform, supplied per call (tests inject a failing one). A
   * module-global fault seam is not a thing: this is the only seam.
   */
  writeFn?: WriteRows;
  /**
   * #1934 — the patch id this round is reviewing, which an independent
   * confirmation must equal for it to count. Supplied by the caller that
   * already computed it for its own ledger write (`lens-ledger.ts`), so a round
   * never pays for a second `git diff | git patch-id --stable`; when absent the
   * store computes it itself for a `confirmFixes` round. No value at all (no
   * clone, a failed identity read) means NO confirmation is consulted — the
   * round retires nothing it would not have retired before #1934.
   */
  patchId?: string;
  /**
   * #1934 — ask this round to retire a row whose cited line has NOT changed on
   * the strength of an INDEPENDENT confirmation recorded against this exact
   * commit (review-confirmation.ts). Opt-IN, and opt-in per CALL: a caller that
   * does not set it consults no ledger and gains no retirement, so the pre-#1934
   * behaviour is the default rather than a mode something could forget to
   * disable. The ledger path is resolved the same override-honouring way the
   * store's own location is, so an isolated round reads the ledger it was
   * isolated with.
   */
  confirmFixes?: boolean;
}

/** The result of recording one round: the decisions, or why nothing was recorded. */
export type RecordOutcome =
  | {
      ok: true;
      decisions: Decision[];
      carried: Finding[];
      resolved: ResolvedNotice[];
      /**
       * #1125 — memory the round set aside and disclosed: a malformed row the
       * store refuses to act on, and an operator acceptance whose cited code
       * changed so its suppression lapsed. A non-empty list means the round's
       * suppression did NOT apply to these rows; the caller renders them, and a
       * row the operator accepted by name must never vanish from that list.
       */
      setAside?: SetAsideNotice[];
      /**
       * #1934 AC4 — rows whose independent confirmation LAPSED this round: a row
       * a previous round retired on a confirmation, which this round found no
       * longer binds to the commit under review. The row stays `open` and its
       * cited code is unchanged — what changed is the evidence — so the caller
       * renders this and the row carries a `confirmationLapsed` notice on disk, so
       * a later reader can see it was once retired and is not now. A row nobody
       * ever confirmed is never listed.
       */
      lapsed?: ConfirmationLapse[];
    }
  | { ok: false; reason: string; setAside?: SetAsideNotice[] };

/** The result of an acceptance: the accepted row, or why nothing was accepted. */
export type AcceptOutcome = { ok: true; row: StoredFinding } | { ok: false; reason: string };

// #1934 AC4 — the lapsed-confirmation notice is DECLARED in the leaf
// (review-findings-store-types.ts) and re-exported here: the round produces it
// and this store returns it, so a copy in either one made them import each
// other (the same reason `Decision` lives in review-findings-file.ts).
export type { ConfirmationLapse } from "./review-findings-store-types.ts";

/** The write seam the caller may supply (tests inject a failing one).
 * A module-global fault seam is not a thing: this is the only seam. */
export type WriteRows = (file: string, rows: StoredFinding[]) => void;

/** The real write: serialize, cap per branch, tmp file, atomic rename. */
export function defaultWriteRows(file: string, rows: StoredFinding[]): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify({ rows: capPerBranch(rows) }, null, 2), "utf8");
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

type MutateOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; setAside?: SetAsideNotice[] };

/** Copy one malformed row aside, named by its content, so a repeat never duplicates it. */
function setAside(file: string, row: unknown): void {
  const text = JSON.stringify(row, null, 2);
  const copy = copyBytesAside(file, text, "a malformed findings row");
  trace(
    copy.copied
      ? `review-findings: a malformed row was set aside in ${copy.path}`
      : `review-findings: a malformed row was set aside but the copy failed (${copy.reason})`,
  );
}

/**
 * Read-modify-write the findings file under the ledger lock. `fn` gets the
 * stored rows and returns the rows to keep plus a value. Private: the only
 * callers are `acceptFinding` and `recordFindingRunOutcome` in this module.
 * Never throws.
 *
 * `loc` is the pair the CALLER resolved, threaded in so the read it acted on and
 * the write this performs cannot name two different files — a second `locate`
 * here would re-read the environment between the two, and a round whose read
 * came from one ledger and whose write landed in another is exactly the shape
 * #1125 spent a round removing elsewhere. `writeFn` is likewise the caller's,
 * per call, defaulting to the real atomic write.
 */
export async function mutateFindings<T>(
  loc: FindingsLocation,
  fn: (rows: StoredFinding[]) => { rows: StoredFinding[]; result: T },
  /** Memory the caller had already read and set aside BEFORE this write: on a
   * failed write the round never reaches its summary, so these notices would be
   * lost with it (#1125). Attaching them to the `{ok:false}` outcome keeps the
   * disclosure alive exactly as far as the successful one's does. */
  preLockSetAside?: SetAsideNotice[],
  writeFn: WriteRows = defaultWriteRows,
): Promise<MutateOutcome<T>> {
  let release: (() => void) | undefined;
  try {
    release = await acquireLedgerLock(loc.ledger);
    const parsed = parseFindingsFile(loc.file);
    if (!parsed.ok) {
      // The bytes are re-read here rather than reused from the caller's read:
      // this is the read UNDER THE LOCK, and the copy must be of what the writer
      // was about to overwrite. A copy that cannot be made still refuses, and
      // says the copy failed rather than pretending the bytes are safe.
      const copy: CorruptCopy = copyBytesAside(
        loc.file,
        readFileSync(loc.file, "utf8"),
        "the corrupt findings file",
      );
      trace(`review-findings: ${loc.file} is corrupt (${parsed.reason})`);
      return {
        ok: false,
        reason: `the findings file is corrupt (${parsed.reason}); it was not overwritten — ${corruptDisclosure(loc.file, copy)}`,
        ...(preLockSetAside && preLockSetAside.length > 0 ? { setAside: preLockSetAside } : {}),
      };
    }
    for (const bad of parsed.malformed) setAside(loc.file, bad);
    const { rows, result } = fn(parsed.rows);
    writeFn(loc.file, rows);
    return { ok: true, value: result };
  } catch (err) {
    // The disclosure outlives the write: a failed write means the round records
    // nothing and never reaches its summary, so the memory the round had already
    // set aside would otherwise vanish along with the refusal (#1125).
    return {
      ok: false,
      reason: `write failed: ${(err as Error).message.slice(0, 160)}`,
      ...(preLockSetAside && preLockSetAside.length > 0 ? { setAside: preLockSetAside } : {}),
    };
  } finally {
    try {
      release?.();
    } catch (err) {
      trace(`review-findings: lock release failed: ${(err as Error).message}`);
    }
  }
}
