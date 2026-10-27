/**
 * plan-duplicate-self — the deterministic post-filter that stops the /plan
 * duplicate-risk check naming the issue it was asked to plan (#1856).
 *
 * Field evidence: two of seven plan sessions on an external factory handed off
 * at exit 10 with a HIGH duplicate verdict, and on one of them the named
 * "duplicate" was the issue being planned itself ("#869 (OPEN …) already covers
 * this exact scope verbatim"). The descriptor of a plan started FROM an
 * existing issue is a near-copy of that issue's own title, and the mechanical
 * inventory plus the prior-context rows both feed the child a verbatim listing
 * of it — so the child's most confident duplicate is the ticket under plan.
 *
 * Five rules, all deterministic, none of them a judgment about the model's
 * reasoning:
 *
 *   1. The source issue N and its own split children are never duplicates. They
 *      are the SUBJECT of the plan. Excluded wherever they appear: the
 *      inventory rows, the prior-context rows, the child's prompt, and the
 *      verdict's named issues.
 *   2. A CLOSED issue that the child ITSELF called prior art or a reversal
 *      target is what the child's own charter says is not a duplicate, so a
 *      HIGH that rests only on those is downgraded, not believed. Prior art can
 *      be satisfied ONLY by an inventory row known to be CLOSED: a named issue
 *      the inventory never carried has no known state, and rule 3 keeps it.
 *   3. Anything else stands: a HIGH that names one other OPEN issue halts
 *      exactly as it did before, and so does a `#X-k` token whose parent is not
 *      the source — that is someone else's decomposition, not this plan's.
 *   4. A number this filter cannot account for keeps the HIGH (#1856 review
 *      rounds 1–2). The extraction above reads `#N` tokens only, so a rationale
 *      that cites the rest of its evidence some other way — `GH-12`, `ticket 12`,
 *      `bug 12`, `issue-12`, `issue:12`, `issue12`, `pull 12`, `PR 12`,
 *      `…/issues/12`, or a `#` id past `Number.MAX_SAFE_INTEGER` — looked like a
 *      self-only HIGH to rules 1–2 and was downgraded while main halted. Round 1
 *      answered that with a WORD LIST of reference shapes and it leaked: every
 *      spelling the list had not enumerated still downgraded. So rule 4 is
 *      STRUCTURAL and fail-closed instead. After the `#N` tokens this filter
 *      positively resolved as excluded, the rest of the text is stripped only of
 *      the number shapes a rationale legitimately carries (ISO dates, version
 *      strings, clock times, and the digits inside the excluded tokens) and ANY
 *      DIGIT RUN THAT SURVIVES KEEPS THE HIGH. A stray number keeps the stop,
 *      never the reverse, so an unenumerated spelling of a reference cannot
 *      downgrade anything: the failure mode moves from a silent wrong downgrade
 *      to a halt the operator can see.
 *   5. The prior-art word must sit in the SAME CLAUSE as the CLOSED issue's
 *      token (#1856 review round 2), where a clause ends at `. ! ? ; , :` or a
 *      newline. Words from an adjacent issue's clause count for nothing, so
 *      "#1856 is prior art; #103 is unlanded duplicate work" halts, and so does
 *      the comma form, while "reverses the landed decision in #103" downgrades.
 *      A clause that NEGATES the prior-art word ("#103 is not prior art, it is
 *      unlanded duplicate work") is the child saying the closed issue is a real
 *      duplicate, and suppresses nothing. Round 3: EVERY mention is judged, not
 *      just the first — "#103 is prior art for this. #103 is not landed, it is
 *      unlanded duplicate work" is one affirmation followed by a denial, and a
 *      reply that reads only the first clause suppressed a HIGH main halts on. A
 *      CLOSED issue is excluded only when SOME clause affirms prior art and NO
 *      clause naming it negates it.
 *
 * Rules 1–5 read the child's FULL reply, not the 400-char slice the parser keeps
 * for display (round-1 lens H1): an OPEN duplicate named past that cut is
 * invisible to the slice, and a HIGH that halts on main must not be downgraded
 * here because the evidence fell off the end of a window.
 *
 * An ABSENT marker is never a downgrade — `parseDuplicateRisk` defaults an
 * unparsed reply to medium, and recording that as an intentional suppression
 * would let a crashed child read as a decision the driver made.
 *
 * Issue state is normalised ONCE, where the post-filter's known-issue map is
 * built (`normaliseIssueState` in plan-investigate.ts), so every reader of
 * `KnownIssue.state` / `ExcludedDuplicate.state` sees the same three values and
 * no comparison has to re-case the string.
 */
