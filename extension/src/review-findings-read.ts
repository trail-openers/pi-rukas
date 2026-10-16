/**
 * review-findings-read — the findings file's READ path (#1125), split from
 * review-findings-store.ts (AGENTS.md §12 file-size gate). The store keeps every
 * write; this module reads, and reads differently on purpose.
 *
 * Two read policies, and the difference between them is the whole module:
 *
 *   - `readFindingsFile` (review-findings-file.ts) treats an unreadable file as
 *     "no memory". That is right for a prompt block: a lens prompt missing its
 *     prior-findings data costs nothing.
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
 * Nothing here writes to disk, and nothing here calls git: the ledger path comes
 * from the store's `locate`, which every round resolves before it reads (the
 * `ledgerOf` callback below), so a read performs no second lookup and invents no
 * second resolution rule.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type SetAsideNotice,
  type StoredFinding,
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

/**
 * Resolve the findings file's path from the ledger path the store resolved for
 * this clone. `ledgerOf` is the store's cache accessor, injected so this module
 * stays a leaf the store can own. When nothing has resolved a ledger path yet
 * there is nothing to read from, and the caller treats it as the store being
 * absent (which is the truth for a clone that never recorded a round).
 */
export function locateFindingsFile(
  cwd: string,
  ledgerOf: (cwd: string) => string | undefined,
): { ledger: string; file: string } | undefined {
  const ledger = ledgerOf(cwd);
  if (!ledger) return undefined;
  const dir = path.dirname(ledger);
  if (!existsSync(dir)) return undefined;
  return { ledger, file: path.join(dir, FINDINGS_FILE) };
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
 * The rows of one branch, read straight from the file in a single pass. Throws
 * when the file exists but cannot be read or parsed; `readFindingsFile`'s
 * fail-open is the wrong policy for a round's evidence.
 */
/**
 * The branch's rows with the file's fail-OPEN policy: an unreadable file reads
 * as no memory (traced). A prompt block uses this — a lens prompt missing its
 * prior-findings data costs nothing, and a prompt must never fail a review.
 */
export function readBranchRowsFailOpen(
  cwd: string,
  branch: string,
  ledgerOf: (cwd: string) => string | undefined,
): StoredFinding[] {
  const loc = locateFindingsFile(cwd, ledgerOf);
  if (!loc) return [];
  try {
    return readBranchRowsRaw(cwd, branch, ledgerOf)?.rows ?? [];
  } catch (err) {
    trace(
      `review-findings: ${loc.file} is unreadable (${(err as Error).message.slice(0, 120)}) — treated as no memory`,
    );
    return [];
  }
}

export function readBranchRowsRaw(
  cwd: string,
  branch: string,
  ledgerOf: (cwd: string) => string | undefined,
): BranchRows | undefined {
  const loc = locateFindingsFile(cwd, ledgerOf);
  if (!loc) return undefined;
  const raw = readRawRows(loc.file);
  if (!raw) return { rows: [], malformed: [] };
  const mine = raw.filter((r) => (r as { branch?: unknown })?.branch === branch);
  const split = splitRows(mine);
  return { rows: split.rows, malformed: split.malformed.map(describeSetAside) };
}
