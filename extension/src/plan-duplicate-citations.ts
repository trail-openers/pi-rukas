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
 * What is NOT here, and why: the clause/negation prose matching the CLOSED
 * prior-art exclusion used to run on. Four review rounds of #1856 each found a
 * new phrasing that slipped past it (comma clauses, a denial in the next
 * sentence, "reverses nothing", `#00103` padding, `UN-LANDED` and other
 * hyphenated or unlisted negators), so round 5 deleted the rule and with it
 * every clause-boundary and negator matcher in this module. Prose about a CLOSED
 * issue now decides nothing.
 *
 * Two invariants the rules upstream depend on, and the reason these matchers are
 * anchored rather than loose:
 *
 *   - a mention is `#+token` with a `(?![\d-])` guard, so `#7` never reads as a
 *     mention inside `#71` or `#7-2` — one issue's token is never another's;
 *   - rule 4 strips the WHOLE citation, leading `#` run and all, and only then
 *     asks whether any digit survives. Anything it cannot place is left in
 *     place, which is what makes the rule fail closed.
 */

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
  // number of leading zeros, and it is applied to EVERY numeric segment rather
  // than just the first: tokens are canonical (#1856 round 4), so a split-child
  // token resolved as `1856-2` was read out of some spelling of `#1856-2`, and
  // `#01856-02` is the SAME issue with both segments padded. A padding rule that
  // covered only the parent left the padded child segment in place as a digit run
  // of its own, which kept a HIGH this filter had already resolved (the fail-open
  // direction of a strip that under-matches is the safe one for the driver, but it
  // is still wrong: the filter positively identified the reference). `segmentRe`
  // splits the canonical token on `-` and puts `0*` before each part, so a
  // resolved `1856-2` becomes `#+0*1856-0*2`.
  // It is fail-open only in the one direction a zero prefix can be read — a
  // leading zero is not a digit of the id — and the `(?![\d-])` anchor keeps the
  // strip from ever reaching into a longer digit run: `#012` is not a spelling of
  // a resolved `#1`, and `#1856-027` is not a spelling of `#1856-2`.
  for (const token of [...resolvedTokens].sort((a, b) => b.length - a.length)) {
    rest = rest.split(new RegExp(`#+${segmentRe(token)}(?![\\d-])`, "g")).join(" ");
  }
  for (const re of SAFE_NUMBER_RES) rest = rest.replace(re, " ");
  return rest;
}

/**
 * A canonical token (`1856`, `1856-2`) as a pattern that admits leading zeros on
 * EACH numeric segment. `escapeForRegExp` already restricts a token to
 * `[0-9-]`, so splitting on `-` can only yield digit runs, and the empty string a
 * malformed token would produce at the edges simply contributes no `0*`.
 */
function segmentRe(token: string): string {
  return escapeForRegExp(token)
    .split("-")
    .map((part) => `0*${part}`)
    .join("-");
}

/** Tokens are `[0-9-]+` by construction; this keeps the RegExp constructor honest. */
function escapeForRegExp(s: string): string {
  return s.replace(/[^0-9-]/g, "");
}