import {
  EXCLUSION_CLAUSE_MAX_CHARS,
  EXCLUSION_DISCLOSURE_MAX_ROWS,
  EXCLUSION_REASON_MAX_CHARS,
  EXCLUSION_TITLE_MAX_CHARS,
} from "./plan-duplicate-disclosure.ts";
import type { MechanicalInventory } from "./plan-inventory.ts";
import type { DuplicateRisk, ExcludedDuplicate } from "./plan-investigate.ts";

/** The prior-context source tag the duplicate-risk child is shown for a related issue. */
const ISSUE_SOURCE_RE = /^issue #(\d+) \(/;

/**
 * Words that make a CLOSED issue the child's own prior art / reversal target —
 * the vocabulary its charter hands it ("prior art or a REVERSAL target").
 * Matched per clause (rule 5), never across the whole reply: a reply that
 * discharges rule 1 for the planned issue and then halts on a genuinely open
 * duplicate must not have that open finding's own wording read back as a
 * prior-art claim about the closed issue.
 */
const PRIOR_ART_RE =
  /\b(prior art|reversal|revers(?:e|es|ed|ing)|supersed\w*|overturn\w*|landed|deliberate(?:ly)?\s+chang\w*)\b/i;

/**
 * The same vocabulary with an optional negation in front of it — "is not prior
 * art", "isn't superseded", "was never landed". A clause whose only prior-art
 * word is negated is the child REJECTING prior art for that issue, so it
 * satisfies nothing. The window is three words because the negation that
 * matters is the one attached to the verb, not any `not` in the sentence.
 */
const PRIOR_ART_NEGATED_RE =
  /\b(?:not|never|isn'?t|wasn'?t|weren'?t|doesn'?t|don'?t|didn'?t|cannot|can'?t|no)\s+(?:\w+\s+){0,2}(?:prior\s+art|reversal|revers(?:e|es|ed|ing)|supersed\w*|overturn\w*|landed|deliberate(?:ly)?\s+chang\w*)\b/i;

/**
 * The number shapes a rationale legitimately carries that are NOT evidence about
 * another issue, and so are stripped before rule 4 asks whether any digits are
 * left: an ISO date (`2026-10-27`, with or without a time — the field case's
 * `(OPEN, created 2026-10-27)`), a clock time (`14:05`, `9:30:12.5`), a
 * `v`-prefixed version of THREE OR MORE parts, and the digits inside the tokens
 * this filter already resolved, which the caller removes with the tokens
 * themselves.
 *
 * A date or a version is a `.`/`:`-joined run of digit groups, so each pattern
 * takes its separators AND the digits at both ends: stripping them one at a time
 * can never leave an orphan digit run for rule 4 to misread as a reference.
 * Deliberately NOT stripped (round 3, lens HIGH): a bare digit run (`12`, `3
 * rounds`, `line 41`), a PREFIXLESS dotted number at any arity (`0.14.27`,
 * `1855.1.0`) and a TWO-PART `v` number (`v1855.1`). An issue reference can be
 * written every one of those ways, so a shape that cannot be told apart from one
 * keeps its digits and rule 4 keeps the HIGH — the fail-closed side of the
 * trade. Only the `v` prefix plus three parts is a shape no issue id takes.
 */
const SAFE_NUMBER_RES = [
  // ISO date, optionally with a time and an offset.
  /(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?(?:Z|[+-]\d{2}:?\d{2}))?)?)/gi,
  // Clock time: 14:05, 9:30:12.5
  /(?:\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b)/g,
  // A `v`-prefixed version of THREE OR MORE parts: v0.14.27, V1.2.3.4. The `v`
  // is what makes it a version and not an issue id written with a stray dot, and
  // the third part is what rules out `v1855.1` — an issue number wearing a `v`.
  // The part count is spelled out, not written `{2,}`: `(?:\.\d+){2,}` after a
  // required `\.\d+` counts THREE optional groups and matches only four-part
  // versions, which read every three-part one as an unaccounted number.
  /(?:\bv\d+\.\d+(?:\.\d+)(?:\.\d+)*)/gi,
];

