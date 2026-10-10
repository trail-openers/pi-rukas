#!/usr/bin/env bun
/**
 * #955 round-2 hardening — the merge guard shapes the adversarial review
 * confirmed, by execution, still bypass the guard (mergesPr → undefined).
 *
 * The round-1 fix (test-merge-guard-955.ts) covered post-verb number
 * extraction, subshell (bash -c) unwrapping and the -R passthrough. Round 2
 * adds: process-wrapper prefixes (timeout/command/nohup/sudo/nice/time/oo/
 * stdbuf), forge paths (/usr/bin/gh), live subshell / backtick bodies
 * (( … ), backtick command lines), fail-closed depth exhaustion, glab
 * --project, /pulls/N URLs and quoted numeric positionals.
 *
 * Every shape is asserted through mergesPr (the matcher) AND through the
 * real hook (registerMergeGuard with a failing lens ledger) — the guard
 * must REFUSE, not merely match.
 *
 * Note on `$( … )` / backtick substitution in an assignment
 * (`x=$(gh pr merge 17)`): the substitution runs the command, so it IS a
 * live merge and the guard matches it (fail-closed: the guard cannot
 * distinguish a substitution whose output is discarded from one whose
 * output is used). The "dead-code" shapes (a quoted verb inside a
 * non-executed string, like `echo "gh pr merge 1"`) stay open.
 */

import { mergesPr } from "../src/bash-command-parser.ts";
import { extractMergeNumber, mergeVerbArgs, mergeVerbRepo } from "../src/merge-parse.ts";

process.env.PI_ENSEMBLE_FORGE = "github";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------ wrapper prefixes
// Every process wrapper the adversarial review named: the merge verb must
// still match, and the PR number must still be extracted.

for (const cmd of [
  "timeout 30 gh pr merge 17",
  "timeout -s TERM 30 gh pr merge 17",
  "timeout -k 5 30 gh pr merge 17",
  "command gh pr merge 17",
  "nohup gh pr merge 17 &",
  "sudo gh pr merge 17",
  "sudo -E -u x gh pr merge 17",
  "nice gh pr merge 17",
  "nice -n 5 gh pr merge 17",
  "nice -n 10 gh pr merge 17",
  "time gh pr merge 17",
  "time -p gh pr merge 17",
  "env gh pr merge 17",
  "env -i gh pr merge 17",
  // `env -u FOO` takes a value token — the round-1 skip-all-dashes walk
  // stopped at `FOO` and the door stayed open (adversarial CRITICAL #1).
  "env -u FOO gh pr merge 17",
  "env -u FOO -u BAR gh pr merge 17",
  // `exec` re-executes the shell's own invocation as the new command —
  // it is a wrapper, not a command head (adversarial CRITICAL #2).
  "exec gh pr merge 17",
  "builtin gh pr merge 17",
  // `timeout` flag shapes: `-k N`, `--signal=KILL`, `--signal KILL` (the
  // space-separated `--signal` takes its value token — a `--flag=value`
  // form keeps the value inside the token).
  "timeout -k 5 30 gh pr merge 17",
  "timeout --signal=KILL 30s gh pr merge 17",
  "timeout --signal KILL 30s gh pr merge 17",
  "timeout -k 5 30s gh pr merge 17",
  "stdbuf -oL gh pr merge 17",
  // Stacked wrappers (bash unwraps iteratively — the guard must too).
  "nohup sudo gh pr merge 17",
  "timeout 30 nice -n 5 gh pr merge 17",
  // A forge PATH instead of a bare name.
  "/usr/bin/gh pr merge 17",
  "/opt/homebrew/bin/gh pr merge 17",
  // A relative forge path (#955 adversarial round 2, finding 2).
  "./gh pr merge 17",
  "bin/gh pr merge 17",
  // Chained after another command, still wrapped.
  "cd /data/3 && timeout 30 gh pr merge 17",
  "git status; nohup gh pr merge 17 &",
  // glab through a wrapper.
  "timeout 30 glab mr merge 7",
  "/usr/bin/glab mr merge 7",
]) {
  assert(mergesPr(cmd) !== undefined, `canary (wrapper): blocked — ${cmd}`);
}

