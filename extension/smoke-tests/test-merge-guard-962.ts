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
merges('echo "$(gh pr merge 17)"', 17);
merges('echo "`gh pr merge 17`"', 17);
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

console.log(`\nexit ${exit}`);
process.exit(exit);
