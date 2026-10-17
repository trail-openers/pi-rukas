#!/usr/bin/env bun
/**
 * Headless S5 (#1025) — the merge-authority and evidence gate.
 *
 * The composition refuses a merge it has no written permission for, and the
 * refusal is attributable to the gate that made it. Every case here runs the
 * real runner (`runHeadless` → the driver → the merged step → the state file →
 * the exit code) over a cycle parked at the merge step, with the `exec` seam
 * answering every `gh`/`git` call — and, for the doctrine-denial and evidence
 * cases, an injected policy judge placed in front of whatever the doctrine read
 * produced.
 *
 * The three load-bearing properties the split-out cases assert:
 *
 *   - A green PR is not permission (#380): with every `gh` answer green and no
 *     doctrine grant, the cycle exits 10 and runs no forge merge. The denial is
 *     attributed to the doctrine READ at the cycle's base commit — the judge is
 *     a real seam injection, so the refusal comes from what the documents said
 *     (or could not be read from them), not from an env var switched off for the
 *     whole process. (That process-wide switch is what made the old doctrine-
 *     denial case vacuous.)
 *   - Even with a grant in hand, the evidence gate decides: BLOCKED state,
 *     failing checks, and a CLOSED PR are each refused, and each names its own
 *     gate's probe so the refusal cannot be hiding behind something downstream.
 *
 * Merge commands are never spelled as literals in this file or its fixture: the
 * mode-independent merge guard reads the bash command text of every tool call,
 * and a test that quotes the forbidden form trips it for a reason unrelated to
 * what the test asserts (#1390 / #1417).
 *
 * Shares `lib/headless-s5-harness.ts` with `test-headless-gates.ts`.
 */

import { EXIT } from "../src/headless/exit-code.ts";
import { MERGE_GRANT } from "./lib/headless-s5-fixture.ts";
import {
  assertEvidenceProbe,
  assertEvidenceReason,
  assertLogClean,
  initEnv,
  judgeThatAnswers,
  judgeThatRecords,
  mergedRun,
  restoreEnv,
} from "./lib/headless-s5-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

initEnv();

// ── 1. The composition refuses: green `gh`, no written grant → exit 10, no merge.
{
  const r = await mergedRun({ issue: 9001, grant: undefined, merge: "green" });
  assert(
    r.code === EXIT.handoff,
    `green PR + no doctrine grant → awaiting-human-merge → exit 10 (got ${r.code})`,
  );
  assert(
    r.state?.pipelineState.status === "handoff",
    `...and the cycle parks in handoff (got ${r.state?.pipelineState.status})`,
  );
  const cap = [...(r.state?.eventLog ?? [])].reverse().find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "awaiting-human-merge",
    `the cap is awaiting-human-merge (got ${cap?.kind === "cap-hit" ? cap.cap : cap?.kind})`,
  );
  assert(
    r.state?.pipelineState.mergeHold?.authorityGranted === false,
    "the recorded hold says the authority was not granted",
  );
  assert(
    r.log.mergeCmds.length === 0,
    `no forge merge ran — every \`gh\` answer was green and it still did not merge (${r.log.mergeCmds.length} attempted)`,
  );
  // The gate's ORDER is load-bearing here: authority is decided first and
  // evidence is gathered only when authority granted (`authority.granted ?
  // gatherMergeEvidence(...) : undefined`). A denial therefore reads the
  // doctrine and never calls gh — and that short-circuit is exactly what
  // makes "a green PR is not permission" true. Asserting a gh call here would
  // assert the opposite of the contract.
  assert(
    r.log.doctrineReads.some((c) => c.includes("AGENTS.md") && c.includes(r.baseSha)),
    `authority was decided from the doctrine at the cycle's base commit, not from gh's green answer (${r.log.doctrineReads.join(" | ") || "no doctrine read reached the seam"})`,
  );
  assert(
    r.log.calls.every((c) => !c.includes("mergeStateStatus,mergeable,state")),
    "the evidence gate was not consulted at all — a denied cycle does not get to ask gh whether it may merge",
  );
  assertLogClean(assert, r.log);
}

