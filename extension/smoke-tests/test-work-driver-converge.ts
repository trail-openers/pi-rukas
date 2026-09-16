#!/usr/bin/env bun
/**
 * Smoke test — the end-of-develop converge gate (issue #741, P2).
 *
 * The verify gate proves the diff BUILDS; the converge gate proves it is
 * COMPLETE (cross-checks the diff against the plan's deliverables).
 *
 * Part 1 drives the real `runWorkDriver` with a scripted dispatchFn +
 * verifyExecFn. Part 2 exercises the pure classification + prompt +
 * recovery/explain functions. Part 3 covers the escape hatch.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext, STEP_ORDINAL } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import {
  buildConvergeCorrectivePrompt,
  classifyDeliverables,
  convergeGateEnabled,
  runConvergeGate,
} from "../src/work-driver-converge.ts";
import { recoveryStepsForCap } from "../src/work-driver-handoff-recovery.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { initialState, readState, type WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

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

// The explore reply with the ## Spec block the intent gate parses into
// normalisedSpec (the seam runConvergeGate reads). Two deliverables, one
// per workstream; task-b is the one the diff will omit.
const EXPLORE_SPEC = [
  "VERDICT: NEEDS_WORK",
  "INTENT-VERDICT: proceed",
  "",
  "## Spec",
  "",
  "### Intent",
  "Add a feature with two deliverables.",
  "",
  "### Deliverables",
  "- d1: Add alpha to task-a [paths: extension/src/alpha.ts]",
  "- d2: Add beta to task-b [paths: extension/src/beta.ts]",
  "",
  "### Acceptance criteria",
  "- [ ] alpha implemented",
  "- [ ] beta implemented",
  "",
  "### Evidence",
  "- [confirmed] the feature is not present in the codebase",
].join("\n");

// Two workstreams so both files are declared (the scope fence then allows
// each developer to touch its own file — the converge gate is the one that
// checks task-b actually landed). ### subheading shape (parseWorkstreams).
const PLAN_TWO_WORKSTREAMS = [
  "## Workstreams",
  "### task-a — implement alpha",
  "- paths: extension/src/alpha.ts",
  "### task-b — implement beta",
  "- paths: extension/src/beta.ts",
].join("\n");

// #297-style zero backoff so nothing sleeps.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// --- Part 1: end-to-end through the real driver wiring ---

function makeConvergeExec(
  _dir: string,
  opts: { secondDiffHasBeta?: boolean },
): NonNullable<DriverContext["verifyExecFn"]> {
  // The diff name-set the converge gate sees:
  //   first converge pass  — alpha.ts only (task-b's deliverable ABSENT)
  //   second converge pass — alpha.ts (+ beta.ts when the corrective worked)
  let diffRead = 0;
  const filesForDiff = (): string[] => {
    // diffRead 0 = before any diff read. The develop verify gate reads the
    // diff first (diffRead 0 → 1). The converge gate's first read is
    // diffRead 1 (after the increment); its second read (post-corrective)
    // is diffRead 2.
    //
    // For the "secondDiffHasBeta" case the corrective worked, so both files
    // are present from the converge gate's SECOND read. The verify gate's
    // diff read is diffRead 1 (after increment), converge pass 1 is
    // diffRead 2, converge pass 2 is diffRead 3. So both files appear
    // from diffRead >= 3.
    if (diffRead >= 3 && opts.secondDiffHasBeta) {
      return ["extension/src/alpha.ts", "extension/src/beta.ts"];
    }
    return ["extension/src/alpha.ts"];
  };
  return async (cmd, execOpts) => {
    if (cmd === "git status --porcelain") {
      return { stdout: filesForDiff().map((f) => `M  ${f}`).join("\n") + "\n" };
    }
    if (cmd.startsWith("git diff --name-only")) {
      diffRead += 1;
      return { stdout: filesForDiff().join("\n") + "\n" };
    }
    // The safety net / verify gate evidence: committed work ahead of the
    // base exists, so the develop gate passes and the converge gate runs.
    if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" };
    if (cmd === "git rev-parse HEAD") return { stdout: BASE_SHA + "\n" };
    if (cmd.startsWith("git symbolic-ref")) return { stdout: "refs/heads/main\n" };
    if (cmd.startsWith("gh pr list")) return { stdout: "" };
    if (cmd.startsWith("gh pr view"))
      return { stdout: JSON.stringify({ state: "OPEN", headRefName: BRANCH }) };
    void execOpts;
    return { stdout: "" };
  };
}

async function runConvergeCycle(
  issue: number,
  opts: { secondDiffHasBeta?: boolean },
): Promise<WorkState | undefined> {
  const dir = mkdtempSync(path.join(tmpdir(), `converge-${issue}-`));
  try {
    await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
      recursive: true,
    });
    const wtA = path.join(dir, ".worktrees", `issue-${issue}-task-a`);
    const wtB = path.join(dir, ".worktrees", `issue-${issue}-task-b`);
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue,
      issueBodyFetcherFn: mockIssueBodyOk,
      verifyExecFn: makeConvergeExec(dir, opts),
      dispatchFn: async (_pi, spec, dOpts) => {
        const label = dOpts?.label ?? spec.role;
        if (label === "explore") return mkResult({ text: EXPLORE_SPEC });
        if (label === "plan") return mkResult({ text: PLAN_TWO_WORKSTREAMS });
        if (label === "ops")
          return mkResult({
            role: "ops",
            text: `branch: ${BRANCH}\n\n## Worktrees\n- task-a: ${wtA}\n- task-b: ${wtB}`,
          });
        if (label === "developer" || label?.startsWith("developer[")) {
          return mkResult({ role: "developer", text: "done — implemented the assigned work" });
        }
        if (label === "adversarial")
          return mkResult({ role: "adversarial-developer", text: "VERDICT: APPROVED" });
        if (label === "lens:security" || label === "lens:simplicity")
          return mkResult({ role: "code-review-specialist", text: "verdict: APPROVED" });
        if (
          label === "lens:architecture" ||
          label === "lens:performance" ||
          label === "lens:error-handling" ||
          label === "lens:type-safety"
        )
          return mkResult({ role: "code-review-specialist", text: "verdict: APPROVED" });
        if (label === "ops:commit-pr")
          return mkResult({ role: "ops", text: "Committed and pushed.\npr: 999" });
        if (label === "ops:ci") return mkResult({ role: "ops", text: "ci-status: success" });
        if (label === "ops:merged") return mkResult({ role: "ops", text: "merged" });
        if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted.\nlabel: applied" });
        return mkResult({ role: spec.role, text: "ok" });
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    return await readState(dir, issue);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // --- AC2: absent deliverable → one corrective re-dispatch, then (if the
  // corrective works) the gate re-runs and the cycle proceeds (no cap). ---
  const s1 = await runConvergeCycle(999, { secondDiffHasBeta: true });
  const cap1 = s1?.eventLog.find(
    (e) => e.kind === "cap-hit" && e.cap === "develop-incomplete-deliverables",
  );
  const redispatches1 = s1?.eventLog.filter((e) => e.kind === "converge-redispatch") ?? [];
  assert(
    s1?.pipelineState.convergeEvidence !== undefined,
    "AC2: the converge gate ran and persisted evidence (convergeEvidence present)",
  );
  assert(
    cap1 === undefined,
    "AC2: no develop-incomplete-deliverables cap (the corrective worked — no cap raised)",
  );
  assert(
    redispatches1.length === 1,
    "AC2: the corrective re-dispatch fired exactly once (the converge-redispatch event marker)",
  );
  assert(
    s1?.pipelineState.convergeEvidence !== undefined &&
      s1.pipelineState.convergeEvidence.deliverables.length >= 2,
    "AC2: convergeEvidence was persisted with per-deliverable status",
  );
  const d2 = s1?.pipelineState.convergeEvidence?.deliverables.find((d) => d.id === "D2");
  assert(
    d2?.status === "implemented",
    "AC2: after the corrective re-dispatch, D2 re-classifies as implemented (the gate re-ran on the new diff)",
  );
  assert(
    s1?.pipelineState.status === "running" || s1?.pipelineState.status === "merged",
    "AC2: the cycle did NOT hand off (it proceeded past develop)",
  );

  // --- AC3: two absences — the corrective also fails to land beta → the
  // distinct cap fires → handoff. ---
  const s3 = await runConvergeCycle(1000, {}); // secondDiffHasBeta unset → beta still absent
  const cap3 = s3?.eventLog.find(
    (e) => e.kind === "cap-hit" && e.cap === "develop-incomplete-deliverables",
  );
  assert(
    cap3 !== undefined,
    "AC3: a second absence raises the DISTINCT cap develop-incomplete-deliverables (not verify-failed:develop)",
  );
  assert(
    cap3 !== undefined &&
      (cap3.evidence?.includes("D2") ||
        cap3.evidence?.includes("beta") ||
        s3?.pipelineState.convergeEvidence?.deliverables.find((d) => d.id === "D2")?.status ===
          "absent"),
    "AC3: the cap names the missing deliverable (evidence or convergeEvidence carries D2/beta)",
  );
  const redispatches3 = s3?.eventLog.filter((e) => e.kind === "converge-redispatch") ?? [];
  assert(
    redispatches3.length === 1,
    "AC3: the corrective re-dispatch happened exactly once before the cap (one-shot, not a loop)",
  );
  assert(
    s3?.pipelineState.status === "handoff" && s3?.pipelineState.currentStep === "handoff",
    "AC3: the cap routes the cycle to handoff",
  );
}

{
  // --- AC4 (disabled hatch): PI_ENSEMBLE_CONVERGE=0 skips silently. ---
  const prev = process.env.PI_ENSEMBLE_CONVERGE;
  process.env.PI_ENSEMBLE_CONVERGE = "0";
  let gateSkipped = false;
  try {
    assert(convergeGateEnabled() === false, "AC4: PI_ENSEMBLE_CONVERGE=0 disables the gate");
    const dir = mkdtempSync(path.join(tmpdir(), "converge-off-"));
    try {
      const state = initialState(1001, 1000);
      const withSpec: WorkState = {
        ...state,
        pipelineState: {
          ...state.pipelineState,
          worktrees: { default: dir },
          baseSha: "c".repeat(40),
          normalisedSpec: {
            intent: "test",
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
            rationale: "test",
          },
        },
      };
      // A diff that contains NEITHER deliverable — if the gate ran it would
      // classify both absent.
      const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
        if (cmd.startsWith("git diff --name-only")) return { stdout: "src/other.ts\n" };
        if (cmd === "git status --porcelain") return { stdout: "M  src/other.ts\n" };
        return { stdout: "" };
      };
      const ctx: DriverContext = { pi: makeFakePi().pi, repoRoot: dir, issue: 1001, verifyExecFn: exec };
      const verdict = await runConvergeGate(ctx, withSpec);
      gateSkipped = verdict === null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    if (prev === undefined) Reflect.deleteProperty(process.env, "PI_ENSEMBLE_CONVERGE");
    else process.env.PI_ENSEMBLE_CONVERGE = prev;
  }
  assert(gateSkipped, "AC4: disabled hatch skips silently (gate returns null — no classification)");
}

// --- Part 2: pure classification + recovery + explain seams ---

{
  const twoDelivs = [
    { id: "D1", description: "alpha", paths: ["src/alpha.ts"] },
    { id: "D2", description: "beta", paths: ["src/beta.ts"] },
  ];
  // 1 of 2 present → D2 absent.
  const v1 = classifyDeliverables(twoDelivs, new Set(["src/alpha.ts"]));
  assert(
    v1.absent.length === 1 && v1.absent[0].id === "D2" && v1.deliverables[0].status === "implemented",
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
  assert(v3.absent.length === 0, "classify: a directory declaration is satisfied by files beneath it");
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
  assert(v5.absent.length === 0, "classify: an annotated path ('src/alpha.ts (new)') still matches the diff");

  // --- The AC2 fixture case as a pure function: diff omits one of two →
  // the corrective prompt names exactly the missing deliverable. ---
  const vFix = classifyDeliverables(twoDelivs, new Set(["src/alpha.ts"]));
  const spec = {
    issue: 999,
    pipelineState: {
      workstreams: {
        "task-b": { id: "task-b", scope: "beta", paths: ["src/beta.ts"], outOfScope: [] },
      },
      normalisedSpec: {
        intent: "x",
        deliverables: twoDelivs,
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
    prompt.includes("D2") && prompt.includes("src/beta.ts"),
    "prompt: the corrective re-dispatch names the missing deliverable (D2 / src/beta.ts)",
  );
  assert(
    prompt.includes("task-b"),
    "prompt: the corrective re-dispatch attributes the missing path to its owning workstream",
  );
  assert(
    prompt.includes("acceptance criteria"),
    "prompt: the corrective re-dispatch carries the normalised spec (the LLM-assisted seam)",
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
          { id: "D2", status: "absent", reason: "none of 1 declared path(s) in the diff (src/beta.ts)" },
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
}

// --- The disabled-hatch silence through the gate's own entry (no spec) ---
{
  const dir = mkdtempSync(path.join(tmpdir(), "converge-nospec-"));
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

// STEP_ORDINAL import sanity — the gate runs at end-of-develop; the ordinal
// table is the step-ord source the driver loop reads. Assert the shape.
assert(
  typeof STEP_ORDINAL.develop === "object" && STEP_ORDINAL.develop !== null,
  "sanity: STEP_ORDINAL.develop is a well-formed object",
);
void STEP_ORDINAL;

console.log(`\nexit ${exit}`);
process.exit(exit);
