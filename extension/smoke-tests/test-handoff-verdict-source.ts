#!/usr/bin/env bun
/**
 * #848 lens fix — the explain "N/M workstream branches failed" count (the
 * step-failed:develop fanoutTag in work-driver-explain.ts) must agree with
 * the handoff's "Workstream verdicts" section on a fence-flipped fixture.
 *
 * Pre-fix the tag counted straight off the last branches-converged event
 * while the section (after #814) rendered the fence-flipped verdicts; a
 * later lens-review converged event for the same fixture shape used to
 * shadow the develop one for the section but not the other surface.
 */

import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/Users/x/repo";
const FENCE = "fence violation: src/main.rs (declared by task-d)";

function fenceFlippedState(): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 848,
    createdAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "develop",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-848-fence",
      // branchName deliberately present: the develop fanoutTag only renders
      // with a branch on hand.
      normalisedSpec: {
        intent: "Ship the fence flip.",
        deliverables: [],
        acceptanceCriteria: [],
        outOfScope: [],
        assumptions: [],
        openQuestions: [],
        evidence: [],
        verdict: "proceed",
        rationale: "Fence flip verified in the branch-completed events.",
      },
    },
    // The fence flip: branches-converged says task-a FAIL (fence), while
    // both branch-completed events are still ok:true (the flip replaces
    // the converged event, never the per-branch events).
    eventLog: [
      { kind: "branch-completed", step: "develop", workstreamId: "task-a", ok: true, ms: 1, at: 3 },
      { kind: "branch-completed", step: "develop", workstreamId: "task-b", ok: true, ms: 1, at: 4 },
      {
        kind: "branches-converged" as const,
        step: "develop" as const,
        at: 5,
        verdicts: [
          { id: "task-a", ok: false, reason: FENCE },
          { id: "task-b", ok: true },
        ],
      },
      { kind: "cap-hit", at: 6, cap: "step-failed:develop", reviewRound: 0, nextStep: "handoff" },
    ],
  };
}

const s = fenceFlippedState();
const md = renderHandoffMarkdown(s, REPO);
const chat = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-848`);

// The explain "Why" sentence names the count: 1/2 failed (task-a fence-flipped).
const tag = /(\d)\/(\d) workstream branches failed/.exec(md);
assert(!!tag, "markdown: the explain sentence carries an 'N/M workstream branches failed' count");
assert(!!tag && tag[1] === "1" && tag[2] === "2", `markdown: the explain count is 1/2, not 0/2 (got ${tag?.[0] ?? "none"})`);

// And it must AGREE with the handoff section on the same fence-flipped fixture.
assert(
  md.includes("task-a: FAIL — " + FENCE) && md.includes("- task-b: ok"),
  "markdown: the verdict section shows the fence-flipped task-a FAIL and task-b ok",
);
assert(
  chat.includes(`Workstream verdicts (develop fanout, 1/2 ok):`) && chat.includes(`task-a: FAIL — ${FENCE}`),
  "chat: the verdict section + 1/2-ok header agree with the explain count",
);
const flippedInMd = md.includes(`task-a: FAIL — ${FENCE}`);
const flippedInChat = chat.includes(`task-a: FAIL — ${FENCE}`);
assert(
  flippedInMd === flippedInChat && flippedInMd,
  "both surfaces agree on the flipped line (non-vacuity guard)",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
