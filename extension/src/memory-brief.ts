/**
 * memory-brief — what the developer is told about prior work on these files.
 *
 * ## The selection rule, and why it is not the one that shipped
 *
 * A 940-observation sweep against the live store settled three things that the
 * seam's own defaults get wrong for this leg.
 *
 * **1. The hybrid score is an exact boolean, and its threshold was set too high.**
 * When BM25 matches nothing, RRF returns the semantic list unchanged and its
 * scores are exactly `1/(25+r)`. Measured: a query for `sandbox-fs-guard.ts`
 * (which nothing mentions) returns `0.038462, 0.037037, 0.035714, 0.034483,
 * 0.033333` — precisely `1/26 … 1/30`. So `1/26 = 0.038462` is the ceiling for
 * a row BM25 never saw, and any score above it proves both retrievers found the
 * row. Across 940 observations the interval `(0.038462, 0.047883)` was
 * **empty**, so the separation is real rather than a tuning artefact.
 *
 * `HYBRID_AGREEMENT = 0.075` is a stricter bit — *rank 1 in both* — and it is
 * kept here deliberately. Precision matters more than recall for a memory
 * injected into a developer's prompt: an agent adopts a retrieved claim at
 * first exposure and recovers poorly from a wrong one. Measured unfiltered,
 * basename queries: 0.075 gives 9 rows, 9 true, **precision 1.00**; relaxing to
 * 0.04 gives 48 rows, 41 true, precision 0.85. The looser bar is available and
 * measured; it is not the default.
 *
 * **2. `--memory-type guard` was the actual bug.** Filtered, a query for
 * `permission-guard.ts` scores 0.0385 — the dead ladder — and the guard is
 * missed. **Unfiltered the same query scores 0.076923** and it is found. The
 * filter also caps the reachable universe at 5 rows of 111 (guards are 4.5% of
 * this corpus; 81 rows are `fact`), and measured *worse* on both axes. Reads
 * here are unfiltered. That is not a loosening of safety: the ladder still
 * guarantees silence when the token is absent, filter or no filter.
 *
 * **3. The semantic floor inside the conjunction costs recall for nothing.**
 * Re-adding `SIM_FLOOR` to the agreement leg drops files-hit from 22/24 to 8/24
 * while removing zero false positives. The agreement bit is doing all the work.
 *
 * ## Why one query per basename
 *
 * Concatenating file names destroys the signal: measured, a three-basename
 * query scored the correct guard 0.6301 — below any usable floor — while the
 * same guard scored 0.6513 for its own basename alone. Each file gets its own
 * query, and a stem fallback (`permission-guard` when `permission-guard.ts`
 * finds nothing) recovers rows written before the extension was conventional.
 */

import path from "node:path";
import {
  HYBRID_AGREEMENT,
  type MemoryHit,
  type VipuneOpts,
  isIdentifierShaped,
  preferNewest,
  renderBrief,
  vipuneSearch,
} from "./vipune.ts";

/** Hits carried into a prompt. Bounded by cost: the corpus median is 742 chars. */
export const MAX_BRIEF_HITS = 5;

/** Files queried per step, so a wide workstream cannot fan out unbounded. */
export const MAX_QUERY_FILES = 6;

export interface BriefResult {
  /** Markdown for the prompt, or "" when nothing survived selection. */
  text: string;
  queries: string[];
  hits: MemoryHit[];
  emptyBrief: boolean;
}

/**
 * Queries for a set of changed files: each basename, then its stem as a
 * fallback. Deduplicated, order preserved, bounded.
 */
export function memoryQueriesFor(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths.slice(0, MAX_QUERY_FILES)) {
    const base = path.basename(p.trim());
    if (!base) continue;
    for (const q of [base, base.replace(/\.[^.]+$/, "")]) {
      if (q.length < 3 || seen.has(q)) continue;
      seen.add(q);
      out.push(q);
    }
  }
  return out;
}

/**
 * Retrieve, select and render the brief for a set of changed files.
 *
 * Never throws and never blocks a cycle: every failure mode — vipune missing,
 * slow, erroring — degrades to an empty brief. The code work is already done by
 * the time this runs; a memory problem must not cost it.
 */
export async function buildMemoryBrief(
  paths: readonly string[],
  opts: VipuneOpts,
): Promise<BriefResult> {
  const queries = memoryQueriesFor(paths);
  const collected = new Map<string, MemoryHit>();
  const used: string[] = [];

  for (const q of queries) {
    // The agreement bit is only meaningful for an identifier-shaped query;
    // BM25 fires on stopwords and sub-tokens otherwise, and the bit false-fires.
    if (!isIdentifierShaped(q)) continue;
    used.push(q);
    let r: Awaited<ReturnType<typeof vipuneSearch>>;
    try {
      r = await vipuneSearch(q, { ...opts, hybrid: true, includeCandidates: true });
    } catch {
      continue;
    }
    if (r.kind !== "hits") continue;
    for (const h of r.hits) {
      // Unfiltered by type, and selected on the agreement bit alone — see the
      // module header for why the floor is not applied here.
      if (h.similarity >= HYBRID_AGREEMENT && !collected.has(h.id)) collected.set(h.id, h);
    }
    if (collected.size >= MAX_BRIEF_HITS) break;
  }

  const hits = preferNewest([...collected.values()], "fact").slice(0, MAX_BRIEF_HITS);
  return {
    text: hits.length > 0 ? renderBrief(hits, "Prior memory about these files") : "",
    queries: used,
    hits,
    emptyBrief: hits.length === 0,
  };
}
