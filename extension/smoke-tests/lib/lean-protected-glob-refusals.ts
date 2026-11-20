/**
 * The refusal half of `test-lean-protected-globs.ts`'s timing contract — the shapes the
 * `lean.protectedPaths` loader must REFUSE rather than admit, and the advice its refusal has to
 * carry. It is the sibling of `lib/lean-protected-glob-shapes.ts`, which holds the shapes the loader
 * ADMITS and what they cost: that file measures what the ceilings let through, this one proves the
 * ceilings (and the positional rule beside them) actually close.
 *
 * The refused rows fall into three groups, and each is a different kind of bound:
 *
 *   - **DEPTH** — one `**` segment past the ceiling, spelled with the cheapest segments that still
 *     backtrack. A length bound cannot catch it: the entries are nineteen characters.
 *   - **LENGTH** — one wildcard past the TOTAL ceiling. Cost rises with the length of a path that
 *     never matches, so these are timed with the load-time check bypassed and the regex compiled
 *     from the entry directly (the same source `compiled()` builds): on the legal 4,095-character
 *     dense path they cost 769 ms to 6.3 s, where the admitted four-wildcard shapes cost 12–26 ms.
 *   - **POSITION** — the bound no count expresses. Every entry here sits AT or BELOW all four
 *     ceilings and still costs seconds, because the wildcard is written BESIDE a doublestar segment
 *     with only literals between: that doublestar absorbs any number of segments, so the wildcard is
 *     retried at every offset it absorbs and pays for the whole length of the path on top of its
 *     depth. Two spellings pay — a wildcard BEFORE the first doublestar, and one wedged BETWEEN two
 *     of them — and the loader refuses both via `wildcardBesideDoublestar` in `protected-globs.ts`,
 *     which names the segment.
 */
import { protectedPathProblem } from "../../src/lean/protected-globs.ts";

/** Shapes the loader must REFUSE rather than admit. The first group is one `**` segment over the
 *  DEPTH ceiling with the cheapest spelling that still backtracks: single-character segments between
 *  the doublestars and a tail the path can never satisfy. This is the entry the segment ceiling
 *  exists for — one that normalisation cannot collapse, and that a length bound cannot catch at 19
 *  characters.
 *
 *  The second group is one wildcard over the TOTAL ceiling, and the reason that ceiling is four. The
 *  DEPTH rows cost 60 ms to 597 ms on the column of one-character segments; the LENGTH rows cost
 *  769 ms to 6.3 s on the legal 4,095-character dense path. With only the segment ceiling and the
 *  two OS limits in place the loader admits all of them, says nothing, and the matcher pays. The
 *  first two of the LENGTH group are the rows that were deliberately red at the previous commit. The
 *  row before last is over BOTH ceilings at once and is cheap (1.1 ms) precisely because the depth
 *  ceiling is what makes that shape affordable; it is an entry past the total count all the same,
 *  and the total-wildcard refusal is what the loader returns.
 *
 *  The third group is POSITION rather than count: each entry carries FOUR or fewer wildcards, TWO or
 *  fewer doublestar segments and nineteen characters — inside every count — and each costs seconds on
 *  the path the filesystem can actually hold. Four of them put the wildcard BEFORE the first doublestar;
 *  the fourth of those spells its doublestar run as two adjacent doublestars deliberately, so
 *  normalisation collapses them to one segment and the entry reaches the position check clear of the
 *  depth ceiling — which is why only position catches it. The last four are the MIRROR: the wildcard
 *  sits BETWEEN the two doublestars, where the entry's first segment is itself the doublestar and a
 *  rule that only looks forward from it sees nothing. The refusal names the segment either way.
 */
