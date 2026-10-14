/**
 * plan-draft-conflicts — operator-over-investigation conflict rules for /plan drafting.
 *
 * The operator's lines (ACCEPTANCE CRITERIA, OUT OF SCOPE, Decisions, i.e.
 * the `context param` prior-context entries) are final. An investigation
 * item (edge case, test-surface, out-of-scope, suggested criterion) that
 * contradicts one of them is dropped BEFORE drafting and disclosed, so the
 * drafted spec never carries the clash.
 *
 * Detection is deliberately lexical and conservative: two lines conflict when
 * they share at least three content tokens (the same topic) and exactly one of
 * them carries a negation / exclusion cue (the opposite polarity). Operator
 * lines are never dropped. This runs only while drafting. It never decides
 * whether the gap gate blocks or files: the gate (plan-gaps.ts, prompt in
 * plan-gate-prompt.ts) judges the drafted spec on its own terms.
 *
 * Two investigation items that clash are settled by an operator line when that
 * line agrees with one of them and contradicts the other: the contradicted item
 * is dropped and the disclosure names the operator line. Only an unsettled
 * clash drops both items and raises an Open Question.
 */

import type { OperatorDirectives } from "./plan-directives.ts";
import type { AngleFindings, PlanItemKindName } from "./plan-draft.ts";
import { OPERATOR_SOURCE } from "./plan-prior-context.ts";

/**
 * Minimum shared content tokens for two lines to be about the same thing.
 * Three, not two: a 401 line and a 429 line about one response shape share two
 * tokens and carry opposite polarity, and must both survive (#1132 fixture).
 */
const MIN_SHARED_TOKENS = 3;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "each",
  "every",
  "any",
  "all",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "its",
  "their",
  "then",
  "than",
  "when",
  "where",
  "which",
  "while",
  "also",
  "must",
  "should",
  "will",
  "would",
  "can",
  "may",
  "does",
  "do",
  "has",
  "have",
  "had",
  "use",
  "uses",
  "used",
  "file",
  "spec",
  "item",
  "line",
  "case",
  "pass",
  "plan",
  "one",
  "there",
  "here",
  "about",
  "over",
  "under",
  "only",
]);

/**
 * Polarity cues: a line carrying one asserts the opposite of a line without.
 * Whole words only: a hyphen or word character on either side disqualifies a
 * match, so `no-op` and `not-applicable` are not negations (#1132).
 */
const NEGATION_CUE =
  /(?<![\w-])(?:not|no|never|none|nothing|without|cannot|can't|don't|doesn't|must not|shall not|excluded?|absent|instead|rather than|forbidden|disallowed|prohibited)(?![\w-])|n't(?![\w-])/i;

/** Content tokens: lowercase words of length ≥ 3, stopwords removed. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

function sharedTokenCount(a: string, b: string): number {
  const tb = contentTokens(b);
  let n = 0;
  for (const t of contentTokens(a)) if (tb.has(t)) n++;
  return n;
}

/** True when two lines are about the same thing with opposite polarity. */
export function linesConflict(a: string, b: string): boolean {
  if (sharedTokenCount(a, b) < MIN_SHARED_TOKENS) return false;
  return NEGATION_CUE.test(a) !== NEGATION_CUE.test(b);
}

/** Same topic and same polarity: the operator line restates the investigation item. */
function agrees(op: string, item: string): boolean {
  return (
    sharedTokenCount(op, item) >= MIN_SHARED_TOKENS &&
    NEGATION_CUE.test(op) === NEGATION_CUE.test(item)
  );
}

/** One investigation item as the drafting path sees it. */
export interface InvestigationLine {
  kind: PlanItemKindName;
  text: string;
  angle: string;
}

export interface DroppedInvestigationItem<T extends InvestigationLine = InvestigationLine> {
  item: T;
  /** The operator line it contradicts or that settled its clash, or the other investigation line. */
  against: string;
  /**
   * operator: contradicts an operator line. settled: an operator line agreed
   * with `sibling` and contradicted this item. investigation: an unsettled clash.
   * duplicate: restates an operator line (same polarity) with no concrete reference.
   */
  reason: "operator" | "investigation" | "settled" | "duplicate";
  /** For "settled": the investigation line the operator line kept. */
  sibling?: string;
}

export interface InvestigationConflictResult<T extends InvestigationLine = InvestigationLine> {
  kept: T[];
  dropped: DroppedInvestigationItem<T>[];
  /** Open Questions for investigation-vs-investigation clashes no operator line settles. */
  openQuestions: string[];
}

/**
 * Files, paths and line numbers: a restatement that adds one of these is kept,
 * because it carries grounding the operator line lacks.
 */
const CONCRETE_REFERENCE =
  /[\w-]+\.(?:ts|tsx|js|mjs|cjs|md|json|sh|rs|py|go|ya?ml)\b|[\w.-]+\/[\w.-]+|:\d+\b/;

/** The operator line that settles a clash between two items, and which item it keeps. */
function settlement<T extends InvestigationLine>(
  a: T,
  b: T,
  operatorLines: string[],
): { keep: T; drop: T; line: string } | undefined {
  for (const op of operatorLines) {
    if (agrees(op, a.text) && linesConflict(op, b.text)) return { keep: a, drop: b, line: op };
    if (agrees(op, b.text) && linesConflict(op, a.text)) return { keep: b, drop: a, line: op };
  }
  return undefined;
}

/**
 * Drop investigation items that contradict the operator. A clash between two
 * investigation items is settled by an operator line that agrees with one side
 * (that side is kept, the other dropped and disclosed as settled); an unsettled
 * clash drops BOTH sides and becomes an Open Question. An item is dropped at
 * most once, however many conflicting pairs it sits in.
 */
export function filterInvestigationConflicts<T extends InvestigationLine>(
  items: T[],
  operatorLines: string[],
): InvestigationConflictResult<T> {
  const doomed = new Set<T>();
  // Items an operator line settled in their favour: already endorsed, so not deduplicated.
  const settledKeep = new Set<T>();
  const dropped: DroppedInvestigationItem<T>[] = [];
  const drop = (d: DroppedInvestigationItem<T>): void => {
    if (doomed.has(d.item)) return;
    doomed.add(d.item);
    dropped.push(d);
  };
  const live = (): T[] => items.filter((it) => !doomed.has(it));

  // 1. Operator-settled pairs: the side the operator line contradicts goes.
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (!a || !b || doomed.has(a) || doomed.has(b)) continue;
      if (!linesConflict(a.text, b.text)) continue;
      const s = settlement(a, b, operatorLines);
      if (s) {
        settledKeep.add(s.keep);
        drop({ item: s.drop, against: s.line, reason: "settled", sibling: s.keep.text });
      }
    }
  }

  // 2. Items that contradict an operator line are conflicts. Items that restate
  //    one (same topic, same polarity) are duplicates, kept only when they add a
  //    concrete reference. A restatement is never labelled a conflict.
  for (const item of live()) {
    const op = operatorLines.find((o) => linesConflict(o, item.text));
    if (op !== undefined) {
      drop({ item, against: op, reason: "operator" });
      continue;
    }
    // Acceptance-criterion paraphrases are routed to "Suggested additional criteria"
    // by the render-time AC suppression (plan-draft), so they are not dropped here.
    if (settledKeep.has(item) || item.kind === "acceptance-criterion") continue;
    if (CONCRETE_REFERENCE.test(item.text)) continue;
    const dup = operatorLines.find((o) => agrees(o, item.text));
    if (dup !== undefined) drop({ item, against: dup, reason: "duplicate" });
  }

  // 3. Unsettled investigation-vs-investigation clashes among the rest.
  const openQuestions: string[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (!a || !b || doomed.has(a) || doomed.has(b)) continue;
      if (!linesConflict(a.text, b.text)) continue;
      drop({ item: a, against: b.text, reason: "investigation" });
      drop({ item: b, against: a.text, reason: "investigation" });
      openQuestions.push(`Unresolved investigation conflict: "${a.text}" vs "${b.text}"`);
    }
  }
  return { kept: live(), dropped, openQuestions };
}

