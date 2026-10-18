#!/usr/bin/env bun
/**
 * The shared tree-object absence rule (#1002 round 2).
 *
 * `gitCatFileSaysAbsent` is the rule `lens-evidence.ts`'s path-existence probe
 * acts on: `false` there becomes an "Unsourced path" finding, a throw is
 * silence. So the two shapes that share exit 128 must not collapse — git's OWN
 * wording decides, exactly as it does for the ref probe in
 * `test-git-range-1153.ts` (whose §4 pins `gitSaysAbsent`). Pinned directly
 * rather than through `runClaimScan`, so the rule has a home independent of its
 * one caller and a wording change cannot silently move a scan verdict.
 *
 * Split from `test-git-range-1153.ts` for the 500-line gate (AGENTS.md §12),
 * the same seam that took the round-3 object-id companion to
 * `test-git-range-object-id-1153.ts`.
 */

import { gitCatFileSaysAbsent } from "../src/git-range.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** An exec rejection in the shape node's `execFile` leaves: a code, a signal,
 * and git's stderr — the three fields the rule reads. */
const at = (over: Record<string, unknown>) =>
  Object.assign(new Error("Command failed: git cat-file -e"), over);

/** git's real wording for "I read that commit and that path is not in it". */
const ABSENT_WORDS = "fatal: path 'x' does not exist in 'y'\n";

assert(
  gitCatFileSaysAbsent(at({ code: 128, stderr: ABSENT_WORDS })) === true,
  "cat-file: exit 128 + git's 'does not exist in' wording is absent — the fact a path finding rests on",
);
assert(
  gitCatFileSaysAbsent(at({ code: 1, stderr: "fatal: does not exist\n" })) === true,
  "cat-file: exit 1 with the same wording is absent too",
);

// The trap the fix round existed for: a broken clone and a missing path share
// an exit code, and only git's sentence distinguishes them. The clone-broken
// wording is paired with the SAME "does not exist" sentence a real absence
// carries, so this fails when the clone guard is dropped rather than resting on
// the wording clause the assertion above already covers.
assert(
  gitCatFileSaysAbsent(
    at({ code: 128, stderr: "fatal: not a git repository\nfatal: path 'x' does not exist\n" }),
  ) === false,
  "cat-file: exit 128 from a broken clone is NOT absent — 'could not tell' must stay a throw",
);
assert(
  gitCatFileSaysAbsent(
    at({ code: 128, stderr: "fatal: detected dubious ownership in repository\n" }),
  ) === false,
  "cat-file: exit 128 from a dubious-ownership refusal is NOT absent either",
);
assert(
  gitCatFileSaysAbsent(at({ code: 127, stderr: "git: command not found\n" })) === false,
  "cat-file: exit 127 (git missing) is not absent",
);
// A probe the harness terminated carries a numeric code as well — node reports
// `killed: true` alongside a `signal` naming what ended it. Neither is git's
// answer, whatever it managed to print first.
assert(
  gitCatFileSaysAbsent(at({ code: 128, killed: true, signal: "SIGKILL", stderr: ABSENT_WORDS })) ===
    false,
  "cat-file: a killed probe is not absent, whatever it printed",
);
assert(
  gitCatFileSaysAbsent(at({ code: 128, signal: "SIGTERM", stderr: ABSENT_WORDS })) === false,
  "cat-file: a signalled probe is not absent",
);
assert(
  gitCatFileSaysAbsent(at({ code: 128, stderr: "" })) === false,
  "cat-file: exit 128 that said nothing is not absent — no wording, no fact",
);
assert(
  gitCatFileSaysAbsent(new Error("no code at all")) === false,
  "cat-file: an error with no exit code is not absent",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