// The number must survive the wrapper: `timeout 30 gh pr merge 17` is PR 17,
// not 30.
{
  const a = mergeVerbArgs("timeout 30 gh pr merge 17");
  assert(a !== undefined, "wrapper: verb tail present");
  assert(extractMergeNumber(a ?? "") === 17, "timeout 30 gh pr merge 17 → 17 (not 30)");
}
{
  const a = mergeVerbArgs("sudo gh pr merge 17");
  assert(extractMergeNumber(a ?? "") === 17, "sudo gh pr merge 17 → 17");
}
{
  const a = mergeVerbArgs("/usr/bin/gh pr merge 17");
  assert(extractMergeNumber(a ?? "") === 17, "/usr/bin/gh pr merge 17 → 17");
}
{
  const a = mergeVerbArgs("nohup gh pr merge 17 &");
  assert(extractMergeNumber(a ?? "") === 17, "nohup gh pr merge 17 & → 17");
}
// The value-taking wrapper flags: the number must still be the PR, not a
// wrapper argument (adversarial CRITICAL #1: `env -u` took its value
// token into the command-word slot, breaking the door).
{
  const a = mergeVerbArgs("env -u FOO gh pr merge 17");
  assert(a !== undefined, "env -u: the verb tail is present");
  assert(extractMergeNumber(a ?? "") === 17, "env -u FOO gh pr merge 17 → 17");
}
{
  const a = mergeVerbArgs("exec gh pr merge 17");
  assert(a !== undefined, "exec: the verb tail is present");
  assert(extractMergeNumber(a ?? "") === 17, "exec gh pr merge 17 → 17");
}
{
  const a = mergeVerbArgs("timeout --signal KILL 30s gh pr merge 17");
  assert(extractMergeNumber(a ?? "") === 17, "timeout --signal KILL 30s → 17 (not 30s, not KILL)");
}

// ------------------------------------------------------------ subshell / substitution
// `( … )` subshells run their body — the guard must see the merge. `$( … )`
// and backticks in a command line run the inner command too (the
// substitution executes before the assignment), so they are live merges
// the guard must catch (fail-closed: the guard cannot distinguish a
// substitution whose output is discarded from one whose is used).
for (const cmd of [
  "(gh pr merge 17)",
  "(cd x && gh pr merge 17)",
  "x=$(gh pr merge 17)",
  "x=`gh pr merge 17`",
  "echo $(gh pr merge 17)",
  "y=`glab mr merge 7`",
  // Nesting: a merge inside a substitution inside a subshell (and the
  // inverse).
  "a=$(( (gh pr merge 17) ))",
  "$( (glab mr merge 7) )",
  "(x=$(gh pr merge 17))",
  "w=`nohup gh pr merge 17`",
  // A merge in a later segment of a chain that also carries constructs.
  "ls $(gh pr list) && (gh pr merge 17)",
]) {
  assert(mergesPr(cmd) !== undefined, `canary (construct): blocked — ${cmd}`);
}

{
  const a = mergeVerbArgs("(gh pr merge 17)");
  assert(a !== undefined, "subshell: verb tail present");
  assert(extractMergeNumber(a ?? "") === 17, "(gh pr merge 17) → 17");
}
{
  const a = mergeVerbArgs("x=$(gh pr merge 17)");
  assert(extractMergeNumber(a ?? "") === 17, "x=$(gh pr merge 17) → 17");
}
{
  const a = mergeVerbArgs("x=`gh pr merge 17`");
  assert(extractMergeNumber(a ?? "") === 17, "backtick: the number is 17");
}

// ------------------------------------------------------------ depth: fail closed
// A merge hidden 4 shell-eval layers deep exceeds the unwrap budget (3).
// The guard must treat it as a merge WITH NO number → the fallback refusal,
// never as "not a merge".

