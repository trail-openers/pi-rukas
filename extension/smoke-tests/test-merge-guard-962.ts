#!/usr/bin/env bun
/**
 * #962 — the merge guard's residual bypass shapes, each asserted to be
 * refused, beside a nearby benign command that must stay allowed (so the
 * matcher does not over-refuse ordinary gh usage).
 *
 * The issue's items: `case … esac` arms, unquoted `bash -c`, `eval "$() gh
 * pr merge N"`, the quoted eq-form `--repo="…"`, glab REST `--method GET`
 * with `-f` fields, glab `--project` on the REST thread, and a timeout on
 * detectForge's git calls. Plus the same-class shapes found verifying them:
 * a merge on a later LINE, after a first-segment `bash -c '…'`, spelled
 * with escapes or adjacent quotes, inside a double-quoted substitution, a
 * REST endpoint glued to `;`, and the `--repo=` / `-R=` / `-RVALUE` forms.
 *
 * Matcher-level assertions go through `analyseMergeCommand` (the guard's
 * one entry point, raw + canonical reading); the refusals are also driven
 * through the REAL hook with an empty ledger.
 */

import { detectForge } from "../src/forge-detect.ts";
import { analyseMergeCommand, type MergeAnalysis } from "../src/merge-analyse.ts";
import { readMergeTarget } from "../src/merge-target.ts";
import {
  assert,
  exit,
  GOOD_ENTRIES,
  hookDecision,
  setupLedgerPath,
  teardownLedger,
} from "./merge-guard-helpers.ts";

const show = (a: MergeAnalysis) => JSON.stringify(a);

/** `cmd` is a merge of PR `n` (and, when given, repo `repo`). */
function merges(cmd: string, n: number | undefined, repo?: string) {
  const a = analyseMergeCommand(cmd);
  const ok =
    a.kind === "merge" && a.prNumber === n && (repo === undefined || a.repo === repo);
  assert(ok, `merge #${n ?? "?"}${repo ? ` in ${repo}` : ""}: ${JSON.stringify(cmd)} → ${show(a)}`);
}

/** `cmd` is not a merge at all. */
function benign(cmd: string) {
  const a = analyseMergeCommand(cmd);
  assert(a.kind === "none", `benign: ${JSON.stringify(cmd)} → ${show(a)}`);
}

function kind(cmd: string, k: MergeAnalysis["kind"]) {
  const a = analyseMergeCommand(cmd);
  assert(a.kind === k, `${k}: ${JSON.stringify(cmd)} → ${show(a)}`);
}

// ------------------------------------------------------------ 1. case … esac
merges("case x in 1) gh pr merge 17;; esac", 17);
merges("case $x in a|b) glab mr merge 17 ;; *) echo ;; esac", 17);
merges("case x in 1) echo;; 2 ) gh pr merge 17;; esac", 17);
merges("case x in (1) gh pr merge 17;; esac", 17);
merges("case x in 1) gh api -X PUT repos/o/r/pulls/17/merge;; esac", 17);
benign("case x in 1) gh pr view 17;; esac");
benign("case x in 1) gh api repos/o/r/pulls/17;; esac");

// ------------------------------------------------------------ 2. unquoted bash -c
// bash runs only the ONE word after -c: `bash -c gh pr merge 17` runs `gh`
// with $0=pr — not a merge. A word that IS the merge (escaped spaces,
// adjacent quoted runs) is one.
benign("bash -c gh pr merge 17");
merges("bash -c gh\\ pr\\ merge\\ 17", 17);
merges("bash -c gh' pr merge 17'", 17);
merges('bash -c "gh pr merge 17"', 17);

// ------------------------------------------------------------ 3. eval "$() gh pr merge N"
merges('eval "$() gh pr merge 12"', 12);
merges('eval "$(true) gh pr merge 12"', 12);
merges("$(echo hi) gh pr merge 3", 3);
merges("`true` gh pr merge 4", 4);
merges('eval $"gh pr merge 17"', 17);
benign("echo $(gh pr view 1)");
benign('eval "$(ssh-agent -s)"');

// ------------------------------------------------------------ 4. --repo eq / glued forms
kind('gh pr merge 17 --repo="o/r;id"', "unsafe");
kind('gh --repo="o/r;id" pr merge 17', "unsafe");
merges('gh pr merge 17 --repo="o/r"', 17, "o/r");
merges("gh pr merge 17 --repo=o/r", 17, "o/r");
merges("gh --repo=o/r pr merge 17", 17, "o/r");
merges("gh pr merge 17 -R=o/r", 17, "o/r");
merges("gh pr merge 17 -Ro/r", 17, "o/r");
merges("gh -Ro/r pr merge 17", 17, "o/r");
benign("gh --repo=o/r pr view 17");

// ------------------------------------------------------------ 5. glab REST GET + body fields
const GL = "glab api projects/1/merge_requests/17/merge";
merges(`${GL} --method GET -f state=merged`, 17);
merges(`${GL} --method=PUT`, 17);
merges(`${GL} -XPUT`, 17);
benign(`${GL} --method GET`);
benign(GL);
benign("glab api projects/1/merge_requests/17 -X PUT");