/** The rule that removed a candidate, rendered into the disclosure. */
export const EXCLUSION_REASONS = {
  source: "the issue this plan is for (a plan is not the duplicate of its own subject)",
  "split-child": "the planned issue's own split child",
  "prior-art": "a CLOSED issue the risk check itself called prior art or a reversal target",
} as const;

/**
 * Tail of the prior-art disclosure: the clause the rule matched is quoted, so
 * the operator reads the child's own words instead of a fixed claim the filter
 * asserts about them.
 */
export const PRIOR_ART_EVIDENCE = "the risk check called it that in this clause";

/**
 * The disclosure itself — the section renderer and every character bound on it —
 * lives in plan-duplicate-disclosure.ts, which also names why each slot is
 * bounded the width it is. `EXCLUSION_REASONS` and `PRIOR_ART_EVIDENCE` stay
 * HERE because the rules below compose them into the row they explain; a row
 * whose wording the rule that removed it cannot see is a disclosure nobody can
 * check.
 */

/**
 * Clause boundaries for rule 5: sentence terminators, a semicolon, a comma and a
 * colon, plus a newline. Narrower than a sentence on purpose — the common
 * rationale is one long dash-separated line, so at sentence scope a word about
 * `#1856` leaks into `#103`'s judgement.
 */
const CLAUSE_BOUNDARY = /[.!?,;:\n]/;

/**
 * Is this already-normalised state "CLOSED"? The comparison is exact by design:
 * {@link normaliseIssueState} is the only place a forge's spelling is cased, and
 * a caller that passes raw bytes gets `false` — a state nobody normalised is
 * never evidence that an issue's work landed.
 */
export function isClosedState(state: PlanIssueState): boolean {
  return state === "CLOSED";
}

/**
 * One issue a rationale names: the numeric id when the forge has one, and the
 * `N-k` split-child token as `parent`/`child` (a plain `Number()` of "1856-2"
 * is NaN, so the token cannot travel as a number).
 */
export interface NamedIssueRef {
  /** The numeric id, or NaN for a split-child token. */
  id: number;
  /** The token as written in the rationale, without the `#`. */
  token: string;
  /** Set when the token is a split-child id (`N-k`). */
  parent?: number;
  child?: number;
}

/** Every `#N` (or `#N-k`) token a rationale names, in order, deduped by token. */
export function namedIssueRefs(text: string): NamedIssueRef[] {
  const out: NamedIssueRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/#(\d+(?:-\d+)?)/g)) {
    const token = m[1] ?? "";
    if (seen.has(token)) continue;
    seen.add(token);
    if (token.includes("-")) {
      const [parent, child] = token.split("-").map((x) => Number(x));
      if (
        Number.isSafeInteger(parent) &&
        child !== undefined &&
        Number.isSafeInteger(child) &&
        child >= 1
      ) {
        out.push({ id: Number.NaN, token, parent, child });
      }
      continue;
    }
    const id = Number(token);
    if (Number.isSafeInteger(id) && id > 0) out.push({ id, token });
  }
  return out;
}

/** The numeric ids a rationale names (split-child tokens excluded). */
export function namedIssueTokens(text: string): number[] {
  return namedIssueRefs(text)
    .map((r) => r.id)
    .filter((n) => Number.isSafeInteger(n));
}

/**
 * The clause rule 5 reads for one named issue: the text around the `#token` up
 * to the nearest clause boundary on either side. The token itself is kept and no
 * other token's words are read, which is what stops an adjacent finding's "is
 * unlanded duplicate work" being satisfied by a neighbour's "prior art".
 */
export function clauseNaming(text: string, token: string): string {
  const clauses = everyClauseNaming(text, token);
  return clauses.length === 0 ? "" : (clauses[0] ?? "");
}

/**
 * Every clause that names `#token`, in order of appearance — the shape rule 5
 * actually judges (round 3). The match is anchored with `(?![\d-])` so `#7`
 * never reads as a mention inside `#71` or `#7-2`, and each occurrence yields
 * its own clause, so an affirmation in one sentence cannot outrank a denial in
 * the next.
 */
