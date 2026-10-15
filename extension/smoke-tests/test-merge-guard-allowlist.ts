#!/usr/bin/env bun
/**
 * #962 — the merge guard accepts only a plain merge command
 * (merge-allowlist.ts). Every accepted form with its number and repo; every
 * bypass shape from the #955/#1317 reviews refused; ordinary non-merge
 * commands allowed; the refusal driven through the real hook; a 30 kB
 * command analysed well inside the hook budget; the forge-detect git bound.
 */

import { detectForge } from "../src/forge-detect.ts";
import { type MergeCommand, readMergeCommand } from "../src/merge-allowlist.ts";
import { analyseRefusal } from "../src/merge-guard.ts";
import { type MergeExecFn, readMergeTarget } from "../src/merge-target.ts";
import {
  GOOD_ENTRIES,
  assert,
  exit,
  hookDecision,
  setupLedgerPath,
  teardownLedger,
} from "./merge-guard-helpers.ts";

const show = (m: MergeCommand) => JSON.stringify(m);

// ------------------------------------------------------------ accepted forms
const ACCEPTED: Array<[string, "github" | "gitlab", number | undefined, string | undefined]> = [
  ["gh pr merge 17", "github", 17, undefined],
  ["gh pr merge", "github", undefined, undefined],
  ["gh pr merge --squash", "github", undefined, undefined],
  ["gh pr merge 17 --squash --delete-branch", "github", 17, undefined],
  ["gh pr merge 17 -s -d", "github", 17, undefined],
  ["gh pr merge 17 -m", "github", 17, undefined],
  ["gh pr merge 17 --merge --rebase -r", "github", 17, undefined],
  ["gh pr merge 17 --delete-branch=false", "github", 17, undefined],
  ["gh pr merge 17 --delete-branch=true --disable-auto", "github", 17, undefined],
  ['gh pr merge 17 --subject "fix: a b" --body-file x.md', "github", 17, undefined],
  ["gh pr merge 17 --subject 'fix(review): x; y' -b 'z'", "github", 17, undefined],
  ["gh pr merge 17 -t subj -F body.md -A me@example.com", "github", 17, undefined],
  ["gh pr merge 17 --subject=x --author-email=a@b.c --match-head-commit abc123", "github", 17, undefined],
  ["gh pr merge 17 --match-head-commit=abc123", "github", 17, undefined],
  ["gh pr merge 17 --subject 17", "github", 17, undefined],
  ["gh -R o/r pr merge 17", "github", 17, "o/r"],
  ["gh --repo o/r pr merge 17 --squash", "github", 17, "o/r"],
  ["gh --repo=o/r pr merge 17", "github", 17, "o/r"],
  ["gh pr merge 17 -R o/r", "github", 17, "o/r"],
  ["gh pr merge 17 --squash --repo=my.org/my-repo_1", "github", 17, "my.org/my-repo_1"],
  ["gh pr merge -R o/r", "github", undefined, "o/r"],
  ['gh pr "merge" 17', "github", 17, undefined],
  ["gh pr merge '17'", "github", 17, undefined],
  // Quote removal is bash's: these run `gh pr merge 17` and are read so.
  ['gh p"r" m"erge" 17', "github", 17, undefined],
  ["gh pr m'erge' 17", "github", 17, undefined],
  ['g"h" pr merge 17', "github", 17, undefined],
  ['gh pr me""rge 1"7"', "github", 17, undefined],
  ["  gh\tpr  merge   17  ", "github", 17, undefined],
  ["glab mr merge 12", "gitlab", 12, undefined],
  ["glab mr merge", "gitlab", undefined, undefined],
  ["glab mr merge 12 --squash -d --rebase -y --auto-merge=false", "gitlab", 12, undefined],
  ["glab mr merge 12 -s --remove-source-branch -r --yes", "gitlab", 12, undefined],
  ['glab mr merge 12 -m "msg here" --squash-message s --sha abc', "gitlab", 12, undefined],
  ["glab mr merge -m 17", "gitlab", undefined, undefined],
  ["glab mr merge 12 --message=x --sha=abc", "gitlab", 12, undefined],
  ["glab -R group/sub/proj mr merge 12", "gitlab", 12, "group/sub/proj"],
  ["glab --repo g/p mr merge 3", "gitlab", 3, "g/p"],
  ["glab mr merge 3 -R a/b", "gitlab", 3, "a/b"],
];
for (const [cmd, forge, n, repo] of ACCEPTED) {
  const m = readMergeCommand(cmd);
  assert(
    m.kind === "merge" && m.forge === forge && m.prNumber === n && m.repo === repo,
    `accepted: ${JSON.stringify(cmd)} → ${forge} #${n ?? "branch"} ${repo ?? ""} (${show(m)})`,
  );
}

