/**
 * plan-never-claim — the deterministic NEVER CLAIM post-filter (#677).
 *
 * Split from plan-investigate.ts along the 500-line seam (AGENTS.md §12); the
 * barrier that runs it stays in plan-investigate.ts and this module owns the
 * rule, its disclosure wording, and the display clip both share.
 *
 * DROPS any structured item whose normalised text contains a forbidden phrase as
 * an EXACT normalised substring (trim + collapse internal whitespace + lowercase
 * — the same normalisation as sub-issue reconciliation). Verbatim-only by design:
 * loose matching was measured to false-positive on the epic's own true invariants
 * and correctly-negated restatements, so it is out of scope.
 *
 * Dropped items are NEVER silent — the returned disclosure names every matched
 * phrase BY ITS POSITION in the operator's block ("phrase 2"), each dropped
 * item's kind, and the per-angle drop counts, and the driver threads it into the
 * drafted body and the result details. The findings array is REPLACED, not
 * mutated: the caller's original array is untouched, and the disclosure is the
 * ONLY place the dropped items are accounted for — a filter that quietly shrank
 * `toolUses` without a disclosure line would be the exact anti-pattern #677
 * exists to prevent.
 *
 * The disclosure is PHRASE-FREE by construction (#2233): it quotes neither the
 * phrase nor the dropped item's text. The driver appends this disclosure to the
 * drafted body BEFORE the forbidden-phrase scan, so anything it quoted came back
 * as a `draft-invalid` halt naming the very thing the operator ruled out — the
 * filter could never keep text out of a filed spec by dropping an item, and the
 * halt detail echoed the phrase into the operator transcript as well. Positional
 * naming keeps the drop auditable (the operator counts lines in their own block)
 * without reproducing a character of it.
 */
import type { AngleFindings, PlanItemKind } from "./plan-draft.ts";
import { normalisePhrase } from "./plan-validate.ts";

export interface NeverClaimFilterResult {
  findings: AngleFindings[];
  /** Empty when nothing was dropped — the disclosure is a no-op then. */
  disclosure: string[];
  droppedCount: number;
}

export function applyNeverClaimFilter(
  findings: AngleFindings[],
  forbiddenPhrases: string[],
): NeverClaimFilterResult {
  const phrases = forbiddenPhrases.map(normalisePhrase).filter((p) => p.length > 0);
  if (phrases.length === 0) return { findings, disclosure: [], droppedCount: 0 };
  const disclosure: string[] = [];
  let droppedCount = 0;
  const out = findings.map((f) => {
    const dropped: { kind: string; phraseIndex: number }[] = [];
    const kept: PlanItemKind[] = [];
    for (const item of f.toolUses) {
      const nItem = normalisePhrase(item.text);
      // The index is the position in the operator's own NEVER CLAIM list, so
      // "phrase N" is the line the operator counts in their block.
      const hit = phrases.findIndex((p) => nItem.includes(p));
      if (hit >= 0) {
        dropped.push({ kind: item.kind, phraseIndex: hit });
        droppedCount++;
      } else {
        kept.push(item);
      }
    }
    for (const d of dropped) {
      disclosure.push(
        `NEVER CLAIM filter dropped ${dropped.length} item(s) from angle "${f.name}": matched the operator's phrase ${d.phraseIndex + 1} (exact normalised substring, verbatim-only). Neither the phrase nor the dropped item's text is quoted here — the driver appends this line to the body it then scans for that phrase. Dropped item kind: [${d.kind}].`,
      );
    }
    return { ...f, toolUses: kept };
  });
  return { findings: out, disclosure, droppedCount };
}
