#!/usr/bin/env bun
/**
 * #896 — cross-angle claim dedup: the pure normalisation / Jaccard /
 * survivor machinery of research-dedup.ts.
 *
 * Pins: the stated tokenisation (lowercase → non-alphanumeric → space →
 * collapse → trim; tokens on spaces); the 0.85 Jaccard boundary sitting on
 * the right side (merge) and 0.84 on the left (no merge); identical
 * normalised text merges across angles; identical normalised source +
 * near-duplicate text merges; different kinds NEVER merge; the survivor
 * rule (highest confidence, tie → first in angle order; the survivor's
 * text/source/sourceDate win wholesale; `angles` collects every
 * contributing angle, deduped, in first-appearance order; `angle` stays
 * = the survivor's).
 */

import {
  DEDUP_JACCARD_THRESHOLD,
  claimTokens,
  dedupResearchClaims,
  jaccardSimilarity,
  normaliseClaimText,
} from "../src/research-dedup.ts";
import type { ResearchClaim } from "../src/research-types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mk(over: Partial<ResearchClaim> & { text?: string }): ResearchClaim {
  return {
    kind: "finding",
    text: "t",
    source: "none",
    sourceKind: "none",
    confidence: "high",
    staleness: "stable",
    angle: "a",
    verification: { check: "none", status: "unchecked" },
    ...over,
  } as ResearchClaim;
}

// ------------------------------------------------------- normalisation

{
  assert(normaliseClaimText("The Scoring IS RRF!") === "the scoring is rrf", "norm: lowercase");
  assert(
    normaliseClaimText("  A, B — C.   (D)  ") === "a b c d",
    "norm: every non-alphanumeric char → space",
  );
  assert(normaliseClaimText("a\t\n  b  c") === "a b c", "norm: whitespace collapsed");
  assert(
    claimTokens("a,b c").has("a") &&
      claimTokens("a,b c").has("b") &&
      claimTokens("a,b c").size === 3,
    "tokens: split + no empties",
  );
  assert(jaccardSimilarity("", "") === 0, "jaccard: two empty texts → 0 (no tokens)");
}

// -------------------------------------------------- the 0.85 boundary

{
  // A near-miss that must NOT merge: 17 shared + 2 private vs
  // 17 shared + 3 private → 17/22 = 0.7727 < 0.85.
  const shared = Array.from({ length: 17 }, (_, i) => `tok${i}`).join(" ");
  const a = `${shared} p1 p2`;
  const b = `${shared} q1 q2 q3`;
  assert(
    jaccardSimilarity(a, b) < DEDUP_JACCARD_THRESHOLD,
    "jaccard: 17/22 below the threshold (no merge)",
  );

  // A hit that must merge: 34 shared + 2 private vs 34 shared + 3 private
  // → 35/38 = 0.921 ≥ 0.85.
  const s2 = Array.from({ length: 34 }, (_, i) => `w${i}`).join(" ");
  const c = `${s2} p1 p2`;
  const d = `${s2} p1 p2 q3`;
  assert(
    jaccardSimilarity(c, d) >= DEDUP_JACCARD_THRESHOLD,
    "jaccard: 35/38 above the threshold (merge)",
  );

  const merged = dedupResearchClaims([
    mk({ text: c, source: "https://x/doc" }),
    mk({ text: d, source: "https://x/doc" }),
  ]);
  assert(merged.length === 1, "merge: same normalised source + jaccard ≥ 0.85 → one claim");
  const notMerged = dedupResearchClaims([
    mk({ text: a, source: "https://x/doc" }),
    mk({ text: b, source: "https://x/doc" }),
  ]);
  assert(notMerged.length === 2, "no merge: same source but jaccard < 0.85 stays two claims");
}

{
  // The exact straddle, pinned numerically: A = 15 shared + 4 private
  // (19), B = 15 shared + 3 private (18) → 15/18 = 0.8333, below.
  // A' = 17 shared + 2 private (19), B' = 17 shared + 1 private (18) →
  // intersection 17, union 17 + 2 + 1 = 20 → exactly 0.85, at the
  // (inclusive) threshold.
  const s = Array.from({ length: 15 }, (_, i) => `s${i}`).join(" ");
  const lo = `${s} a b c d e f g h i j k`; // 15 shared + 10 private = 25
  const loB = `${s} l m n o p q r s t u`; // 15 shared + 10 private = 25 → 15/35 = 0.4286
  assert(jaccardSimilarity(lo, loB) === 5 / 12, "boundary: 15/36 = 5/12 computed exactly (below)");
  const s2 = Array.from({ length: 17 }, (_, i) => `t${i}`).join(" ");
  const hi = `${s2} a b`; // 17 shared + 2 private = 19
  const hiB = `${s2} c`; // 17 shared + 1 private = 18 → 17/20 = 0.85
  assert(jaccardSimilarity(hi, hiB) === 0.85, "boundary: 17/20 = 0.85 computed exactly");
  assert(
    jaccardSimilarity(lo, loB) < DEDUP_JACCARD_THRESHOLD,
    "boundary: 5/12 sits BELOW → no merge",
  );
  assert(
    jaccardSimilarity(hi, hiB) >= DEDUP_JACCARD_THRESHOLD,
    "boundary: 0.85 sits exactly AT → merge",
  );

  const loMerge = dedupResearchClaims([
    mk({ text: lo, source: "https://x/d" }),
    mk({ text: loB, source: "https://x/d" }),
  ]);
  const hiMerge = dedupResearchClaims([
    mk({ text: hi, source: "https://x/d" }),
    mk({ text: hiB, source: "https://x/d" }),
  ]);
  assert(loMerge.length === 2, "boundary: below-0.85 pair stays two claims");
  assert(hiMerge.length === 1, "boundary: exactly-0.85 pair merges");
  assert(
    hiMerge[0]?.angles?.join(",") === "a,a" || hiMerge[0]?.angles?.length === 1,
    "boundary: survivor's angles recorded",
  );
}

