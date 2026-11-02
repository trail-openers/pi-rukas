/**
 * The second half of the flank fixtures: the cases that pin `NOT_PATH`, the
 * LEFT flank of `mentionsPath`.
 *
 * WHY A FILE OF ITS OWN. `mentionsPath` interpolates TWO classes — `PATH_CHAR`
 * into the right-flank lookahead and `NOT_PATH` on the left — and both are
 * `PathCharClass`-annotated mirrors of the same character set. Until this file,
 * every fixture in the suite mutated only `PATH_CHAR`, so the table that
 * reported "0 reds" for a member had measured one of the two constants and
 * printed its verdict for both. Splitting the fixtures along the flank each one
 * witnesses is what makes a per-member row name the constant it mutated. It is
 * also the only response to the size cap that does not shorten a witness:
 * `test-lens-coverage-denominator.ts` and `test-lens-coverage-routing.ts` were at
 * 498/500 and 499/500, so the fixtures these rows need could not have gone into
 * either without breaching AGENTS.md §12.
 *
 * Each fixture is a PAIR: a spelling the matcher must refuse and a spelling it
 * must still accept, differing in one character's position. A lone `undefined`
 * fixture is satisfied by every mutation of the class — a summary that never
 * matches has no opinion about whether `_` is a path character — so the sibling
 * is what makes the pair a boundary rather than a tautology. `expected` is what
 * the SHIPPED matcher prints for each; the pair is the evidence, not the label.
 *
 * Every `reds` figure in the header of `lens-flank-escape-probe.ts` is a pasted
 * line from the scratch runs described there, and every mutant in that table is
 * the output of `lens-class-mutants.ts`.
 */

/** A digit glued to the left of a path is not a boundary: `NOT_PATH` cannot
 * consume the `0`, so the citation does not open. Expected: NOT accounted.
 * Witness: `NOT_PATH` minus `0-9` — see the table in `lens-flank-escape-probe.ts`. */
export const LEFT_DIGIT_GLUED: [string, string, "summary" | undefined, string] = [
  "x0src/b.ts is fine",
  "src/b.ts",
  undefined,
  "a digit glued to the left of a path is not a citation — `NOT_PATH` cannot consume it, so the left flank never opens",
];

/** The same digit after a space IS a boundary. Expected: accounted. This is the
 * half that keeps `LEFT_DIGIT_GLUED` from being an assertion that merely never
 * matches. */
export const LEFT_DIGIT_SPACED: [string, string, "summary" | undefined, string] = [
  "x0 src/b.ts is fine",
  "src/b.ts",
  "summary",
  "a digit followed by a space is a boundary, so the citation opens — the sibling that makes LEFT_DIGIT_GLUED a boundary test and not a tautology",
];

/** `_` glued left. Witness: `NOT_PATH` minus the `_` member. */
export const LEFT_UNDERSCORE_GLUED: [string, string, "summary" | undefined, string] = [
  "x_src/b.ts is fine",
  "src/b.ts",
  undefined,
  "an underscore glued to the left of a path is not a citation — `_` is a path character, so `NOT_PATH` cannot consume it",
];

export const LEFT_UNDERSCORE_SPACED: [string, string, "summary" | undefined, string] = [
  "x_ src/b.ts is fine",
  "src/b.ts",
  "summary",
  "an underscore followed by a space is a boundary (the sibling of LEFT_UNDERSCORE_GLUED)",
];

/** `/` glued left — the case that carries the recital guards, so it is the
 * highest-value row on this side: `--- a/…`, `+++ b/…` and `+++ "b/…"` are all
 * refused because `/` cannot be consumed by `NOT_PATH`. */
export const LEFT_SLASH_GLUED: [string, string, "summary" | undefined, string] = [
  "x/src/b.ts is fine",
  "src/b.ts",
  undefined,
  "a slash glued to the left of a path is not a citation — the same rule that refuses `--- a/src/a.ts` and `+++ b/src/a.ts`",
];

export const LEFT_SLASH_SPACED: [string, string, "summary" | undefined, string] = [
  "x/ src/b.ts is fine",
  "src/b.ts",
  "summary",
  "a slash followed by a space is a boundary (the sibling of LEFT_SLASH_GLUED)",
];

/** `+` glued left. This is the re-emitted-diff-line case: `"…\n+src/a.ts"` and
 * `"…\n+++src/a.ts"` are refused HERE, at the left flank, and nowhere else. */
export const LEFT_PLUS_GLUED: [string, string, "summary" | undefined, string] = [
  "x+src/b.ts is fine",
  "src/b.ts",
  undefined,
  "a plus glued to the left of a path is not a citation — this is the flank that refuses a re-emitted `+src/a.ts`",
];

export const LEFT_PLUS_SPACED: [string, string, "summary" | undefined, string] = [
  "x+ src/b.ts is fine",
  "src/b.ts",
  "summary",
  "a plus followed by a space is a boundary (the sibling of LEFT_PLUS_GLUED)",
];

/** `-` glued left. */
export const LEFT_HYPHEN_GLUED: [string, string, "summary" | undefined, string] = [
  "x-src/b.ts is fine",
  "src/b.ts",
  undefined,
  "a hyphen glued to the left of a path is not a citation — `-` is a path character, so the left flank cannot open on it",
];