// ── 2. Doctrine present at base but unreadable at the gate → still exit 10.
// This case used to be VACUOUS: `PI_ENSEMBLE_POLICY_JUDGE=0` was set for the
// whole file, so `askPolicy` denied at its first line and never consulted the
// documents — the denial did not depend on the doctrine read at all, and a
// fixture whose doctrine handling was broken passed. The judge is now injected
// (an eager one that would grant the merge if it were handed any text), the
// process-wide kill-switch is set only for the cases that want it, and the read
// itself is asserted.
{
  const r = await mergedRun({
    issue: 9002,
    grant: MERGE_GRANT,
    merge: "green",
    refuseDoctrine: true,
    judge: judgeThatAnswers("permitted", MERGE_GRANT),
  });
  assert(
    r.code === EXIT.handoff,
    `doctrine unreadable at the gate → no grant → exit 10 (got ${r.code})`,
  );
  assert(
    r.state?.pipelineState.mergeHold?.authorityGranted === false,
    "the hold records the denial rather than a silent pass",
  );
  assert(r.log.mergeCmds.length === 0, "and nothing was merged");
  // The denial is attributed to the read: the gate asked for the doctrine at the
  // base commit, the seam refused it, and the eager judge was handed nothing to
  // quote. Break the fixture's doctrine handling and this is the assertion that
  // goes red — not the env var.
  assert(
    r.log.doctrineReads.some((c) => c.includes("AGENTS.md") && c.includes(r.baseSha)),
    `the gate attempted the \`git show <baseSha>:AGENTS.md\` read at the cycle's base commit (${r.log.doctrineReads.join(" | ") || "no doctrine read"})`,
  );
  assert(
    r.state?.pipelineState.mergeHold?.authoritySource === "none",
    `the hold's source is the absence of a grant, not a judge malfunction (got ${r.state?.pipelineState.mergeHold?.authoritySource})`,
  );
  assert(
    r.log.calls.every((c) => !c.includes("mergeStateStatus,mergeable,state")),
    "a doctrine denial short-circuits before the evidence gate — the eager judge cannot trade a green PR for permission",
  );
  assertLogClean(assert, r.log);
}

