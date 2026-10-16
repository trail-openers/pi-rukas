#!/usr/bin/env bun
/**
 * The size bound, asserted directly (#955 restored by #1417, widened round 1).
 *
 * `readMergeCommand` applies `analysisBound` first, so every bound assertion
 * the decision matrix makes does so through the classifier — which means the
 * predicate itself is never seen. That matters here specifically: the bound is
 * the one rule whose failure mode is invisible from the classifier's side. An
 * over-broad bound looks like a working guard (a read is held — an agent works
 * around it); an under-broad one is a #955 recurrence (a 40 kB merge command
 * reaches current-branch PR resolution), and only the predicate is positioned
 * to tell those apart.
 *
 * The three questions this file asks of `exceedsAnalysisBound` directly:
 *   1. short never bounds, whatever it contains;
 *   2. long + forge + merge word bounds — including the doors spelled with an
 *      HTTP client or a script runner rather than `gh`/`glab` (the REST merge
 *      of #955, the reason the forge test is the trigger's `FORGE_WORD`);
 *   3. long + forge + NO merge word does not (the round-1 widening — a long
 *      read is a read), and long without a forge word never does.
 * Plus: the bound's own refusal is the bare code plus its detail, and nothing
 * the bound refuses is ever reported as a merge.
 */

import { readMergeCommand } from "../src/merge-allowlist.ts";
import {
  MERGE_COMMAND_SIZE_BOUND,
  analysisBound,
  exceedsAnalysisBound,
} from "../src/merge-size.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

/** One character past the bound, padded with a benign word. */
const pad = (extra = 0) => "y".repeat(MERGE_COMMAND_SIZE_BOUND + 1 + extra);

// ------------------------------------------------------------ short never bounds
for (const cmd of [
  "gh pr merge 17",
  "gh pr merge 17 --subject merge",
  "gh api repos/o/r/pulls/17/merge",
  "glab mr merge 12 --auto-merge=false",
  `gh pr merge 17 --subject ${"x".repeat(MERGE_COMMAND_SIZE_BOUND - 30)}`,
]) {
  assert(
    !exceedsAnalysisBound(cmd) && analysisBound(cmd) === undefined,
    `a command at or under the bound is never held by it: ${cmd.slice(0, 40)}`,
  );
}

// ------------------------------------------------------------ long + merge word bounds
for (const cmd of [
  `gh pr merge 17 ${pad()}`,
  `gh pr merge --squash ${pad()}`,
  `glab mr merge 12 --auto-merge=false ${pad()}`,
  `gh api repos/o/r/pulls/1/merge ${pad()}`,
  `glab api projects/1/merge_requests/2/merge ${pad()}`,
  `gh pr merge 17 --subject 'merge ' ${pad()}`,
  `gh pr list --state open ${pad()} automerge`,
  `gh ${"$(merge ".repeat(5000)}`,
  `bash -c 'gh pr merge 17' ${pad()}`,
  `env gh pr merge 17 ${pad()}`,
  // #1417 round 2 (security): the same door spelled without `gh`/`glab`. The
  // bound's forge test is `FORGE_WORD` — the trigger's own set — so these take
  // the ledger-checked `too-large` path instead of running unbounded and
  // landing on the classifier's `not-a-forge-command` hold.
  `curl -X PUT https://api.github.com/repos/o/r/pulls/1/merge ${pad()}`,
  `wget --method=PUT https://api.github.com/repos/o/r/pulls/1/merge ${pad()}`,
  `hub merge o/r/1 ${pad()}`,
  `node -e 'octokit.pulls.merge({owner:"o",repo:"r",pull_number:1})' ${pad()}`,
]) {
  assert(
    exceedsAnalysisBound(cmd) === true,
    `a long merge-bearing command is bounded: ${cmd.slice(0, 45)}…`,
  );
  const m = readMergeCommand(cmd);
  // Never a merge, and never an unread pass either: the bound is the refusal,
  // named, with its length. That naming is what the hold text renders.
  assert(
    m.kind === "refused" && m.reason === "too-large",
    `…and the classifier refuses it as too-large: ${cmd.slice(0, 45)}… (${JSON.stringify(m).slice(0, 80)})`,
  );
  assert(
    m.kind === "refused" && (m.detail ?? "").includes(String(cmd.length)),
    `…naming the length that tripped it: ${cmd.slice(0, 45)}…`,
  );
}