// ------------------------------------------------------------ refused shapes
const REFUSED: string[] = [
  // Chains, pipes, newlines, background, redirections.
  "cd x && gh pr merge 17",
  "cd /data/3 && gh pr merge",
  "git status; gh pr merge 12 --squash",
  "gh pr merge 17 && gh pr merge 5",
  "gh pr merge 17 & gh pr merge 5",
  "gh pr merge 17 &gh pr merge 5",
  "echo hi\ngh pr merge 17",
  "gh pr merge 17\nglab mr merge 5",
  "gh pr merge 17\r",
  "gh pr merge 17 >/dev/null",
  "gh pr merge 17>/dev/null",
  "gh pr merge &>/dev/null 17",
  "gh pr merge &>>/dev/null 17",
  'gh pr merge 17 --subject "fix: a b" 2>&1 &',
  "nohup gh pr merge 17 &",
  "gh pr merge 17 # it's",
  "echo hi # gh pr merge 17",
  "gh pr merge 17 | cat",
  // Substitutions, nested and glued.
  "$(echo x)gh pr merge 9",
  "$(true) gh pr merge 12",
  "`true`gh pr merge 4",
  "x=$(gh pr merge 17)",
  "x=`gh pr merge 12`",
  'echo "$(gh pr merge 17)"',
  'gh pr merge 17 "$(gh pr merge 5)"',
  "gh pr merge 17 $(gh pr merge 5)",
  "gh pr merge 17 `gh pr merge 5`",
  'gh pr view "$(gh pr merge 5)"',
  "x=$(y=$(gh api repos/o/r/pulls/17/merge))",
  "cat <(gh pr merge 5)",
  "gh pr view 1 >(gh pr merge 5)",
  'gh pr merge 17 --subject "$(date)"',
  "gh pr merge $PR",
  'gh pr merge "$N"',
  "gh pr merge 1 $X",
  // Subshells, groups, control flow, functions, heredocs.
  "(gh pr merge 17)",
  "{ gh pr merge 12; }",
  "if true; then gh pr merge 12; fi",
  "for i in 1; do gh pr merge 12; done",
  "case x in 1) gh pr merge 17;; esac",
  "function f { gh pr merge 12; }; f",
  "sh <<EOF\ngh pr merge 12\nEOF",
  "cat <<'EOF'\ndon't\nEOF\ngh pr merge 17",
  'bash <<< "gh pr merge 12"',
  // Interpreters, eval, xargs, sourcing, alias.
  "echo gh pr merge 12 | sh",
  'echo "gh pr merge 12" | sh',
  "printf 'gh pr merge 12' | bash",
  "echo 17 | xargs -I{} gh pr merge {}",
  "echo 17 | xargs gh pr merge",
  "echo gh pr merge 12 > x.sh; sh x.sh",
  "source <(echo gh pr merge 12)",
  'bash -c "gh pr merge 17"',
  "bash -c 'gh pr merge 12 --squash'",
  "bash -c gh pr merge 17",
  "bash -c gh\\ pr\\ merge\\ 17",
  "bash -c gh' pr merge 17'",
  "sh -c 'glab mr merge 7'",
  'eval "gh pr merge 17"',
  "eval gh pr merge 17",
  'eval $"gh pr merge 17"',
  "alias m='gh pr merge'; m 17",
  // Wrappers and prefixes.
  "env gh pr merge 17",
  "env FOO=1 gh pr merge 12",
  "FOO=1 gh pr merge 12",
  "GH_REPO=a/b gh pr merge 12",
  "command gh pr merge 17",
  "builtin gh pr merge 17",
  "nice gh pr merge 12",
  "nice -n 5 glab mr merge 3",
  "time gh pr merge 12",
  "sudo gh pr merge 17",
  "exec gh pr merge 12",
  "timeout 30 gh pr merge 17",
  "nohup gh pr merge 17",
  "stdbuf -oL gh pr merge 17",
  "oo gh pr merge 12 --squash",
  "! gh pr merge 12",
  "/usr/bin/gh pr merge 17",
  "./gh pr merge 17",
  "GH pr merge 17",
  "./g pr merge 17",
  "hubcli mr merge 4",
  "gh pr MERGE 17",
  // Quoting and escaping that hides the verb or the number.
  "\\gh pr merge 17",
  "gh pr mer\\\nge 17",
  "gh pr m$'\\x65'rge 17",
  "$'\\x67h' pr merge 17",
  'gh pr m$"erge" 17',
  'gh pr merge 17 "unterminated',
  "gh pr merge '17",
  "{gh,pr,merge,17}",
  "gh pr {merge,view} 17",
  "gh pr merge 17 --subject é",
  "gh pr merge 17",
  "gh pr merge\v17",
  // Wrong targets and flags.
  "gh pr merge https://github.com/o/r/pull/17",
  "gh pr merge feature/x",
  "gh pr merge 017",
  "gh pr merge 0",
  "gh pr merge 99999999999999999999",
  "gh pr merge --squash 17",
  "gh pr merge 17 18",
  "gh pr merge 17 --admin",
  // Deferred merges run after the check, against a later head.
  "gh pr merge 17 --auto",
  "gh pr merge --squash --auto",
  "glab mr merge 12 --when-pipeline-succeeds",
  "glab mr merge 12 --auto-merge",
  "glab mr merge 12 --auto-merge=true",
  // A repo value never starts with a dash.
  "gh -R -x/y pr merge 17",
  "gh pr merge 17 --squash=true",
  "gh pr merge 17 -sd",
  "gh pr merge 17 --",
  "gh pr merge 17 --subject",
  "gh pr merge 17 --unknown",
  "gh pr merge view 17",
  "gh -R a/b pr merge 17 --repo c/d",
  "gh pr merge 17 -R a/b -R a/b",
  "gh pr merge 17 -R=a/b",
  "gh pr merge 17 -Ro/r",
  'gh pr merge 17 --repo="o/r;id"',
  "gh pr merge 17 --repo=",
  "gh pr merge 17 -R",
  "gh -R host/o/r pr merge 17",
  "gh -R o pr merge 17",
  "gh pr --repo o/r merge 17",
  "glab mr merge 3 -R a/b --repo c/d",
  "glab mr merge 3 --repo=a/b",
  "glab --project o/r mr merge 12",
  "glab mr merge 12 --auto-merge",
  "glab mr merge -m",
  "glab mr merge 12 --delete-branch",
  "glab pr merge 12",
  "gh mr merge 12",
  // REST, GraphQL, other clients — refused whatever the method.
  "gh api repos/o/r/pulls/12/merge",
  "gh api -X PUT repos/o/r/pulls/17/merge",
  "gh api repos/o/r/pulls/12/merge -X GET",
  'gh api repos/o/r/pulls/12/merge "-X GET"',
  "gh api repos/o/r/pulls/12/merge --method GET",
  "gh -R o/r api repos/o/r/pulls/17/merge",
  "glab api /projects/1/merge_requests/12/merge -X PUT",
  "glab api projects/1/merge_requests/17/merge",
  "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'",
  "curl -X PUT https://api.github.com/repos/o/r/pulls/1/merge",
  "curl -X PUT -H 'PRIVATE-TOKEN: t' https://gitlab.example.com/api/v4/projects/1/merge_requests/2/merge",
  "wget --method=PUT https://api.github.com/repos/o/r/pulls/1/merge",
  "http PUT api.github.com/repos/o/r/pulls/1/merge",
  "hub merge https://github.com/o/r/pull/1",
  // Prose that names a merge next to a forge.
  'gh pr comment 5 --body "please merge"',
  "gh pr comment 5 --body 'we will gh pr merge 12 later'",
  'echo "gh pr merge 12"',
  'git commit -m "docs: explain gh pr merge 12"',
  "grep -rn 'gh pr merge' .",
  "gh alias set m 'pr merge'",
];
for (const cmd of REFUSED) {
  const m = readMergeCommand(cmd);
  assert(m.kind === "refused", `refused: ${JSON.stringify(cmd)} (${show(m)})`);
}

