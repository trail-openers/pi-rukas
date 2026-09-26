import { type OperatorDirectives, parseOperatorDirectivesWithLines } from "./plan-directives.ts";
/**
 * plan-prior-context-assembly — the two-channel prior-context build for the
 * /plan pipeline (split out of plan-driver.ts along the 500-line seam,
 * AGENTS.md §12).
 *
 * Phase 1 of the pipeline assembles prior context from three sources — the
 * operator's `context` param (D2: the authority, rendered verbatim), related
 * issues from the forge, and vipune snapshots (D6: tagged as prior, droppable
 * tail). Since #858 the operator's typed-block lines (those the directive
 * parser CONSUMED) stay in the child-prompt channel (D2: the operator is
 * authority — test-plan-prior-context.ts pins those caps on the full
 * context) but leave the FILED-body inventory (they render in their typed
 * section, and re-listing them verbatim is the duplication #858 removes).
 * This module is the single site where the split happens; the driver feeds
 * both arrays to their consumers and never re-derives it.
 */
import { type MechanicalInventory, VIPUNE_PRIOR_SOURCE } from "./plan-draft.ts";

export interface PriorContextAssembly {
  /**
   * The FULL operator context (every non-blank line) + related issues +
   * vipune snapshots — what the child-prompt channel (angle prompts,
   * duplicate-risk, gap gate) receives (D2: the operator is the authority
   * and those caps are pinned byte-exactly in test-plan-prior-context.ts).
   */
  priorContext: { source: string; fact: string }[];
  /**
   * The FILED-body variant: untyped prose lines only (typed-block lines
   * consumed by the directive parser are excluded) + related issues +
   * vipune snapshots (D6: the precedence note fires off the vipune source
   * tag, which this array carries).
   */
  inventoryContext: { source: string; fact: string }[];
  /** D7: operator typed blocks override specialist output for their fields. */
  directives: OperatorDirectives;
}

/**
 * Build both prior-context channels from the operator's `context` param and
 * the mechanical inventory. `context.trim().split("\n")` indices align with
 * the parser's 0-based source lines (both see the same string), so a
 * consumed line index excludes exactly that line from the inventory.
 */
export function assemblePriorContext(
  context: string | undefined,
  inv: MechanicalInventory,
): PriorContextAssembly {
  // D7: operator typed blocks override specialist output for their fields.
  // #858: `withLines` reports which source lines the typed blocks CONSUMED;
  // those lines leave the FILED-body inventory (they render in their typed
  // section) but stay in the child-prompt channel. The one loop below feeds
  // both uses.
  const { directives, consumedLines } = parseOperatorDirectivesWithLines(context);
  const consumed = new Set(consumedLines);
  const priorContext: { source: string; fact: string }[] = [];
  const inventoryContext: { source: string; fact: string }[] = [];
  if (context && context.trim().length > 0) {
    const contextLines = context.trim().split("\n");
    contextLines.forEach((rawLine, idx) => {
      const line = rawLine.trim();
      if (!line) return;
      // D2: no 200-char clipping of operator context — the operator is the
      // authority and the inventory renders it verbatim.
      priorContext.push({ source: "context param", fact: line });
      if (!consumed.has(idx)) inventoryContext.push({ source: "context param", fact: line });
    });
  }
  const relatedEntries = inv.related
    .slice(0, 5)
    .map((r) => ({ source: `issue #${r.number} (${r.state})`, fact: r.title }));
  // D6: vipune hits are tagged as prior snapshots (may be stale); the
  // precedence note in the child prompts makes live context win on conflict.
  // #858: the relevance-filtered rows feed BOTH channels (they are the
  // inventory's non-operator content in the filed body too).
  const vipuneEntries = inv.memory.map((h) => ({
    source: VIPUNE_PRIOR_SOURCE,
    fact: h.content.slice(0, 200),
  }));
  priorContext.push(...relatedEntries, ...vipuneEntries);
  inventoryContext.push(...relatedEntries, ...vipuneEntries);
  return { priorContext, inventoryContext, directives };
}
