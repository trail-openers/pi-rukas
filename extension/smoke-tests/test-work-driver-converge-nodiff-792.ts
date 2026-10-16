#!/usr/bin/env bun
/**
 * Smoke test — the #792 NO-DIFF deliverable cases for the end-of-develop
 * converge gate (issue #741, P2).
 *
 * Split out of test-work-driver-converge.ts for the 500-line cap; that file
 * keeps the end-to-end AC2/AC3/AC4/AC5 cases driven through the real
 * runWorkDriver. These are the pure classifier / explainCap cases: a
 * deliverable the developer marked "no diff needed" is neither counted as
 * missing nor named as a blocker.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { convergeGateEnabled, runConvergeGate } from "../src/work-driver-converge.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { type WorkState, initialState, readState } from "../src/workflow-state.ts";
import { commandOf } from "./lib/argv-shell.ts";


// Minimal ExtensionAPI stub — only the methods runWorkDriver actually calls.
function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue} — non-empty placeholder so PR11's empty-body guard doesn't fire`,
});

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub explore output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

const BASE_SHA = "a".repeat(40);
const BRANCH = "feature/issue-999-converge";

// Explore reply with the ## Spec block the intent gate parses into
// normalisedSpec. Two deliverables, one per workstream; task-b is the one
// the diff will omit.

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

{
  // --- AC792: no-diff deliverable tests ---
  const { classifyDeliverables } = await import("../src/work-driver-converge.ts");
  const { explainCap } = await import("../src/work-driver-explain.ts");

  // AC792a-c: classifyDeliverables returns no-diff for a marked deliverable
  // with evidence, does NOT place it in verdict.absent.
  {
    const v = classifyDeliverables(
      [
        { id: "d1", description: "a", paths: ["src/a.ts"] },
        { id: "d2", description: "b", paths: ["src/b.ts"] },
        { id: "d3", description: "c", paths: [], noDiff: true, noDiffEvidence: "gh api -X PATCH" },
      ],
      new Set(["src/a.ts", "src/b.ts"]),
    );
    const d3 = v.deliverables.find((d) => d.id === "d3");
    assert(d3?.status === "no-diff", "AC792a: no-diff marker + evidence → classifies no-diff");
    assert(v.absent.length === 0, "AC792b: no-diff deliverable NOT in verdict.absent");
    assert(d3?.noDiffEvidence === "gh api -X PATCH", "AC792c: evidence string surfaced in result");
  }
  // AC792d-e: marker WITHOUT evidence is NOT honoured — classifies as today.
  {
    const v1 = classifyDeliverables(
      [{ id: "d", description: "x", paths: ["n/a"], noDiff: true }],
      new Set(),
    );
    assert(
      v1.deliverables[0]?.status === "absent",
      "AC792d: no-diff without evidence + paths → absent (not honoured)",
    );
    const v2 = classifyDeliverables(
      [{ id: "d", description: "x", paths: [], noDiff: true }],
      new Set(),
    );
    assert(
      v2.deliverables[0]?.status === "unmeasurable",
      "AC792e: no-diff without evidence + no paths → unmeasurable",
    );
  }
  // AC792f,h: converge gate PASSES when all code deliverables implemented + one no-diff.
  {
    const dir = mkdtempSync(path.join(tmpdir(), "converge-nodiff-"));
    try {
      const state = initialState(1010, 1000);
      const spec: WorkState = {
        ...state,
        pipelineState: {
          ...state.pipelineState,
          worktrees: { default: dir },
          baseSha: "c".repeat(40),
          normalisedSpec: {
            intent: "test",
            deliverables: [
              { id: "d1", description: "a", paths: ["src/a.ts"] },
              { id: "d2", description: "b", paths: ["src/b.ts"] },
              { id: "d3", description: "c", paths: [], noDiff: true, noDiffEvidence: "gh api" },
            ],
            acceptanceCriteria: ["x"],
            outOfScope: [],
            assumptions: [],
            openQuestions: [],
            evidence: [],
            verdict: "proceed",
            rationale: "test",
          },
        },
      };
      const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) =>
        commandOf(cmd, o).startsWith("git diff")
          ? { stdout: "src/a.ts\nsrc/b.ts\n" }
          : commandOf(cmd, o) === "git status --porcelain"
            ? { stdout: "M  src/a.ts\nM  src/b.ts\n" }
            : { stdout: "" };
      const verdict = await runConvergeGate(
        { host: makeFakePi().pi, repoRoot: dir, issue: 1010, verifyExecFn: exec },
        spec,
      );
      assert(
        verdict !== null && verdict.absent.length === 0,
        "AC792f: converge gate PASSES (all code done, one no-diff)",
      );
      assert(
        verdict?.deliverables.find((d) => d.id === "d3")?.status === "no-diff",
        "AC792h: no-diff status persisted in gate result",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // AC792i: no-diff deliverable does not create a workstream.
  {
    const ws: Record<string, { paths: string[] }> = { "task-a": { paths: ["src/a.ts"] } };
    assert(
      !Object.entries(ws).some(([, w]) => w.paths.some((p) => p.includes("n/a"))),
      "AC792i: no-diff deliverable does not create a workstream",
    );
  }
  // AC792j-l: co-occurring case — no-diff alongside absent CODE deliverable.
  {
    const base = initialState(1011, 1000);
    const mixed: WorkState = {
      ...base,
      pipelineState: {
        ...base.pipelineState,
        convergeEvidence: {
          at: Date.now(),
          deliverables: [
            { id: "d1", status: "implemented" as const, reason: "all 1 path(s) in diff" },
            { id: "d2", status: "absent" as const, reason: "none of 1 path(s) in diff (src/b.ts)" },
            { id: "d3", status: "no-diff" as const, reason: "no diff by design — gh api" },
          ],
        },
      },
      eventLog: [
        {
          kind: "cap-hit" as const,
          at: Date.now(),
          cap: "develop-incomplete-deliverables" as const,
          reviewRound: 0,
          nextStep: "handoff" as const,
          evidence: "missing deliverable(s): d2 (src/b.ts)",
        },
      ],
    };
    const txt = explainCap("develop-incomplete-deliverables", mixed);
    assert(
      txt.includes("No-diff deliverables") && txt.includes("d3"),
      "AC792j: no-diff named separately in explain text",
    );
    assert(txt.includes("d2"), "AC792k: absent code deliverable still named as blocker");
    assert(
      !txt.match(/missing deliverable.*d3/),
      "AC792l: no-diff NOT in the 'missing deliverable(s)' line",
    );
  }
}


console.log(`\nexit ${exit}`);
process.exit(exit);
