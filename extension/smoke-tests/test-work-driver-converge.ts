#!/usr/bin/env bun
/**
 * Smoke test — the end-of-develop converge gate (issue #741, P2).
 *
 * The verify gate proves the diff BUILDS; the converge gate proves it is
 * COMPLETE (cross-checks the diff against the plan's deliverables).
 *
 * Drives the real `runWorkDriver` with a scripted dispatchFn +
 * verifyExecFn (the AC2/AC3/AC4/AC5 end-to-end cases) plus the escape
 * hatch. The pure classification + prompt + recovery/explain functions
 * live in the sibling test-work-driver-converge-pure.ts.
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
  opts: { secondDiffHasBeta?: boolean; probeFails?: boolean },
): NonNullable<DriverContext["verifyExecFn"]> {
  // The diff name-set the converge gate sees: the gate reads the committed
  // diff once per worktree per pass (two worktrees here), and the develop
  // verify gate reads it once per worktree too, BEFORE the gate runs:
  //
  //   diffRead 1-2  — develop verify gate: alpha.ts only
  //   diffRead 3-4  — converge gate, pass 1: alpha.ts only (D2 ABSENT)
  //   diffRead 5+   — converge gate, pass 2 (after the corrective): both
  //                    files when the corrective worked
  let diffRead = 0;
  const filesForDiff = (): string[] => {
    if (diffRead >= 5 && opts.secondDiffHasBeta) {
      return ["extension/src/alpha.ts", "extension/src/beta.ts"];
    }
    return ["extension/src/alpha.ts"];
  };
  return async (cmd, execOpts) => {
    if (cmd === "git status --porcelain") {
      // The converge gate's tree-changed probe (and the verify gate's
      // evidence check) both read porcelain. A throwing probe is the
      // AC5c seam: the three-state probe returns "unknown" and the
      // caller falls through to the safety net + verify re-run.
      if (opts.probeFails) throw new Error("simulated git status failure (AC5c)");
      return {
        stdout:
          filesForDiff()
            .map((f) => `M  ${f}`)
            .join("\n") + "\n",
      };
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
  opts: {
    secondDiffHasBeta?: boolean;
    correctiveOk?: boolean;
    correctiveFalsy?: boolean;
    probeFails?: boolean;
  },
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
  assert(
    s1?.pipelineState.status === "running" || s1?.pipelineState.status === "merged",
    "AC2: the cycle did NOT hand off (it proceeded past develop)",
  );

  // --- AC5: a FAILED corrective (child returns ok:false — the documented
  // killed-child shape, not a throw) must NOT present as a completeness
  // verdict: the cap fires, but its evidence says the corrective never ran.
  // ---
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

  // --- AC5b: a FALSY corrective dispatch result (undefined — neither an
  // ok:true nor a DispatchResult) must take the same failure path as
  // ok:false: the cap fires with failure evidence and NO
  // converge-redispatch marker. The pre-fix code tested `retry?.ok` and
  // `else if (retry)` — both falsy for undefined — and fell through to
  // the success path.
  // ---
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

  // --- AC5c: a throwing `git status` probe (the tree-changed check in the
  // converge gate) must route like `changed` — the safety net + verify
  // re-run still happen — rather than skipping them. The cap fires (the
  // corrective did not land beta) but the code path through the throwing
  // probe is exercised. The state is identical to AC3 (the cap fires
  // either way); what distinguishes this test is that the probe threw
  // and the gate did NOT silently skip the re-run.
  // ---
  const s5c = await runConvergeCycle(1004, { secondDiffHasBeta: false, probeFails: true });
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

console.log(`\nexit ${exit}`);
process.exit(exit);