// ------------------------------------------------------------ 6. glab --project on the REST thread
merges("glab --project o/r api projects/:id/merge_requests/3/merge -X PUT", 3, "o/r");
merges("glab --project=o/r api projects/:id/merge_requests/3/merge -X PUT", 3, "o/r");

// ------------------------------------------------------------ same class: lines, segments, spelling
merges("echo hi\ngh pr merge 17", 17);
merges("echo hi\ngh api -X PUT repos/o/r/pulls/17/merge", 17);
merges("bash -c 'true'; gh pr merge 17", 17);
merges("eval 'true'; gh pr merge 17", 17);
merges("\\gh pr merge 17", 17);
merges('g"h" pr merge 17', 17);
merges('gh p"r" merge 17', 17);
kind('echo "$(gh pr merge 17)"', "nested");
kind('echo "`gh pr merge 17`"', "nested");
merges("gh api -X PUT repos/o/r/pulls/17/merge; echo", 17);
merges("gh api -X PUT repos/o/r/pulls/17/merge|cat", 17);
// The raw tokens read PR 1, bash runs PR 17: the readings disagree.
kind('gh pr merge 1"7"', "ambiguous");
benign("echo hi\\\ngh pr view 17");
benign("gh pr view 17\ngh pr checks 17 2>&1");
benign('echo "gh pr merge 12"');
benign("echo '$(gh pr merge 12)'");
benign('git commit -m "docs: explain gh pr merge 12"');
benign('echo "\\$(gh pr merge 17)"');
merges('gh pr merge 17 --subject "fix: a b" 2>&1 &', 17);
merges('gh pr merge "17"', 17);

// ------------------------------------------------------------ review round 1
// The REST door reads the repo with the verb door's token reader.
merges("gh -Ro/r api -X PUT repos/o/r/pulls/17/merge", 17, "o/r");
merges('gh --repo="o/r" api -X PUT repos/o/r/pulls/17/merge', 17, "o/r");
kind('gh --repo="o/r;id" api -X PUT repos/o/r/pulls/17/merge', "unsafe");
// An empty repo value is refused, not replaced by the CWD's repo.
kind("gh pr merge 17 --repo=", "unsafe");
kind('gh pr merge 17 --repo=""', "unsafe");
// ANSI-C escapes and brace expansion are what bash runs.
merges("$'\\x67h' pr merge 17", 17);
merges("$'\\147h' pr merge 17", 17);
merges("$'\\u0067h' pr merge 17", 17);
merges("{gh,pr,merge,17}", 17);
merges("gh pr m{e,}rge 17", 17);
benign("echo {a,b}; gh pr view 17");
// A glab method that is not a literal word fails closed.
merges(`${GL} --method "$M"`, 17);
merges(`${GL} -X`, 17);
// The case-arm scan stops at a separator; quoted parens inside a
// substitution do not end it early.
merges("case x in esac; gh pr merge 17; echo $(date)", 17);
merges('$(echo ")") gh pr merge 17', 17);

// ------------------------------------------------------------ review round 2
merges("gh pr me\\\nrge 17", 17);
// The REST repo is the merge segment's own flag, not another segment's.
merges("gh -R a/b pr view 1; gh api -X PUT repos/o/r/pulls/17/merge", 17);
{
  const a = analyseMergeCommand("gh -R a/b pr view 1; gh api -X PUT repos/o/r/pulls/17/merge");
  assert(a.kind === "merge" && a.repo === undefined, `REST repo not taken from an unrelated segment → ${show(a)}`);
}
// One merge per command: a second merge would run unchecked.
kind("gh pr merge 17 && gh pr merge 5", "multiple");
kind("gh pr merge 17\nglab mr merge 5", "multiple");
merges("gh pr merge 17 && gh pr view 5", 17);
// A brace word past the expansion bound still yields its alternatives.
merges("echo {a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b} && gh pr merge 17", 17);

// ------------------------------------------------------------ review round 3
merges("case $(echo x) in x) gh pr merge 17;; esac", 17);
// A comment is inert: the apostrophe in it does not hide the number (the
// raw reading sees an unclosed quote, the canonical one sees PR 17).
kind("gh pr merge 17 # it's", "ambiguous");
benign("echo hi # gh pr merge 17");
{
  const t0 = performance.now();
  const a = analyseMergeCommand(`echo {${"a,".repeat(255)}a}{${"b,".repeat(999)}b} merge`);
  const dt = performance.now() - t0;
  assert(a.kind === "none" && dt < 1000, `a hostile brace word stays bounded (${dt.toFixed(0)}ms) → ${show(a)}`);
}

