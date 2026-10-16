/**
 * review-findings-read — the findings file's READ path (#1125), split from
 * review-findings-store.ts (AGENTS.md §12 file-size gate). The store keeps every
 * write; this module reads, and reads differently on purpose.
 *
 * Two read policies, and the difference between them is the whole module:
 *
 *   - `parseFindingsFile` (review-findings-file.ts) is the writer's read: it
 *     reports an unreadable file as corrupt, and the store refuses to overwrite
 *     it and copies it aside.
 *   - `readBranchRowsRaw` here THROWS on a file that exists but cannot be read.
 *     A round that resolves, carries and suppresses rows is making decisions, and
 *     "no memory" and "memory unreadable" are different answers to the question
 *     "what does this branch already know?". A caller that cannot tell them apart
 *     reviews a branch as though nothing had ever been found on it, silently. The
 *     caller turns the throw into a `memoryNote` the operator sees.
 *
 * A malformed row is never returned as a row — a reader must not act on a row the
 * writer would set aside — but it IS returned as a notice, because a malformed
 * row that held an operator acceptance silently stops suppressing.
 *
 * A file that cannot be parsed is copied aside to `<file>.corrupt-<hash>` and
 * named in the throw, mirroring the writer's disclosure: the round refuses, and
 * the reason tells the operator where the bytes are and what to do.
 *
 * Nothing here writes to disk, and nothing here calls git or reads the
 * environment: the caller that resolved the ledger path (the store's `locate`)
 * passes it in. A read therefore performs no second lookup, invents no second
 * resolution rule, and cannot be served a stale path by a hidden cache.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type SetAsideNotice,
  type StoredFinding,
  describeSetAside,
  splitRows,
} from "./review-findings-file.ts";
import { hashText } from "./review-findings-match.ts";
import { trace } from "./trace.ts";

/** The findings file's name, beside `review-ledger.json` — re-exported by the store. */
export const FINDINGS_FILE = "review-findings.json";

/** What one branch's read produced: its valid rows, and its malformed rows. */
export interface BranchRows {
  rows: StoredFinding[];
  malformed: SetAsideNotice[];
}

/** The findings file that sits beside a ledger the caller has already resolved. */
export function findingsFileFor(ledger: string): string {
  return path.join(path.dirname(ledger), FINDINGS_FILE);
}

/**
 * Read the findings file's raw rows. Throwing IS the point — see the module
 * header. A missing file is the genuine empty store (undefined), not a failure.
 */
function readRawRows(file: string): unknown[] | undefined {
  if (!existsSync(file)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const rows = (parsed as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw new Error(`${FINDINGS_FILE} has no rows array`);
  return rows as unknown[];
}

/**
 * Copy an unreadable findings file aside and name the copy, so a fail-CLOSED
 * read discloses exactly like the store's fail-closed write: the operator sees
 * WHERE the bytes still are, and what to do about them. Same
 * `.corrupt-<hash>` scheme as the write path, so one repair recipe covers both.
 */
function copyAsideUnreadable(file: string, err: unknown): string {
  const junk = readFileSync(file, "utf8");
  const copy = `${file}.corrupt-${hashText(junk)}`;
  try {
    if (!existsSync(copy)) writeFileSync(copy, `${junk}\n`, "utf8");
    return copy;
  } catch (copyErr) {
    trace(
      `review-findings: could not copy ${file} aside: ${(copyErr as Error).message.slice(0, 120)}`,
    );
    return `(the copy could not be made: ${(copyErr as Error).message.slice(0, 80)})`;
  }
}

/**
 * The rows of one branch, read straight from the file in a single pass.
 *
 * Throws when the file exists but cannot be read or parsed: a round must not
 * record on "no memory" when the memory is merely unreadable. `file` is the
 * resolved path the caller obtained from its own `locate` — this module never
 * resolves it, so a read cannot be served a path a cache kept from an earlier
 * value of `PI_ENSEMBLE_REVIEW_LEDGER_FILE`.
 */
export function readBranchRowsRaw(file: string, branch: string): BranchRows | undefined {
  let raw: unknown[] | undefined;
  try {
    raw = readRawRows(file);
  } catch (err) {
    // Fail closed, and disclose: the operator action leads and the copy closes,
    // because the reason is clipped downstream and a truncated message must keep
    // both halves it can still act on.
    const copy = copyAsideUnreadable(file, err);
    const cause = (err as Error).message.replace(/\s+/g, " ").slice(0, 100);
    throw new Error(
      `repair or remove ${file}, or set PI_ENSEMBLE_REVIEW_LEDGER_FILE to a healthy ledger. ` +
        `Unreadable (${cause}); the bytes are copied to ${copy}`,
    );
  }
  if (!raw) return { rows: [], malformed: [] };
  const mine = raw.filter((r) => (r as { branch?: unknown })?.branch === branch);
  const split = splitRows(mine);
  return { rows: split.rows, malformed: split.malformed.map(describeSetAside) };
}

/**
 * The branch's rows with the file's fail-OPEN policy: an unreadable file reads
 * as no memory (traced once, with the reason). A prompt block uses this — a lens
 * prompt missing its prior-findings data costs nothing, and a prompt must never
 * fail a review. `undefined` means there is no ledger path to read from at all,
 * which the caller treats as the store being absent.
 */
export function readBranchRowsFailOpen(
  file: string | undefined,
  branch: string,
): StoredFinding[] | undefined {
  if (!file) {
    trace(`review-findings: no ledger path resolved for ${branch} — no findings to read`);
    return undefined;
  }
  if (!existsSync(path.dirname(file))) {
    trace(`review-findings: the ledger dir ${path.dirname(file)} is missing — no findings to read`);
    return [];
  }
  try {
    return readBranchRowsRaw(file, branch)?.rows ?? [];
  } catch (err) {
    trace(
      `review-findings: ${file} is unreadable (${(err as Error).message.slice(0, 120)}) — treated as no memory`,
    );
    return [];
  }
}
