#!/usr/bin/env bun
/**
 * #955 REST-door and paren canaries (rest of the suite).
 *
 * The REST doors in mergesPr (bash-merges-pr.ts): the gh door is
 * method-blind (gh api defaults to POST/PUT, so /pulls/N/merge IS the
 * write unless an explicit GET with no body fields), the glab door is
 * method-aware (an explicit PUT/POST or body fields, and no explicit
 * GET). These canaries cover the shapes the other two #955 test files
 * do not: forge paths on the REST doors, -X/--method flags, the
 * no-repo /projects/{id}/mr/N/merge glab shape, the -R flag BEFORE api,
 * `env -S` wrappers, unbalanced parens, and REST reads that stay open.
 */

import { mergesPr } from "../src/bash-merges-pr.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------ REST writes are blocked
// gh api defaults to POST/PUT: a /pulls/N/merge call with no method, or an
// explicit PUT (either flag spelling), is the merge.
for (const cmd of [
  "/usr/bin/gh api repos/o/r/pulls/17/merge -X PUT",
  "gh api -X PUT repos/o/r/pulls/17/merge",
  "gh api --method PUT repos/o/r/pulls/17/merge",
  // glab api is method-aware: an explicit PUT on either REST shape is the
  // merge, and the forge path must not hide the door.
  "/opt/homebrew/bin/glab api -X PUT projects/1/merge_requests/3/merge",
  "glab api /projects/1/mr/12/merge -X PUT",
  // A repo flag BEFORE `api` on the REST door (the FORGE prefix in
  // bash-merges-pr.ts must allow it, like the verb door does).
  "gh -R o/r api -X PUT repos/o/r/pulls/17/merge",
  // Wrapper / paren shapes that still run a live merge verb.
  'env -S "gh pr merge 17"',
  "(gh pr merge 17",
  "(gh pr merge 17)",
]) {
  assert(mergesPr(cmd) !== undefined, `canary (merge): blocked — ${cmd}`);
}

// ------------------------------------------------------------ REST reads stay open
for (const cmd of [
  "gh api repos/o/r/pulls/17",
  "gh api repos/o/r/pulls/17/merge --method GET",
  "gh api repos/o/r/pulls/17/files",
  'echo "("',
  'echo "( hi',
  "gh pr view 17",
]) {
  assert(mergesPr(cmd) === undefined, `allowed (non-merge) — ${cmd}`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