// ------------------------------------------------------------ not merges
const NOT_MERGES: string[] = [
  "gh pr view 17 --json mergeable,mergeStateStatus",
  "gh pr list --state merged",
  "gh pr checks 17",
  "git merge --ff-only origin/main",
  'git commit -m "fix: x"',
  "rg merge src/",
  "echo merge",
  "gh pr comment 5 --body-file x.md",
  "gh pr view 17; gh pr checks 17 && echo done",
  "gh api repos/o/r/pulls/17 --jq .mergeable",
  "cd x && git merge origin/main",
  "bun run smoke-tests/test-merge-guard.ts",
  "",
];
for (const cmd of NOT_MERGES) {
  const m = readMergeCommand(cmd);
  assert(m.kind === "none", `not a merge: ${JSON.stringify(cmd)} (${show(m)})`);
}

// ------------------------------------------------------------ the residual
// A merge assembled entirely from expansions spells no merge word: outside the
// honest-agent threat model, documented in docs/troubleshooting.md.
for (const cmd of ["gh pr m$X 17", "$G pr m$X 17", "gh pr m$(echo e)rge 17", "gh pr m?rge 17", "bash x.sh"]) {
  assert(readMergeCommand(cmd).kind === "none", `documented residual (not read as a merge): ${cmd}`);
}