/** The disclosure bullet for one dropped item (rendered in the filed body). */
export function droppedDisclosure(d: DroppedInvestigationItem): string {
  const { item } = d;
  const why =
    d.reason === "operator"
      ? `dropped: conflicts with operator decision "${d.against.slice(0, 160)}"`
      : d.reason === "duplicate"
        ? `dropped: duplicate of operator line "${d.against.slice(0, 160)}"`
        : d.reason === "settled"
          ? `dropped: operator decision "${d.against.slice(0, 160)}" settles its clash with the investigation line "${(d.sibling ?? "").slice(0, 160)}"`
          : `dropped: conflicts with another investigation line "${d.against.slice(0, 160)}" that no operator decision settles`;
  return `- ${why} — [${item.angle} / ${item.kind}] ${item.text}`;
}

/** Investigation kinds an operator line can contradict (#1132). */
const CONFLICTABLE_KINDS: ReadonlySet<PlanItemKindName> = new Set<PlanItemKindName>([
  "edge-case",
  "test-surface-item",
  "out-of-scope",
  "acceptance-criterion",
]);

/** Operator-authored lines: final, never dropped by this rule. */
export function operatorLinesOf(
  directives: OperatorDirectives,
  priorContext: { source: string; fact: string }[],
): string[] {
  return [
    ...directives.acceptanceCriteria,
    ...directives.outOfScope,
    ...directives.pitfalls,
    ...(directives.testSurface ?? []),
    ...priorContext.filter((p) => p.source === OPERATOR_SOURCE).map((p) => p.fact),
  ];
}

/** The investigation-authored candidate items this rule may drop. */
function conflictableItems(findings: AngleFindings[]) {
  return findings.flatMap((f) => f.toolUses.filter((i) => CONFLICTABLE_KINDS.has(i.kind)));
}

/**
 * #1132: operator lines are final. Drop every investigation item that
 * contradicts one BEFORE any bullet is written, and return the drops (for
 * disclosure) plus any investigation-vs-investigation Open Questions.
 */
export function applyOperatorConflicts(
  findings: AngleFindings[],
  directives: OperatorDirectives,
  priorContext: { source: string; fact: string }[],
) {
  const res = filterInvestigationConflicts(
    conflictableItems(findings),
    operatorLinesOf(directives, priorContext),
  );
  const dropItems = new Set(res.dropped.map((d) => d.item));
  return {
    findings: findings.map((f) => ({
      ...f,
      toolUses: f.toolUses.filter((i) => !dropItems.has(i)),
    })),
    dropped: res.dropped,
    openQuestions: res.openQuestions,
  };
}

/** #1132: the disclosure section for dropped investigation items ("" when none). */
export function droppedSection(dropped: DroppedInvestigationItem[]): string {
  if (dropped.length === 0) return "";
  return `\n## Dropped investigation items\n\n${dropped.map(droppedDisclosure).join("\n")}\n`;
}
