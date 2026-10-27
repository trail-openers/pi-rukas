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
 * Dropped items are NEVER silent — the returned disclosure names every phrase
 * that matched and the per-angle drop counts, and the driver threads it into the
 * drafted body and the result details. The findings array is REPLACED, not
 * mutated: the caller's original array is untouched, and the disclosure is the
 * ONLY place the dropped items are accounted for — a filter that quietly shrank
 * `toolUses` without a disclosure line would be the exact anti-pattern #677
 * exists to prevent.
 */
import type { AngleFindings, PlanItemKind } from "./plan-draft.ts";
import { normalisePhrase } from "./plan-validate.ts";

/** How much of a dropped item's text the disclosure line quotes. */
const DROPPED_TEXT_DISPLAY_MAX = 80;

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
    const dropped: { kind: string; text: string; phrase: string }[] = [];
    const kept: PlanItemKind[] = [];
    for (const item of f.toolUses) {
      const nItem = normalisePhrase(item.text);
      const hit = phrases.find((p) => nItem.includes(p));
      if (hit) {
        dropped.push({ kind: item.kind, text: item.text, phrase: hit });
        droppedCount++;
      } else {
        kept.push(item);
      }
    }
    if (dropped.length > 0) {
      for (const d of dropped) {
        const shown =
          d.text.length > DROPPED_TEXT_DISPLAY_MAX
            ? `${d.text.slice(0, DROPPED_TEXT_DISPLAY_MAX - 1)}…`
            : d.text;
        disclosure.push(
          `NEVER CLAIM filter dropped ${dropped.length} item(s) from angle "${f.name}": matches the operator's forbidden phrase "${d.phrase}" (exact normalised substring). Dropped: [${d.kind}] ${shown}`,
        );
      }
    }
    return { ...f, toolUses: kept };
  });
  return { findings: out, disclosure, droppedCount };
}
