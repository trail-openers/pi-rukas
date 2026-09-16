#!/usr/bin/env bun
/**
 * Smoke test — the end-of-develop converge gate (issue #741, P2), part 2:
 * the PURE seams behind the gate — `classifyDeliverables`, the corrective
 * prompt builder, the recovery/explain cap entries, and the gate's
 * repoRoot-containment + empty-spec skips.
 *
 * The end-to-end driver scenarios (runConvergeCycle AC2/AC3/AC4/AC5) live
 * in the sibling test-work-driver-converge.ts.
 */

import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { type DriverContext, STEP_ORDINAL } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import {
  buildConvergeCorrectivePrompt,
  classifyDeliverables,
  runConvergeGate,
} from "../src/work-driver-converge.ts";
import { recoveryStepsForCap } from "../src/work-driver-handoff-recovery.ts";
import { initialState, type WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Minimal ExtensionAPI stub — only the methods the converge gate calls.
function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

// --- Pure classification seams ---

{
  const twoDelivs = [
    { id: "D1", description: "alpha", paths: ["src/alpha.ts"] },
    { id: "D2", description: "beta", paths: ["src/beta.ts"] },
  ];
  // 1 of 2 present → D2 absent.
  const v1 = classifyDeliverables(twoDelivs, new Set(["src/alpha.ts"]));
  assert(
    v1.absent.length === 1 &&
      v1.absent[0].id === "D2" &&
      v1.deliverables[0].status === "implemented",
    "classify: one of two declared deliverables in the diff → the other is ABSENT",
  );
  // Both absent.
  const v2 = classifyDeliverables(twoDelivs, new Set(["src/other.ts"]));
  assert(v2.absent.length === 2, "classify: neither declared path in the diff → both ABSENT");
  // Partial: D1 has two paths, one present.
  const vPart = classifyDeliverables(
    [{ id: "D1", description: "alpha", paths: ["src/alpha.ts", "src/alpha2.ts"] }],
    new Set(["src/alpha.ts"]),
  );
  assert(
    vPart.partial.length === 1 && vPart.absent.length === 0,
    "classify: some-but-not-all declared paths present → PARTIAL (never blocks)",
  );
  // Directory declaration covers its contents.
  const v3 = classifyDeliverables(
    [{ id: "D1", description: "alpha", paths: ["src/alpha"] }],
    new Set(["src/alpha/x.ts"]),
  );
  assert(
    v3.absent.length === 0,
    "classify: a directory declaration is satisfied by files beneath it",
  );
  // Prose deliverable → unmeasurable, never blocks.
  const v4 = classifyDeliverables([{ id: "D1", description: "alpha", paths: [] }], new Set());
  assert(
    v4.deliverables[0].status === "unmeasurable" && v4.absent.length === 0,
    "classify: a prose deliverable (no paths) is unmeasurable and never absent",
  );
  // Annotation normalisation: "src/alpha.ts (new)" reads as src/alpha.ts.
  const v5 = classifyDeliverables(
    [{ id: "D1", description: "alpha", paths: ["src/alpha.ts (new)"] }],
    new Set(["src/alpha.ts"]),
  );
  assert(
    v5.absent.length === 0,
    "classify: an annotated path ('src/alpha.ts (new)') still matches the diff",
  );

  // --- Recovery + explain for the new cap. ---
  const base = initialState(1002, 1000);
  const capState: WorkState = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      branchName: "feature/issue-1002",
      convergeEvidence: {
        at: 1,
        deliverables: [
          { id: "D1", status: "implemented", reason: "all 1 declared path(s) in the diff" },
          {
            id: "D2",
            status: "absent",
            reason: "none of 1 declared path(s) in the diff (src/beta.ts)",
          },
          { id: "D3", status: "partial", reason: "only 1/2 declared path(s) in the diff" },
        ],
      },
    },
  };
  // cap-hit is LAST in the log — the reverse scan in recoveryStepsForCap
  // must find it (the cap is on the event, not on pipelineState).
  capState.eventLog.push({
    kind: "cap-hit",
    at: 2,
    cap: "develop-incomplete-deliverables",
    reviewRound: 0,
    nextStep: "handoff",
    evidence: "missing deliverable(s): D2 (src/beta.ts)",
  });
  const recovered = recoveryStepsForCap(capState);
  assert(
    recovered.cap === "develop-incomplete-deliverables" &&
      recovered.steps.some((s) => s.section === "develop-incomplete-deliverables"),
    "recovery: develop-incomplete-deliverables has a recovery section (inspect + re-run + abandon)",
  );
  const explain = explainCap("develop-incomplete-deliverables", capState);
  assert(
    explain.includes("INCOMPLETE") && explain.length > 80,
    "explain: the cap renders an operator-readable sentence naming the completeness gap",
  );
  assert(
    explain.includes("D3") || explain.includes("partial"),
    "explain: the partial deliverable is surfaced as a non-blocking warning",
  );

  // --- Finding 4: a worktree path outside repoRoot in the persisted map is
  // skipped (degraded past), not shelled into — an all-outside set is
  // unreadable, so the gate degrades to pass (null).
  const outsideDir = path.join(tmpdir(), "pi-rukas-converge-outside");
  const withOutside: WorkState = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      worktrees: { default: outsideDir },
      baseSha: "e".repeat(40),
      normalisedSpec: {
        intent: "x",
        deliverables: [
          { id: "D1", description: "do alpha", paths: ["src/alpha.ts"] },
          { id: "D2", description: "do beta", paths: ["src/beta.ts"] },
        ],
        acceptanceCriteria: ["x"],
        outOfScope: [],
        assumptions: [],
        openQuestions: [],
        evidence: [],
        verdict: "proceed",
        rationale: "",
      },
    },
  };
  const outsideCtx: DriverContext = {
    pi: makeFakePi().pi,
    repoRoot: path.join(tmpdir(), "pi-rukas-converge-inside"),
    issue: 1003,
    verifyExecFn: async () => ({
      stdout: "src/alpha.ts\nsrc/beta.ts\n",
    }),
  };
  const outsideVerdict = await runConvergeGate(outsideCtx, withOutside);
  assert(
    outsideVerdict === null,
    "gate: a worktree path outside repoRoot is skipped (degrades to pass, not an absent classification)",
  );
}

