/**
 * plan-draft-dedupe — the duplicate stage of operator-line filtering for /plan drafting (#1151).
 *
 * Single responsibility: drop an investigation item that RESTATES an operator
 * line. It runs after plan-draft-conflicts.ts (stage 1, which drops items that
 * CONTRADICT an operator line) and only ever sees the items stage 1 kept.
 *
 * An item is a duplicate only when all of these hold:
 *   - its polarity agrees with the operator line (both negated or both not);
 *   - its content-token set is a subset of the operator line's content-token set,
 *     with at least MIN_SHARED_TOKENS tokens, so it adds no word the operator
 *     line lacks — an item that adds a requirement is kept;
 *   - it carries no concrete reference (a file, path or line number), which is
 *     grounding the operator line lacks;
 *   - it is not an acceptance criterion (those are routed to "Suggested
 *     additional criteria" at render time, plan-draft.ts) and not an item an
 *     operator line already endorsed in stage 1.
 *
 * Dropped duplicates use the shared "duplicate" reason, so disclosure is the
 * same as before the split.
 */

import type { OperatorDirectives } from "./plan-directives.ts";
import {
  type DroppedInvestigationItem,
  type InvestigationLine,
  MIN_SHARED_TOKENS,
  NEGATION_CUE,
  conflictableItems,
  contentTokens,
  operatorLinesOf,
  withoutItems,
} from "./plan-draft-conflicts.ts";
import type { AngleFindings } from "./plan-draft.ts";

/**
 * Files, paths and line numbers: a restatement that adds one of these is kept,
 * because it carries grounding the operator line lacks.
 */
const CONCRETE_REFERENCE =
  /[\w-]{1,255}\.(?:ts|tsx|js|mjs|cjs|md|json|sh|rs|py|go|ya?ml)\b|[\w.-]{1,255}\/[\w.-]{1,255}|:\d{1,9}\b/;

/** True when `item` restates `op`: same polarity, and every content token of the item is in the operator line. */
function restates(op: string, item: string): boolean {
  if (NEGATION_CUE.test(op) !== NEGATION_CUE.test(item)) return false;
  const opTokens = contentTokens(op);
  const itemTokens = contentTokens(item);
  if (itemTokens.size < MIN_SHARED_TOKENS) return false;
  for (const token of itemTokens) if (!opTokens.has(token)) return false;
  return true;
}

/**
 * Drop each item that restates an operator line. Items in `endorsed` (settled
 * in an operator line's favour) and concrete or acceptance-criterion items are
 * kept. The returned `dropped` entries carry reason "duplicate".
 */
export function dedupeAgainstOperatorLines<T extends InvestigationLine>(
  items: T[],
  operatorLines: string[],
  endorsed: ReadonlySet<unknown> = new Set(),
): { kept: T[]; dropped: DroppedInvestigationItem<T>[] } {
  const kept: T[] = [];
  const dropped: DroppedInvestigationItem<T>[] = [];
  for (const item of items) {
    if (
      endorsed.has(item) ||
      item.kind === "acceptance-criterion" ||
      CONCRETE_REFERENCE.test(item.text)
    ) {
      kept.push(item);
      continue;
    }
    const dup = operatorLines.find((o) => restates(o, item.text));
    if (dup !== undefined) dropped.push({ item, against: dup, reason: "duplicate" });
    else kept.push(item);
  }
  return { kept, dropped };
}

/**
 * The findings-level duplicate stage (#1151): removes restatements from the
 * findings that stage 1 (`applyOperatorConflicts`) left behind.
 */
export function applyOperatorDedupe(
  findings: AngleFindings[],
  directives: OperatorDirectives,
  priorContext: { source: string; fact: string }[],
  endorsed: ReadonlySet<unknown>,
) {
  const res = dedupeAgainstOperatorLines(
    conflictableItems(findings),
    operatorLinesOf(directives, priorContext),
    endorsed,
  );
  return {
    findings: withoutItems(findings, new Set(res.dropped.map((d) => d.item))),
    dropped: res.dropped,
  };
}
