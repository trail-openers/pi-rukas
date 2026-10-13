/**
 * lens-review-dedupe — the duplicate-collapse and ordering of lens findings,
 * split from lens-review-format.ts (AGENTS.md §12 file-size limit). The
 * re-export there keeps every importer unchanged.
 *
 * #1129 — a duplicate set keeps its HIGHEST-severity record (a triggered
 * MEDIUM must not lose to the LOW downgrade of the same finding); the lens
 * roster precedence only breaks a tie at equal severity.
 */

import type { Severity } from "./lens-review-format.ts";
import type { Finding, FindingSource } from "./lens-review-types.ts";
import { CLAIM_SCAN, CLAIM_SCAN_PRECEDENCE, type RosterEntry } from "./lens-roster.ts";

/**
 * Deduplicate findings by (normalised path, line, lowercased title). When
 * duplicates exist across lenses, keep the highest-severity record; at equal
 * severity keep the one from the highest-priority lens (roster precedence
 * ascending: the lowest declared value wins). `lens` takes the roster parsed
 * from the skills dir; lenses the roster does not know (e.g. stale findings
 * from an older pass) fall back to 99.
 */
export function dedupeFindings(input: Finding[], lens: RosterEntry[]): Finding[] {
  const precedenceOf = new Map<FindingSource, number>();
  for (const l of lens) {
    if (l.precedence !== undefined) precedenceOf.set(l.name, l.precedence);
  }
  // CLAIM_SCAN ranks above every lens at equal severity. Its findings are
  // lookups, not judgments — if a lens and the scan land on the same line at
  // the same severity, the one that can point at a grep result is the one
  // worth keeping. Severity is compared first (see the loop below), so a more
  // severe lens finding still wins. NEGATIVE_INFINITY so it outranks any
  // declared value, whatever the skill authors renumber to.
  precedenceOf.set(CLAIM_SCAN, CLAIM_SCAN_PRECEDENCE);
  const precedence = (f: Finding) => precedenceOf.get(f.lens) ?? 99;
  // `bestByKey` is bounded by the lens fan-in (≤6 children × finite findings
  // per pass) — at most a few hundred entries per invocation, and the whole
  // map goes out of scope when this function returns. No explicit cap needed.
  const bestByKey = new Map<string, Finding>();
  for (const f of input) {
    const key = `${f.path}::${f.line ?? 0}::${normaliseTitle(f.title)}`;
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, f);
      continue;
    }
    const severityGap = SEVERITY_ORDER[f.severity] - SEVERITY_ORDER[existing.severity];
    if (severityGap < 0 || (severityGap === 0 && precedence(f) < precedence(existing))) {
      bestByKey.set(key, f);
    }
  }
  return Array.from(bestByKey.values()).sort(sortFindings);
}

function normaliseTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[.!?;,]+$/, "")
    .trim();
}

const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function sortFindings(a: Finding, b: Finding): number {
  const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (s !== 0) return s;
  if (a.path !== b.path) return a.path.localeCompare(b.path);
  return (a.line ?? 0) - (b.line ?? 0);
}
