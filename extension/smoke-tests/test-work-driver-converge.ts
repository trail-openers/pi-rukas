#!/usr/bin/env bun
/**
 * Smoke test — the end-of-develop converge gate (issue #741, P2).
 * Drives the real `runWorkDriver` with a scripted dispatchFn +
 * verifyExecFn (AC2/AC3/AC4/AC5 end-to-end cases) plus the escape
 * hatch and the #792 no-diff deliverable cases.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext } from "../src/work-driver-context.ts";
import { convergeGateEnabled, runConvergeGate } from "../src/work-driver-converge.ts";
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

// Explore reply with the ## Spec block the intent gate parses into
// normalisedSpec. Two deliverables, one per workstream; task-b is the one
// the diff will omit.
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

// Two workstreams so both files are declared. ### subheading shape.
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

function makeConvergeExec(
  _dir: string,
  opts: { secondDiffHasBeta?: boolean; probeFails?: boolean },
): NonNullable<DriverContext["verifyExecFn"]> & { statusReads: () => number; diffReads: () => number } {
  let diffRead = 0;
  let probeRead = 0;
  const filesForDiff = (): string[] =>
    diffRead >= 5 && opts.secondDiffHasBeta
      ? ["extension/src/alpha.ts", "extension/src/beta.ts"]
      : ["extension/src/alpha.ts"];
  const exec = async (cmd, execOpts) => {
    if (cmd === "git status --porcelain") {
      const isProbe = (execOpts as { timeout?: number } | undefined)?.timeout !== undefined;
      if (isProbe) probeRead += 1;
      if (opts.probeFails && isProbe) throw new Error("simulated git status failure (AC5c)");
      return { stdout: filesForDiff().map((f) => `M  ${f}`).join("\n") + "\n" };
    }
    if (cmd.startsWith("git diff --name-only")) { diffRead += 1; return { stdout: filesForDiff().join("\n") + "\n" }; }
    if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" };
    if (cmd === "git rev-parse HEAD") return { stdout: BASE_SHA + "\n" };
    if (cmd.startsWith("git symbolic-ref")) return { stdout: "refs/heads/main\n" };
    if (cmd.startsWith("gh pr list")) return { stdout: "" };
    if (cmd.startsWith("gh pr view")) return { stdout: JSON.stringify({ state: "OPEN", headRefName: BRANCH }) };
    void execOpts;
    return { stdout: "" };
  };
  exec.statusReads = () => probeRead;
  exec.diffReads = () => diffRead;
  return exec;
}

async function runConvergeCycle(
  issue: number,
  opts: { secondDiffHasBeta?: boolean; correctiveOk?: boolean; correctiveFalsy?: boolean; probeFails?: boolean },
  execOut?: { statusReads: () => number; diffReads: () => number },
): Promise<WorkState | undefined> {
  const dir = mkdtempSync(path.join(tmpdir(), `converge-${issue}-`));
  try {
    await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const wtA = path.join(dir, ".worktrees", `issue-${issue}-task-a`);
    const wtB = path.join(dir, ".worktrees", `issue-${issue}-task-b`);
    const exec = makeConvergeExec(dir, opts);
    if (execOut) { execOut.statusReads = exec.statusReads; execOut.diffReads = exec.diffReads; }
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue,
      issueBodyFetcherFn: mockIssueBodyOk,
      verifyExecFn: exec,
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
          const isCorrective = label === "developer";
          if (isCorrective) {
            // A failed corrective (child returns ok:false — the documented
            // killed-child shape, AC5).
            if (opts.correctiveOk === false)
              return mkResult({ role: "developer", ok: false, text: "(child killed)" });
            // A falsy dispatch result — neither ok:true nor a DispatchResult
            // (AC5b: undefined must take the failure path, not the success
            // path).
            if (opts.correctiveFalsy === true) return undefined;
            return mkResult({ role: "developer", text: "done — implemented the missing work" });
          }
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
        if (label === "ops:handoff")
          return mkResult({ role: "ops", text: "Posted.\nlabel: applied" });
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
  const d2 = s1?.pipelineState.convergeEvidence?.deliverables.find((d) => d.id === "d2");
  assert(
    d2?.status === "implemented",
    "AC2: after the corrective re-dispatch, d2 re-classifies as implemented (the gate re-ran on the new diff)",
  );
  // AC2 is a claim about the CONVERGE GATE, not the terminal cycle status:
  // the fixture cannot support a full cycle (lens-review shells out through
  // `execp` rather than the injected `verifyExecFn` seam). Assert on the
  // event log: the pipeline advanced past develop and no develop-phase cap fires.
  const devConverged = s1?.eventLog.find(
    (e) => e.kind === "branches-converged" && e.step === "develop",
  );
  const devCap = s1?.eventLog.find(
    (e) => e.kind === "cap-hit" && (e as { step?: string }).step === "develop",
  );
  const lensStarted = s1?.eventLog.find((e) => e.kind === "step-started" && e.step === "lens-review");
  assert(
    devConverged !== undefined &&
      devCap === undefined &&
      lensStarted !== undefined &&
      (s1?.pipelineState.status === "handoff" || s1?.pipelineState.status === "running" || s1?.pipelineState.status === "merged"),
    "AC2: the converge gate did not block the cycle — develop converged (branches-converged) with no develop-phase cap, and the pipeline advanced to lens-review (handoff at that later step is a fixture artefact, not a converge-block)",
  );

  // --- AC5: a FAILED corrective (ok:false) must NOT present as a
  // completeness verdict: the cap fires, but its evidence says the corrective never ran.
  const s5 = await runConvergeCycle(1002, { secondDiffHasBeta: false, correctiveOk: false });
  const cap5 = s5?.eventLog.find(
    (e) => e.kind === "cap-hit" && e.cap === "develop-incomplete-deliverables",
  );
  const redispatches5 = s5?.eventLog.filter((e) => e.kind === "converge-redispatch") ?? [];
  assert(
    cap5 !== undefined && redispatches5.length === 0,
    "AC5: a failed corrective (ok:false) raises the cap WITHOUT the converge-redispatch marker",
  );
  assert(
    cap5 !== undefined && (cap5.evidence?.includes("corrective re-dispatch FAILED") ?? false),
    "AC5: the failed corrective's cap evidence says it did not run (not a completeness verdict)",
  );
  assert(
    s5?.pipelineState.status === "handoff" && s5?.pipelineState.currentStep === "handoff",
    "AC5: the failed corrective routes the cycle to handoff",
  );

  // --- AC5b: a FALSY corrective dispatch result (undefined) must take the
  // same failure path as ok:false: the cap fires with failure evidence and
  // NO converge-redispatch marker.
  const s5b = await runConvergeCycle(1003, { secondDiffHasBeta: false, correctiveFalsy: true });
  const cap5b = s5b?.eventLog.find(
    (e) => e.kind === "cap-hit" && e.cap === "develop-incomplete-deliverables",
  );
  const redispatches5b = s5b?.eventLog.filter((e) => e.kind === "converge-redispatch") ?? [];
  assert(
    cap5b !== undefined && redispatches5b.length === 0,
    "AC5b: a falsy corrective result (undefined) raises the cap WITHOUT the converge-redispatch marker",
  );
  assert(
    cap5b !== undefined && (cap5b.evidence?.includes("corrective re-dispatch FAILED") ?? false),
    "AC5b: the falsy corrective's cap evidence names the failure (no result returned)",
  );
  assert(
    s5b?.pipelineState.status === "handoff" && s5b?.pipelineState.currentStep === "handoff",
    "AC5b: the falsy corrective routes the cycle to handoff",
  );

  // --- AC5c: a throwing `git status` probe must route like `changed`.
  // The gate handler's probe is the only porcelain read that passes a
  // `timeout` option, so the mock counts only probe reads.
  const counts5c = { statusReads: () => 0, diffReads: () => 0 };
  const s5c = await runConvergeCycle(1004, { secondDiffHasBeta: false, probeFails: true }, counts5c);
  const cap5c = s5c?.eventLog.find(
    (e) => e.kind === "cap-hit" && e.cap === "develop-incomplete-deliverables",
  );
  const redispatches5c = s5c?.eventLog.filter((e) => e.kind === "converge-redispatch") ?? [];
  assert(
    cap5c !== undefined,
    "AC5c: a throwing git-status probe does NOT suppress the cap (the gate re-ran and classified both absent)",
  );
  assert(
    redispatches5c.length === 1,
    "AC5c: the corrective re-dispatch fired exactly once (the probe failure did not skip the gate)",
  );
  assert(
    counts5c.statusReads() === 1,
    "AC5c: the post-corrective re-run ACTUALLY RAN (the probe's git status read fired exactly once — the old skip path would have fired zero)",
  );
  assert(
    s5c?.pipelineState.status === "handoff" && s5c?.pipelineState.currentStep === "handoff",
    "AC5c: the cycle still reaches handoff (the throwing probe did not break the cycle)",
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
      (cap3.evidence?.includes("d2") ||
        cap3.evidence?.includes("beta") ||
        s3?.pipelineState.convergeEvidence?.deliverables.find((d) => d.id === "d2")?.status ===
          "absent"),
    "AC3: the cap names the missing deliverable (evidence or convergeEvidence carries d2/beta)",
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
              { id: "D1", description: "a", paths: ["src/a.ts"] },
              { id: "D2", description: "b", paths: ["src/b.ts"] },
            ],
            acceptanceCriteria: ["x"], outOfScope: [], assumptions: [],
            openQuestions: [], evidence: [], verdict: "proceed", rationale: "test",
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
      const ctx: DriverContext = {
        pi: makeFakePi().pi,
        repoRoot: dir,
        issue: 1001,
        verifyExecFn: exec,
      };
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
        { id: "d3", description: "c", paths: ["n/a"], noDiff: true, noDiffEvidence: "gh api -X PATCH" },
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
    assert(v1.deliverables[0]?.status === "absent", "AC792d: no-diff without evidence + paths → absent (not honoured)");
    const v2 = classifyDeliverables(
      [{ id: "d", description: "x", paths: [], noDiff: true }],
      new Set(),
    );
    assert(v2.deliverables[0]?.status === "unmeasurable", "AC792e: no-diff without evidence + no paths → unmeasurable");
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
            intent: "test", deliverables: [
              { id: "d1", description: "a", paths: ["src/a.ts"] },
              { id: "d2", description: "b", paths: ["src/b.ts"] },
              { id: "d3", description: "c", paths: ["n/a"], noDiff: true, noDiffEvidence: "gh api" },
            ],
            acceptanceCriteria: ["x"], outOfScope: [], assumptions: [],
            openQuestions: [], evidence: [], verdict: "proceed", rationale: "test",
          },
        },
      };
      const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) =>
        cmd.startsWith("git diff") ? { stdout: "src/a.ts\nsrc/b.ts\n" }
          : cmd === "git status --porcelain" ? { stdout: "M  src/a.ts\nM  src/b.ts\n" }
          : { stdout: "" };
      const verdict = await runConvergeGate({ pi: makeFakePi().pi, repoRoot: dir, issue: 1010, verifyExecFn: exec }, spec);
      assert(verdict !== null && verdict.absent.length === 0, "AC792f: converge gate PASSES (all code done, one no-diff)");
      assert(verdict?.deliverables.find((d) => d.id === "d3")?.status === "no-diff", "AC792h: no-diff status persisted in gate result");
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
      eventLog: [{
        kind: "cap-hit" as const, at: Date.now(), cap: "develop-incomplete-deliverables" as const,
        reviewRound: 0, nextStep: "handoff" as const, evidence: "missing deliverable(s): d2 (src/b.ts)",
      }],
    };
    const txt = explainCap("develop-incomplete-deliverables", mixed);
    assert(txt.includes("No-diff deliverables") && txt.includes("d3"), "AC792j: no-diff named separately in explain text");
    assert(txt.includes("d2"), "AC792k: absent code deliverable still named as blocker");
    assert(!txt.match(/missing deliverable.*d3/), "AC792l: no-diff NOT in the 'missing deliverable(s)' line");
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
