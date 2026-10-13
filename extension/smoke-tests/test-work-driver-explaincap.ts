#!/usr/bin/env bun
/**
 * #543 F4(i) — explainCap renders a defined trigger line from capEvidence
 * for BOTH cap kinds. The switch is NOT compile-exhaustive: a missing case
 * returns the fallback "step failed: ..." string, so this is the canary.
 * Split from test-work-driver-pr4.ts (AGENTS.md §12 file-size limit).
 */

import { explainCap } from "../src/work-driver-explain.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { appendDevelopVerifyFailure } from "../src/work-develop-verify-failure.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function runExplainCapCanaries() {
  // (i) explainCap renders a defined (non-undefined) trigger line from
  // capEvidence for both caps. The switch is NOT compile-exhaustive, so the
  // canary is the gate: a missing case returns the fallback "step failed: ..."
  // string rather than the cap-specific sentence.
  for (const [cap, kind, needle] of [
    ["loop-detected", "loop", "looped on"],
    ["token-budget", "token-budget", "token budget"],
  ] as const) {
    let s = initialState(543, 1_000_000);
    s = { ...s, pipelineState: { ...s.pipelineState, currentStep: "handoff" } };
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        // #544 — CapEvidence is a discriminated union: the kind's required
        // fields (count for loop, the budget arithmetic for token-budget)
        // must be present.
        capEvidence:
          kind === "loop"
            ? { kind, count: 10, tool: "bash", fingerprint: "ls /a" }
            : { kind, budgetTokens: 100_000, usedTokens: 110_000 },
      },
    };
    s = appendEvent(s, {
      kind: "cap-hit",
      at: 2,
      cap,
      reviewRound: 1,
      nextStep: "handoff",
    } as Parameters<typeof appendEvent>[1]);
    const line = explainCap(cap, s);
    assert(
      typeof line === "string" && line.includes(needle),
      `explainCap(${cap}) renders the trigger evidence (${needle})`,
    );
  }

  // #981 — `lens-fix-reposition` must render its SPECIFIC sentence, not the
  // generic `step failed: …` fallback. The switch is not compile-exhaustive
  // (new caps land in the `cap-hit` union but a missing case here silently
  // falls to the fallback), so this is the canary for the reposition guard:
  // without the case the line reads "step failed: lens-fix-reposition" and
  // the operator loses the guard's explanation entirely.
  {
    let s981 = initialState(981, 1_000_000);
    s981 = { ...s981, pipelineState: { ...s981.pipelineState, currentStep: "handoff" } };
    s981 = appendEvent(s981, {
      kind: "cap-hit",
      at: 2,
      cap: "lens-fix-reposition",
      reviewRound: 2,
      nextStep: "handoff",
      evidence:
        "diverged: worktree has diverged from the branch tip 01234567 — the tree holds commits the branch does not: aaa1111",
      lensWorktreePath: "/tmp/wt-981",
    } as Parameters<typeof appendEvent>[1]);
    const line = explainCap("lens-fix-reposition", s981);
    assert(
      typeof line === "string" &&
        line.includes("lens-fix reposition guard could not establish the correct base"),
      "explainCap(lens-fix-reposition) renders the specific reposition sentence",
    );
    assert(
      !line.startsWith("step failed:"),
      "explainCap(lens-fix-reposition) does NOT fall to the generic 'step failed' fallback",
    );
  }
}

runExplainCapCanaries();

// #1137 — a verify-failed:develop cap whose cap-hit carries evidence: the
// handoff "Why" shows the evidence string, not "(evidence detail missing
// from state)". The fix-pass park writes its detail on the cap-hit's
// `evidence` field, not on verifyEvidence.failures — the renderer must read
// the former.
{
  const evidence =
    "adversarial fix pass: the diff of docs is byte-identical to its pre-pass state — nothing was fixed";
  let s = initialState(1137, 1_000_000);
  s = { ...s, pipelineState: { ...s.pipelineState, currentStep: "handoff" } };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 2,
    cap: "verify-failed:develop",
    reviewRound: 1,
    nextStep: "handoff",
    evidence,
  } as Parameters<typeof appendEvent>[1]);
  const line = explainCap("verify-failed:develop", s);
  assert(
    typeof line === "string" && line.includes(evidence),
    `explainCap(verify-failed:develop) shows the cap's evidence string`,
  );
  assert(
    !line.includes("evidence detail missing from state"),
    "explainCap(verify-failed:develop) does NOT say 'evidence detail missing' when the cap carries evidence",
  );
  // The full handoff markdown also carries the evidence in the "Why" section.
  s = { ...s, pipelineState: { ...s.pipelineState, status: "handoff" as const } };
  const md = renderHandoffMarkdown(s);
  assert(
    md.includes("byte-identical"),
    "handoff markdown: the 'Why' section carries the cap's evidence string",
  );
  assert(
    !md.includes("evidence detail missing from state"),
    "handoff markdown: no 'evidence detail missing' when the cap carries evidence",
  );
}

// #1137 — a REAL develop verify-failure cap (appendDevelopVerifyFailure) carries
// evidence too, but the Why must keep the per-failure bullets with the fence
// attribution: the cap's evidence is only a join of the same failures, so the
// fix-pass precedence must not apply to it.
{
  const failure = "task-a: FAIL — fence violation: src/main.rs (declared by task-d)";
  const gate = {
    failures: [failure],
    fenceViolations: [
      { kind: "sibling-declared", workstreamId: "task-a", file: "src/main.rs", declaredById: "task-d" },
    ],
  } as unknown as Parameters<typeof appendDevelopVerifyFailure>[1];
  let s = initialState(1137, 1_000_000);
  s = { ...s, pipelineState: { ...s.pipelineState, currentStep: "develop" } };
  s = appendDevelopVerifyFailure(s, gate);
  const line = explainCap("verify-failed:develop", s);
  assert(
    line.includes(`  - ${failure}`),
    "explainCap(real develop verify cap) keeps the per-failure bullet with the fence attribution",
  );
  assert(
    !line.includes("evidence detail missing from state"),
    "explainCap(real develop verify cap) does not report missing evidence",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