export function everyClauseNaming(text: string, token: string): string[] {
  const safe = escapeForRegExp(token);
  if (safe === "") return [];
  const out: string[] = [];
  // A leading run of `#`s belongs to the mention (`##1856`): starting at the
  // digits rather than at the first `#` would leave the clause beginning
  // mid-token, which reads the same words and clips their left context.
  const re = new RegExp(`#+${safe}(?![\\d-])`, "g");
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    let from = at;
    while (from > 0 && !CLAUSE_BOUNDARY.test(text[from - 1] ?? "")) from--;
    let to = at + m[0].length;
    while (to < text.length && !CLAUSE_BOUNDARY.test(text[to] ?? "")) to++;
    out.push(text.slice(from, to).trim());
  }
  return out;
}

/**
 * Rule 4, structural: does the text still contain a number this filter has not
 * accounted for? Call it with the `#N` / `#N-k` tokens the extractor positively
 * resolved as excluded (the subject, its split children) — those digits come out
 * with the tokens, so a reply whose only numbers are the subject and an ISO date
 * reads clean and downgrades, while `GH-12`, `ticket 12`, `bug 12`, `issue-12`,
 * `issue:12`, `issue12`, `pull 12`, a `/issues/12` URL, a 21-digit `#…` or a
 * plain `line 41` leaves a digit run and KEEPS THE HIGH. Any spelling of a
 * reference works, because the rule never asks what a reference LOOKS like — it
 * asks whether anything numeric is left unexplained. Failing to account for a
 * number is never a downgrade.
 */
export function citesUnaccountedNumber(text: string, resolvedTokens: string[]): boolean {
  return /\d/.test(strippedForNumberScan(text, resolvedTokens));
}

/**
 * Rule 4's strip, exposed for the test that has to SEE what the citation removal
 * left behind: a predicate returning a boolean cannot show that `##1856` lost its
 * stray `#` rather than merely losing its digits.
 */
export function citesUnaccountedNumberStripped(text: string, resolvedTokens: string[]): string {
  return strippedForNumberScan(text, resolvedTokens);
}

function strippedForNumberScan(text: string, resolvedTokens: string[]): string {
  let rest = text;
  // Longest token first, and never into a longer digit run: removing `7` before
  // `77` (or before `7-2`) would blank the digits of a token this filter did
  // NOT resolve and rule 4 would then read a real reference as accounted for.
  // `(?![\d-])` also refuses a partial match, and matches nothing that a
  // `namedIssueRefs` token can be — every one ends in a digit. The leading `#+`
  // goes with it: a reply that writes `##1856` (a heading-flavoured citation) is
  // one the extractor resolved, and leaving the stray `#` behind used to be
  // harmless only because `#` carries no digit — removing the whole citation is
  // what makes the strip match the mention the extractor read.
  for (const token of [...resolvedTokens].sort((a, b) => b.length - a.length)) {
    rest = rest.split(new RegExp(`#+${escapeForRegExp(token)}(?![\\d-])`, "g")).join(" ");
  }
  for (const re of SAFE_NUMBER_RES) rest = rest.replace(re, " ");
  return rest;
}

/** Tokens are `[0-9-]+` by construction; this keeps the RegExp constructor honest. */
function escapeForRegExp(s: string): string {
  return s.replace(/[^0-9-]/g, "");
}

/**
 * Is `n` the source issue itself, or one of its split children? A split child
 * of issue N is anything the child or the inventory writes as `N-k` (the
 * decomposition id form a planner uses for an issue's own sub-issues), so
 * `#869-2` is the subject, never a duplicate. A bare `#N` is decided by
 * `number === source` at the call site, so an unrelated `N` from some other
 * numbering can never be mistaken for the subject.
 */
export function isSplitChildOf(parent: number, source: number): boolean {
  return Number.isSafeInteger(parent) && parent === source;
}

/** The inventory rows for a plan of issue `source`, with the subject removed. */
export function relatedExcludingSource(
  inv: MechanicalInventory,
  source: number | undefined,
): MechanicalInventory["related"] {
  if (source === undefined) return inv.related;
  return inv.related.filter((r) => r.number !== source && !isSplitChildOf(r.number, source));
}

