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
import { extractMergeNumber, mergeVerbArgs, mergeVerbRepo } from "../src/merge-parse.ts";

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
  // A process wrapper in front of the shell-eval word (#955 lens round 3,
  // PM-verified bypass: mergeVerbUnwrapOne only recognised the shell-eval
  // word at token 0): exec, sh, sudo, nohup, timeout, and `command eval`.
  'exec bash -c "gh pr merge 17"',
  'exec sh -c "glab mr merge 7"',
  'sudo bash -c "gh pr merge 17"',
  'nohup bash -c "gh pr merge 17"',
  'timeout 30 bash -c "gh pr merge 17"',
  'command eval "gh pr merge 17"',
]) {
  assert(mergesPr(cmd) !== undefined, `canary (merge): blocked — ${cmd}`);
}

// ------------------------------------------------------------ per-segment shell-eval unwrap (#955 round 4)
// A shell-eval word in a LATER segment (after `;`, `&&`, `|`) was invisible
// to the whole-command unwrap: `cd x && bash -c "gh pr merge 17"` and all
// the shapes below now must read as a merge.
for (const cmd of [
  'cd x && bash -c "gh pr merge 17"',
  'gh pr view 17; bash -c "gh pr merge 17"',
  'cd x && exec bash -c "gh pr merge 17"',
  'cd x; eval "gh pr merge 17"',
  'true | sudo bash -c "gh pr merge 17"',
  'gh pr view 17; exec bash -c "gh pr merge 17"',
]) {
  assert(mergesPr(cmd) !== undefined, `canary (merge, per-segment unwrap): blocked — ${cmd}`);
}

// The PR number must still extract from the per-segment shape: the verb tail
// comes from the unwrapped inner text, and 17 is the first bare positional.
assert(
  extractMergeNumber(mergeVerbArgs('cd x && bash -c "gh pr merge 17"') ?? "") === 17,
  "canary (number): mergeVerbArgs/extractMergeNumber yield 17 from the per-segment shape",
);

// ------------------------------------------------------------ repo through the shell-eval unwrap (#955)
// The -R flag sits INSIDE the shell-eval body: the tail path (number) sees
// it after unwrapping, but mergeVerbRepo used to read the repo only from
// the post-verb tail of the raw command — so the number came from `o/r`
// while the guard verified the PR in the CWD's repo (wrong-target ledger
// check). The repo must come from the SAME unwrapped tail that yields the
// number, for every path.
for (const cmd of [
  'bash -c "gh pr merge 17 -R o/r"',
  'cd x && bash -c "gh pr merge 17 -R o/r"',
  'cd x && bash -c "cd y && bash -c \\"gh pr merge 17 -R o/r\\""',
]) {
  const r = mergeVerbRepo(cmd);
  assert(
    r?.kind === "repo" && r.repo === "o/r",
    `canary (repo through unwrap): repo is o/r — ${cmd}`,
  );
  assert(
    extractMergeNumber(mergeVerbArgs(cmd) ?? "") === 17,
    `canary (number through unwrap): number is 17 — ${cmd}`,
  );
}

// An unsafe repo value inside the unwrapped body is refused at the
// extraction boundary (never interpolated), not silently dropped.
const unsafe = mergeVerbRepo('bash -c "gh pr merge 17 -R \\"o/r; x\\""');
assert(
  unsafe?.kind === "unsafe",
  "canary (repo through unwrap, unsafe): an injected repo value in the body is refused (unsafe), not dropped",
);

// The subshell's closing paren glued to the value: `(gh pr merge 17 -R
// o/r)` must read the repo o/r (the paren is stripped, the way the number
// path already copes with `17)`), not the false-refusal `o/r)`.
const paren = mergeVerbRepo("(gh pr merge 17 -R o/r)");
assert(
  paren?.kind === "repo" && paren.repo === "o/r",
  "canary (repo, subshell paren): the closing paren is stripped — repo is o/r",
);
assert(
  extractMergeNumber(mergeVerbArgs("(gh pr merge 17 -R o/r)") ?? "") === 17,
  "canary (number, subshell paren): number is 17",
);

// ------------------------------------------------------------ REST reads stay open
for (const cmd of [
  "gh api repos/o/r/pulls/17",
  "gh api repos/o/r/pulls/17/merge --method GET",
  "gh api repos/o/r/pulls/17/files",
  'echo "("',
  'echo "( hi',
  "gh pr view 17",
  // Wrapper before a shell-eval word, but no merge inside: the wrapper
  // skip must not make a non-merge look like a merge.
  'timeout 30 bash -c "echo hi"',
  'sudo bash -c "gh pr view 17"',
  // Per-segment unwrap must not make a non-merge segment look like one:
  // `cd x && bash -c "echo hi"` unwraps the segment to `echo hi` (no merge
  // verb); `cd x; eval "echo gh pr merge"` unwraps to `echo gh pr merge`,
  // where a leading `echo` never matches the verb head — the eval body is
  // inert the same way `echo "gh pr merge 12"` is at the top level. `true
  // | bash -c "gh pr view 17"` unwraps to a VIEW, not a merge.
  'cd x && bash -c "echo hi"',
  'cd x; eval "echo gh pr merge"',
  'true | bash -c "gh pr view 17"',
]) {
  assert(mergesPr(cmd) === undefined, `allowed (non-merge) — ${cmd}`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
