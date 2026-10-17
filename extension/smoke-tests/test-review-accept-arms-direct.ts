#!/usr/bin/env bun
/**
 * #1125 — the accept guard's ARMS asked DIRECTLY, one shell segment at a time.
 *
 * Split out of test-review-accept-guard-hardened.ts so each file stays under the §12
 * size limit. The invariant is the one that motivated the split: the guard's pre-checks
 * refuse `-c` and any quoted word for every command, so a whole command proves only the
 * pre-check. These ask one arm one segment — what the ARM refuses, with nothing above it
 * to catch the fall. The A1/A2 arms are the last line for a git/gh read the pre-checks
 * let through.
 */

import { armCommit, armForgeRead, armGitRead } from "../src/review-accept-arms.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Words exactly as an arm receives them: lowercased segment split on spaces. */
const words = (s: string): string[] => s.toLowerCase().split(" ");

/**
 * A1 refuses every repo-location selector, every operand that NAMES the store, and every
 * empty quoted word. Each spelling below is the only term in the arm that can make its
 * case red — remove that term and the case fails.
 */
for (const c of [
  "git -c /repo/.git log",
  "git --git-dir=/x log",
  "git --git-dir /x log",
  "git --work-tree=/x status",
  "git --exec-path=/x status",
  "git --exec-path /x blame src/a.ts",
  "git log --oneline --git-dir=/x",
  // The empty word AFTER the verb, spelled so nothing else in the segment refuses: an
  // operand test cannot see through `''`, so this is the case the empty-word refusal is
  // the only term that makes red.
  "git log '' review-findings.json",
  "git log '' extension/src/review-findings-store.ts",
  // `''` glued to a DOT-relative path: the colon branch reads `.git/` (not the store) and
  // the plain basename test sees `.json`, so ONLY the empty-word term can make this red.
  "git log '' .git/review-findings.json",
  // The `-G` term is the only one that sees these: the dashdash term reads the word as a
  // path (`-G…` is not a basename), so only the `-g` branch can make them red.
  "git log -Greview-findings-store --oneline",
  "git log --pickaxe-regex -Greview-findings-store",
  "git diff -Greview-findings.json HEAD",
])
  assert(!armGitRead(words(c)), `arm A1 refuses the selector / store operand — ${c}`);
for (const c of ["git log --oneline", "git --no-pager status", "git show HEAD:readme.md"])
  assert(armGitRead(words(c)), `arm A1 still admits the plain read — ${c}`);

/** A2 refuses the same selectors on a forge read, and still admits the exact reads. */
for (const c of [
  "gh pr view 1 --git-dir=/x",
  "gh pr view 1 -c x",
  "gh pr diff 2 --work-tree=/x",
  "gh repo view --git-dir /x",
])
  assert(!armForgeRead(words(c)), `arm A2 refuses the repo-location selector — ${c}`);
for (const c of ["gh pr view 1105", "glab mr diff 3"])
  assert(armForgeRead(words(c)), `arm A2 still admits the exact read — ${c}`);

/**
 * A7 (`git commit -m "<prose>"`) carries the same write-flag / repo-location ban the git
 * read arms carry: a `-c` config can name a hook or an alias the commit then runs.
 */
for (const c of ['git commit -m "x" -c y.z=1', 'git commit -m "x" --git-dir=/x'])
  assert(!armCommit(words(c)), `arm A7 refuses the write-capable flag — ${c}`);
for (const c of ['git commit -m "plain message"', 'git commit -m "fix: guard"'])
  assert(armCommit(words(c)), `arm A7 still admits the plain commit — ${c}`);

process.exit(exit);