// --- The empty-spec skip through the gate's own entry (no spec) ---
{
  const dir = mkdtempSync(path.join(tmpdir(), "converge-pure-nospec-"));
  try {
    const state = initialState(1003, 1000);
    const withSpec: WorkState = {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        worktrees: { default: dir },
        normalisedSpec: {
          intent: "x",
          deliverables: [],
          acceptanceCriteria: [],
          outOfScope: [],
          assumptions: [],
          openQuestions: [],
          evidence: [],
          verdict: "proceed",
          rationale: "",
        },
      },
    };
    const ctx: DriverContext = { pi: makeFakePi().pi, repoRoot: dir, issue: 1003 };
    const verdict = await runConvergeGate(ctx, withSpec);
    assert(verdict === null, "gate: a spec with zero deliverables skips (nothing to converge on)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- The AC2 fixture case as a pure function: diff omits one of two →
// the corrective prompt names exactly the missing deliverable. ---
const lowerDelivs = [
  { id: "d1", description: "alpha", paths: ["src/alpha.ts"] },
  { id: "d2", description: "beta", paths: ["src/beta.ts"] },
];
const vFix = classifyDeliverables(lowerDelivs, new Set(["src/alpha.ts"]));
const spec = {
  issue: 999,
  pipelineState: {
    workstreams: {
      "task-b": { id: "task-b", scope: "beta", paths: ["src/beta.ts"], outOfScope: [] },
    },
    worktrees: {
      "task-b": "/tmp/fake-wt-task-b",
    },
    normalisedSpec: {
      intent: "x",
      deliverables: lowerDelivs,
      acceptanceCriteria: ["alpha implemented", "beta implemented"],
      outOfScope: [],
      assumptions: [],
      openQuestions: [],
      evidence: [],
      verdict: "proceed" as const,
      rationale: "",
    },
  },
} as unknown as WorkState;
const prompt = buildConvergeCorrectivePrompt(spec, vFix);
assert(
  prompt.includes("d2") && prompt.includes("src/beta.ts"),
  "prompt: the corrective re-dispatch names the missing deliverable (d2 / src/beta.ts)",
);
assert(
  prompt.includes("task-b"),
  "prompt: the corrective re-dispatch attributes the missing path to its owning workstream",
);
assert(
  prompt.includes("acceptance criteria"),
  "prompt: the corrective re-dispatch carries the normalised spec (the LLM-assisted seam)",
);

// STEP_ORDINAL sanity — the gate runs at end-of-develop; the ordinal table
// is the step-ord source the driver loop reads. Assert the POSITION and
// the TOTAL: a renumbering of the step table (or a step being dropped or
// added) would shift develop's number or the total, and both are load-
// bearing for the "step N/9" badge the operator sees in scrollback.
assert(
  STEP_ORDINAL.develop.num === 4 && STEP_ORDINAL.develop.total === 9,
  "sanity: develop is step 4 of 9 in the STEP_ORDINAL table (a renumbering breaks the badge)",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
