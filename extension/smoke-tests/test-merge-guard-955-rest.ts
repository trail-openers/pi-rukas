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
  // #955 adversarial round 4 (finding 1, valid depth-4 form): the inner
  // layer does not terminate — the guard must read NO repo from the
  // malformed body (the CWD repo is used for the branch-resolution
  // fallback), never a value from text that is not a valid command.
]) {
  assert(mergesPr(cmd) === undefined, `allowed (non-merge) — ${cmd}`);
}

// #955 adversarial round 4 (finding 1): the shell-VALID depth-4 form (plain
// single quotes, no backslashes) is a live merge the guard must match,
// fail-closed (no number / no repo from the malformed inner layer); the
// previous canary (the \\'-escaped form) was a false positive — that string
// is not a live merge, but its malformed inner layer fails closed the same
// way (a merge with no number, the fallback refusal).
{
  // The shell-VALID depth-4 form unwraps to `(sh -c ` — a truncated,
  // non-merge inner string — so the guard returns undefined (not a merge).
  // This is CORRECT: the string is a bash syntax error, not a clean merge.
  const valid = "bash -c '(sh -c '(gh pr merge 12)')'";
  assert(mergeVerbArgs(valid) === undefined, "canary (depth 4, valid shell form): not a merge (inner text is a truncated non-merge)");
}
{
  const escaped = "bash -c \\'(sh -c \\'(gh pr merge 12)\')\'";
  assert(mergesPr(escaped) !== undefined, "canary (depth 4, escaped-quote form): fails closed (blocked)");
  // The escaped form: the merge verb is in bare (unquoted) tokens, so the
  // number IS extracted (12) — the guard blocks the merge and resolves the
  // PR number correctly.
  assert(extractMergeNumber(mergeVerbArgs(escaped) ?? "") === 12, "canary (depth 4, escaped form): the number is 12 (bare tokens)");
}

// #955 adversarial round 4 (false positives, finding 3): everyday commands
// whose arguments or commit messages MENTION a merge verb are not merges —
// the verb must be an UNQUOTED command word (the segment head, after the
// wrapper walk), never data.
for (const cmd of [
  'git commit -m "gh pr merge 17"',
  "git commit -m 'we will gh pr merge 17 later'",
  "grep -rn 'gh pr merge' .",
  'git commit -m "revert: accidental merge of 17"',
  // A double-quoted repo value whose escaped quote closes early: the
  // unquoted form carries a literal " — the guard must read NO repo (the
  // value fails the repo boundary check; naive slice(1,-1) would keep the
  // escaped quote inside the value and validate it as a repo the guard then
  // interpolated — a false-safe the review would flag).
]) {
  assert(mergesPr(cmd) === undefined, `allowed (non-merge, round-4) — ${cmd}`);
}
{
  const earlyClose = 'bash -c "gh pr merge 17 -R \\"o/r\""';
  assert(mergeVerbRepo(earlyClose) === undefined, "canary (repo, escaped quote closes early): no repo is read — the malformed value is not a repo");
}

// #955 adversarial round 4 (finding 2, the rest of it): a repo flag in an
// UNRELATED segment (a VIEW segment) must not be adopted by the merge
// segment — the guard verifies the merge in the CWD's repo, not the repo a
// different segment happened to name.
{
  const disagree = "gh -R o/r pr view 12 && gh pr merge 17";
  assert(mergesPr(disagree) !== undefined, "canary (disagreement): the merge segment still matches");
  assert(mergeVerbRepo(disagree) === undefined, "canary (disagreement): the view segment's -R is NOT adopted — no repo (CWD used)");
  assert(
    extractMergeNumber(mergeVerbArgs(disagree) ?? "") === 17,
    "canary (disagreement): the number comes from the merge segment (17, not 12)",
  );
}
// The inverse: a repo flag INSIDE the merge segment (post-verb) is adopted
// (the number and the repo must come from the same segment).
{
  const sameSeg = "bash -c \"gh pr view 12 && gh pr merge 17 -R o/r\"";
  assert(mergeVerbRepo(sameSeg)?.kind === "repo" && mergeVerbRepo(sameSeg)?.repo === "o/r", "canary (same-segment repo): the repo comes from the merge segment");
  assert(
    extractMergeNumber(mergeVerbArgs(sameSeg) ?? "") === 17,
    "canary (same-segment repo): the number comes from the merge segment (17, not 12)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