export const LEFT_HYPHEN_SPACED: [string, string, "summary" | undefined, string] = [
  "x- src/b.ts is fine",
  "src/b.ts",
  "summary",
  "a hyphen followed by a space is a boundary (the sibling of LEFT_HYPHEN_GLUED)",
];

/** `.` glued left. The one left-flank member whose refusal the other four do not
 * imply: a leading full stop is how a prose sentence can start, and it is still
 * not a boundary. */
export const LEFT_DOT_GLUED: [string, string, "summary" | undefined, string] = [
  ".src/b.ts is fine",
  "src/b.ts",
  undefined,
  "a full stop glued to the left of a path is not a citation — `.` is a path character, so it is `NOT_PATH`'s own member doing the refusing",
];

export const LEFT_DOT_SPACED: [string, string, "summary" | undefined, string] = [
  ". src/b.ts is fine",
  "src/b.ts",
  "summary",
  "a full stop followed by a space is a boundary (the sibling of LEFT_DOT_GLUED)",
];

/** A path terminated by a DIGIT is a different file, not `src/b.ts` with a `0`
 * on it. `0-9` is a `PATH_CHAR` member, so the lookahead refuses to close.
 * Expected: NOT accounted. */
export const TERM_DIGIT: [string, string, "summary" | undefined, string] = [
  "See src/b.ts0",
  "src/b.ts",
  undefined,
  "a path terminated by a digit is not a citation of the shorter file — `0-9` is a PATH_CHAR, so the lookahead refuses to close",
];

/** A path terminated by `_`. Witness for the `_` member of `PATH_CHAR`, which no
 * earlier fixture covered: `_` is in neither `TERMINATOR` nor any existing
 * terminal-position fixture, so it was the one `PATH_CHAR` member whose row was
 * printed from reasoning rather than a red. */
export const TERM_UNDERSCORE: [string, string, "summary" | undefined, string] = [
  "See src/b.ts_",
  "src/b.ts",
  undefined,
  "a path terminated by an underscore is not a citation of the shorter file — `_` is a PATH_CHAR with no TERMINATOR and no follower to hide behind (witness: the only assertion that reddens when `_` is deleted from PATH_CHAR)",
];

/** A path terminated by an uppercase letter. */
export const TERM_UPPER: [string, string, "summary" | undefined, string] = [
  "See src/b.tsT",
  "src/b.ts",
  undefined,
  "a path terminated by an uppercase letter is not a citation of the shorter file — `A-Z` is a PATH_CHAR, so the lookahead refuses to close",
];

/** A re-emitted `+` header with no separating space, on a SINGLE-file
 * denominator. The multi-file header rows already exist in
 * `test-lens-coverage-denominator.ts`; this is the same bytes with the
 * denominator narrowed to the one file, which is how the `+` deletion is
 * attributed to a left-flank rule rather than to the three-file set. */
export const REEMIT_PLUS_SOLO: [string, string, "summary" | undefined, string] = [
  "notes\n+src/a.ts",
  "src/a.ts",
  undefined,
  "a re-emitted `+` header with no space is not a citation, with the denominator narrowed to the one file (witness: red when `+` is deleted from NOT_PATH)",
];

/** As above for `+++`. */
export const REEMIT_TRIPLE_PLUS_SOLO: [string, string, "summary" | undefined, string] = [
  "notes\n+++src/a.ts",
  "src/a.ts",
  undefined,
  "a re-emitted `+++` header with no space is not a citation, single-file denominator (witness: red when `+` is deleted from NOT_PATH)",
];

/** A path that ends a line on the markdown bullet `-`. `.` has a sentence-closing
 * fixture; `-` had none, which is the "whole-class figure wearing a per-member
 * label" the earlier table carried for `TERMINATOR`. With `-` deleted from
 * `TERMINATOR` the anchored arm cannot close here and the path stops accounting. */
export const TERMINATOR_HYPHEN: [string, string, "summary" | undefined, string] = [
  "Reviewed src/a.ts-",
  "src/a.ts",
  "summary",
  "a path that ends a line on the markdown bullet still accounts — `-` is BOTH a TERMINATOR and a PATH_CHAR, so the lookahead would refuse it and only the anchored terminator arm lets it account (witness: red when `\-` is deleted from TERMINATOR)",
];

export const TEST_LEFT_FLANK_CASES: readonly [string, string, "summary" | undefined, string][] = [
  LEFT_DIGIT_GLUED,
  LEFT_DIGIT_SPACED,
  LEFT_UNDERSCORE_GLUED,
  LEFT_UNDERSCORE_SPACED,
  LEFT_SLASH_GLUED,
  LEFT_SLASH_SPACED,
  LEFT_PLUS_GLUED,
  LEFT_PLUS_SPACED,
  LEFT_HYPHEN_GLUED,
  LEFT_HYPHEN_SPACED,
  LEFT_DOT_GLUED,
  LEFT_DOT_SPACED,
  TERM_DIGIT,
  TERM_UNDERSCORE,
  TERM_UPPER,
  REEMIT_PLUS_SOLO,
  REEMIT_TRIPLE_PLUS_SOLO,
  TERMINATOR_HYPHEN,
];