// ------------------------------------------------------------ long + no merge word does not
for (const cmd of [
  `gh pr view 17 --json body ${pad()}`,
  `gh pr view 17 --json mergeable,mergeStateStatus ${pad()}`,
  `gh pr checks 17 ${pad()}`,
  `gh api repos/o/r/issues/250 --jq .[].name ${pad()}`,
  `gh api "repos/o/r/issues/248/labels?per_page=100" --jq ".[].name" ${pad()}`,
  `gh pr create --title x --body "release notes: ${pad()}"`,
  // No forge word at all: length is never a reason, whatever the text says.
  `git commit -m '${"x".repeat(MERGE_COMMAND_SIZE_BOUND * 4)}'`,
  `echo ${pad()}`,
]) {
  assert(
    exceedsAnalysisBound(cmd) === false,
    `a long command that spells no merge word is not bounded: ${cmd.slice(0, 45)}…`,
  );
  assert(
    readMergeCommand(cmd).kind === "none",
    `…and the classifier lets it through: ${cmd.slice(0, 45)}…`,
  );
}

// ------------------------------------------------------------ the bound is the number it says
assert(
  MERGE_COMMAND_SIZE_BOUND === 8000,
  `the bound is the documented 8000 (got ${MERGE_COMMAND_SIZE_BOUND})`,
);
// An HTTP client aimed at a forge merge endpoint IS bounded: the bound's forge
// test is the trigger's own `FORGE_WORD` set (curl/wget/http/hub/node/octokit/
// api.github.com/gitlab, …), so a 9 kB REST merge door takes the
// ledger-checked `too-large` path rather than running unbounded. Asserted in
// the block above; pinned here alongside the two exemptions that must NOT
// widen — a long read that spells no merge word, and a long command with no
// forge word at all.
assert(
  exceedsAnalysisBound(`curl -X PUT https://api.github.com/repos/o/r/pulls/1/merge ${pad()}`) ===
    true,
  "a long curl merge door is bounded by the forge-word test, not left to the classifier",
);
// The exemption that must never widen: a long forge-naming READ that spells no
// merge word is a read, whatever length it reaches — this is the #1417 symptom
// the round-1 widening removed, and it survives the forge-word widening above
// because the merge-word exemption is the second gate, not the first.
for (const cmd of [
  `http GET https://api.github.com/repos/o/r/pulls/1 ${pad()}`,
  `hub api repos/o/r/pulls/1 ${pad()}`,
  `curl https://api.github.com/repos/o/r/pulls/17 ${pad()}`,
]) {
  assert(
    exceedsAnalysisBound(cmd) === false && readMergeCommand(cmd).kind === "none",
    `a long forge READ with no merge word stays a read: ${cmd.slice(0, 45)}…`,
  );
}
// …and a long command naming NO forge word at all is never bounded, however
// many merge words it spells — length alone is not a reason.
for (const cmd of [
  `echo ${pad()} merge mergebranch automerge`,
  `git log ${pad()} merge pr merge`,
]) {
  assert(
    exceedsAnalysisBound(cmd) === false,
    `a long command with no forge word is never bounded: ${cmd.slice(0, 45)}…`,
  );
}

{
  const justUnder = `gh pr merge 17 ${"x".repeat(MERGE_COMMAND_SIZE_BOUND - "gh pr merge 17 ".length)}`;
  assert(justUnder.length === MERGE_COMMAND_SIZE_BOUND, "fixture sits exactly ON the bound");
  assert(!exceedsAnalysisBound(justUnder), "…which is not past it");
  assert(exceedsAnalysisBound(`${justUnder}y`), "one character more is");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
