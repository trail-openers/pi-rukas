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
 *
 * TWO PREDICATES, PINNED SEPARATELY. `exceedsAnalysisBound` is the matcher's
 * (fail-closed: length + forge word, nothing else); `exceedsClassifierBound`
 * is the classifier's (that, plus the merge-shape test that #1417's read
 * exemption rides on). The questions above are the CLASSIFIER's, so they ask
 * `exceedsClassifierBound` — and the last block pins the matcher's predicate
 * at its own seam: the two differ on exactly one axis, and a predicate that
 * silently absorbs the other's clause is invisible through `readMergeCommand`,
 * which only ever consults one of them.
 */

import { readMergeCommand } from "../src/merge-allowlist.ts";
import { FORGE_WORD, MERGE_WORD as MERGE_WORD_RE } from "../src/merge-lex-views.ts";
import {
  MERGE_COMMAND_SIZE_BOUND,
  analysisBound,
  exceedsAnalysisBound,
  exceedsClassifierBound,
} from "../src/merge-size.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

/** One character past the bound, padded with a benign word. */
const pad = (extra = 0) => "y".repeat(MERGE_COMMAND_SIZE_BOUND + 1 + extra);

/**
 * The merge doors #1417 round 2 widened the forge test for: each names a forge
 * only through `FORGE_WORD` (curl / wget / hub / node + octokit / api.github.
 * com), never `gh` or `glab`. Used by BOTH predicate blocks below so the one
 * axis they differ on is the only thing that differs between them.
 */
const longNonCliMergeDoors = (): string[] => [
  `curl -X PUT https://api.github.com/repos/o/r/pulls/1/merge ${pad()}`,
  `wget --method=PUT https://api.github.com/repos/o/r/pulls/1/merge ${pad()}`,
  `hub merge o/r/1 ${pad()}`,
  `node -e 'octokit.pulls.merge({owner:"o",repo:"r",pull_number:1})' ${pad()}`,
];

/**
 * The shapes on the ONE axis the two predicates differ on: long, naming a
 * forge word, spelling NO merge word, verb pair or GraphQL mutation. Two
 * families, because the classifier must be refused by the shape test from both
 * sides — a predicate that absorbed the other's clause fails one of them:
 *
 *   - long READS naming a forge (`gh pr view`, a plain GET) — the #1417 read
 *     the classifier must let run while the matcher still holds it;
 *   - long commands naming NO forge word at all — exempt under both, since
 *     nothing in them can be a merge door.
 *
 * The non-CLI merge doors (curl / wget / hub / node + octokit / api.github.
 * com — a forge named only through `FORGE_WORD`, never `gh`/`glab`) are NOT
 * here: they spell the merge word, so both predicates bound them. They carry
 * their own block below.
 */
const longNoMergeWordCommands = (): string[] => [
  `gh pr view 17 --json body ${pad()}`,
  // #1417's own example: the merge-state FIELDS are a read — the field-name
  // list contains "merge", so this is a fixture the word test below must not
  // collapse. Its no-merge-word-ness is pinned against the trigger's own set.
  `gh pr view 17 --json mergeable,mergeStateStatus ${pad()}`,
  `gh api repos/o/r/issues/250 --jq .[].name ${pad()}`,
  `gh api "repos/o/r/issues/248/labels?per_page=100" --jq ".[].name" ${pad()}`,
  `gh pr create --title x --body "release notes: ${pad()}"`,
  `http GET https://api.github.com/repos/o/r/pulls/1 ${pad()}`,
  `hub api repos/o/r/pulls/1 ${pad()}`,
  `curl https://api.github.com/repos/o/r/pulls/17 ${pad()}`,
  `git commit -m '${"x".repeat(MERGE_COMMAND_SIZE_BOUND * 4)}'`,
  `echo ${pad()}`,
];