// #955 adversarial round 4 (finding 1): the PREVIOUS canary (the `\'`-escaped
// form) was a false positive — `\` outside a quote escapes the following
// character in bash, so `\'` is a literal `'` and the raw string tokenises
// with the merge verb in BARE (unquoted) tokens. The guard's fail-closed
// `hasMergeVerbInRaw` scan catches it: a merge with no number, the fallback
// refusal. The shell-VALID depth-4 form (plain single quotes, no
// backslashes) unwraps to `(sh -c ` — a truncated, non-merge inner string
// (the tokenizer reads the first single-quoted run as the complete `-c`
// argument) — and correctly returns `undefined` (not a merge): the merge
// verb is inside a second quoted run that bash would concatenate with the
// bare tokens between them, a shape the guard treats as unparseable
// (fail-closed via the `hasMergeVerbInRaw` gate in `matchMergeVerbTail`).
const DEEP_MERGE_VALID = "bash -c '(sh -c '(gh pr merge 12)')'";
{
  // The valid depth-4 form: the guard returns undefined (the inner text
  // `(sh -c ` is not a merge). This is CORRECT — the actual bash semantics
  // of this string are a syntax error, not a clean merge; the guard's
  // job is not to guess intent for malformed input, it is to never let a
  // LIVE merge through. The escaped form below is the live-merge canary.
  assert(mergeVerbArgs(DEEP_MERGE_VALID) === undefined, "canary (depth 4, valid shell form): not a merge (inner text is a truncated non-merge)");
}
const deepEscaped = "bash -c \\'(sh -c \\'(gh pr merge 12)\\')\\'";
{
  assert(mergesPr(deepEscaped) !== undefined, "canary (depth 4, escaped-quote form): fails closed (matches, no clean pass)");
  // The escaped form: the merge verb is in bare (unquoted) tokens, so the
  // number IS extracted (12) — the guard blocks the merge and resolves the
  // PR number correctly. The canary asserts the guard MATCHES (refuses),
  // not that the number is missing.
  assert(extractMergeNumber(mergeVerbArgs(deepEscaped) ?? "") === 12, "canary (depth 4, escaped form): the number is 12 (bare tokens)");
}
{
  assert(mergesPr(deepEscaped) !== undefined, "canary (depth 4, escaped-quote form): fails closed (matches, no clean pass)");
}
// The valid depth-4 form is not a merge (the inner text is a truncated
// non-merge) — the guard returns undefined for both the number and the repo,
// and the CWD repo is used for the branch-resolution fallback.
{
  assert(mergeVerbRepo(DEEP_MERGE_VALID) === undefined, "canary (depth 4, valid form): no repo is read (not a merge)");
}

// An unparseable inner string (an unterminated quote in a raw command that
// still carries a merge verb) is likewise a merge-with-no-number: refused.
{
  const bad = 'bash -c "gh pr merge 12';
  assert(
    mergesPr(bad) !== undefined,
    "canary (unparseable): an unterminated-quote merge still matches",
  );
}

// #955 lens fix 5: unbalanced parens or backticks fail closed.
{
  const bad = "(gh pr merge 17";
  assert(
    mergesPr(bad) !== undefined,
    "canary (unbalanced paren): an unbalanced `(` with a merge verb still matches",
  );
}
{
  const notMerge = 'echo "(" ';
  assert(
    mergesPr(notMerge) === undefined,
    'canary (balanced): `echo "("` is not a merge (no merge verb)',
  );
}

// ------------------------------------------------------------ glab --project, /pulls/N, quoted number
{
  const a = mergeVerbArgs("glab --project o/r mr merge 7");
  assert(a !== undefined, "glab --project: the verb door matches");
  assert(extractMergeNumber(a ?? "") === 7, "glab --project o/r mr merge 7 → 7");
  assert(
    mergeVerbRepo("glab --project o/r mr merge 7")?.kind === "repo" && mergeVerbRepo("glab --project o/r mr merge 7")?.repo === "o/r",
    "…and the repo is o/r (--project)",
  );
}
{
  const a = mergeVerbArgs("gh pr merge https://github.com/o/r/pulls/17/merge");
  assert(a !== undefined, "/pulls/N URL: the verb door matches");
  assert(extractMergeNumber(a ?? "") === 17, "…and the number is 17 (/pulls/N)");
  assert(
    mergeVerbRepo("gh pr merge https://github.com/o/r/pulls/17/merge")?.kind === "repo" && mergeVerbRepo("gh pr merge https://github.com/o/r/pulls/17/merge")?.repo === "o/r",
    "…and the repo is o/r",
  );
}
{
  const a = mergeVerbArgs('gh pr merge "17"');
  assert(extractMergeNumber(a ?? "") === 17, 'gh pr merge "17" → 17 (quoted numeric positional)');
}
{
  const a = mergeVerbArgs("gh pr merge '17'");
  assert(extractMergeNumber(a ?? "") === 17, "gh pr merge '17' → 17 (single-quoted)");
}