/**
 * The prior-context rows the duplicate-risk child sees, with the subject
 * removed. `assemblePriorContext` pushes `issue #N (STATE)` entries straight
 * from the inventory, so without this the "PM has already established" block
 * names the planned issue itself — the second self-match vector.
 */
export function priorContextExcludingSource(
  priorContext: { source: string; fact: string }[],
  source: number | undefined,
): { source: string; fact: string }[] {
  if (source === undefined) return priorContext;
  return priorContext.filter((p) => {
    const m = ISSUE_SOURCE_RE.exec(p.source);
    if (!m) return true;
    const n = Number(m[1]);
    return n !== source && !isSplitChildOf(n, source);
  });
}

/**
 * The three issue states this filter reasons about. The forges agree on
 * `OPEN`/`CLOSED` (`mapGhIssue` upper-cases, `mapGlIssue` maps `opened`/`closed`
 * onto them); anything else they or a cache file carry is `"unknown"`, which
 * satisfies no rule rather than being compared case-by-case at each site.
 *
 * `PlanIssueState`, not `IssueState`: forge-types.ts already owns that name for
 * the two-state forge union, and a second `IssueState` here shadowed it in every
 * file that imported both.
 */
export type PlanIssueState = "OPEN" | "CLOSED" | "unknown";

/**
 * Normalise a forge's state string to {@link PlanIssueState}. ONE site does this —
 * where the post-filter's known-issue map is built — so no downstream rule has
 * to re-case or trim a string to decide whether an issue is closed.
 */
export function normaliseIssueState(state: string | undefined): PlanIssueState {
  const upper = (state ?? "").trim().toUpperCase();
  return upper === "OPEN" || upper === "CLOSED" ? upper : "unknown";
}

/**
 * Is this value already one of the three states the union admits? The cache
 * guard asks, because it reads bytes nobody passed through
 * {@link normaliseIssueState}: admitting only the normalised forms means a
 * hand-edited entry with `"closed"` or `"wontfix"` is a MISS rather than a state
 * some rule later has to second-guess.
 */
export function isIssueState(x: unknown): x is PlanIssueState {
  return x === "OPEN" || x === "CLOSED" || x === "unknown";
}

/** What the inventory knows about one issue number. */
export interface KnownIssue {
  state: PlanIssueState;
  title: string;
}

/**
 * Did the child honour this CLOSED issue as landed work in the clause naming it?
 * A clause with an unnegated prior-art word is the child deferring to a landed
 * decision (rule 2 satisfied); anything else — no word at all, or only a negated
 * one — is the child calling the closed issue a real duplicate, and the HIGH
 * stands.
 */
function priorArtClause(clause: string): boolean {
  return PRIOR_ART_RE.test(clause) && !PRIOR_ART_NEGATED_RE.test(clause);
}

/**
 * Rule 5 over EVERY mention of one issue (round 3): an issue is honoured as
 * landed work only when SOME clause naming it affirms prior art AND no clause
 * naming it negates it. Judging the first mention alone let the field shape
 * "#103 is prior art for this. #103 is not landed, it is unlanded duplicate
 * work" exclude a CLOSED issue the child had just called a real duplicate.
 */
function priorArtForAllMentions(clauses: string[]): boolean {
  if (clauses.length === 0) return false;
  let affirmed = false;
  for (const clause of clauses) {
    if (PRIOR_ART_NEGATED_RE.test(clause)) return false;
    if (PRIOR_ART_RE.test(clause)) affirmed = true;
  }
  return affirmed;
}

/**
 * The post-filter. `verdict` is what the child's marker parsed to; a failed
 * dispatch (no verdict at all) and an absent marker both come back untouched —
 * nothing here may invent a downgrade. Pass `fullText` (the child's uncut reply)
 * so the fail-closed rules read evidence the 400-char display slice dropped.
 * `known` maps an issue number to what the inventory carried for it; a number
 * with no row has no known state, so it can never satisfy the CLOSED-prior-art
 * rule and its HIGH stands.
 */