// ------------------------------------------------------------ short never bounds
for (const cmd of [
  "gh pr merge 17",
  "gh pr merge 17 --subject merge",
  "gh api repos/o/r/pulls/17/merge",
  "glab mr merge 12 --auto-merge=false",
  `gh pr merge 17 --subject ${"x".repeat(MERGE_COMMAND_SIZE_BOUND - 30)}`,
]) {
  assert(
    !exceedsAnalysisBound(cmd) && !exceedsClassifierBound(cmd) && analysisBound(cmd) === undefined,
    `a command at or under the bound is never held by either predicate: ${cmd.slice(0, 40)}`,
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
  ...longNonCliMergeDoors(),
]) {
  assert(
    exceedsClassifierBound(cmd) === true && exceedsAnalysisBound(cmd) === true,
    `a long merge-bearing command is bounded by BOTH predicates: ${cmd.slice(0, 45)}…`,
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
for (const cmd of longNoMergeWordCommands()) {
  assert(
    exceedsClassifierBound(cmd) === false,
    `a long command that spells no merge word is not bounded by the CLASSIFIER predicate: ${cmd.slice(0, 45)}…`,
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
); // The exemption that must never widen: a long forge-naming READ that spells no
// merge word is a read, whatever length it reaches — this is the #1417 symptom
// the round-1 widening removed, and it survives the forge-word widening above
// because the merge-word exemption is the second gate, not the first.
for (const cmd of [
  `gh pr checks 17 ${pad()}`,
  `gh api repos/o/r/issues/251/timeline --jq ".[].event" ${pad()}`,
]) {
  assert(
    exceedsClassifierBound(cmd) === false && readMergeCommand(cmd).kind === "none",
    `a long forge READ with no merge word stays a read: ${cmd.slice(0, 45)}…`,
  );
}
// …and a long command naming NO forge word at all is never bounded by either
// predicate, however many merge words it spells — length alone is not a reason.
for (const cmd of [
  `echo ${pad()} merge mergebranch automerge`,
  `git log ${pad()} merge pr merge`,
]) {
  assert(
    exceedsAnalysisBound(cmd) === false && exceedsClassifierBound(cmd) === false,
    `a long command with no forge word is never bounded: ${cmd.slice(0, 45)}…`,
  );
}

// ------------------------------------------- the matcher's predicate, at its own seam
//
// The two predicates differ on ONE axis, and the classifier cannot see it:
// `readMergeCommand` consults only `exceedsClassifierBound`, so if the merge-
// shape clause moved into `exceedsAnalysisBound` every assertion above still
// passed — while the fail-closed caller would hand a long read to its own
// "is this a merge?" seam instead of holding it. So the matcher's predicate is
// pinned here, on its own. Both families of the long-no-merge-word shape are
// asserted: a forge-naming READ the matcher holds while the classifier runs,
// and a forge-less command (bounded by neither, since nothing in it can be a
// merge door). The non-CLI merge doors, which spell the merge word and are
// therefore bounded by BOTH, are the third shape and are asserted last.
for (const cmd of longNoMergeWordCommands()) {
  const namesForge = FORGE_WORD.test(cmd);
  assert(
    !MERGE_WORD_RE.test(cmd),
    `the fixture really spells no merge word under the classifier's own word set — otherwise the pair below proves nothing: ${cmd.slice(0, 45)}…`,
  );
  assert(
    exceedsAnalysisBound(cmd) === namesForge && exceedsClassifierBound(cmd) === false,
    `long + no merge word: matcher ${namesForge ? "holds (a fail-closed caller cannot ask what it spells)" : "exempts (no forge word, so nothing in it can be a merge door)"}, classifier exempts: ${cmd.slice(0, 45)}…`,
  );
  assert(
    analysisBound(cmd) === undefined && readMergeCommand(cmd).kind === "none",
    `…and it reaches the classifier, whose own answer for it is none: ${cmd.slice(0, 45)}…`,
  );
}
// …and the non-CLI merge doors: bounded by BOTH predicates, which is what keeps
// this block from reading as "the two predicates always disagree". A long REST
// merge door named only by `curl`/`octokit`/api.github.com — #955's door, #1417
// round 2's widening — is held by the matcher AND by the classifier.
for (const cmd of longNonCliMergeDoors()) {
  assert(
    exceedsAnalysisBound(cmd) === true && exceedsClassifierBound(cmd) === true,
    `a long non-gh forge-shaped merge door is bounded under BOTH predicates: ${cmd.slice(0, 45)}…`,
  );
  assert(
    analysisBound(cmd)?.reason === "too-large",
    `…and the classifier refuses it as too-large rather than reading it: ${cmd.slice(0, 45)}…`,
  );
}
{
  // The exemption the matcher must never take on: a long command naming a
  // forge word while spelling NO merge word anywhere. `exceedsAnalysisBound`
  // holds it — a fail-closed caller that stops reading must not then say "not
  // a merge" — and only `exceedsClassifierBound` exempts it, because the
  // classifier's own answer below the bound is `none` anyway.
  const noMergeWord = `curl https://api.github.com/repos/o/r/pulls/17 ${pad()}`;
  assert(
    exceedsAnalysisBound(noMergeWord) === true,
    "the matcher's predicate is unconditional past the bound: a long forge-shaped command is held whatever it spells",
  );
  assert(
    exceedsClassifierBound(noMergeWord) === false,
    "the classifier's predicate is the only one carrying #1417's no-merge-word exemption",
  );
  assert(
    !MERGE_WORD_RE.test(noMergeWord),
    "the fixture really spells no merge word — otherwise both assertions above prove nothing",
  );
}

{
  const justUnder = `gh pr merge 17 ${"x".repeat(MERGE_COMMAND_SIZE_BOUND - "gh pr merge 17 ".length)}`;
  assert(justUnder.length === MERGE_COMMAND_SIZE_BOUND, "fixture sits exactly ON the bound");
  assert(
    !exceedsAnalysisBound(justUnder) && !exceedsClassifierBound(justUnder),
    "…which is not past it (under either predicate)",
  );
  assert(
    exceedsAnalysisBound(`${justUnder}y`) && exceedsClassifierBound(`${justUnder}y`),
    "one character more is (under either predicate)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
