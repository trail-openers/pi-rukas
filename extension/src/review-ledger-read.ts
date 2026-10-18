/**
 * review-ledger-read — the READ side of the review ledger, split from
 * review-ledger.ts (AGENTS.md §12 file-size limit).
 *
 * The split seam is the dependency, not the topic: everything here parses rows
 * out of a path the CALLER already resolved, so this module needs no git, no
 * lock, and no `process.env`. That matters for #1449 specifically — the writer
 * and the #912 guard disagree about where a row is precisely because both
 * resolve the path through the override-honouring `ledgerPathFor`, and a reader
 * that took a path as an argument is the one place that comparison can be made
 * honestly. Keeping the parsing free of the resolver also keeps it testable
 * without a repository.
 *
 * The write side (`appendLedgerEntry`) and the path resolvers (`ledgerPathFor`,
 * `cloneLedgerPathFor`, `misdirectedLedgerWrite`) stay in review-ledger.ts /
 * review-ledger-path.ts: those are the parts that touch git and the env, and
 * the parts whose failures are traced rather than thrown.
 */

import { readFileSync } from "node:fs";
import { trace } from "./trace.ts";

import type { LedgerEntry, LedgerFile, ReviewKind } from "./review-ledger.ts";

/** Read the raw ledger (no git involved — the path is supplied). */
export function readLedgerFile(file: string): LedgerFile {
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as { entries?: unknown };
  if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
  return { entries: validEntries(parsed.entries) };
}

/**
 * #1449 — the ONLY permissive read of `readLedgerFile`, for a caller that has
 * already read the same file by another route and wants the raw rows back.
 *
 * `readLedgerFile` THROWS on an unreadable path (a missing file or an fs error)
 * and can throw on a malformed one (`JSON.parse` on a file written by hand, or
 * truncated mid-write). The one production caller that re-reads a path it had
 * already read — the #912 merge guard's misdirected-write diagnostic in
 * `merge-guard-provenance.ts` — must not let either reach the caller: the guard
 * is fail-CLOSED, and a provenance helper that throws out of the handler is a
 * fault inside the gate that decides whether a merge happens. A diagnostic is
 * allowed to be silent; it is never allowed to change the verdict.
 *
 * `readLedgerAt` is the same never-throw contract but discards the rows, so it
 * cannot answer "what did the file say". Every OTHER caller keeps the throwing
 * contract deliberately: `appendLedgerEntry` re-reads under the lock right
 * before its rename, and there a swallowed read error would drop a concurrent
 * writer's row — an empty ledger there is data loss, not a safe default.
 */
export function readLedgerFileSafe(file: string): LedgerFile {
  try {
    return readLedgerFile(file);
  } catch {
    return { entries: [] };
  }
}

/**
 * Validate an untrusted row before the ledger trusts it: `branch` must be
 * a non-empty string, `kind` one of the two review kinds, `patchId` a
 * string, `at` a finite number, `passed` a boolean. Anything else is
 * dropped (and traced) — a corrupt row must not satisfy or shadow a
 * genuine one.
 */
export function validEntries(entries: unknown[]): LedgerEntry[] {
  const ok: LedgerEntry[] = [];
  for (const e of entries) {
    if (
      e &&
      typeof e === "object" &&
      typeof (e as LedgerEntry).branch === "string" &&
      (e as LedgerEntry).branch.length > 0 &&
      ((e as LedgerEntry).kind === "adversarial" || (e as LedgerEntry).kind === "lens") &&
      typeof (e as LedgerEntry).patchId === "string" &&
      typeof (e as LedgerEntry).at === "number" &&
      Number.isFinite((e as LedgerEntry).at) &&
      typeof (e as LedgerEntry).passed === "boolean"
    ) {
      ok.push(e as LedgerEntry);
    } else {
      trace(`review-ledger: dropped invalid ledger entry: ${safeJson(e)}`);
    }
  }
  return ok;
}

/** One line, for the trace: a never-throwing JSON stringify. */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "undefined";
  } catch {
    return "<unserialisable>";
  }
}

/**
 * The LATEST entry per kind for a branch (max `at`), or undefined.
 *
 * Adversarial: the guard requires the latest to be `passed` AND its patchId
 * to equal the current one. Lens: the latest must be `passed` (any patchId
 * — a passing lens entry may predate a later commit; a later FAILING lens
 * run is what the latest-ness protects against).
 */
export function latestEntry(entries: LedgerEntry[], branch: string, kind: ReviewKind) {
  let best: LedgerEntry | undefined;
  for (const e of entries) {
    if (e.branch !== branch || e.kind !== kind) continue;
    if (!best || e.at >= best.at) best = e;
  }
  return best;
}

/** Read + validate the ledger from a resolved path; never throws. */
export function readLedgerAt(file: string): LedgerEntry[] {
  try {
    return readLedgerFile(file).entries;
  } catch {
    return [];
  }
}
