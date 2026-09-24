#!/usr/bin/env bun
/**
 * agents-md-diff — the #840 fix for the corrupt unified diff.
 *
 * The old renderer in agents-md-tool.ts had two defects:
 *   1. Empty oldText split to [""], which LCS-matched the first blank line
 *      of the new text, producing a phantom context op.
 *   2. The hunk loop rendered each change run at start-1..end+1 then resumed
 *      at end+1, so the boundary context line was re-emitted by the next
 *      hunk's back-walk — overlapping hunks that duplicated lines 2-3x.
 *
 * This test exercises the fixed renderer directly, asserting:
 *   - the split convention (empty → zero lines; trailing newline dropped)
 *   - the acceptance criteria (exact output for the two specified pairs)
 *   - the property that "+"-line count == lines added and "-"-line count ==
 *     lines removed over several generated pairs
 *   - the truncation marker and its remainder count
 *   - edge cases (empty/empty, identical, trailing-newline-only diff)
 */

import { unifiedDiff, toLines, DIFF_MAX_LINES, DIFF_MAX_CELLS } from "../src/agents-md-diff.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function countLines(text: string, prefix: string): number {
  return text
    .split("\n")
    .filter((l) => l.startsWith(prefix)).length;
}

function lcsCount(a: string[], b: string[]): number {
  const n = a.length,
    m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!,
      nx = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--)
      row[j] = a[i] === b[j] ? nx[j + 1]! + 1 : Math.max(nx[j]!, row[j + 1]!);
  }
  return dp[0][0]!;
}

function propCase(name: string, old: string, neu: string) {
  const d = unifiedDiff(old, neu);
  const a = toLines(old),
    b = toLines(neu);
  const lcs = lcsCount(a, b);
  const trueAdd = b.length - lcs;
  const trueDel = a.length - lcs;
  const plus = countLines(d, "+");
  const minus = countLines(d, "-");
  assert(plus === trueAdd, `${name}: + lines ${plus} == added ${trueAdd}`);
  assert(minus === trueDel, `${name}: - lines ${minus} == removed ${trueDel}`);
}

// ---------------------------------------------------------------- toLines

assert(JSON.stringify(toLines("")) === "[]", "toLines: empty string → zero lines");
assert(JSON.stringify(toLines("a\nb\n")) === '["a","b"]', "toLines: trailing newline dropped");
assert(JSON.stringify(toLines("a\nb\nc")) === '["a","b","c"]', "toLines: no trailing newline");
assert(JSON.stringify(toLines("\n")) === '[""]', "toLines: single \\n → one blank line");

// ------------------------------------------------------- acceptance criteria

const d1 = unifiedDiff("", "a\nb\nc");
assert(d1 === "+a\n+b\n+c", `unifiedDiff("", "a\\nb\\nc") yields exactly +a, +b, +c (got ${JSON.stringify(d1)})`);
assert(countLines(d1, "-") === 0, "empty-old: no - lines");
assert(countLines(d1, " ") === 0, "empty-old: no context lines");
assert(countLines(d1, "+") === 3, "empty-old: exactly 3 + lines");

const d2 = unifiedDiff("a\nb\nc\n", "a\nb\nc\nd\n");
assert(countLines(d2, "+") === 1 && d2.includes("+d"), `append: exactly one +d (got ${JSON.stringify(d2)})`);
assert(countLines(d2, "-") === 0, "append: no - lines");

// ------------------------------------------------- property check over pairs

propCase("two separated", "x,1\ny,2\nz,3\nw\nv", "x,1\ny,22\nz,33\nw\nv");
propCase("three separated", "1\nA\n2\nB\n3\nC\n9", "1\nA11\n2\nB22\n3\nC33\n9");
propCase("single leading change", "A\nB\nC", "X\nB\nC");
propCase("single trailing change", "A\nB\nC", "A\nB\nY");
propCase("delete middle", "A\nB\nC\nD", "A\nC\nD");
propCase("delete all", "A\nB\nC", "");
propCase("two runs bridgeable", "A\n1\nB\n2\nC", "A\n11\nB\n22\nC");
propCase("two runs far apart", "A\n1\nB\nC\nD\nE\n2\nF", "A\n11\nB\nC\nD\nE\n22\nF");
propCase("single append at end", "a\nb\nc", "a\nb\nc\nd");

// -------------------------------------------------------------- truncation

// 100 deletions + 102 additions = 202 ops → should truncate at 200 with marker
const truncOld = Array.from({ length: 100 }, (_, i) => `old_${i}`).join("\n");
const truncNew = Array.from({ length: 102 }, (_, i) => `new_${i}`).join("\n");
const trunc = unifiedDiff(truncOld, truncNew);
const truncLines = trunc.split("\n");
const markerIdx = truncLines.findIndex((l) => l.includes("more lines"));
assert(markerIdx !== -1, "truncation: marker present");
if (markerIdx !== -1) {
  const rendered = truncLines.slice(0, markerIdx);
  assert(rendered.length === DIFF_MAX_LINES, `truncation: exactly ${DIFF_MAX_LINES} rendered lines (got ${rendered.length})`);
  assert(markerIdx === DIFF_MAX_LINES, `truncation: marker at position ${DIFF_MAX_LINES} (got ${markerIdx})`);
  assert(countLines(rendered.join("\n"), "+") === 100, `truncation: all 100 adds rendered (got ${countLines(rendered.join("\n"), "+")})`);
  assert(countLines(rendered.join("\n"), "-") === 100, `truncation: all 100 dels rendered (got ${countLines(rendered.join("\n"), "-")})`);
  assert(truncLines[markerIdx] === "… 2 more lines", `truncation: marker says 2 more lines (got ${JSON.stringify(truncLines[markerIdx])})`);
} else {
  assert(false, `truncation: no marker found, got ${truncLines.length} lines`);
}

// ------------------------------------------------- oversized input guard

// 3000 × 3000 = 9,000,000 cells > DIFF_MAX_CELLS: no LCS table is built, so
// this must return an explicit marker almost instantly (a real 9M-cell pass
// would take well over a second).
{
  const bigA = Array.from({ length: 3000 }, (_, i) => `a_${i}`).join("\n");
  const bigB = Array.from({ length: 3000 }, (_, i) => `b_${i}`).join("\n");
  const startedAt = Date.now();
  const big = unifiedDiff(bigA, bigB);
  const elapsed = Date.now() - startedAt;
  assert(big === "… diff too large to render (3000 → 3000 lines)", `oversized: explicit marker line (got ${JSON.stringify(big)})`);
  assert(elapsed < 1000, `oversized: returned in ${elapsed}ms (<1s, no table built)`);
  assert(3000 * 3000 > DIFF_MAX_CELLS, "oversized: test inputs actually exceed the cell budget");
}

// ---------------------------------------------------------------- edge cases

assert(unifiedDiff("", "") === "", "empty/empty → ''");
assert(unifiedDiff("a\nb", "a\nb\n") === "", "trailing-newline-only diff → ''");
assert(unifiedDiff("A\nB\nC", "A\nB\nC") === "", "identical → ''");

{
  const d = unifiedDiff("x,1\ny,2\nz,3", "x,1\ny,22\nz,33");
  const lines = d.split("\n");
  assert(lines.length === new Set(lines).size, "no duplicate rendered lines");
}

console.log(exit === 0 ? "\nAll diff checks passed." : "\nFAILED");
process.exit(exit);