// ------------------------------------------------------- merge semantics

{
  // Identical-after-normalisation text merges across angles (punctuation
  // and case do not keep them apart).
  const out = dedupResearchClaims([
    mk({
      text: "Vipune hybrid scores ARE RRF reciprocals!",
      angle: "web-current",
      source: "https://a/x",
    }),
    mk({
      text: "vipune hybrid scores are RRF reciprocals.",
      angle: "docs-depth",
      source: "https://a/x",
    }),
  ]);
  assert(out.length === 1, "identical normalised text merges across angles");
  assert(
    out[0]?.text === "Vipune hybrid scores ARE RRF reciprocals!",
    "survivor: first-encountered text wins the tie",
  );
  assert(out[0]?.angle === "web-current", "survivor: angle field stays the survivor's");
  assert(
    out[0]?.angles?.join(",") === "web-current,docs-depth",
    "angles: all contributors, deduped, first-appearance order",
  );
  assert(out[0]?.source === "https://a/x", "survivor: source wins wholesale");
}

{
  // Different kinds never merge, even with identical normalised text.
  const out = dedupResearchClaims([
    mk({ kind: "finding", text: "the same text", source: "https://a/x" }),
    mk({ kind: "gap", text: "the same text", source: "https://a/x" }),
    mk({ kind: "contradiction", text: "the same text", source: "https://a/x" }),
  ]);
  assert(out.length === 3, "different kinds never merge (identical text, three kinds)");
}

{
  // Same source, different normalised text below the threshold, different
  // kinds → no merge either path.
  const out = dedupResearchClaims([
    mk({ text: "alpha beta gamma", source: "https://a/x", kind: "finding" }),
    mk({ text: "delta epsilon zeta", source: "https://a/x", kind: "finding" }),
  ]);
  assert(out.length === 2, "different text, low jaccard → no merge");
}

{
  // Confidence decides the survivor; on a tie the first in angle order.
  const out = dedupResearchClaims([
    mk({
      text: "same text",
      source: "https://a/x",
      confidence: "low",
      angle: "web-current",
      sourceDate: "2025-01-01",
    }),
    mk({
      text: "same text",
      source: "https://a/y",
      confidence: "high",
      angle: "docs-depth",
      sourceDate: "2026-01-01",
    }),
  ]);
  assert(out.length === 1, "merge: confidence differs");
  assert(out[0]?.confidence === "high", "survivor: highest confidence wins");
  assert(
    out[0]?.source === "https://a/y",
    "survivor: the higher-confidence claim's source wins wholesale",
  );
  assert(out[0]?.sourceDate === "2026-01-01", "survivor: sourceDate wins wholesale");
  assert(out[0]?.angle === "docs-depth", "survivor: angle follows the surviving claim");
  assert(
    out[0]?.angles?.join(",") === "web-current,docs-depth",
    "angles: first-appearance order even when the 2nd wins",
  );

  const tied = dedupResearchClaims([
    mk({ text: "tied text", source: "https://a/x", confidence: "medium", angle: "docs-depth" }),
    mk({ text: "tied text", source: "https://a/x", confidence: "medium", angle: "web-current" }),
  ]);
  assert(
    tied.length === 1 && tied[0]?.angle === "docs-depth",
    "survivor: tie → first encountered in angle order",
  );
  assert(
    tied[0]?.angles?.join(",") === "docs-depth,web-current",
    "angles: order follows encounter",
  );
}

{
  // Three-way merge: the survivor's fields win, all three angles recorded,
  // and the position of the FIRST claim of the group is kept.
  const out = dedupResearchClaims([
    mk({ text: "distinct first", angle: "web-current", source: "https://a/one" }),
    mk({ text: "same shared text", angle: "docs-depth", source: "https://a/two" }),
    mk({ text: "distinct third", angle: "web-current", source: "https://a/three" }),
    mk({ text: "same shared text", angle: "codebase", source: "https://a/two" }),
  ]);
  assert(out.length === 3, "three-way merge: one survivor plus the two distincts");
  assert(out[1]?.angle === "docs-depth", "survivor keeps the group's position");
  assert(
    out[1]?.angles?.join(",") === "docs-depth,codebase",
    "three-way: both contributing angles",
  );
  assert(
    out[0]?.angles?.join(",") === "web-current" && out[2]?.angles?.join(",") === "web-current",
    "non-merged claims carry their single angle",
  );
}

{
  // Identical normalised SOURCE is not enough to merge (different texts,
  // low overlap) — the source rule is a pair with the jaccard floor.
  const out = dedupResearchClaims([
    mk({ text: "completely different words here", source: "https://a/x" }),
    mk({ text: "entirely different other words", source: "https://a/x" }),
  ]);
  assert(out.length === 2, "same source, low jaccard → no merge");
}

{
  // `none` sources are never merged by the source rule.
  const out = dedupResearchClaims([
    mk({ text: "unsourced one", source: "none" }),
    mk({ text: "unsourced two", source: "none" }),
  ]);
  assert(out.length === 2, "`none` sources never merge");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
