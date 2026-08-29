#!/usr/bin/env bun
/**
 * #507 — clipTitle: word-boundary truncation with a single U+2026 ellipsis.
 *
 * The mechanized commit-pr path derives the PR title from the issue title
 * and previously applied a bare `.slice(0, 72)` — a mid-word cut with no
 * ellipsis ("...per-row cosine loop in Dat"). The same string feeds both
 * `git commit -m` and `gh pr create --title`, and under squash-merge the PR
 * title becomes the commit subject on main, so the mid-word cut reached
 * CHANGELOG.md and release notes by two independent routes.
 *
 * Offline pure-function test, same shape as test-vipune-argv.ts: pinned
 * literals, no harness.
 */

import { clipTitle } from "../src/work-driver-commit.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: string, expected: string, msg: string) {
  assert(
    actual === expected,
    `${msg} — got ${JSON.stringify(actual)}${actual === expected ? "" : `, expected ${JSON.stringify(expected)}`}`,
  );
}

// ---- pass-through: at or under budget, byte-identical

eq(clipTitle("a".repeat(64), 64), "a".repeat(64), "exactly-budget passes through unchanged");
eq(clipTitle("a short title", 64), "a short title", "short title passes through unchanged");
eq(clipTitle("", 64), "", "empty passes through unchanged");

// ---- over-budget with a word boundary

// Pinned literal from the issue: 64 a's + " word" (69 code units; the only
// whitespace is at index 64, which is AFTER cut=63) → degenerate path,
// cut at 63 + ellipsis.
eq(
  clipTitle(`${"a".repeat(64)} word`, 64),
  `${"a".repeat(63)}…`,
  "pinned literal: 64 a's + ' word' → no boundary at or before cut → 63 a's + ellipsis",
);
// The symmetric case where the space IS the cut: 63 a's + " word" (68 units).
// cut=63 lands ON the space → boundary found, prefix 63 a's, ellipsis.
eq(
  clipTitle(`${"a".repeat(63)} word`, 64),
  `${"a".repeat(63)}…`,
  "63 a's + ' word' → the space at index 63 is the boundary → 63 a's + ellipsis",
);

const title =
  "fix: the mechanized PR title is clipped mid-word at seventy-two chars and ships as the commit subject";
assert(title.length > 64, "fixture sanity: the long title really is over budget");
const clipped = clipTitle(title, 64);
eq(clipped.length, 64, "result is exactly the budget long (word boundary + ellipsis)");
assert(clipped.endsWith("\u2026"), "ends with the single U+2026 ellipsis code unit");
assert(!clipped.endsWith("..."), "the ellipsis is NOT three dots");
assert(
  clipped.endsWith("\u2026") && /\s/.test(title[63]),
  "boundary found at index 63: source char at the cut point is whitespace",
);
assert(clipped.slice(-1) === "\u2026", "last code unit is the ellipsis");
assert(!clipped.includes("commit subject"), "the tail beyond the boundary is absent");

// budget+1: one over the pass-through line
eq(
  clipTitle(`${"b".repeat(64)}w`, 64),
  `${"b".repeat(63)}…`,
  "65-char single token: degenerate mid-word cut at 63 + ellipsis",
);
eq(
  clipTitle(`${"c".repeat(63)} ${"d".repeat(20)}`, 64),
  `${"c".repeat(63)}…`,
  "budget+1 with a boundary: last space at index 63, prefix 63 c's, ellipsis",
);

// trailing whitespace before the cut
eq(
  clipTitle(`word ${"x".repeat(70)}  `, 64),
  "word…",
  "trailing whitespace before the cut is trimmed (boundary at the space, prefix non-empty)",
);

// ---- degenerate: single unbreakable token over the budget

eq(
  clipTitle("z".repeat(100), 64),
  `${"z".repeat(63)}…`,
  "unbreakable 100-char token: cut at 63 + ellipsis (the only case allowed to cut a word)",
);
eq(
  clipTitle("q".repeat(65), 64),
  `${"q".repeat(63)}…`,
  "unbreakable 65-char token: same rule, budget-1 cut",
);

// whitespace at the very end of the token, right at the boundary, must not
// yield an empty-after-trimEnd prefix
// Leading spaces: the scan finds the boundary at the last space (index 5) but
// the prefix trims to empty → rejected → degenerate cut at 63.
// 5 spaces + 70 a's = 75 > 64, so cut = 63 → 5 spaces + 58 a's + ellipsis.
eq(
  clipTitle(" ".repeat(5) + "a".repeat(70), 64),
  `${" ".repeat(5) + "a".repeat(58)}…`,
  "leading spaces: the only boundary trims empty → degenerate cut of the a-run",
);

// ---- surrogate pairs

