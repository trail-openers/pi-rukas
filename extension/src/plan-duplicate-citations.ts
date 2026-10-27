/**
 * plan-duplicate-citations — reading the `#N` citations out of a duplicate-risk
 * rationale (#1856).
 *
 * The sibling half of plan-duplicate-self.ts: that module decides which named
 * issues a HIGH may be downgraded for, this one answers the two mechanical
 * questions its rules ask of the child's text — WHICH issues does this reply
 * cite, and WHICH of its numbers does the filter account for. Both are pure text
 * functions over one rationale, with no knowledge of verdicts, inventories or
 * issue state, so they move as a unit.
 *
 * Two invariants the rules upstream depend on, and the reason these matchers are
 * anchored rather than loose:
 *
 *   - a mention is `#+token` with a `(?![\d-])` guard, so `#7` never reads as a
 *     mention inside `#71` or `#7-2` — one issue's clause is never another's;
 *   - rule 4 strips the WHOLE citation, leading `#` run and all, and only then
 *     asks whether any digit survives. Anything it cannot place is left in
 *     place, which is what makes the rule fail closed.
 */

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
 * Clause boundaries for rule 5: sentence terminators, a semicolon, a comma and a
 * colon, plus a newline. Narrower than a sentence on purpose — the common
 * rationale is one long dash-separated line, so at sentence scope a word about
 * `#1856` leaks into `#103`'s judgement.
 */
const CLAUSE_BOUNDARY = /[.!?,;:\n]/;

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
 * Did the child honour this CLOSED issue as landed work in the clause naming it?
 * A clause with an unnegated prior-art word is the child deferring to a landed
 * decision (rule 2 satisfied); anything else — no word at all, or only a negated
 * one — is the child calling the closed issue a real duplicate, and the HIGH
 * stands.
 */
export function priorArtClause(clause: string): boolean {
  return PRIOR_ART_RE.test(clause) && !PRIOR_ART_NEGATED_RE.test(clause);
}

/**
 * Rule 5 over EVERY mention of one issue (round 3): an issue is honoured as
 * landed work only when SOME clause naming it affirms prior art AND no clause
 * naming it negates it. Judging the first mention alone let the field shape
 * "#103 is prior art for this. #103 is not landed, it is unlanded duplicate
 * work" exclude a CLOSED issue the child had just called a real duplicate.
 */
export function priorArtForAllMentions(clauses: string[]): boolean {
  if (clauses.length === 0) return false;
  let affirmed = false;
  for (const clause of clauses) {
    if (PRIOR_ART_NEGATED_RE.test(clause)) return false;
    if (PRIOR_ART_RE.test(clause)) affirmed = true;
  }
  return affirmed;
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
  return /\d/.test(citesUnaccountedNumberStripped(text, resolvedTokens));
}

/**
 * Rule 4's strip, exposed for the test that has to SEE what the citation removal
 * left behind: a predicate returning a boolean cannot show that `##1856` lost its
 * stray `#` rather than merely losing its digits.
 */
export function citesUnaccountedNumberStripped(text: string, resolvedTokens: string[]): string {
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