// ── 3. Even with a grant in hand, evidence gates the merge.
// `authority.granted` is not sufficient; the forge's own answer decides. The
// judge is injected so authority IS granted in these three cases — otherwise
// the cycle short-circuits on the authority gate and the evidence gate is never
// reached, which is how "blocked" and "unopen" passed for a reason unrelated to
// the gate they name.
{
  const r = await mergedRun({
    issue: 9003,
    grant: MERGE_GRANT,
    merge: "blocked",
    judge: judgeThatAnswers("permitted", MERGE_GRANT),
  });
  assert(
    r.code === EXIT.handoff,
    `mergeStateStatus BLOCKED → not merged → exit 10 (got ${r.code})`,
  );
  assert(
    r.state?.pipelineState.status !== "merged",
    "...and a cycle whose evidence refused never reaches merged",
  );
  assert(
    r.state?.pipelineState.mergeHold?.authorityGranted === true,
    `authority WAS granted, so the refusal came from the evidence gate (authoritySource ${r.state?.pipelineState.mergeHold?.authoritySource})`,
  );
  assertEvidenceProbe(assert, r);
  assertEvidenceReason(assert, r, "mergeStateStatus is BLOCKED", "BLOCKED");
  assert(
    r.state?.pipelineState.mergeHold?.evidenceReason?.includes("BLOCKED") === true,
    `the hold names the BLOCKED verdict as the reason (got ${r.state?.pipelineState.mergeHold?.evidenceReason})`,
  );
  assert(r.log.mergeCmds.length === 0, "and the BLOCKED PR was never merged");
  assertLogClean(assert, r.log);
}
{
  const r = await mergedRun({
    issue: 9004,
    grant: MERGE_GRANT,
    merge: "failing",
    judge: judgeThatAnswers("permitted", MERGE_GRANT),
  });
  assert(r.code === EXIT.handoff, `failing required checks → exit 10 (got ${r.code})`);
  assert(
    r.state?.pipelineState.mergeHold?.authorityGranted === true,
    "authority WAS granted, so the failing checks are what stopped it",
  );
  assertEvidenceProbe(assert, r);
  assertEvidenceReason(assert, r, "required checks failing", "failing-checks");
  assert(
    r.state?.pipelineState.mergeHold?.evidenceReason?.includes("checks failing") === true,
    `the hold names the failing check (got ${r.state?.pipelineState.mergeHold?.evidenceReason})`,
  );
  assert(r.log.mergeCmds.length === 0, "failing checks stop the merge before it is attempted");
  assertLogClean(assert, r.log);
}
{
  const r = await mergedRun({
    issue: 9005,
    grant: MERGE_GRANT,
    merge: "unopen",
    judge: judgeThatAnswers("permitted", MERGE_GRANT),
  });
  assert(r.code === EXIT.handoff, `a PR that is CLOSED, not OPEN → exit 10 (got ${r.code})`);
  assert(
    r.state?.pipelineState.mergeHold?.authorityGranted === true,
    "authority WAS granted, so the PR's own state is what stopped it",
  );
  assertEvidenceProbe(assert, r);
  // The prefix — not `includes("CLOSED")` — is the load-bearing assertion. The
  // fixture's wide `gh pr view` no longer says CLOSED for this verdict either,
  // so a hold reason merely CONTAINING the word could come from somewhere else;
  // the exact prefix `gatherMergeEvidence` builds can only come from the gate.
  assertEvidenceReason(assert, r, "PR is CLOSED, not OPEN", "not-OPEN");
  assert(
    r.state?.pipelineState.mergeHold?.evidenceReason?.includes("CLOSED") === true,
    `the hold names the CLOSED state as the reason (got ${r.state?.pipelineState.mergeHold?.evidenceReason})`,
  );
  assert(
    // `calls` holds the command LINES the seam was handed, never the answers it
    // gave back — a JSON blob in a command line is not an answer, so asserting
    // on `calls` could not fail however CLOSED the wide read was. The answers
    // are recorded separately, and the exclusivity lives on the field that
    // actually carries them: `prViewAnswers`.
    r.log.prViewAnswers.every((a) => !a.includes('"state":"CLOSED"')),
    `no wide \`gh pr view\` ANSWER said CLOSED — only the evidence gate's own probe reported the closed PR (${r.log.prViewAnswers.join(" | ") || "no wide prView was asked"})`,
  );
  assert(r.log.mergeCmds.length === 0, "a PR that is not OPEN is never merged");
  assertLogClean(assert, r.log);
}

// ── 4. The positive control: everything green → exactly one merge, and the
// forge then says MERGED.
// Every refusal case above asserts `mergeCmds.length === 0`. A field that is
// always zero cannot falsify anything — this case drives the SAME field to 1
// under the same harness, so a fixture whose merge matcher never fired would
// fail HERE rather than flattering every refusal case below it. The post-merge
// `gh pr view` answer flips to MERGED only after the merge was asked for, so
// `executeAndVerifyMerge`'s verification is a real confirmation, not a
// hardcoded answer.
{
  const r = await mergedRun({
    issue: 9006,
    grant: MERGE_GRANT,
    merge: "merged",
    judge: judgeThatAnswers("permitted", MERGE_GRANT),
  });
  assert(r.code === EXIT.merged, `grant + permitting judge + green → exit 0 (got ${r.code})`);
  assert(
    r.state?.pipelineState.status === "merged",
    `the cycle reaches merged (got ${r.state?.pipelineState.status})`,
  );
  assert(
    r.log.mergeCmds.length === 1,
    `exactly one forge merge was issued (${r.log.mergeCmds.join(" | ") || "none"})`,
  );
  const merges = r.log.mergeCmds.length;
  // The forge adapter's wide `gh pr view` is the only read whose ANSWER carries
  // `"state":"MERGED"`; the exec seam records command lines, so the ordering
  // assertion below is made on the command stream and the content assertion on
  // what the seam actually handed back (`prViewAnswers` records them).
  assert(
    r.log.prViewAnswers.some((a) => a.includes('"state":"MERGED"')),
    `the forge's post-merge prView was consulted, and it says MERGED (merge cmd rows: ${merges})`,
  );
  assert(
    // Ordered: the wide MERGED answer must come AFTER the merge was asked for.
    // A fixture that hardcoded MERGED from the start would satisfy the check
    // above without any merge having happened.
    r.log.prViewAnswers.findIndex((a) => a.includes('"state":"MERGED"')) > 0 &&
      r.log.prViewAnswers[0]?.includes('"state":"OPEN"') === true,
    "the first prView said OPEN and a later one said MERGED — the flip followed the merge command",
  );
  assert(
    r.log.mergeCmds.length === 1,
    "and the merged outcome is not an accident of a merge that never ran",
  );
  assertLogClean(assert, r.log);
}

