/**
 * plan-draft-conflicts — operator-over-investigation conflict rules for /plan.
 *
 * The operator's lines (ACCEPTANCE CRITERIA, OUT OF SCOPE, Decisions, i.e.
 * the `context param` prior-context entries) are final. An investigation
 * item (edge case, test-surface, out-of-scope, suggested criterion) that
 * contradicts one of them is dropped BEFORE drafting and disclosed, so the
 * gap gate never sees the clash. The same rule is applied to gap-gate
 * reports: a gap that sets an operator line against an investigation line is
 * discarded and disclosed, not counted toward the CRITICAL cap.
 *
 * Detection is deliberately lexical and conservative: two lines conflict when
 * they share at least two content tokens (the same topic) and exactly one of
 * them carries a negation / exclusion cue (the opposite polarity). Operator
 * lines are never dropped; operator-vs-operator conflicts are never touched
 * (they still cap as before).
 */

import type { OperatorDirectives } from "./plan-directives.ts";
import type { AngleFindings } from "./plan-draft.ts";

/** Minimum shared content tokens for two lines to be about the same thing. */
const MIN_SHARED_TOKENS = 2;

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

/** Polarity cues: a line carrying one asserts the opposite of a line without. */
const NEGATION_CUE =
  /\b(?:not|no|never|none|nothing|without|cannot|can't|don't|doesn't|must not|shall not|excluded?|absent|instead|rather than|forbidden|disallowed|prohibited)\b|n't\b/i;

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

/** One investigation item as the drafting path sees it. */
export interface InvestigationLine {
  kind: string;
  text: string;
  angle: string;
}

export interface DroppedInvestigationItem<T extends InvestigationLine = InvestigationLine> {
  item: T;
  /** The operator line it contradicts, or the other investigation line. */
  against: string;
  reason: "operator" | "investigation";
}

export interface InvestigationConflictResult<T extends InvestigationLine = InvestigationLine> {
  kept: T[];
  dropped: DroppedInvestigationItem<T>[];
  /** Open Questions for investigation-vs-investigation clashes no operator line settles. */
  openQuestions: string[];
}

/**
 * Drop investigation items that contradict an operator line, and drop BOTH
 * sides of an investigation-vs-investigation clash. An investigation-vs-
 * investigation clash becomes an Open Question only when no operator line
 * is about the same topic (operator context settles it otherwise).
 */
export function filterInvestigationConflicts<T extends InvestigationLine>(
  items: T[],
  operatorLines: string[],
): InvestigationConflictResult<T> {
  const dropped: DroppedInvestigationItem<T>[] = [];
  const survivors: T[] = [];
  for (const item of items) {
    const op = operatorLines.find((o) => linesConflict(o, item.text));
    if (op !== undefined) dropped.push({ item, against: op, reason: "operator" });
    else survivors.push(item);
  }

  const doomed = new Set<number>();
  const openQuestions: string[] = [];
  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
      const a = survivors[i];
      const b = survivors[j];
      if (!a || !b || doomed.has(i) || doomed.has(j)) continue;
      if (!linesConflict(a.text, b.text)) continue;
      doomed.add(i);
      doomed.add(j);
      dropped.push({ item: a, against: b.text, reason: "investigation" });
      dropped.push({ item: b, against: a.text, reason: "investigation" });
      const settled = operatorLines.some(
        (o) => sharedTokenCount(o, a.text) >= MIN_SHARED_TOKENS || sharedTokenCount(o, b.text) >= MIN_SHARED_TOKENS,
      );
      if (!settled) openQuestions.push(`Unresolved investigation conflict: "${a.text}" vs "${b.text}"`);
    }
  }
  const kept = survivors.filter((_, idx) => !doomed.has(idx));
  return { kept, dropped, openQuestions };
}

/** The disclosure bullet for one dropped item (rendered in the filed body). */
export function droppedDisclosure(d: DroppedInvestigationItem): string {
  const { item } = d;
  const why =
    d.reason === "operator"
      ? `dropped: conflicts with operator decision "${d.against.slice(0, 160)}"`
      : `dropped: conflicts with another investigation line "${d.against.slice(0, 160)}" that no operator decision settles`;
  return `- ${why} — [${item.angle} / ${item.kind}] ${item.text}`;
}

/**
 * A gap-gate finding that sets an operator-authored line against an
 * investigation-authored line. Both sides must be matched; a gap that only
 * touches operator lines (an operator-vs-operator conflict) is NOT one of
 * these and keeps capping.
 */
export function isOperatorInvestigationGap(
  gapText: string,
  operatorLines: string[],
  investigationLines: string[],
): boolean {
  const opMatches = operatorLines.filter((o) => sharedTokenCount(o, gapText) >= MIN_SHARED_TOKENS);
  const invHit = investigationLines.some((i) => sharedTokenCount(i, gapText) >= MIN_SHARED_TOKENS);
  if (opMatches.length === 0 || !invHit) return false;
  // The gap sets two operator lines against each other: an operator-vs-operator
  // contradiction, which is never this rule's to discard.
  for (let i = 0; i < opMatches.length; i++)
    for (let j = i + 1; j < opMatches.length; j++)
      if (linesConflict(opMatches[i] ?? "", opMatches[j] ?? "")) return false;
  return true;
}

/** Investigation kinds an operator line can contradict (#1132). */
const CONFLICTABLE_KINDS = new Set(["edge-case", "test-surface-item", "out-of-scope", "acceptance-criterion"]);

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
  const operatorLines = [
    ...directives.acceptanceCriteria,
    ...directives.outOfScope,
    ...directives.pitfalls,
    ...(directives.testSurface ?? []),
    ...priorContext.filter((p) => p.source === "context param").map((p) => p.fact),
  ];
  const candidates = findings.flatMap((f) => f.toolUses.filter((i) => CONFLICTABLE_KINDS.has(i.kind)));
  const res = filterInvestigationConflicts(candidates, operatorLines);
  const dropItems = new Set(res.dropped.map((d) => d.item));
  return {
    findings: findings.map((f) => ({ ...f, toolUses: f.toolUses.filter((i) => !dropItems.has(i)) })),
    dropped: res.dropped,
    openQuestions: res.openQuestions,
  };
}

/** #1132: the disclosure section for dropped investigation items ("" when none). */
export function droppedSection(dropped: DroppedInvestigationItem[]): string {
  if (dropped.length === 0) return "";
  return `\n## Dropped investigation items\n\n${dropped.map(droppedDisclosure).join("\n")}\n`;
}
