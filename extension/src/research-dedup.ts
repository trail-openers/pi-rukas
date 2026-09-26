/**
 * research-dedup — cross-angle claim deduplication for /research.
 *
 * The driver used to flatten every angle's claims with a bare
 * `angles.flatMap(a => a.claims)`; in the measured self-review run the
 * docs-depth angle reported the same four findings 3-4 times each, inflating
 * 75 claims to ~30 unique. Dedup runs AFTER extraction and BEFORE
 * verification (research-driver.ts), so a merged claim's verification
 * target (source) is the survivor's and url-liveness / code-grounding
 * checks never re-run per duplicate.
 *
 * Merge rule (same kind only — different kinds never merge):
 *  - the normalised texts are identical, OR
 *  - the normalised sources are identical AND Jaccard(text) ≥ 0.85.
 *
 * Normalisation (the Jaccard rule's stated tokenisation): lowercase → every
 * non-alphanumeric char → space → collapse whitespace → trim; tokens are
 * the space-split of that, empties dropped; Jaccard runs over the token
 * SETS (|A∩B| / |A∪B|).
 *
 * Survivor: the highest confidence (high > medium > low); on a tie, the
 * first encountered in angle order, then report order. The survivor's
 * text/source/sourceDate win wholesale; `angles` collects every
 * contributing angle (deduped, in first-appearance order). The existing
 * `angle` field (= the survivor's) stays for readers that do not know the
 * new field.
 */
import type { ResearchClaim } from "./research-types.ts";

/** The boundary of the near-duplicate rule (inclusive — 0.85 merges). */
export const DEDUP_JACCARD_THRESHOLD = 0.85;

/** Normalise a claim's text or source for comparison. */
export function normaliseClaimText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The token set of a string after normalisation (empties dropped). */
export function claimTokens(text: string): Set<string> {
  return new Set(
    normaliseClaimText(text)
      .split(" ")
      .filter((t) => t.length > 0),
  );
}

/** Jaccard similarity of two token SETS (identical-empty → 0, no tokens → 0). */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = claimTokens(a);
  const sb = claimTokens(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const uni = sa.size + sb.size - inter;
  return inter / uni;
}

const CONFIDENCE_RANK: Record<ResearchClaim["confidence"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** True when two SAME-kind claims should merge under the dedup rule. */
export function claimsShouldMerge(a: ResearchClaim, b: ResearchClaim): boolean {
  if (a.kind !== b.kind) return false;
  if (normaliseClaimText(a.text) === normaliseClaimText(b.text)) return true;
  if (a.source === "none" || b.source === "none") return false;
  return (
    normaliseClaimText(a.source) === normaliseClaimText(b.source) &&
    jaccardSimilarity(a.text, b.text) >= DEDUP_JACCARD_THRESHOLD
  );
}

/**
 * Merge duplicate claims in place of the flatMap. Order-preserving: the
 * survivor keeps the position of the first claim of its group; `angles` is
 * the deduped, first-appearance-ordered list of contributing angles.
 */
export function dedupResearchClaims(claims: readonly ResearchClaim[]): ResearchClaim[] {
  const out: ResearchClaim[] = [];
  for (const c of claims) {
    const i = out.findIndex((o) => claimsShouldMerge(o, c));
    if (i === -1) {
      out.push({ ...c, angles: [c.angle] });
      continue;
    }
    const cur = out[i];
    if (!cur) continue;
    const keep = CONFIDENCE_RANK[cur.confidence] <= CONFIDENCE_RANK[c.confidence] ? cur : c;
    const angles = [...new Set([...(cur.angles ?? [cur.angle]), ...(c.angles ?? [c.angle])])];
    out[i] = { ...keep, angles };
  }
  return out;
}