// ── 5. The judge seam is test-only: outside the offline harness an injected
// judge is IGNORED (#1025 security).
// `runHeadless` forwards `policyJudgeFn` to the driver, so without a gate an
// exported-API caller could speak for the merge-authority judge. The gate is
// `PI_ENSEMBLE_FORBID_LIVE_SPAWN=1` — the offline suite's own setting, under
// which the real spawn-side judge could not answer anyway. With the ban dropped
// the eager judge that WANTS to grant must never be consulted: its call counter
// stays at zero and the cycle denies.
//
// `forcePolicyJudgeOff` sets `PI_ENSEMBLE_POLICY_JUDGE=0` for this case, which
// is what keeps it OFF the real judge — the real path would spawn a live child,
// and an offline test must never do that. With the switch set, `askPolicy`
// denies at its first line, so the deny below is attributed to the injected
// judge being ignored (counter 0) plus the real judge being switched off, not
// to a spawn.
{
  const calls: Array<{ prompt: string }> = [];
  const r = await mergedRun({
    issue: 9007,
    grant: MERGE_GRANT,
    merge: "merged",
    judge: judgeThatRecords(calls, "permitted", MERGE_GRANT),
    forbidLiveSpawn: false,
    forcePolicyJudgeOff: true,
    captureEnv: ["PI_ENSEMBLE_FORBID_LIVE_SPAWN", "PI_ENSEMBLE_POLICY_JUDGE"],
  });
  // The harness really did drop the ban for this case — without this, the case
  // would pass because the variable was never unset rather than because the
  // merged step ignored the seam.
  assert(
    r.env.PI_ENSEMBLE_FORBID_LIVE_SPAWN === undefined,
    `the harness dropped the live-spawn ban for this case (env saw ${JSON.stringify(r.env.PI_ENSEMBLE_FORBID_LIVE_SPAWN)})`,
  );
  assert(
    r.env.PI_ENSEMBLE_POLICY_JUDGE === "0",
    `the real judge was switched off so the offline case never spawns (env saw ${JSON.stringify(r.env.PI_ENSEMBLE_POLICY_JUDGE)})`,
  );
  assert(
    calls.length === 0,
    `the injected judge was never asked (it was called ${calls.length} time(s))`,
  );
  assert(
    r.code === EXIT.handoff,
    `an injected judge with no harness to authorise it grants nothing → exit 10 (got ${r.code})`,
  );
  assert(
    r.state?.pipelineState.mergeHold?.authorityGranted === false,
    `the hold records that authority was NOT granted (got ${r.state?.pipelineState.mergeHold?.authorityGranted})`,
  );
  assert(r.log.mergeCmds.length === 0, "and nothing was merged on an unauthorised judge");
  assertLogClean(assert, r.log);
}

restoreEnv();

console.log(`\nexit ${exit}`);
process.exit(exit);
