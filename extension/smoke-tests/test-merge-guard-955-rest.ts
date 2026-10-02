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

// ------------------------------------------------------------ unquoted eval is a transparent wrapper (#955 final fix, HIGH, PM-verified)
// `eval` with an UNQUOTED argument evaluates the next word and its
// arguments as a command — `eval gh pr merge 17` runs the merge exactly
// like the bare form, including behind a chain (`cd x && eval …`) or a
// process wrapper (`sudo eval …`). The quoted case (`eval "gh pr merge
// 17"`) is handled by `mergeVerbUnwrapOne` (the shell-eval unwrap above),
// not here.
for (const cmd of [
  "eval gh pr merge 17",
  "cd x && eval gh pr merge 17",
  "sudo eval gh pr merge 17",
  "command eval gh pr merge 17",
]) {
  assert(mergesPr(cmd) !== undefined, `canary (unquoted eval): blocked — ${cmd}`);
}

// The number must extract from the unquoted-eval shape: the verb tail comes
// from the raw segment's post-verb tokens, and 17 is the first bare
// positional.
assert(
  extractMergeNumber(mergeVerbArgs("eval gh pr merge 17")) === 17,
  "canary (unquoted eval): extractMergeNumber(mergeVerbArgs(...)) === 17",
);

// Unquoted `eval` on a NON-merge command stays open: the wrapper walk must
// not make `eval echo hi` / `eval gh pr view 17` look like a merge, and an
// eval-shaped string inside a commit message is inert data.
for (const cmd of [
  "eval echo hi",
  "eval gh pr view 17",
  'git commit -m "eval gh pr merge 17"',
]) {
  assert(mergesPr(cmd) === undefined, `allowed (unquoted eval, non-merge) — ${cmd}`);
}

// The quoted-eval wrapper forms must still be caught (the quoted case is
// owned by mergeVerbUnwrapOne, which the per-segment path calls for every
// segment head). `command eval "…"` / `sudo eval "…"` are the wrapper-chain
// forms that only the per-segment path sees (mergeVerbUnwrapOne's own loop
// skips the wrapper and lands on the quoted eval token).
for (const cmd of [
  'command eval "gh pr merge 17"',
  'sudo eval "gh pr merge 17"',
]) {
  assert(mergesPr(cmd) !== undefined, `canary (quoted eval, wrapper chain): blocked — ${cmd}`);
}

// #955 adversarial round 5 (CRITICAL): nested / quoted-wrapper `eval` shapes
// that are LIVE merges in bash (verified by execution: the merge command runs
// and its output is captured). The guard must block every one of these — the
// `eval eval "gh pr merge 17"` family was the bypass: the outer `mergeVerbUnwrapOne`
// consumed one layer (the outer `eval`), leaving the inner `eval "gh pr merge 17"`
// as a single quoted token that the per-segment path could not re-enter. The
// fix makes `mergeVerbUnwrapOne` iterative (it follows the full shell-eval
// chain in one call), so a merge hidden behind two (or more) eval layers is
// still seen as a merge and refused.
for (const cmd of [
  // Bare `eval eval` — the canonical bypass shape.
  'eval eval "gh pr merge 17"',
  'eval eval "glab mr merge 7"',
  // Deeper nesting: three evals, or an eval whose body is itself an eval.
  'eval eval eval "gh pr merge 17"',
  'eval eval "eval gh pr merge 17"',
  // Quoted wrapper word + quoted body: `eval "eval" "…"`, `eval "sudo" "…"`,
  // `eval "nice" "…"` — bash concatenates all eval args and re-evaluates,
  // so `eval "sudo" "gh pr merge 17"` runs `sudo gh pr merge 17` (a live
  // merge). The guard blocks these (fail-closed: the guard cannot
  // distinguish a wrapper word that is a no-op from one that is not).
  'eval "eval" "gh pr merge 17"',
  'eval "sudo" "gh pr merge 17"',
  'eval "nice" "gh pr merge 17"',
  'eval "nohup" "gh pr merge 17"',
  // Per-segment forms: the merge is in a LATER segment or a construct.
  'cd x && eval eval "gh pr merge 17"',
  'x=1; eval eval "gh pr merge 17"',
  '(eval eval "gh pr merge 17")',
  'x=$(eval eval "gh pr merge 17")',
]) {
  assert(mergesPr(cmd) !== undefined, `canary (nested eval, CRITICAL r5): blocked — ${cmd}`);
}

// The number must extract from the nested-eval shape (the innermost body is
// `gh pr merge 17`, and 17 is the first bare positional).
assert(
  extractMergeNumber(mergeVerbArgs('eval eval "gh pr merge 17"')) === 17,
  "canary (nested eval, CRITICAL r5): the number is 17",
);
assert(
  extractMergeNumber(mergeVerbArgs('eval "eval" "gh pr merge 17"')) === 17,
  "canary (nested eval, quoted wrapper): the number is 17",
);

// `eval "echo" "gh pr merge 17"` is NOT a live merge (echo prints its args,
// it does not run them) — the guard allows it. This is the one shape in the
// nested-eval family where the guard is correct to stay open.
assert(
  mergesPr('eval "echo" "gh pr merge 17"') === undefined,
  "canary (nested eval, echo): allowed (echo does not run its args)",
);

