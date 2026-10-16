/**
 * review-findings-read — the findings file's READ path (#1125), split from
 * review-findings-store.ts (AGENTS.md §12 file-size gate). The store keeps every
 * write; this module reads, and reads differently on purpose.
 *
 * Three read policies, and the difference between them is the whole module:
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
 *   - `readBranchRowsFailOpen` below reads the same file with the OPPOSITE
 *     policy: unreadable means no memory, traced. Only a caller that cannot fail
 *     anything (a prompt block) uses it.
 *
 * A malformed row is never returned as a row — a reader must not act on a row the
 * writer would set aside — but it IS returned as a notice, because a malformed
 * row that held an operator acceptance silently stops suppressing.
 *
 * What this module writes: the `.corrupt-<hash>` copy a fail-closed read makes of
 * an unreadable file, and nothing else. It is a disclosure copy, not a store
 * write: the file itself is left exactly as it was, and the copy goes through the
 * store's own `copyBytesAside` so one naming scheme covers every copy-aside site.
 * The copy is named in the throw, mirroring the writer's disclosure: the round
 * refuses, and the reason tells the operator where the bytes are and what to do.
 *
 * Nothing here calls git or reads the environment: the caller that resolved the
 * ledger path (the store's `locate`) passes it in. A read therefore performs no
 * second lookup, invents no second resolution rule, and cannot be served a stale
 * path by a hidden cache.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type SetAsideNotice,
  type StoredFinding,
  copyBytesAside,
  corruptDisclosure,
  describeSetAside,
  splitRows,
} from "./review-findings-file.ts";
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
 *
 * The bytes are RETURNED with the rows even when parsing fails: a caller that
 * has to disclose a bad file must disclose the bytes it actually read, because a
 * second read is a second chance to fail and a file replaced between the two
 * would be copied aside under a hash of content nobody read.
 */
function readRawRows(file: string): { rows: unknown[] | undefined; bytes?: string } {
  if (!existsSync(file)) return { rows: undefined };
  const bytes = readFileSync(file, "utf8");
  // The parse is INSIDE its own try: unparseable bytes ARE the bytes the
  // disclosure copies, so the throw carries them rather than losing them. A
  // failure of the READ itself (EISDIR, EACCES) propagates with no bytes, and
  // the caller says so rather than copying an empty file nobody read.
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (err) {
    throw Object.assign(new Error((err as Error).message), { findingsBytes: bytes } as {
      findingsBytes: string;
    });
  }
  const rows = (parsed as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) {
    throw Object.assign(new Error(`${FINDINGS_FILE} has no rows array`), {
      findingsBytes: bytes,
    } as { findingsBytes: string });
  }
  return { rows: rows as unknown[], bytes };
}

/** The bytes an unreadable-file throw carried, or undefined when the read itself failed. */
function carriedBytes(err: unknown): string | undefined {
  const b = (err as { findingsBytes?: unknown })?.findingsBytes;
  return typeof b === "string" ? b : undefined;
}

/**
 * The rows of one branch, read straight from the file in a single pass.
 *
 * Throws when the file exists but cannot be read or parsed: a round must not
 * record on "no memory" when the memory is merely unreadable. `file` is the
 * resolved path the caller obtained from its own `locate` — this module never
 * resolves it, so a read cannot be served a path a cache kept from an earlier
 * value of `PI_ENSEMBLE_REVIEW_LEDGER_FILE`.
 *
 * The bytes are captured in the SAME try as the failure — `readFileSync` on a
 * directory (EISDIR), a file with no read permission (EACCES) and a file that
 * does not parse all fail here with the bytes it did get, if any — and the
 * disclosure names the cause. A present-but-unreadable file therefore produces
 * the same fail-closed "repair or remove …" message as an unparseable one,
 * rather than a bare OS error the operator cannot act on.
 */
export function readBranchRowsRaw(file: string, branch: string): BranchRows | undefined {
  let raw: unknown[] | undefined;
  try {
    raw = readRawRows(file).rows;
  } catch (err) {
    const cause = (err as Error).message.replace(/\s+/g, " ").slice(0, 100);
    // A failure BEFORE any bytes were read (EISDIR, EACCES) has no bytes to
    // disclose, so no copy is made: writing an empty file would put a
    // `.corrupt-<hash of nothing>` next to the real one, and a later stage that
    // copies the actual bytes would leave two copies with two hashes, one of
    // them a lie. The disclosure says so instead.
    const bytes = carriedBytes(err);
    const copy =
      bytes === undefined
        ? ({ copied: false, reason: "nothing could be read from the file" } as const)
        : copyBytesAside(file, bytes, "the unreadable findings file");
    throw new Error(
      `${corruptDisclosure(file, copy)}. Unreadable (${cause}) — the round recorded nothing`,
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
