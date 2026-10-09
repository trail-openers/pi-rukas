/**
 * review-ledger-read — the read-side helpers for the review ledger.
 *
 * #955 file-size split: these functions were extracted from review-ledger.ts
 * so that file stays under the 500-line limit after #1071 added the lock
 * wrapping. The re-exports in review-ledger.ts keep existing importers
 * unchanged.
 */

import { readFileSync } from "node:fs";
import type { LedgerEntry, ReviewKind } from "./review-ledger.ts";
import { trace } from "./trace.ts";

interface LedgerFile {
  entries: LedgerEntry[];
}

/** One line, for the trace: a never-throwing JSON stringify. */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "undefined";
  } catch {
    return "<unserialisable>";
  }
}

/** Read the raw ledger (no git involved — the path is supplied). */
export function readLedgerFile(file: string): LedgerFile {
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as { entries?: unknown };
  if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
  return { entries: validEntries(parsed.entries) };
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
