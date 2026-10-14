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
import type { AngleFindings, PlanItemKind } from "./plan-draft.ts";
import type { PriorContextEntry } from "./plan-prior-context.ts";

/**
 * Files, paths and line numbers: a restatement that adds one of these is kept,
 * because it carries grounding the operator line lacks.
 */
const CONCRETE_REFERENCE =
  /[\w-]{1,255}\.(?:ts|tsx|js|mjs|cjs|md|json|sh|rs|py|go|ya?ml)\b|[\w.-]{1,255}\/[\w.-]{1,255}|:\d{1,9}\b/;

/** The duplicate test's view of one line: its content tokens and polarity, computed once. */
interface LineProfile {
  tokens: Set<string>;
  negated: boolean;
}

function profileOf(text: string): LineProfile {
  return { tokens: contentTokens(text), negated: NEGATION_CUE.test(text) };
}

/** True when the item restates the operator line: same polarity, and every content token of the item is in the operator line. */
function restates(op: LineProfile, item: LineProfile): boolean {
  if (op.negated !== item.negated) return false;
  if (item.tokens.size < MIN_SHARED_TOKENS) return false;
  for (const token of item.tokens) if (!op.tokens.has(token)) return false;
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
  endorsed: ReadonlySet<T> = new Set<T>(),
): { kept: T[]; dropped: DroppedInvestigationItem<T>[] } {
  const ops = operatorLines.map((line) => ({ line, profile: profileOf(line) }));
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
    const itemProfile = profileOf(item.text);
    const dup = ops.find((o) => restates(o.profile, itemProfile));
    if (dup !== undefined) dropped.push({ item, against: dup.line, reason: "duplicate" });
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
  priorContext: PriorContextEntry[],
  endorsed: ReadonlySet<PlanItemKind>,
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