// Termination canary: every eval/wrapper shape above must finish under 50ms.
// The previous developer's uncommitted change had an infinite loop in
// mergeVerbUnwrapOne (a `continue` without advancing `i` on `eval "…"`),
// which hung a probe for 88 minutes. This canary catches that regression.
{
  const shapes = [
    "eval gh pr merge 17",
    "cd x && eval gh pr merge 17",
    "sudo eval gh pr merge 17",
    "command eval gh pr merge 17",
    'eval "gh pr merge 17"',
    'cd x; eval "gh pr merge 17"',
    'command eval "gh pr merge 17"',
    'sudo eval "gh pr merge 17"',
    // #955 adversarial round 5: the nested-eval family (the CRITICAL bypass
    // shapes) — the iterative `mergeVerbUnwrapOne` must terminate on these.
    'eval eval "gh pr merge 17"',
    'eval eval eval "gh pr merge 17"',
    'eval "eval" "gh pr merge 17"',
    'eval "sudo" "gh pr merge 17"',
    'cd x && eval eval "gh pr merge 17"',
    'x=1; eval eval "gh pr merge 17"',
    '(eval eval "gh pr merge 17")',
    'x=$(eval eval "gh pr merge 17")',
    "eval " + "eval ".repeat(998) + '"gh pr merge 17"',
    "eval echo hi",
    "eval gh pr view 17",
    'git commit -m "eval gh pr merge 17"',
    'bash -c "eval gh pr merge 17"',
    'sudo bash -c "eval gh pr merge 17"',
    'command bash -c "eval gh pr merge 17"',
    'timeout 30 eval gh pr merge 17',
    'nice eval gh pr merge 17',
    'nohup eval gh pr merge 17',
    'exec eval gh pr merge 17',
    'eval "echo hi"',
    "eval",
  ];
  for (const cmd of shapes) {
    const t0 = Date.now();
    const r = mergesPr(cmd);
    const dt = Date.now() - t0;
    assert(
      dt < 50,
      `termination canary: ${cmd} finished in ${dt}ms (<50ms), result=${r !== undefined ? "blocked" : "allowed"}`,
    );
  }
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

// ------------------------------------------------------------ REST writes nested deep (#955 adversarial round 5)
// The REST doors must recurse into nested inner-body constructs (the same
// closure the verb door uses via findVerbSpanInSegments): a merge hidden
// two levels deep (a substitution inside a substitution, a subshell inside
// a substitution) is a live merge the guard must catch, fail-closed. The
// FORGE regex cannot anchor a forge word that follows `$( ` or `( ` in the
// stripped text, so the doors must be fed the innermost body itself.
for (const cmd of [
  "x=$(y=$(gh api repos/o/r/pulls/17/merge))",
  "x=`y=$(gh api repos/o/r/pulls/17/merge)`",
  "x=$( (gh api repos/o/r/pulls/17/merge) )",
  "x=$(y= (glab api /projects/o%2Fr/mr/7/merge -f state=merged))",
  "x=$( (glab api /projects/o%2Fr/mr/7/merge -f state=merged) )",
  // glab REST, nested, explicit PUT.
  "x=$(y=$(glab api /projects/1/mr/12/merge -X PUT))",
]) {
  assert(mergesPr(cmd) !== undefined, `canary (REST nested deep): blocked — ${cmd}`);
}

// A REST READ nested deep stays open (no /merge suffix in the innermost).
assert(mergesPr("x=$(y=$(gh api repos/o/r/pulls/17))") === undefined, "canary (REST nested deep, read): allowed");

// ------------------------------------------------------------ unbalanced paren REST (#955 adversarial round 5)
// An unbalanced `(` with a REST door inside is a live merge bash would run
// (`(gh api repos/o/r/pulls/17/merge` with the close on a later line). The
// REST door must refuse it (the leading paren is stripped, the same coping
// matchMergeVerb applies to its glued-paren token) — never read as "not a
// merge". A balanced paren with no /merge stays open.
{
  const bad = "(gh api repos/o/r/pulls/17/merge";
  assert(mergesPr(bad) !== undefined, "canary (unbalanced paren, REST): an unbalanced `(` with a REST merge still matches");
}
{
  const open = "(gh api repos/o/r/pulls/17)";
  assert(mergesPr(open) === undefined, "canary (balanced paren, REST read): allowed");
}

// #955 adversarial round 5 (MINOR #1): the REST-door repo flag is threaded
// to the guard's reads — `gh -R o/r api …/pulls/N/merge` verifies the PR in
// o/r, not the CWD's repo. The guard's `restRepoFor` reads the flag over
// the quote-stripped command and only fires on a repo-shaped value.
{
  // The REST door still matches when the repo flag is present (the -R is
  // threaded to the gh pr view read by merge-guard.ts restRepoFor).
  assert(mergesPr("gh -R o/r api repos/o/r/pulls/17/merge") !== undefined, "canary (REST -R): the door matches with the repo flag");
}

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