export function downgradeSelfDuplicate(
  verdict: DuplicateRisk,
  args: { sourceIssue?: number; known?: Map<number, KnownIssue>; fullText?: string },
): DuplicateRisk {
  if (verdict.downgradedFrom !== undefined) return verdict;
  if (verdict.level.toLowerCase() !== "high") return verdict;
  const source = args.sourceIssue;
  if (source === undefined) return verdict;
  const text = args.fullText ?? verdict.rationale;
  const named = namedIssueRefs(text);
  // A HIGH that names NO issue cannot be attributed to the subject, so it is
  // not the defect this filter exists for and it halts as any other HIGH does.
  if (named.length === 0) return verdict;
  const known = args.known ?? new Map<number, KnownIssue>();
  // Rules 3 and 5, judged first, on the untouched text: a CLOSED issue whose own
  // clause carries no unnegated prior-art word, and an `X-k` token that is not
  // this plan's decomposition, are evidence the child meant as a real duplicate —
  // no later reasoning about the subject may talk the operator out of that halt.
  for (const ref of named) {
    if (ref.parent !== undefined) {
      if (!isSplitChildOf(ref.parent, source)) return verdict;
      continue;
    }
    if (ref.id === source) continue;
    const row = known.get(ref.id);
    if (row === undefined || !isClosedState(row.state)) continue;
    if (!priorArtForAllMentions(everyClauseNaming(text, ref.token))) return verdict;
  }
  const excluded: ExcludedDuplicate[] = [];
  // The tokens this filter positively resolved as excluded; their digits come
  // out of the text before rule 4 looks for what is left.
  const resolved: string[] = [];
  for (const ref of named) {
    // A split-child token: #<parent>-<k> of the planned issue is its own
    // decomposition, never a duplicate of it.
    if (ref.parent !== undefined) {
      // Checked against the source in the pass above; an unrelated parent never
      // gets here.
      if (!isSplitChildOf(ref.parent, source)) return verdict;
      resolved.push(ref.token);
      excluded.push({
        number: ref.parent,
        state: known.get(ref.parent)?.state ?? "unknown",
        title: clip(known.get(ref.parent)?.title ?? "", EXCLUSION_TITLE_MAX_CHARS),
        reason: EXCLUSION_REASONS["split-child"],
      });
      continue;
    }
    const n = ref.id;
    const row = known.get(n);
    if (n === source) {
      resolved.push(ref.token);
      excluded.push(excludedRow(n, row, EXCLUSION_REASONS.source));
      continue;
    }
    if (row !== undefined && isClosedState(row.state)) {
      // Judged by rule 5 above, so SOME clause naming it carries the prior-art
      // word and none negates it. The disclosure quotes the FIRST affirming
      // clause — the one that satisfied the rule — not merely the first mention.
      const affirming =
        everyClauseNaming(text, ref.token).find((c) => priorArtClause(c)) ??
        clauseNaming(text, ref.token);
      const clause = clip(affirming, EXCLUSION_CLAUSE_MAX_CHARS);
      resolved.push(ref.token);
      excluded.push(
        excludedRow(
          n,
          row,
          `${EXCLUSION_REASONS["prior-art"]} — "${clause}" (${PRIOR_ART_EVIDENCE})`,
        ),
      );
      continue;
    }
    // A named issue the filter may not suppress: no inventory row means no
    // known state, so the CLOSED-prior-art rule cannot apply to it (rule 2).
    return verdict;
  }
  // Rule 4, after every token has been judged: a number this filter has not
  // accounted for is evidence it never saw, so the HIGH stands exactly as an
  // OPEN one would rather than ride along unexamined in a downgrade that never
  // read it.
  if (citesUnaccountedNumber(text, resolved)) return verdict;
  return {
    ...verdict,
    level: "medium",
    downgradedFrom: "high",
    downgradeReason: `every issue the duplicate-risk check named was the plan's own subject or closed prior art (${excluded
      .map((e) => `#${e.number}: ${e.reason}`)
      .join("; ")})`,
    excludedIssues: excluded,
  };
}

function excludedRow(
  number: number,
  row: KnownIssue | undefined,
  reason: string,
): ExcludedDuplicate {
  return {
    number,
    state: row?.state ?? "unknown",
    title: clip(row?.title ?? "", EXCLUSION_TITLE_MAX_CHARS),
    reason: clip(reason, EXCLUSION_REASON_MAX_CHARS),
  };
}

/**
 * The row's own clip: cut to width, no ellipsis — a row's slots are bounded
 * rather than decorated, and the prior-art reason ends in a closing bracket
 * whose mate the quoted clause opened, which an ellipsis would drop.
 */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
