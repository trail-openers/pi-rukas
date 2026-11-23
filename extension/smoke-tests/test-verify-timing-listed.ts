#!/usr/bin/env bun
/**
 * Issue #2449 (epic #2424 item 3) / #2465 — the ceiling's allow-list MATCHER, judged
 * on its own. Split from test-verify-timing-ceiling-channels.ts for the AGENTS.md §12
 * 500-line cap, and it is the natural seam: this is the one channel case that never
 * starts the loop. Everything here answers one question about the shipped matcher,
 * through the shipped source, with no fixture, no clock, and no pool.
 *
 * What is pinned (case 12 of the file it came from):
 *
 *   The exemption is the ONE thing that turns an over-bound row green, so the matcher
 *   that grants it has to answer about a KEY FIELD and nothing else. The cached rows
 *   are `secs<TAB>key` with one row per line, so the needle is legal only between a tab
 *   and a newline — flanked by two DIFFERENT delimiters. When the pattern was built from
 *   a single newline variable on both sides, and that variable was filled by
 *   `nl="$(printf '\n')"`, command substitution stripped the trailing newline and the
 *   variable was the EMPTY string: the whole-field test silently became an unanchored
 *   substring test over the raw rows, so `s` (one character of any row), `23` (the
 *   seconds of a row) and `smoke-tests/x/test-a.tsx` (a listed key plus one character)
 *   all exempted a file no list ever named. That is not a strictness nicety — each of
 *   them lets a file that never ran slow sit past the bound.
 *
 * Driven through the shipped source (`verify-timing.sh`, whose parse block sources the
 * ceiling half) exactly as test-verify-timing-allowlist.ts drives `timing_key` and
 * `_timing_allowlist_entries`, so the case judges the matcher the loop runs rather than
 * a copy of it here. The needle is a KEY, not a path: `timing_exempt` reduces every
 * spelling through `timing_key` first, and that normaliser is pinned by the sibling gate.
 * Its own temp list, because the ceiling is armed per spawn through the environment and
 * the shipped list is the shrink-only gate's subject.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { LIB, REPO, removeAllowlist, writeAllowlist } from "./lib/verify-loop-timing-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

{
  const list = writeAllowlist([
    { file: "smoke-tests/x/test-a.ts", seconds: 23 },
    { file: "smoke-tests/y/other.ts", seconds: 9 },
    { file: "smoke-tests/z/third.ts", seconds: 31 },
  ]);
  const listed = (needle: string): boolean => {
    // The cache is filled by the loader's ONE read; `timing_listed` then answers from
    // it, which is the shape of every call after the first in a real run. The ceiling
    // is forced to 1 s so the loader's own knob gate lets the read happen at all.
    const script =
      `. "${path.join(LIB, "verify-timing.sh")}" >/dev/null 2>&1; ` +
      `VERIFY_TIMING_CEILING_S=1; TIMING_ALLOWLIST=${JSON.stringify(list)}; ` +
      `_timing_allowlist_entries >/dev/null; timing_listed ${JSON.stringify(needle)}`;
    const r = spawnSync("bash", ["-c", script], { cwd: REPO, encoding: "utf8" });
    return (r.status ?? -1) === 0;
  };
  const KEPT = "smoke-tests/x/test-a.ts";
  const cases: [string, boolean][] = [
    // The entry itself, and every row of the three-row list — the middle and last rows
    // pin the anchoring at both ends: a pattern anchored only against the start of the
    // haystack would keep the first row and lose these two.
    [KEPT, true],
    ["smoke-tests/y/other.ts", true],
    ["smoke-tests/z/third.ts", true],
    // A SUFFIX of the key: matches nothing, because the tab before it is missing.
    ["test-a.ts", false],
    ["a.ts", false],
    ["x/test-a.ts", false],
    // A substring of the seconds column, and one character of a row — each matched the
    // row under an unanchored test, since rows are separated only by newlines.
    ["s", false],
    ["23", false],
    // A key that is a PREFIX of an entry must not exempt the longer path: the newline
    // after the needle is what refuses it. The empty-string delimiter above left this
    // half unanchored on BOTH sides, so it reddened only with the others — a mutant that
    // drops just the trailing newline is caught by this row alone.
    ["smoke-tests/x/test-a.tsx", false],
    // A path the list never names, spelled as an entry in the list would be.
    ["smoke-tests/fixtures/verify-loop/fixture-ceiling-over.ts", false],
  ];
  try {
    const verdicts = cases.map(([needle]) => listed(needle));
    cases.forEach(([needle, want], i) => {
      const got = verdicts[i] === true;
      assert(
        got === want,
        `case 12: ${want ? "IS" : "is NOT"} listed — ${JSON.stringify(needle)} over a list naming ${JSON.stringify(KEPT)} at 23 s (got ${got})`,
      );
    });
  } finally {
    removeAllowlist(list);
  }
}

process.exit(exit);