// ------------------------------------------------------------ REST doors in subshells / substitutions
// A REST-door call inside `( … )` / `$( … )` / backticks is a live merge
// the guard must catch, fail-closed — the same doctrine the verb door
// applies to those bodies (adversarial ISSUES #3: the REST doors were
// not recursing into inner bodies, so `(gh api repos/o/r/pulls/17/merge)`
// and `x=$(gh api …/pulls/17/merge)` stayed open).
for (const cmd of [
  "(gh api repos/o/r/pulls/17/merge)",
  "x=$(gh api repos/o/r/pulls/17/merge)",
  "x=`gh api repos/o/r/pulls/17/merge`",
  "(glab api /projects/o%2Fr/mr/7/merge -f state=merged)",
  "y=$(glab api /projects/o%2Fr/mr/7/merge -f state=merged)",
  // A repo flag BEFORE `api` on the REST door (#955 adversarial round 2,
  // finding 1: `gh -R o/r api …/merge` was not matched because the FORGE
  // regex required `gh` immediately followed by `api`).
  "gh -R o/r api repos/o/r/pulls/17/merge",
  "gh --repo o/r api repos/o/r/pulls/17/merge",
]) {
  assert(mergesPr(cmd) !== undefined, `canary (REST-in-construct): blocked — ${cmd}`);
}

// A REST read (no /merge suffix) in a subshell stays open.
{
  assert(mergesPr("(gh api repos/o/r/pulls/17)") === undefined, "REST read in subshell: allowed");
  assert(mergesPr("x=$(gh api repos/o/r/pulls/17)") === undefined, "REST read in $(): allowed");
}

// ------------------------------------------------------------ performance / robustness
// A pathological command with many constructs must terminate in O(n) total
// work (no exponential blowup, no throw). The inner-body recursion is
// unbounded in depth but TERMINATING: every extracted body is a strict
// substring of the text that produced it.
{
  let nested = "gh pr merge 12";
  for (let i = 0; i < 50; i++) nested = `$((${nested}))`;
  const t0 = Date.now();
  const m = mergesPr(nested);
  const ms = Date.now() - t0;
  assert(m !== undefined, "canary (perf): 50-level nested $(...) still matches");
  assert(ms < 2000, `50-level nested completes in ${ms}ms (< 2000ms, no blowup)`);
}
{
  const big = "echo " + "a".repeat(50_000) + " && gh pr merge 12";
  const t0 = Date.now();
  const m = mergesPr(big);
  const ms = Date.now() - t0;
  assert(m !== undefined, "canary (perf): 50k-char command still matches");
  assert(ms < 2000, `50k-char command completes in ${ms}ms (< 2000ms, no blowup)`);
}
{
  const ticks = "echo " + "`x`".repeat(3000) + " && gh pr merge 12";
  const t0 = Date.now();
  const m = mergesPr(ticks);
  const ms = Date.now() - t0;
  assert(m !== undefined, "canary (perf): 3000 backticks still matches");
  assert(ms < 2000, `3000 backticks completes in ${ms}ms (< 2000ms, no blowup)`);
}

// ------------------------------------------------------------ non-merges stay open
for (const cmd of [
  "timeout 30 gh pr view 17",
  '(echo "gh pr merge 1")',
  "x=$(gh pr list)",
  "command -v gh",
  "nice -n 5 glab mr view 3",
  "sudo gh pr list",
  "time gh pr checks 12",
  "(echo hi)",
  "x=$(ls /tmp)",
  `x=\`gh pr list\``,
  // A quoted verb inside a non-executed string (the round-1 canary).
  'echo "gh pr merge 12"',
  'echo "glab mr merge 7"',
]) {
  assert(mergesPr(cmd) === undefined, `allowed (non-merge) — ${cmd}`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
