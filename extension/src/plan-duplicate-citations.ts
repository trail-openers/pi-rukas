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
 *
 * Negation is NOT matched here. Round 4 removed the word-window negation that
 * used to sit beside this: "is not prior art", "no … prior art" and "it is not
 * landed" are the same claim in three spacings, and a window can only ever
 * enumerate spellings. Negation is decided reply-wide by {@link replyNegates}
 * and it takes precedence over every affirmation.
 */
const PRIOR_ART_RE =
  /\b(prior art|reversal|revers(?:e|es|ed|ing)|supersed\w*|overturn\w*|landed|deliberate(?:ly)?\s+chang\w*)\b/i;

/**
 * Rule 5's negator tokens (#1856 review round 4), matched case-insensitively as
 * WHOLE WORDS anywhere in the child's reply: `not`, `never`, `no`, `nothing`,
 * `none`, `without`, `unlanded`, the listed contractions, and any `n't`
 * contraction. `unlanded` is spelled out because the `\b`-anchored list would
 * not catch it as a `no`-style word and it is the exact word the field case's
 * rationales use for "this closed issue is a duplicate that never shipped".
 */
const NEGATOR_RE =
  /\b(?:not|never|no|nothing|none|without|unlanded|isn'?t|wasn'?t|weren'?t|doesn'?t|don'?t|didn'?t|hasn'?t|haven'?t|aren'?t|can'?t|cannot|couldn'?t|shouldn'?t|wouldn'?t|won'?t)\b/i;

/**
 * Does the reply negate anything, anywhere? Rule 5's reply-wide half: one
 * negator token anywhere means NO CLOSED issue is excluded as prior art, so the
 * HIGH stands. Judged over the whole reply rather than the clause naming an
 * issue because the child's denial of prior art and its affirmation of it are
 * routinely two different sentences about the same issue ("#103 is prior art.
 * It is not landed."), and a clause-scoped negation reads the second sentence as
 * somebody else's business.
 */
export function replyNegates(text: string): boolean {
  return NEGATOR_RE.test(text);
}

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
  /**
   * The issue this mention names, in CANONICAL form: `String(id)`, or
   * `String(parent) + "-" + String(child)` for a split-child token.
   *
   * Canonical, and not the bytes as written, because this string is used two
   * ways: as the dedupe key, and as the citation rule 4 strips out of the text.
   * Both must be spelling-independent (#1856 review round 4, MEDIUM/security) —
   * a zero-padded `#01856` is the same issue as `#1856`, and a ref whose token
   * carried the leading zeros would dedupe as two issues AND leave the padded
   * spelling in the text for rule 4 to find as an unaccounted number.
   */
  token: string;
  /** Set when the token is a split-child id (`N-k`). */
  parent?: number;
  child?: number;
}

/**
 * Every `#N` (or `#N-k`) token a rationale names, in order, deduped by the issue
 * it names. A leading-zero spelling (`#01856`) names the issue `1856` and is the
 * same ref as `#1856`, so it neither dedupes as a second issue nor reaches rule 4
 * as a number of its own.
 */
export function namedIssueRefs(text: string): NamedIssueRef[] {
  const out: NamedIssueRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/#(\d+(?:-\d+)?)/g)) {
    const written = m[1] ?? "";
    if (written.includes("-")) {
      const [parent, child] = written.split("-").map((x) => Number(x));
      if (
        Number.isSafeInteger(parent) &&
        child !== undefined &&
        Number.isSafeInteger(child) &&
        child >= 1
      ) {
        // Canonical, so `#0103-2` and `#103-2` are one ref: the same parent and
        // the same child, whatever zeros either side was written with.
        const token = `${String(parent)}-${String(child)}`;
        if (!seen.has(token)) {
          seen.add(token);
          out.push({ id: Number.NaN, token, parent, child });
        }
      }
      continue;
    }
    const id = Number(written);
    if (Number.isSafeInteger(id) && id > 0) {
      const token = String(id);
      if (seen.has(token)) continue;
      seen.add(token);
      out.push({ id, token });
    }
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
 * An affirming clause is the child deferring to a landed decision; anything else
 * — no prior-art word at all — is the child calling the closed issue a real
 * duplicate. Negation is NOT judged here: {@link replyNegates} decides that over
 * the whole reply, and it outranks every affirmation.
 */
export function priorArtClause(clause: string): boolean {
  return PRIOR_ART_RE.test(clause);
}

/**
 * Rule 5 over EVERY mention of one issue: an issue is honoured as landed work
 * only when EVERY clause naming it carries an affirming prior-art word. Judging
 * the first mention alone let the field shape "#103 is prior art for this. #103
 * is not landed, it is unlanded duplicate work" exclude a CLOSED issue the child
 * had just called a real duplicate. Round 4 adds the reply-wide half of the rule
 * at the call site: no mention counts when {@link replyNegates} fires.
 */
export function priorArtForAllMentions(clauses: string[]): boolean {
  if (clauses.length === 0) return false;
  return clauses.every((clause) => PRIOR_ART_RE.test(clause));
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
  // what makes the strip match the mention the extractor read. `0*` strips any
  // number of leading zeros: tokens are canonical (#1856 round 4), so a padded
  // spelling `#001856` of a token this filter resolved names the SAME issue and
  // must not survive as a digit run of its own. It is fail-open only in the one
  // direction a zero prefix can be read — a leading zero is not a digit of the
  // id — and the `(?![\d-])` anchor keeps the strip from ever reaching into a
  // longer digit run: `#012` is not a spelling of a resolved `#1`.
  for (const token of [...resolvedTokens].sort((a, b) => b.length - a.length)) {
    rest = rest.split(new RegExp(`#+0*${escapeForRegExp(token)}(?![\\d-])`, "g")).join(" ");
  }
  for (const re of SAFE_NUMBER_RES) rest = rest.replace(re, " ");
  return rest;
}

/** Tokens are `[0-9-]+` by construction; this keeps the RegExp constructor honest. */
function escapeForRegExp(s: string): string {
  return s.replace(/[^0-9-]/g, "");
}