// A lone emoji (one surrogate pair) with the cut INSIDE the pair: 62 e's +
// emoji + x = 62 + 2 + 1 = 65 > 64. No whitespace at all → degenerate path,
// and rule 4 must back off the cut so the pair is not split (a high half at
// cut-1 would dangle in the prefix).
const surrogateAtCut = `${"e".repeat(62)}\u{1F600}x`;
const surrogateResult = clipTitle(surrogateAtCut, 64);
// 62 e's + pair + x = 65. cut=63 falls inside the pair → backs off to 62 →
// 62 e's + ellipsis.
assert(
  surrogateResult.length === 63 && surrogateResult.endsWith("\u2026"),
  `surrogate-at-cut: 62 e's + ellipsis (budget-1 after the pair backoff), got ${JSON.stringify(surrogateResult)}`,
);
assert(
  surrogateResult.charCodeAt(surrogateResult.length - 2) !== 0xdead &&
    !(
      surrogateResult.charCodeAt(surrogateResult.length - 2) >= 0xd800 &&
      surrogateResult.charCodeAt(surrogateResult.length - 2) <= 0xdbff
    ),
  "surrogate-at-cut: no lone high surrogate at the end (rule 8)",
);
assert(surrogateResult.endsWith("\u2026"), "surrogate-at-cut: ends with ellipsis");

// The straddling case the shipped rule-4 check could NOT catch: high half at
// cut-1, low half at cut. 62 a's + pair + "x" has the pair at 62,63 and
// cut=63 — the check reads index 62, the HIGH half, and does not back off,
// so slice(0,63) leaves the high surrogate dangling. Rule 4 now checks the
// CUT position (low half) and backs off: 62 a's + ellipsis.
const straddling = `${"a".repeat(62)}\u{1F600}x`;
const straddlingResult = clipTitle(straddling, 64);
eq(
  straddlingResult,
  `${"a".repeat(62)}…`,
  "straddling pair: high at cut-1 + low at cut → back off, pair dropped whole",
);

// Surrogate pair with a word boundary BEFORE it (so rule 5 fires, not rule 6):
// "word " (5) + 55 a's + emoji pair = 5 + 55 + 2 = 62 <= 64? No: pad to exceed.
// "word " + 57 a's + emoji = 5 + 57 + 2 = 64 → passes through.
// "word " + 58 a's + emoji = 65 > 64 → cut=63, pair is at 62,63 → backs off to 62,
// last whitespace is index 4, prefix "word" → "word…".
eq(
  clipTitle(`word ${"a".repeat(58)}\u{1F600}`, 64),
  "word…",
  "surrogate pair inside the word: word boundary before it wins, ellipsis after 'word'",
);

// A pair that survives WHOLLY inside the prefix must be preserved intact.
// "ab" + emoji + 60 a's + " tail" → 2+2+60+5 = 69 > 64; cut=63; pair at 2,3
// is inside the prefix; last whitespace at 62 (the space before "tail");
// prefix = first 62 chars = "ab" + emoji + 58 a's, no trailing space.
const pairInPrefix = `ab\u{1F600}${"a".repeat(60)} tail`;
const pairInPrefixResult = clipTitle(pairInPrefix, 64);
assert(
  pairInPrefixResult.includes("\u{1F600}"),
  "pair-in-prefix: the emoji survives intact inside the clipped title",
);
assert(pairInPrefixResult.endsWith("\u2026"), "pair-in-prefix: ends with ellipsis");
assert(pairInPrefixResult.length === 64, "pair-in-prefix: budget-long");

// the degenerate path with the pair right at the cut, spelled per the issue's
// fixture shape: <58 ASCII><emoji pair><more non-whitespace>, no whitespace
// after the pair, so rule 5 finds no boundary.
// 58 + 2 + 10 = 70 > 64. cut=63: charAt(62) is the high surrogate of the pair
// (58..59 are the pair), so cut backs off to 59 → "58 a's + pair-less tail"?
// The pair is at indices 58,59. cut=63 falls INSIDE... let's just assert the
// invariants rather than derive: budget-long, ends with ellipsis, no lone
// high surrogate at the end.
const fixture = `${"a".repeat(58)}\u{1F600}${"b".repeat(10)}`;
assert(fixture.length === 70, "surrogate fixture sanity: 58 + 2 + 10 = 70");
const degeneratePair = clipTitle(fixture, 64);
assert(degeneratePair.length === 64, "surrogate degenerate: budget-long");
assert(degeneratePair.endsWith("\u2026"), "surrogate degenerate: ends with ellipsis");
const secondLast = degeneratePair.charCodeAt(degeneratePair.length - 2);
assert(
  !(secondLast >= 0xd800 && secondLast <= 0xdbff),
  "surrogate degenerate: no lone high surrogate at the end (rule 4/6 backoff)",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