// ------------------------------------------------------------ the real hook
await setupLedgerPath();
for (const cmd of [
  "cd x && gh pr merge 17",
  "gh api repos/o/r/pulls/12/merge",
  'gh pr comment 5 --body "please merge"',
]) {
  const r = await hookDecision(cmd, GOOD_ENTRIES);
  assert(r.block, `hook refuses even with a passing ledger: ${JSON.stringify(cmd)}`);
  assert(r.calls.length === 0, `…before any forge call: ${JSON.stringify(cmd)}`);
  const reason = r.reason ?? "";
  assert(
    reason.includes("pr merge [N]") &&
      reason.includes("--body-file") &&
      reason.includes("git commit -F") &&
      reason.includes("PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1"),
    "…naming the accepted form, --body-file, git commit -F and the escape hatch",
  );
}
{
  const r = await hookDecision("gh pr merge 12 -R o/r", GOOD_ENTRIES);
  assert(!r.block, "hook allows an accepted form with a passing ledger");
  assert(
    r.calls.some((c) => c.startsWith("gh pr view 12 ") && c.endsWith("-R o/r")),
    "…reading the PR the command names, in the repo it names",
  );
}
{
  const r = await hookDecision("gh pr merge --squash", GOOD_ENTRIES);
  assert(!r.block, "hook resolves a number-less merge from the current branch");
  assert(r.calls.some((c) => c.includes("--json number")), "…via gh pr view --json number");
}
{
  // The PR read follows the repo's forge (github here); a glab merge would act
  // on a GitLab MR the guard never read.
  const r = await hookDecision("glab mr merge 12", GOOD_ENTRIES);
  assert(r.block && /merges on gitlab but this repo's forge is github/.test(r.reason ?? ""), "hook refuses a merge aimed at the other forge");
}
{
  // Fail closed: a reader that throws (here on a non-string command) refuses.
  const r = await hookDecision({} as never, GOOD_ENTRIES);
  assert(r.block && /could not analyse this command/.test(r.reason ?? ""), "hook refuses when the reader throws");
}
for (const cmd of ["gh pr view 17 --json mergeable", "git merge --ff-only origin/main"]) {
  const r = await hookDecision(cmd, []);
  assert(!r.block && r.calls.length === 0, `hook allows a non-merge untouched: ${cmd}`);
}
teardownLedger();

// ------------------------------------------------------------ fail closed
assert(analyseRefusal(null) === "null", "analyseRefusal renders a thrown null without throwing");
assert(analyseRefusal(new RangeError("deep")) === "RangeError: deep", "…and an Error by name");

// ------------------------------------------------------------ performance
{
  const big = `gh pr merge 17 --subject '${"merge ".repeat(5000)}'`;
  const flood = `gh ${"$(merge ".repeat(5000)}`;
  const plain = `git commit -m '${"x".repeat(30_000)}'`;
  for (const [label, cmd, kind] of [
    ["30 kB accepted merge", big, "merge"],
    ["30 kB substitution flood", flood, "refused"],
    ["30 kB non-merge", plain, "none"],
  ] as const) {
    const t0 = performance.now();
    const m = readMergeCommand(cmd);
    const dt = performance.now() - t0;
    assert(cmd.length >= 30_000 && m.kind === kind, `perf: ${label} → ${kind}`);
    assert(dt < 50, `perf: ${label} analysed in ${dt.toFixed(1)}ms (< 50ms; hook budget 30s)`);
  }
}

// ------------------------------------------------------------ forge-detect git bound
{
  const never: MergeExecFn = () => new Promise(() => {});
  const t0 = performance.now();
  const d = await detectForge("/nonexistent", {
    execFn: never,
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
  const r = await readMergeTarget(never, "/nonexistent", 17, {
    execFn: never,
    env: {},
    forgeConfigContent: "",
    execTimeoutMs: 50,
  });
  if (prev !== undefined) process.env.PI_ENSEMBLE_FORGE = prev;
  assert(!r.ok && /could not determine the forge/.test(r.ok ? "" : r.reason), "stalled git → the merge target read refuses");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