export const SLOW_REFUSED: Array<[string, string]> = [
  ["3 doublestars with one-character segments", "?/**/?/**/?/**/?x"],
  ["4 doublestars with one-character segments", "?/**/?/**/?/**/?/**/?x"],
  // The same three-doublestar shape behind a wildcard-heavy tail — over 300 ms on the deep path
  // with a length bound that reads 21 characters, so the refusal is the only defence.
  ["3 doublestars ahead of an anchored tail", "**/*/**/*/**/*q*r?s*t"],
  // The two rows that were red at the previous commit: admitted then, 813 ms and 1,055 ms on the
  // legal dense path. Both are over the total-wildcard ceiling now and the refusal names it.
  ["6 wildcards on a leading doublestar", "**/*/**/*q*r?s*t"],
  ["5 wildcards on a leading doublestar, shorter tail", "**/*/**/*q*r"],
  // One wildcard over the total ceiling on every shape that pays for it: the mid-pattern spelling
  // (6.4 s), the same with a wider tail (6.3 s), the widened-segment spelling (5.3 s), and the
  // leading-doublestar spelling whose one-character tail the dense path can never satisfy (778 ms).
  ["5 wildcards mid-pattern with a wide tail", "*q*/**/*q*r"],
  ["6 wildcards mid-pattern with a wide tail", "*q*/**/*q*r?s"],
  ["5 wildcards on a widened leading segment", "*q**/**/*q*r"],
  // Five wildcards across three doublestars, over BOTH ceilings at once. It is cheap (1.1 ms) —
  // the depth ceiling is what makes that shape affordable — but it is an entry over the total
  // ceiling all the same, and the total-wildcard refusal is what the loader returns for it.
  ["5 wildcards across 3 doublestars", "?/**/?/**/?x"],
  // One more wildcard past the ceiling on the leading-doublestar spelling, the wildcard tail
  // widened so it can never be satisfied: 815 ms unguarded on the dense path, the most expensive
  // one-wildcard-over-ceiling shape in this set that is not already listed above.
  ["5 wildcards on a leading doublestar ahead of an unsatisfiable tail", "**/*/**/*q*x"],
  // The positional group: each entry carries FOUR or fewer wildcards, TWO or fewer doublestar
  // segments and nineteen characters — inside every count — and each costs seconds (or, for the
  // last, 88 ms) on the path the filesystem can actually hold. The last row spells its doublestar
  // run as two adjacent doublestars deliberately: normalisation collapses them to one segment, so
  // the entry reaches the position check with only one doublestar, clear of the depth ceiling —
  // which is why only position catches it. The refusal names the segment.
  ["A bare wildcard ahead of two doublestars", "*/**/*/**/qq"],
  ["A prefixed wildcard ahead of two doublestars", "q*/**/*/**/qq"],
  ["A wildcard-and-literal ahead of two doublestars", "*q/**/*/**/qq"],
  ["A 2-wildcard segment ahead of a collapsed doublestar run and a literal tail", "*q*/**/**/qq"],
  // The mirror family, which the positional rule used to read only one way round: the wildcard sits
  // BETWEEN the two doublestar segments rather than in front of both, so the entry's FIRST segment
  // is the doublestar and the ahead-of check saw nothing to object to. Same four wildcards, same two
  // doublestars, same nineteen characters — and 800 ms to 2.7 s on the legal dense path, because the
  // wildcard between two `(?:[^/]*[/])*` runs carries a length term for each of them and the tail
  // literal (two `q`s) is one the dense path never satisfies at any offset. These are the rows that
  // falsified the module's measured claim that four wildcards bounded the worst admitted entry at
  // 26 ms, and the ones a project reaches by writing a wildcard mid-pattern with a literal tail.
  ["A 2-wildcard segment between two doublestars and a literal tail", "**/*q*/**/qq"],
  ["A widened segment between two doublestars and a 3-literal tail", "**/*q*/**/qqq"],
  ["A wildcard-with-literal between two doublestars and a literal tail", "**/*q/**/qq"],
  ["A prefixed wildcard between two doublestars and a literal tail", "**/q*/**/qq"],
];

/** Refusals whose MESSAGE has to carry the fix, not just the complaint. The doublestar-ceiling
 *  refusal is the one an author hits by putting a leading doublestar and a slash in front of an
 *  already-anchored path, and dropping that prefix is the edit that keeps the rule's own literals
 *  while taking one doublestar off the matcher. The row below is over the ceiling and starts with
 *  that prefix; the suggestion is the entry without it. (The prefix cannot be spelled literally in
 *  this comment: a comment is not a string, and those two characters end the block.)
 *
 *  The positional refusal has to name the SEGMENT it objected to, not just complain: the entry reads
 *  as an ordinary rule and its wildcards are all within the counts, so an author handed a bare
 *  refusal has nothing to point at. */
export const REFUSAL_TEXT: Array<[string, string, string]> = [
  [
    "leading doublestar ceiling refusal suggests dropping it",
    "**/src/**/test/**",
    "src/**/test/**",
  ],
  [
    "wildcard-beside-doublestar refusal names the offending segment",
    "q*/**/*/**/qq",
    "in the segment `q*`",
  ],
  [
    "the mirror refusal names the segment BETWEEN the doublestars",
    "**/*q*/**/qq",
    "in the segment `*q*`",
  ],
];

/** Runs the two refusal halves. Returns the failure count so the calling test folds it into its own
 *  total and prints one verdict for the whole matcher contract. */
export function runRefusalCases(): number {
  let failures = 0;
  for (const [name, pattern] of SLOW_REFUSED) {
    // The ceiling's other half, and the one an accepted-shape timer cannot see: a shape whose
    // cost grows with the DEPTH, or with the LENGTH, of a path that never matches is refused at
    // LOAD. With no ceiling low enough, the loader admits it, says nothing, and this row is red.
    // The positional refusal is the third kind: it names no count at all, so it is matched on the
    // segment it quotes rather than on the ceiling wording.
    const refusal = protectedPathProblem(pattern);
    if (refusal === undefined) {
      failures++;
      console.error(`FAIL  ${name}: ${JSON.stringify(pattern)} was admitted by the loader`);
    } else if (
      !refusal.includes("this matcher will backtrack over") &&
      !refusal.includes("in the segment")
    ) {
      // A refusal that does not name a ceiling or a segment is a refusal for some other reason, and
      // the row would go green without the bound it exists to prove.
      failures++;
      console.error(
        `FAIL  ${name}: ${JSON.stringify(pattern)} refused for an unrelated reason (${refusal})`,
      );
    } else {
      console.log(`ok  ${name} refused at load (${refusal})`);
    }
  }
  for (const [name, pattern, want] of REFUSAL_TEXT) {
    // A refusal is only useful if it tells the author which spelling works. These rows check the
    // advice carried in the message, not merely that a message exists.
    const refusal = protectedPathProblem(pattern);
    if (refusal === undefined || !refusal.includes(want)) {
      failures++;
      console.error(
        `FAIL  ${name}: ${JSON.stringify(pattern)} refused with ${JSON.stringify(refusal)}, which does not suggest ${JSON.stringify(want)}`,
      );
    } else {
      console.log(`ok  ${name} refusal suggests \`${want}\``);
    }
  }
  return failures;
}

/** How many rows {@link runRefusalCases} owns, so the caller's denominator is honest. */
export const REFUSAL_CASE_COUNT: number = SLOW_REFUSED.length + REFUSAL_TEXT.length;