// ------------------------------------------------------------ the REAL hook refuses
await setupLedgerPath();
for (const cmd of [
  "case x in 1) gh pr merge 17;; esac",
  "bash -c gh\\ pr\\ merge\\ 17",
  'eval "$() gh pr merge 12"',
  `${GL} --method GET -f state=merged`,
  "echo hi\ngh pr merge 17",
  "bash -c 'true'; gh pr merge 17",
  "\\gh pr merge 17",
  'echo "$(gh pr merge 17)"',
]) {
  const r = await hookDecision(cmd, []);
  assert(r.block, `hook refuses (empty ledger): ${JSON.stringify(cmd)} — ${r.reason ?? "allowed"}`);
}
{
  const r = await hookDecision("\\gh pr merge 17", []);
  assert(
    r.calls.some((c) => c.includes("gh pr view 17")),
    "hook verifies the PR the escaped command merges (#17), not a branch fallback",
  );
}
{
  const r = await hookDecision('gh pr merge 17 --repo="o/r;id"', GOOD_ENTRIES);
  assert(r.block && /unsafe repo value/.test(r.reason ?? ""), "hook: quoted eq-form unsafe repo is refused as unsafe");
}
{
  const r = await hookDecision('gh pr merge 1"7"', GOOD_ENTRIES);
  assert(r.block && /ambiguous merge target/.test(r.reason ?? ""), "hook: ambiguous target refused even with a passing ledger");
}
for (const cmd of ["case x in 1) gh pr view 17;; esac", "gh pr view 17\ngh pr checks 17", 'echo "gh pr merge 12"']) {
  const r = await hookDecision(cmd, []);
  assert(!r.block && r.calls.length === 0, `hook allows benign: ${JSON.stringify(cmd)}`);
}
for (const [cmd, reason] of [
  ['gh pr merge 17 "$(gh pr merge 5)"', /runs inside a command substitution/],
  ["echo $(glab mr merge 3)", /runs inside a command substitution/],
  ["gh -R a/b pr merge 17 --repo c/d", /more than one repo/],
  ["glab mr merge 3 -R a/b --repo c/d", /more than one repo/],
] as const) {
  const r = await hookDecision(cmd, GOOD_ENTRIES);
  assert(r.block && reason.test(r.reason ?? ""), `hook refuses with a named reason: ${JSON.stringify(cmd)} — ${r.reason ?? "allowed"}`);
  assert(r.calls.length === 0, `hook refuses before any forge call: ${JSON.stringify(cmd)}`);
}
teardownLedger();

// ------------------------------------------------------------ 7. detectForge git timeout
{
  const never = () => new Promise<never>(() => {});
  const t0 = performance.now();
  const d = await detectForge("/nonexistent", {
    execFn: never as never,
    env: {},
    forgeConfigContent: "",
    allowProbe: false,
    execTimeoutMs: 50,
  });
  const dt = performance.now() - t0;
  assert(d.forge === "unknown" && d.source === "unknown", `stalled git → unknown forge (${d.source})`);
  assert(dt < 2000, `stalled git is bounded (${dt.toFixed(0)}ms < 2000ms)`);
  const prev = process.env.PI_ENSEMBLE_FORGE;
  delete process.env.PI_ENSEMBLE_FORGE;
  const r = await readMergeTarget(never as never, "/nonexistent", 17, {
    execFn: never as never,
    env: {},
    forgeConfigContent: "",
    execTimeoutMs: 50,
  });
  if (prev !== undefined) process.env.PI_ENSEMBLE_FORGE = prev;
  assert(!r.ok && /could not determine the forge/.test(r.ok ? "" : r.reason), "stalled git → the merge target read refuses");
}

// ------------------------------------------------------------ 8. nested merges + repeated repo selectors (#1317)
// Every merge head is judged at every depth; a head inside a substitution or
// process substitution is refused as nested, and two repo selectors are
// refused (gh/glab take the last one, the guard reads the first).
kind('gh pr merge 17 "$(gh pr merge 5)"', "nested");
kind("gh pr merge 17 `gh pr merge 5`", "nested");
kind('gh pr view "$(gh pr merge 5)"', "nested");
kind("echo $(glab mr merge 3)", "nested");
kind('echo "$(gh pr merge 5)"', "nested");
kind("cat <(gh pr merge 5)", "nested");
kind("gh pr view 1 >(gh pr merge 5)", "nested");
kind("gh -R a/b pr merge 17 --repo c/d", "repos");
kind("gh pr merge 17 -R=a/b -R c/d", "repos");
kind("glab mr merge 3 -R a/b --repo c/d", "repos");
kind("glab mr merge 3 --repo=a/b -R c/d", "repos");
kind('bash -c "gh pr merge 17 && gh pr merge 5"', "multiple");
benign("gh pr view 17 --json title");
benign('echo "$(date)"');
merges('gh pr merge 17 --subject "$(date)"', 17);
merges("(gh pr merge 17)", 17);
merges("gh -R a/b pr merge 17", 17, "a/b");
merges("glab mr merge 3 -R a/b", 3, "a/b");
console.log(`\nexit ${exit}`);
process.exit(exit);
