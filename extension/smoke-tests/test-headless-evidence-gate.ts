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
  assertLogClean,
  initEnv,
  judgeThatAnswers,
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
  assert(
    r.state?.pipelineState.mergeHold?.evidenceReason?.includes("CLOSED") === true,
    `the hold names the CLOSED state as the reason (got ${r.state?.pipelineState.mergeHold?.evidenceReason})`,
  );
  assert(r.log.mergeCmds.length === 0, "a PR that is not OPEN is never merged");
  assertLogClean(assert, r.log);
}

restoreEnv();

console.log(`\nexit ${exit}`);
process.exit(exit);
