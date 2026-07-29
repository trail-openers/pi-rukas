#!/usr/bin/env bun
/**
 * Smoke test for the /work driver skeleton (PR1 of workflow-graph compilation).
 *
 * Validates:
 *   1. workflow-state.ts schema round-trip (read/write/append/atomic rename).
 *   2. nextStep() transition table for the wired-up cases (explore→plan,
 *      adversarial-approved verdicts, lens-issues-found capping, terminal).
 *   3. runWorkDriver() loop scaffolding — uses a mock dispatchFn so no real
 *      Pi child is spawned. The skeleton halts on DriverNotImplementedError
 *      for unimplemented steps; the test asserts that path is taken cleanly
 *      and the state file is left in an `aborted` status (NOT corrupted).
 *   4. Inconsistency detection — orphan dispatch-started without a matching
 *      completion event surfaces a halt via sendUserMessage.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked. Budget
 * <500ms total (smoke gate is 22 tests × ~500ms each = ~11s — keep tight).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DriverNotImplementedError,
  type DriverContext,
  STEP_FAILURE_POLICY,
  captureWorktreeSnapshot,
  explainCap,
  nextStep,
  parseAbort,
  parseBranchName,
  parseExploreVerdict,
  parseHandoffCommentUrl,
  parseMergeCommit,
  parsePerIssueVerdicts,
  parsePrNumber,
  parseStepBackReply,
  parseWorkstreams,
  parseWorktreesBlock,
  groupIssues,
  MAX_ISSUES_PER_GROUP,
  verifyCmdFor,
  verifyStepOutcome,
  renderHandoffMarkdown,
  renderHandoffUserMessage,
  runWorkDriver,
  scratchDir,
  setupWorkspaceTmp,
  teardownWorkspaceTmp,
} from "../src/work-driver.ts";
import type { DispatchResult } from "../src/types.ts";
import {
  type WorkState,
  WORK_STATE_SCHEMA_VERSION,
  appendEvent,
  detectInconsistencies,
  initialState,
  readState,
  workStateFile,
  writeState,
} from "../src/workflow-state.ts";

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

// PR11 — default issue-body fetcher for tests. runExplore's empty-body
// halt guard (PR11 §C) would otherwise fire when execp("gh issue view N")
// rejects or returns empty stdout — true for almost every test (the test
// repos don't have GitHub remotes). Tests that deliberately exercise
// the empty-body path pass their own injection; everything else gets
// this stub so the cycle proceeds to plan/branch/develop normally.
const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue} — non-empty placeholder so PR11's empty-body guard doesn't fire`,
});

// #297 — transient retries are exercised by dedicated tests below; zero the
// inter-attempt backoff so persistent-failure tests don't sleep 5-10s per
// retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// PR17 — the outcome-verification gate shells out (git status/rev-list,
// verify command, gh pr view) against the driver's repoRoot/worktrees.
// The flow tests below run in fake tmp dirs that aren't git repos and
// must not depend on this host's gh auth, so the gate is disabled
// globally here. The dedicated PR17 gate tests at the bottom re-enable
// it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";

// Fake DispatchResult builder.
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

// 1. Schema round-trip + atomic write.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-smoke-"));
  try {
    const issue = 547;
    let state = initialState(issue, 1000);
    assert(state.schemaVersion === WORK_STATE_SCHEMA_VERSION, "initialState carries schemaVersion 1");
    assert(state.resumable === false, "initialState is observational-only (resumable=false)");
    assert(state.pipelineState.currentStep === "explore", "initialState starts at explore");
    assert(state.pipelineState.status === "running", "initialState status=running");
    assert(state.eventLog.length === 0, "initialState eventLog empty");

    // Read non-existent state → undefined.
    const missing = await readState(dir, issue);
    assert(missing === undefined, "readState returns undefined for missing file");

    // Persist, read back, verify identity.
    await writeState(dir, state);
    const roundTripped = await readState(dir, issue);
    assert(roundTripped !== undefined, "readState finds the file after writeState");
    assert(
      roundTripped?.pipelineState.currentStep === "explore",
      "round-tripped state preserves currentStep",
    );
    assert(roundTripped?.issue === issue, "round-tripped state preserves issue");

    // Append an event, persist, verify.
    state = appendEvent(state, {
      kind: "step-started",
      step: "explore",
      at: 1500,
    });
    await writeState(dir, state);
    const afterAppend = await readState(dir, issue);
    assert(afterAppend?.eventLog.length === 1, "appendEvent persists exactly one event");
    assert(
      afterAppend?.eventLog[0]?.kind === "step-started",
      "appended event has expected kind",
    );

    // Schema-version mismatch must reject loudly.
    const file = workStateFile(dir, issue);
    await Bun.write(file, JSON.stringify({ ...state, schemaVersion: 99 }));
    try {
      await readState(dir, issue);
      assert(false, "schemaVersion mismatch should throw");
    } catch (err) {
      const msg = (err as Error).message;
      assert(
        msg.includes("schemaVersion=99") && msg.includes("expects 1"),
        "schema mismatch error names both versions",
      );
      assert(msg.includes("PI_ENSEMBLE_WORK_DRIVER=0"), "error surfaces the flag-bypass recovery path");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. nextStep transitions.
{
  const base = initialState(1, 1000);
  // Fresh state with no events: stays at explore (linear table's explore→plan)
  // — but the loop calls runStep("explore") first, which appends events. The
  // next-step decision happens AFTER the step. So on a fresh state with no
  // events, the linear table for explore is plan.
  assert(nextStep(base) === "plan", "fresh state at explore advances to plan");

  // Adversarial-approved with lastCompletedStep="develop" → commit-pr.
  // PR2: routing reads `lastCompletedStep` instead of `currentStep` (which
  // was clobbered to "adversarial" by runAdversarial). PR #239's check on
  // currentStep was always false and silently routed every adversarial-
  // approved to lens-review, skipping commit-pr. Confirmed live on #553.
  let s: WorkState = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
    },
  };
  s = appendEvent(s, { kind: "adversarial-approved", at: 2000, jobId: "j1", rounds: 1 });
  assert(
    nextStep(s) === "commit-pr",
    "adversarial-approved with lastCompletedStep=develop routes to commit-pr",
  );

  // Adversarial-approved with lastCompletedStep="lens-fix" → re-run lens-review.
  s = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "lens-fix",
    },
    eventLog: [{ kind: "adversarial-approved", at: 2000, jobId: "j2", rounds: 1 }],
  };
  assert(
    nextStep(s) === "lens-review",
    "adversarial-approved with lastCompletedStep=lens-fix re-enters lens-review",
  );

  // lens-issues-found, round 1 → lens-fix.
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "lens-review", reviewRound: 1 },
    eventLog: [
      {
        kind: "lens-issues-found",
        at: 3000,
        jobId: "j3",
        round: 1,
        findings: "...",
        verdict: "ISSUES_FOUND",
      },
    ],
  };
  assert(nextStep(s) === "lens-fix", "lens-issues-found within cap routes to lens-fix");

  // lens-issues-found, round 3 → handoff (round cap).
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "lens-review", reviewRound: 3 },
    eventLog: [
      {
        kind: "lens-issues-found",
        at: 3000,
        jobId: "j4",
        round: 3,
        findings: "...",
        verdict: "ISSUES_FOUND",
      },
    ],
  };
  assert(nextStep(s) === "handoff", "lens-issues-found at round cap routes to handoff");

  // lens-issues-found, wall-clock cap exceeded → handoff.
  s = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "lens-review",
      reviewRound: 1,
      reviewCapStartedAt: Date.now() - 91 * 60 * 1000, // 91 min ago
    },
    eventLog: [
      {
        kind: "lens-issues-found",
        at: 3000,
        jobId: "j5",
        round: 1,
        findings: "...",
        verdict: "ISSUES_FOUND",
      },
    ],
  };
  assert(nextStep(s) === "handoff", "lens-issues-found past wall-clock cap routes to handoff");

  // cap-hit event with nextStep="step-back" — driver honours the embedded route.
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "lens-review" },
    eventLog: [
      {
        kind: "cap-hit",
        at: 4000,
        cap: "round-cap",
        reviewRound: 3,
        nextStep: "step-back",
      },
    ],
  };
  assert(nextStep(s) === "step-back", "cap-hit event nextStep=step-back is honoured");

  // CI success → merged.
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "ci" },
    eventLog: [{ kind: "ci-status", at: 5000, status: "success" }],
  };
  assert(nextStep(s) === "merged", "ci-status success routes to merged");

  // CI failure with ciRetryCount under cap → develop (re-fix).
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "ci", ciRetryCount: 1 },
    eventLog: [{ kind: "ci-status", at: 5000, status: "failure" }],
  };
  assert(
    nextStep(s) === "develop",
    "ci-status failure with ciRetryCount=1 (<MAX_CI_RETRIES) routes to develop",
  );

  // CI failure with ciRetryCount at cap → handoff. PR2 B5: prevents the
  // infinite ci → develop → adversarial → lens-review → ci loop that
  // surfaced on issue #553's live cycle when no PR existed for CI to watch.
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "ci", ciRetryCount: 3 },
    eventLog: [{ kind: "ci-status", at: 5000, status: "failure" }],
  };
  assert(
    nextStep(s) === "handoff",
    "ci-status failure with ciRetryCount>=MAX_CI_RETRIES routes to handoff",
  );

  // Terminal status → "done".
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "merged", status: "merged" },
  };
  assert(nextStep(s) === "done", "merged status returns done");

  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "handoff", status: "handoff" },
  };
  assert(nextStep(s) === "done", "handoff status returns done");
}

// 3. runWorkDriver — happy path (single-workstream) with mock dispatch.
//
// PR3 sequence: explore → plan (decomposes) → branch (ops) → develop
// (developer). Plan returns no `## Workstreams` block, so the driver
// synthesises the `default` workstream and the cycle stays single-task.
// Steps 5/7 (adversarial / lens-review) call orchestrator functions
// directly (NOT through dispatchFn); we throw on dispatch #5 to halt
// cleanly before those live paths fire.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-loop-"));
  try {
    const { pi, sent } = makeFakePi();
    void sent;
    const rolesDispatched: string[] = [];
    const labelsDispatched: string[] = [];
    const ctx: DriverContext = {
      pi,
      repoRoot: dir,
      issue: 600,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        rolesDispatched.push(spec.role);
        labelsDispatched.push(opts?.label ?? spec.role);
        // explore (Step 1) → plan (Step 2) → ops branch (Step 3) → developer (Step 4)
        // Halt before adversarial would fire (dispatch #5+).
        if (rolesDispatched.length >= 5) {
          throw new Error("smoke: halting before adversarial step (would call live runAdversarialLoop)");
        }
        return mkResult({
          role: spec.role,
          text: `mock ${spec.role} output for issue #600`,
        });
      },
    };
    await runWorkDriver(ctx);

    // Roles by dispatch order: explore (Step 1) + explore (Step 2 plan,
    // explore-role dispatch with label "plan") + ops (Step 3 branch) + developer (Step 4).
    assert(rolesDispatched[0] === "explore", "Step 1: dispatches @explore (reconnaissance)");
    assert(
      rolesDispatched[1] === "explore" && labelsDispatched[1] === "plan",
      "Step 2: dispatches @explore with label 'plan' (workstream decomposition)",
    );
    assert(rolesDispatched[2] === "ops", "Step 3: dispatches @ops for branch creation");
    assert(rolesDispatched[3] === "developer", "Step 4: dispatches @developer for implementation");
    const after = await readState(dir, 600);
    assert(after !== undefined, "state file persists after the loop halts");
    // Plan-step output had no `## Workstreams` block → driver synthesises default.
    assert(
      after?.pipelineState.workstreams?.default !== undefined,
      "single-workstream cycle synthesises pipelineState.workstreams.default",
    );
    // Step 3 (branch) populates worktrees with default → repoRoot.
    assert(
      after?.pipelineState.worktrees?.default === dir,
      "Step 3 populates worktrees.default = repoRoot for single-workstream cycle",
    );
    const stepsStarted = (after?.eventLog ?? [])
      .filter((e): e is Extract<typeof e, { kind: "step-started" }> => e.kind === "step-started")
      .map((e) => e.step);
    assert(stepsStarted.includes("explore"), "explore step-started recorded");
    assert(stepsStarted.includes("plan"), "plan step-started recorded");
    assert(stepsStarted.includes("branch"), "branch step-started recorded");
    assert(stepsStarted.includes("develop"), "develop step-started recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4. Inconsistency detection halts cleanly.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-inconsistent-"));
  try {
    const issue = 700;
    let s = initialState(issue, 1000);
    // Inject an orphan in-flight job id with no matching dispatch-started.
    s = {
      ...s,
      pipelineState: { ...s.pipelineState, inFlightJobIds: ["orphan-job-id"] },
    };
    await writeState(dir, s);
    const inc = detectInconsistencies(s);
    assert(inc.length > 0, "detectInconsistencies flags orphan inFlightJobId");
    assert(
      inc.some((m) => m.includes("orphan-job-id")),
      "inconsistency message names the orphan jobId",
    );

    const { pi, sent } = makeFakePi();
    await runWorkDriver({ pi, repoRoot: dir, issue });
    assert(
      sent.some((m) => m.includes("state-file inconsistencies")),
      "runWorkDriver surfaces the inconsistency to the user",
    );
    // State must not have been mutated (loop refused to run).
    const after = await readState(dir, issue);
    assert(
      after?.pipelineState.status === "running",
      "inconsistent state is left untouched (no mutation)",
    );
    assert(after?.eventLog.length === 0, "no events appended on inconsistency halt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 5. DriverNotImplementedError surfaces step name.
{
  const err = new DriverNotImplementedError("develop");
  assert(err.step === "develop", "DriverNotImplementedError carries the step");
  assert(err.message.includes("develop"), "error message names the step");
}

// 6. parseAbort detects the ops/dev refusal markers.
{
  // Verbatim shape from issue #553's branch step ops reply (the `\n\n` before
  // `**ABORT` is load-bearing — markers must be on their own line so prose
  // discussing aborts elsewhere doesn't false-positive).
  const realAbort =
    "I'll create the feature branch following the safety preconditions. " +
    "First, let me check the issue #553 content to create an appropriate " +
    "branch description, then verify the preconditions.\n\n" +
    "**ABORT: Working tree is not clean**\n\n" +
    "Mainline identified: `main`\n\nHowever, the working tree has uncommitted changes (41 untracked files)";
  assert(parseAbort(realAbort) !== undefined, "parseAbort detects the real #553 ABORT message");
  assert(parseAbort("ABORT: --ff-only refused")?.startsWith("ABORT:") === true, "parseAbort: plain marker");
  assert(parseAbort(undefined) === undefined, "parseAbort: undefined input is undefined");
  assert(parseAbort("") === undefined, "parseAbort: empty input is undefined");
  assert(
    parseAbort("This text discusses an abort but the marker isn't on its own line") === undefined,
    "parseAbort: false-positive guard (prose mentioning abort, no marker line)",
  );
}

// 6b. work-widget renderStatus (PR2 O2) — pure-function check.
{
  const { renderStatus } = await import("../src/work-widget.ts");
  let state = initialState(553, 1_000_000);
  // Place the cycle mid-flight at lens-fix, step started 1m45s ago.
  state = {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      currentStep: "adversarial",
      reviewRound: 1,
      reviewCapStartedAt: 2_000_000,
      ciRetryCount: 1,
    },
  };
  const stepStartedAt = 5_000_000;
  const now = stepStartedAt + 105_000; // 1m45s
  const out = renderStatus(state, stepStartedAt, now);
  assert(out.includes("/work #553"), "widget renders issue number");
  assert(out.includes("step 5/9 adversarial"), "widget renders step ordinal + name");
  assert(out.includes("1m45s"), "widget renders step elapsed");
  assert(out.includes("round 1/3"), "widget renders review round cap");
  assert(out.includes("cap "), "widget renders wall-clock cap when timer is set");
  assert(out.includes("ci-retry 1/2"), "widget renders ci-retry counter when nonzero");
}

// 6c. Widget omits cap line when caps are inactive.
{
  const { renderStatus } = await import("../src/work-widget.ts");
  const state = initialState(42, 1_000_000); // reviewRound=0, ciRetryCount=0
  const out = renderStatus(state, 1_000_000, 1_005_000);
  assert(out.includes("step 1/9 explore"), "fresh widget renders step explore");
  assert(!out.includes("round"), "fresh widget does NOT render review-round cap");
  assert(!out.includes("ci-retry"), "fresh widget does NOT render ci-retry");
}

// 7. parseBranchName extracts the branch name ops emits.
{
  assert(
    parseBranchName("branch: feature/issue-553-cron-catchup") === "feature/issue-553-cron-catchup",
    "parseBranchName: plain marker",
  );
  assert(
    parseBranchName("**branch**: `feature/issue-547-x`") === "feature/issue-547-x",
    "parseBranchName: markdown bold + backticks",
  );
  assert(parseBranchName(undefined) === undefined, "parseBranchName: undefined input");
  assert(parseBranchName("Some prose about a branch") === undefined, "parseBranchName: no marker line");
  // Multi-line reply ending with the marker — the realistic shape from ops.
  const realistic = [
    "Branch created successfully.",
    "Mainline: main (fast-forwarded)",
    "",
    "branch: feature/issue-553-fix",
  ].join("\n");
  assert(
    parseBranchName(realistic) === "feature/issue-553-fix",
    "parseBranchName: end-of-reply marker line",
  );
}

// 8. setupWorkspaceTmp / teardownWorkspaceTmp / scratchDir (PR2 fold-in).
// Verifies the post-#553 cleanup wiring: scratch dir created, .git/info/exclude
// gains the /tmp/ entry (idempotent on subsequent calls), teardown removes it.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-tmp-"));
  try {
    const fs = await import("node:fs/promises");
    // Synthesize a minimal .git dir so .git/info/exclude is a real path.
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });

    const tmpDirPath = scratchDir(dir, 999);
    assert(tmpDirPath.endsWith("/tmp/issue-999"), "scratchDir builds <repo>/tmp/issue-<N>");

    const created = await setupWorkspaceTmp(dir, 999);
    assert(created === tmpDirPath, "setupWorkspaceTmp returns the scratch dir path");
    // dir exists
    const stat = await fs.stat(created);
    assert(stat.isDirectory(), "setupWorkspaceTmp creates the scratch dir");
    // .git/info/exclude has the /tmp/ line
    const exclude = await fs.readFile(path.join(dir, ".git", "info", "exclude"), "utf8");
    assert(/^\/tmp\/?\s*$/m.test(exclude), ".git/info/exclude gains /tmp/ entry");
    assert(exclude.includes("# pi-ensemble"), "exclude entry carries banner comment");

    // Idempotent: second call doesn't duplicate the entry.
    await setupWorkspaceTmp(dir, 999);
    const exclude2 = await fs.readFile(path.join(dir, ".git", "info", "exclude"), "utf8");
    const occurrences = (exclude2.match(/^\/tmp\/?\s*$/gm) ?? []).length;
    assert(occurrences === 1, "setupWorkspaceTmp is idempotent (no duplicate /tmp/ lines)");

    // Pre-existing /tmp/ line is preserved untouched.
    await fs.writeFile(path.join(dir, ".git", "info", "exclude"), "# user-managed\n/tmp/\nfoo.log\n");
    await setupWorkspaceTmp(dir, 999);
    const exclude3 = await fs.readFile(path.join(dir, ".git", "info", "exclude"), "utf8");
    assert(
      exclude3.includes("# user-managed") && exclude3.includes("foo.log"),
      "setupWorkspaceTmp preserves pre-existing exclude content",
    );
    const reOccurrences = (exclude3.match(/^\/tmp\/?\s*$/gm) ?? []).length;
    assert(reOccurrences === 1, "setupWorkspaceTmp doesn't add /tmp/ when already present");

    // Teardown removes the dir.
    await fs.writeFile(path.join(created, "smoke.txt"), "scratch");
    await teardownWorkspaceTmp(dir, 999);
    let removed = false;
    try {
      await fs.stat(created);
    } catch {
      removed = true;
    }
    assert(removed, "teardownWorkspaceTmp removes the scratch dir");

    // Teardown on already-removed dir is a no-op (no throw).
    await teardownWorkspaceTmp(dir, 999);
    assert(true, "teardownWorkspaceTmp on missing dir is safe (no-op)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 9. PR3 parsers: parseWorkstreams + parseWorktreesBlock.
//
// These are the lenient regex parsers the driver uses on Step 2 (plan)
// and Step 3 (branch) replies to populate pipelineState.workstreams and
// pipelineState.worktrees respectively. They must never throw; malformed
// input collapses to the empty result and the caller falls back to the
// synthesised `default` workstream.
{
  // Single workstream: just one ### default block.
  const single = `
Some prose before the block.

## Workstreams

### default — fix the WikiView error UX
- paths: frontend/src/components/WikiView.tsx, frontend/src/__tests__/WikiView.test.tsx
- out-of-scope: backend, docs, build config

Trailing prose.
`;
  const singleResult = parseWorkstreams(single);
  assert(
    Object.keys(singleResult).length === 1 && singleResult.default !== undefined,
    "parseWorkstreams: single default workstream parsed",
  );
  assert(
    singleResult.default?.scope === "fix the WikiView error UX",
    "parseWorkstreams: scope captured from heading dash",
  );
  assert(
    singleResult.default?.paths.includes("frontend/src/components/WikiView.tsx"),
    "parseWorkstreams: paths captured from `- paths:` line",
  );
  assert(
    singleResult.default?.outOfScope.includes("backend"),
    "parseWorkstreams: out-of-scope captured (LOAD-BEARING for issue #553 scope-contamination prevention)",
  );

  // Multi-workstream: 3 ### entries.
  const multi = `
## Workstreams

### task-a — frontend UI cleanup
- paths: frontend/src/components/Foo.tsx
- out-of-scope: backend

### task-b — backend API fix
- paths: src/api/handlers.rs
- out-of-scope: frontend

### task-c — docs update
- paths: docs/api.md
- out-of-scope: code
`;
  const multiResult = parseWorkstreams(multi);
  assert(Object.keys(multiResult).length === 3, "parseWorkstreams: 3 workstreams parsed");
  assert(
    multiResult["task-a"]?.scope === "frontend UI cleanup",
    "parseWorkstreams: first multi-workstream scope captured",
  );
  assert(
    multiResult["task-b"]?.paths.includes("src/api/handlers.rs"),
    "parseWorkstreams: second multi-workstream paths captured",
  );

  // No block → empty result (caller synthesises default).
  const noBlock = "Just some prose with no Workstreams heading anywhere.";
  assert(
    Object.keys(parseWorkstreams(noBlock)).length === 0,
    "parseWorkstreams: missing block returns {} (caller synthesises default)",
  );

  // Malformed block → empty result (never throws).
  const malformed = "## Workstreams\n\nnot a ### subheading just prose\n";
  assert(
    Object.keys(parseWorkstreams(malformed)).length === 0,
    "parseWorkstreams: malformed block returns {} (no throw)",
  );

  // parseWorktreesBlock: 2-worktree block.
  const wtText = `
Branch created.

## Worktrees

- task-a: /Users/dev/projects/foo/.worktrees/issue-553-task-a
- task-b: /Users/dev/projects/foo/.worktrees/issue-553-task-b

branch: feature/issue-553-fix
`;
  const wtResult = parseWorktreesBlock(wtText, "/Users/dev/projects/foo");
  assert(
    wtResult["task-a"] === "/Users/dev/projects/foo/.worktrees/issue-553-task-a",
    "parseWorktreesBlock: absolute path captured",
  );
  assert(
    Object.keys(wtResult).length === 2,
    "parseWorktreesBlock: 2 entries from ## Worktrees block",
  );

  // Missing block → empty (single-workstream fallback path in runBranch).
  assert(
    Object.keys(parseWorktreesBlock("no block here", "/repo")).length === 0,
    "parseWorktreesBlock: missing block returns {} (caller falls back to {default: repoRoot})",
  );
}

// 10. Multi-workstream develop fanout via mock dispatchFn.
//
// Asserts:
//  - N>1 workstreams trigger Promise.all of N developer dispatches
//  - branches-fanned-out → N × branch-completed → branches-converged events
//  - partial failure (one branch throws) records ok:false WITHOUT aborting
//    the other branches' completion
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-fanout-"));
  try {
    const fs = await import("node:fs/promises");
    // Pre-seed state at the "develop" step with 3 workstreams + worktrees
    // so we can exercise runDevelop's fanout path directly without running
    // Steps 1-3 (which would need mocked plan output).
    const state = {
      schemaVersion: 1 as const,
      resumable: false as const,
      issue: 700,
      issueBodyFetcherFn: mockIssueBodyOk,
      startedAt: 1_000_000,
      updatedAt: 1_000_000,
      pipelineState: {
        currentStep: "develop" as const,
        lastCompletedStep: "branch" as const,
        inFlightJobIds: [],
        worktrees: {
          "task-a": `${dir}/.worktrees/task-a`,
          "task-b": `${dir}/.worktrees/task-b`,
          "task-c": `${dir}/.worktrees/task-c`,
        },
        workstreams: {
          "task-a": { id: "task-a", scope: "frontend", paths: ["frontend/foo.ts"], outOfScope: [] },
          "task-b": { id: "task-b", scope: "backend", paths: ["src/api.rs"], outOfScope: [] },
          "task-c": { id: "task-c", scope: "docs", paths: ["docs/api.md"], outOfScope: [] },
        },
        reviewRound: 0,
        ciRetryCount: 0,
        plumbReports: [],
        status: "running" as const,
        branchName: "feature/issue-700-multi",
      },
      eventLog: [
        // Minimum prior events so the loop doesn't trip on inconsistency
        // detection (no orphan inFlightJobIds expected).
      ],
    };
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    await writeState(dir, state);

    const seenCwds: string[] = [];
    const seenLabels: string[] = [];
    let throwOnce = false;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 700,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenCwds.push(spec.cwd ?? "<no cwd>");
        seenLabels.push(opts?.label ?? spec.role);
        // Throw on task-b ONLY to exercise partial-failure handling.
        if (opts?.label === "developer[task-b]" && !throwOnce) {
          throwOnce = true;
          throw new Error("mock: simulated provider error for task-b");
        }
        // Other dispatches halt the cycle right after develop (we don't
        // want to drive into adversarial). Return ok=true; the loop will
        // then attempt adversarial via the live orchestrator path. We
        // detect that by throwing on any non-develop dispatch role.
        if (spec.role !== "developer") {
          throw new Error("smoke: halting after develop fanout");
        }
        return mkResult({
          role: "developer",
          text: `mock developer output for ${opts?.label}`,
        });
      },
    };
    await runWorkDriver(ctx);

    // Three developer dispatches fired, one per workstream, each with the
    // correct per-worktree cwd.
    const developerLabels = seenLabels.filter((l) => l.startsWith("developer["));
    assert(developerLabels.length === 3, "multi-workstream: 3 developer dispatches fired");
    assert(
      developerLabels.includes("developer[task-a]") &&
        developerLabels.includes("developer[task-b]") &&
        developerLabels.includes("developer[task-c]"),
      "multi-workstream: each workstream id appears in a developer dispatch label",
    );

    // Each developer's cwd is its workstream's worktree.
    const cwdsByLabel = Object.fromEntries(
      seenLabels.map((l, i) => [l, seenCwds[i]]).filter(([l]) => l?.startsWith("developer[")),
    );
    assert(
      cwdsByLabel["developer[task-a]"] === `${dir}/.worktrees/task-a`,
      "multi-workstream: developer[task-a] dispatches with task-a's worktree cwd",
    );
    assert(
      cwdsByLabel["developer[task-c]"] === `${dir}/.worktrees/task-c`,
      "multi-workstream: developer[task-c] dispatches with task-c's worktree cwd",
    );

    // Event sequence: branches-fanned-out → 3 × (dispatch-completed or
    // dispatch-failed) + 3 × branch-completed → branches-converged.
    const after = await readState(dir, 700);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(kinds.includes("branches-fanned-out"), "multi-workstream: branches-fanned-out emitted");
    const branchCompletions = (after?.eventLog ?? []).filter((e) => e.kind === "branch-completed");
    assert(
      branchCompletions.length === 3,
      "multi-workstream: 3 branch-completed events (one per branch)",
    );
    assert(
      kinds.includes("branches-converged"),
      "multi-workstream: branches-converged emitted after all branches resolve",
    );

    // Partial failure: task-b's branch-completed has ok=false, others ok=true.
    const verdictsByWorkstream = Object.fromEntries(
      branchCompletions.map((e) => [
        (e as Extract<typeof e, { kind: "branch-completed" }>).workstreamId,
        (e as Extract<typeof e, { kind: "branch-completed" }>).ok,
      ]),
    );
    assert(verdictsByWorkstream["task-a"] === true, "task-a: success recorded");
    assert(verdictsByWorkstream["task-b"] === false, "task-b: failure recorded (partial-failure aggregate)");
    assert(verdictsByWorkstream["task-c"] === true, "task-c: success recorded (NOT aborted by task-b failure)");

    // branches-converged carries the per-branch verdict aggregate.
    const converged = (after?.eventLog ?? []).find((e) => e.kind === "branches-converged");
    assert(converged !== undefined, "branches-converged is present");
    if (converged?.kind === "branches-converged") {
      assert(
        converged.verdicts.filter((v) => v.ok).length === 2,
        "branches-converged verdicts: 2 of 3 ok (partial failure aggregate)",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 11. PR4 — parsePrNumber lenient variants.
{
  assert(parsePrNumber("pr: 556") === 556, "parsePrNumber: plain `pr: 556`");
  assert(parsePrNumber("pr: #556") === 556, "parsePrNumber: hash-prefixed");
  assert(parsePrNumber("**pr**: `#556`") === 556, "parsePrNumber: markdown bold + backticks");
  assert(parsePrNumber("PR: 42") === 42, "parsePrNumber: case-insensitive");
  // End-of-reply marker line — the realistic shape from ops commit-pr.
  const realistic = [
    "Branch pushed and PR opened.",
    "",
    "Title: feat(#42): fix the thing",
    "URL: https://github.com/foo/bar/pull/42",
    "",
    "pr: 42",
  ].join("\n");
  assert(parsePrNumber(realistic) === 42, "parsePrNumber: end-of-reply marker line");
  assert(parsePrNumber(undefined) === undefined, "parsePrNumber: undefined input");
  assert(parsePrNumber("Some prose with PR mentioned but no marker") === undefined, "parsePrNumber: no marker line");
  assert(parsePrNumber("pr: not-a-number") === undefined, "parsePrNumber: non-numeric rejected");
}

// 12. PR4 — parseHandoffCommentUrl finds the gh-printed URL.
{
  // gh prints the comment URL after `gh pr comment` / `gh issue comment` succeeds.
  const okReply = [
    "Posted comment.",
    "https://github.com/org/repo/pull/553#issuecomment-2547382109",
    "",
    "Applied label needs-human-attention.",
  ].join("\n");
  assert(
    parseHandoffCommentUrl(okReply) === "https://github.com/org/repo/pull/553#issuecomment-2547382109",
    "parseHandoffCommentUrl: finds PR comment URL",
  );
  const issueReply = "https://github.com/org/repo/issues/600#issuecomment-99 posted.";
  assert(
    parseHandoffCommentUrl(issueReply) === "https://github.com/org/repo/issues/600#issuecomment-99",
    "parseHandoffCommentUrl: finds issue comment URL",
  );
  assert(parseHandoffCommentUrl(undefined) === undefined, "parseHandoffCommentUrl: undefined input");
  assert(
    parseHandoffCommentUrl("ops failed: gh auth missing") === undefined,
    "parseHandoffCommentUrl: no URL → undefined",
  );
}

// 13. PR4 — renderHandoffMarkdown shape against a synthetic state.
{
  let s = initialState(553, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      branchName: "feature/issue-553-fix",
      reviewRound: 3,
      prNumber: 556,
    },
  };
  s = appendEvent(
    s,
    {
      kind: "dispatch-completed",
      step: "explore",
      role: "explore",
      jobId: "j1",
      label: "explore",
      ok: true,
      ms: 28000,
      at: 1_001_000,
      transcriptPath: "/tmp/foo/explore.json",
    },
    {
      kind: "dispatch-completed",
      step: "develop",
      role: "developer",
      jobId: "j2",
      label: "developer",
      ok: true,
      ms: 240000,
      at: 1_240_000,
      transcriptPath: "/tmp/foo/developer.json",
    },
    {
      kind: "lens-issues-found",
      at: 1_900_000,
      jobId: "j3",
      round: 3,
      findings: "[]",
      verdict: "ISSUES_FOUND",
    },
    { kind: "cap-hit", at: 1_900_000, cap: "round-cap", reviewRound: 3, nextStep: "handoff" },
  );
  const md = renderHandoffMarkdown(s);
  assert(md.includes("Cap hit"), "renderHandoffMarkdown: includes Cap hit banner");
  assert(md.includes("round-cap"), "renderHandoffMarkdown: names the cap that fired");
  assert(md.includes("feature/issue-553-fix"), "renderHandoffMarkdown: surfaces branch name");
  assert(md.includes(".pi/work-state/553.json"), "renderHandoffMarkdown: points at state file");
  assert(md.includes("What was attempted"), "renderHandoffMarkdown: includes step-duration block");
  assert(md.includes("28.0s · explore"), "renderHandoffMarkdown: includes per-step durations");
  assert(
    md.includes("Recurring finding pattern"),
    "renderHandoffMarkdown: includes finding-pattern section when lens-issues-found present",
  );
  assert(md.includes("Transcripts"), "renderHandoffMarkdown: lists transcripts when present");
  assert(md.includes("/tmp/foo/explore.json"), "renderHandoffMarkdown: transcript paths verbatim");
}

// 14. PR4 — Pattern 3 (speculative explore) fires alongside developer.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-spec-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(700, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: dir },
        workstreams: {
          default: {
            id: "default",
            scope: "single-task scope",
            paths: ["src/foo.ts"],
            outOfScope: [],
          },
        },
        branchName: "feature/issue-700",
      },
    };
    await writeState(dir, s);

    const seenLabels: string[] = [];
    const seenPromptHints: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 700,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        // Capture whether the developer prompt mentions the speculative
        // context file (proves the developer knows where to look mid-flight).
        if (opts?.label === "developer" || opts?.label?.startsWith("developer[")) {
          if (spec.prompt.includes("speculative-default.md") || spec.prompt.includes("speculative-")) {
            seenPromptHints.push("developer-knows-about-speculative");
          }
        }
        // Halt after the develop step's parallel dispatches.
        if (seenLabels.length >= 3) {
          throw new Error("smoke: halting after develop step's Promise.all");
        }
        return mkResult({ role: spec.role, text: `mock ${spec.role} output` });
      },
    };
    await runWorkDriver(ctx);

    // Single-workstream develop should have fired BOTH developer AND
    // speculative explore concurrently (Promise.allSettled).
    assert(
      seenLabels.includes("developer"),
      "Pattern 3 (N=1): developer dispatched",
    );
    assert(
      seenLabels.includes("explore:speculative"),
      "Pattern 3 (N=1): speculative explore dispatched alongside developer",
    );
    assert(
      seenPromptHints.includes("developer-knows-about-speculative"),
      "Pattern 3 (N=1): developer prompt names the speculative-context.md scratch path",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 15. PR4 — speculative explore CAN be disabled via env opt-out.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-no-spec-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(701, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: dir },
        workstreams: {
          default: {
            id: "default",
            scope: "single-task scope",
            paths: ["src/foo.ts"],
            outOfScope: [],
          },
        },
      },
    };
    await writeState(dir, s);

    const prev = process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE;
    process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE = "1";
    try {
      const seenLabels: string[] = [];
      const ctx: DriverContext = {
        pi: makeFakePi().pi,
        repoRoot: dir,
        issue: 701,
        dispatchFn: async (_pi, spec, opts) => {
          seenLabels.push(opts?.label ?? spec.role);
          if (seenLabels.length >= 2) {
            throw new Error("smoke: halting after develop step");
          }
          return mkResult({ role: spec.role, text: `mock ${spec.role} output` });
        },
      };
      await runWorkDriver(ctx);
      assert(seenLabels.includes("developer"), "opt-out: developer dispatched");
      assert(
        !seenLabels.includes("explore:speculative"),
        "opt-out: speculative explore skipped under PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE=1",
      );
    } finally {
      if (prev === undefined) delete process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE;
      else process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 16. PR4 — round suffix only renders for round > 1 in lifecycle formatLine.
{
  const lc = await import("../src/lifecycle-events.ts");
  // Round 1 (or undefined) → no suffix.
  const round1 = lc.formatLine({
    kind: "step-started",
    jobId: "adversarial",
    label: "adversarial",
    role: "adversarial",
    stepNumber: 5,
    stepTotal: 9,
    round: 1,
  });
  assert(!round1.includes("(round"), "round=1 produces no `(round N)` suffix (first entry)");
  // Round 2+ shows suffix.
  const round2 = lc.formatLine({
    kind: "step-started",
    jobId: "adversarial",
    label: "adversarial",
    role: "adversarial",
    stepNumber: 5,
    stepTotal: 9,
    round: 2,
  });
  assert(round2.includes("(round 2)"), "round=2 shows `(round 2)` suffix");
  // Same for step-completed.
  const completed3 = lc.formatLine({
    kind: "step-completed",
    jobId: "lens-review",
    label: "lens-review",
    role: "lens-review",
    stepNumber: 7,
    stepTotal: 9,
    elapsedMs: 30000,
    round: 3,
  });
  assert(completed3.includes("(round 3)"), "step-completed: round=3 suffix shown");
}

// 17. PR5 — STEP_FAILURE_POLICY classifies every WorkStep.
{
  const required: Array<keyof typeof STEP_FAILURE_POLICY> = [
    "explore",
    "plan",
    "branch",
    "develop",
    "adversarial",
    "commit-pr",
    "lens-review",
    "lens-fix",
    "step-back",
    "ci",
    "handoff",
    "merged",
  ];
  for (const step of required) {
    const policy = STEP_FAILURE_POLICY[step];
    assert(
      policy === "HALT" || policy === "RETRY_ONCE" || policy === "DEGRADED_OK",
      `STEP_FAILURE_POLICY['${step}'] is one of HALT/RETRY_ONCE/DEGRADED_OK (got ${policy})`,
    );
  }
  // Spot-check the load-bearing classifications.
  assert(STEP_FAILURE_POLICY.develop === "HALT", "develop is HALT (the #553 root cause)");
  assert(STEP_FAILURE_POLICY.adversarial === "RETRY_ONCE", "adversarial is RETRY_ONCE");
  assert(STEP_FAILURE_POLICY["lens-review"] === "RETRY_ONCE", "lens-review is RETRY_ONCE");
  assert(STEP_FAILURE_POLICY.handoff === "DEGRADED_OK", "handoff is DEGRADED_OK (loop terminator)");
}

// 18. PR5+6 — explainCap returns non-empty for every WorkEvent cap-hit shape.
{
  const fakeState = initialState(1, 1_000_000);
  const capValues = [
    "adversarial-loop",
    "round-cap",
    "wall-clock",
    "ci-retry",
    "developer-timeout",
    // PR6 — explore verdict caps
    "explore-already-complete",
    "explore-needs-clarification",
    "step-failed:explore",
    "step-failed:plan",
    "step-failed:branch",
    "step-failed:develop",
    "step-failed:adversarial",
    "step-failed:commit-pr",
    "step-failed:lens-review",
    "step-failed:lens-fix",
    "step-failed:ci",
  ] as const;
  for (const cap of capValues) {
    const sentence = explainCap(cap, fakeState);
    assert(
      typeof sentence === "string" && sentence.length > 30,
      `explainCap('${cap}') returns a meaningful sentence (${sentence.length} chars)`,
    );
  }
}

// 19. PR5 — runWorkDriver halts cleanly on HALT-class dispatch-failed.
// Empirical: develop SIGTERM cascade from #553 must NOT advance to adversarial.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-halt-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    // Pre-seed state at develop so we can mock a develop failure.
    let s = initialState(800, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-800-test",
      },
    };
    await writeState(dir, s);

    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 800,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        // Developer dispatch SIGTERMs (the #553 shape).
        if (spec.role === "developer") {
          return mkResult({
            role: "developer",
            ok: false,
            exitCode: 143,
            text: "[pi-ensemble] killed after 1800000ms timeout",
          });
        }
        // Speculative explore returns ok so the develop-step fanout
        // settles cleanly (the failure-path comes from the developer leg).
        if (spec.role === "explore" && opts?.label?.startsWith("explore:speculative")) {
          return mkResult({ role: "explore", text: "mock speculative context" });
        }
        // Handoff ops returns ok (so runHandoff completes; we're verifying
        // the cycle reached handoff at all, not the gh-fallback path).
        if (opts?.label === "ops:handoff") {
          return mkResult({ role: "ops", text: "Posted." });
        }
        throw new Error(`unexpected dispatch in halt smoke: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 800);
    assert(after?.pipelineState.status === "aborted", "HALT on develop sets status=aborted");
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(
      kinds.includes("cap-hit"),
      "HALT on develop synthesises a cap-hit event",
    );
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "developer-timeout",
      "HALT recognises SIGTERM as cap='developer-timeout' (not generic step-failed:develop)",
    );
    // The driver must NOT have dispatched adversarial after the develop
    // failure — that's the cascade we're preventing.
    const adversarialDispatches = seenLabels.filter((l) =>
      l.startsWith("adversarial") || l === "adversarial_loop",
    );
    assert(
      adversarialDispatches.length === 0,
      "halt-cascade prevention: NO adversarial dispatch after develop SIGTERM",
    );
    // But the handoff DID run (ops:handoff in the labels).
    assert(
      seenLabels.includes("ops:handoff"),
      "halt-cascade routes through handoff (ops:handoff dispatch fired)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 20. PR5 — captureWorktreeSnapshot populates the snapshot.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-snap-"));
  try {
    const fs = await import("node:fs/promises");
    // Initialise a real git repo so the shell-outs have something to read.
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);
    await execp("git init -q", { cwd: dir });
    await execp(
      'git config user.email "smoke@test" && git config user.name "Smoke" && git commit --allow-empty -q -m init',
      { cwd: dir, shell: "/bin/bash" },
    );
    await fs.writeFile(path.join(dir, "modified.txt"), "hi");
    await execp("git add modified.txt", { cwd: dir });
    await fs.writeFile(path.join(dir, "unstaged.txt"), "hi");

    const snap = await captureWorktreeSnapshot(dir, "main");
    assert(snap.headSha.length > 0, "captureWorktreeSnapshot: HEAD sha resolved");
    assert(snap.branchExists === true, "captureWorktreeSnapshot: branch exists locally");
    assert(snap.branchPushed === false, "captureWorktreeSnapshot: no origin → branchPushed=false");
    assert(
      snap.modifiedFiles.includes("modified.txt") || snap.modifiedFiles.includes("unstaged.txt"),
      "captureWorktreeSnapshot: lists modified files",
    );
    assert(
      snap.stagedCount + snap.unstagedCount >= 2,
      "captureWorktreeSnapshot: counts at least 2 files (1 staged + 1 unstaged)",
    );
    assert(snap.capturedAt > 0, "captureWorktreeSnapshot: timestamp set");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 21. PR5 — renderHandoffUserMessage produces the multi-line operator template.
{
  let s = initialState(553, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "aborted",
      branchName: "feature/issue-553-fix",
      handoffSnapshot: {
        modifiedFiles: ["src/foo.ts", "tests/foo.test.ts"],
        unstagedCount: 1,
        stagedCount: 1,
        branchExists: true,
        branchPushed: false,
        headSha: "abc1234",
        capturedAt: 1_000_500,
      },
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "developer-timeout",
    reviewRound: 0,
    nextStep: "handoff",
  });
  s = appendEvent(s, {
    kind: "handoff-emitted",
    at: 1_000_600,
    commentUrl: undefined, // simulates gh-fallback failure
    labelApplied: false,
    handoffBodyPath: "/tmp/issue-553/handoff-comment.md",
  });

  const msg = renderHandoffUserMessage(s, "/repo/lantern", "/repo/lantern/tmp/issue-553");
  assert(
    msg.includes("HANDOFF DISPATCH INCOMPLETE"),
    "renderHandoffUserMessage: INCOMPLETE banner when commentUrl is null",
  );
  assert(
    msg.includes("gh issue comment 553 --body-file"),
    "renderHandoffUserMessage: surfaces the manual gh-comment recovery command",
  );
  assert(
    msg.includes("developer subagent hit its wall-clock cap"),
    "renderHandoffUserMessage: explainCap output appears in body",
  );
  assert(
    msg.includes("feature/issue-553-fix"),
    "renderHandoffUserMessage: surfaces branch name",
  );
  assert(msg.includes("HEAD abc1234"), "renderHandoffUserMessage: surfaces HEAD sha");
  assert(
    msg.includes("modified: src/foo.ts, tests/foo.test.ts") ||
      msg.includes("src/foo.ts") && msg.includes("tests/foo.test.ts"),
    "renderHandoffUserMessage: lists modified files",
  );
  assert(
    msg.includes("PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER=5400000"),
    "renderHandoffUserMessage: recovery #2 names per-role timeout env var",
  );
  assert(
    msg.includes("rm /repo/lantern/.pi/work-state/553.json"),
    "renderHandoffUserMessage: recovery #3 surfaces the rm command",
  );
}

// 22. PR5 — renderHandoffMarkdown adds Worktree state + Concrete recovery sections.
{
  let s = initialState(553, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      branchName: "feature/issue-553-fix",
      handoffSnapshot: {
        modifiedFiles: ["src/foo.ts"],
        unstagedCount: 1,
        stagedCount: 0,
        branchExists: true,
        branchPushed: false,
        headSha: "deadbee",
        capturedAt: 1_000_500,
      },
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "developer-timeout",
    reviewRound: 0,
    nextStep: "handoff",
  });
  const md = renderHandoffMarkdown(s);
  assert(md.includes("### What this cap means"), "renderHandoffMarkdown: 'What this cap means' section");
  assert(md.includes("### Worktree state at handoff"), "renderHandoffMarkdown: 'Worktree state at handoff' section");
  assert(md.includes("### Concrete recovery commands"), "renderHandoffMarkdown: 'Concrete recovery commands' section");
  assert(md.includes("### Inspect further"), "renderHandoffMarkdown: 'Inspect further' footer");
  assert(
    md.includes("PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER"),
    "renderHandoffMarkdown: surfaces per-role timeout env in recovery #2",
  );
}

// 23. PR6 — parseExploreVerdict pure helper.
{
  assert(parseExploreVerdict("VERDICT: ALREADY_COMPLETE") === "ALREADY_COMPLETE",
    "parseExploreVerdict: plain ALREADY_COMPLETE");
  assert(parseExploreVerdict("**VERDICT:** NEEDS_WORK") === "NEEDS_WORK",
    "parseExploreVerdict: bold-wrapped NEEDS_WORK");
  assert(parseExploreVerdict("verdict: needs_clarification") === "NEEDS_CLARIFICATION",
    "parseExploreVerdict: case-insensitive, lower-snake input");
  assert(
    parseExploreVerdict("## Verdict\n\nVERDICT: ALREADY_COMPLETE\n\n## Touchpoints") ===
      "ALREADY_COMPLETE",
    "parseExploreVerdict: embedded under heading, first match wins",
  );
  assert(parseExploreVerdict("no verdict here") === null,
    "parseExploreVerdict: missing verdict → null");
  assert(parseExploreVerdict("VERDICT: NEVER_VALID") === null,
    "parseExploreVerdict: unknown verdict → null (not coerced)");
  assert(parseExploreVerdict("") === null, "parseExploreVerdict: empty string → null");
}

// 24. PR6 — runWorkDriver halts cleanly on VERDICT: ALREADY_COMPLETE.
// Empirical #533: explore correctly identified ALREADY_COMPLETED but
// driver ran every step to lens-fix before user intervention. After
// PR6, the verdict routes to handoff with no plan/branch/develop.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-already-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 533,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (spec.role === "explore" && opts?.label === "explore") {
          return mkResult({
            role: "explore",
            text: "## Verdict\n\nVERDICT: ALREADY_COMPLETE\n\nIssue closed via PR #534 5 days ago.",
          });
        }
        if (opts?.label === "ops:handoff") {
          return mkResult({ role: "ops", text: "Posted." });
        }
        throw new Error(`unexpected dispatch in already-complete smoke: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 533);
    assert(
      after?.pipelineState.exploreVerdict === "ALREADY_COMPLETE",
      "ALREADY_COMPLETE: exploreVerdict persisted on pipelineState",
    );
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "explore-already-complete",
      "ALREADY_COMPLETE: synthesises cap='explore-already-complete'",
    );
    // The cascade the empirical #533 ran: must NOT have seen plan/branch/develop.
    const cascadeLabels = seenLabels.filter((l) =>
      l === "plan" || l === "branch" || l === "developer" || l.startsWith("adversarial") ||
      l === "commit-pr" || l.startsWith("lens-review"),
    );
    assert(
      cascadeLabels.length === 0,
      `ALREADY_COMPLETE: NO plan/branch/develop/adversarial dispatch (got: ${cascadeLabels.join(",") || "none"})`,
    );
    assert(
      seenLabels.includes("ops:handoff"),
      "ALREADY_COMPLETE: handoff DID run (ops:handoff dispatch fired)",
    );
    assert(
      after?.pipelineState.status === "handoff",
      "ALREADY_COMPLETE: terminal status=handoff (not aborted — nothing broke)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 25. PR6 — VERDICT: NEEDS_CLARIFICATION routes to handoff with distinct cap.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-clarify-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 700,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (spec.role === "explore" && opts?.label === "explore") {
          return mkResult({
            role: "explore",
            text: "VERDICT: NEEDS_CLARIFICATION\n\nAcceptance criteria are missing.",
          });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, 700);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "explore-needs-clarification",
      "NEEDS_CLARIFICATION: synthesises cap='explore-needs-clarification'",
    );
    assert(
      after?.pipelineState.exploreVerdict === "NEEDS_CLARIFICATION",
      "NEEDS_CLARIFICATION: exploreVerdict persisted",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 26. PR6 — NEEDS_WORK proceeds to plan normally (regression guard for
// happy path). Missing verdict header also falls through unchanged.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-needswork-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let planSeen = false;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 701,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (spec.role === "explore" && opts?.label === "explore") {
          return mkResult({
            role: "explore",
            text: "VERDICT: NEEDS_WORK\n\n## Workstreams\n\n### default — fix the bug",
          });
        }
        if (opts?.label === "plan") {
          planSeen = true;
          // Halt the loop by throwing — we only care that plan was reached.
          throw new Error("test halt after reaching plan");
        }
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 701);
    assert(
      after?.pipelineState.exploreVerdict === "NEEDS_WORK",
      "NEEDS_WORK: exploreVerdict persisted even on the proceed path",
    );
    assert(planSeen, "NEEDS_WORK: driver proceeded to plan step (no early halt)");
    // PR5's halt-cascade router synthesises a step-failed:plan cap when we
    // throw inside plan to halt the test — that's correct, separate path.
    // The PR6 guarantee is that NO explore-* cap fired (i.e. the verdict
    // router didn't intercept).
    const exploreCapHits = (after?.eventLog ?? []).filter(
      (e) => e.kind === "cap-hit" && e.cap.startsWith("explore-"),
    );
    assert(
      exploreCapHits.length === 0,
      "NEEDS_WORK: no explore-* cap-hit synthesised (verdict router did not intercept)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 27. PR6 — runLens empty-diff guard skips dispatch + synthesises lens-approved.
// Empirical #533 lens-review found phantom PERFORMANCE issues in unrelated
// files on an empty diff; this guard prevents that path.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-empty-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    // Pre-seed state at lens-review with no worktrees and a clean repoRoot
    // → fetchAllDiffs returns "" and the guard fires.
    let s = initialState(702, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-review",
        lastCompletedStep: "commit-pr",
        worktrees: {},
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-702-test",
        prNumber: 9999,
      },
    };
    await writeState(dir, s);

    // Initialise a git repo at dir so fetchAllDiffs has something to read
    // (it'll return empty since nothing is staged/modified).
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);
    await execp("git init -q", { cwd: dir });
    await execp(
      'git config user.email "t@t" && git config user.name "T" && git commit --allow-empty -q -m init',
      { cwd: dir, shell: "/bin/bash" },
    );

    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 702,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        // ci step calls ops to watch CI; stub a quick success so we reach merged.
        if (spec.role === "ops") {
          return mkResult({ role: "ops", text: "CI_STATUS: success" });
        }
        throw new Error(`unexpected dispatch in empty-diff smoke: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 702);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(
      kinds.includes("lens-skipped-empty-diff"),
      "empty-diff: lens-skipped-empty-diff event emitted",
    );
    assert(
      kinds.includes("lens-approved"),
      "empty-diff: synthesised lens-approved event emitted (so nextStep advances)",
    );
    // No lens children dispatched — the role wouldn't be ops or handoff if so.
    const lensReviewLabels = seenLabels.filter((l) =>
      l.startsWith("lens-review") || l.startsWith("code-review-specialist"),
    );
    assert(
      lensReviewLabels.length === 0,
      `empty-diff: NO lens dispatch fired (got: ${lensReviewLabels.join(",") || "none"})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 28. PR6 — renderHandoffUserMessage produces cap-specific recovery commands
// for explore-* caps (different from PR5's developer-timeout set).
{
  let s = initialState(533, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "handoff",
      exploreVerdict: "ALREADY_COMPLETE",
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "explore-already-complete",
    reviewRound: 0,
    nextStep: "handoff",
  });
  s = appendEvent(s, {
    kind: "handoff-emitted",
    at: 1_000_600,
    commentUrl: "https://github.com/x/y/issues/533#comment-1",
    labelApplied: true,
    handoffBodyPath: "/tmp/issue-533/handoff-comment.md",
  });
  const msg = renderHandoffUserMessage(s, "/repo/lantern", "/repo/lantern/tmp/issue-533");
  assert(
    msg.includes("explore concluded this issue is already done"),
    "explore-already-complete: explainCap output in body",
  );
  assert(
    msg.includes("gh issue close 533"),
    "explore-already-complete: recovery includes gh issue close",
  );
  assert(
    !msg.includes("PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER"),
    "explore-already-complete: does NOT include the wrong 'longer cap' recovery",
  );
  assert(
    !msg.includes("git add -p && git commit"),
    "explore-already-complete: does NOT include the wrong 'git push what's there' recovery",
  );

  const md = renderHandoffMarkdown(s);
  assert(
    md.includes("gh issue close 533"),
    "renderHandoffMarkdown: explore-already-complete recovery includes gh issue close",
  );
  assert(
    !md.includes("PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER"),
    "renderHandoffMarkdown: explore-already-complete does NOT include the wrong recovery",
  );
}

// 29. PR7 — runWorkDriver halts on branches-converged ALL-FAILED.
// Empirical /work 553 2026-06-24: all 3 develop workstreams provider-errored
// mid-stream; pre-PR7 the driver advanced into adversarial APPROVAL of an
// empty diff. After PR7, branches-converged with any ok:false → halt.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-bc-allfail-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(900, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: {
          "task-a": `${dir}/.worktrees/task-a`,
          "task-b": `${dir}/.worktrees/task-b`,
          "task-c": `${dir}/.worktrees/task-c`,
        },
        workstreams: {
          "task-a": { id: "task-a", scope: "a", paths: [], outOfScope: [] },
          "task-b": { id: "task-b", scope: "b", paths: [], outOfScope: [] },
          "task-c": { id: "task-c", scope: "c", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-900-multi",
      },
    };
    await writeState(dir, s);

    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 900,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        // All 3 developer dispatches return ok:false (provider-error shape).
        if (spec.role === "developer") {
          return mkResult({ role: "developer", ok: false, exitCode: 1, text: "" });
        }
        // Speculative explores (PR3 fanout) — ok so the develop converge
        // settles on the developer leg failures.
        if (spec.role === "explore" && opts?.label?.startsWith("explore:speculative")) {
          return mkResult({ role: "explore", text: "mock" });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 900);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(
      kinds.includes("branches-converged"),
      "branches-converged emitted",
    );
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "step-failed:develop",
      "all-failed: synthesises cap='step-failed:develop' (PR7 router intercepts)",
    );
    const advLabels = seenLabels.filter((l) => l.startsWith("adversarial"));
    assert(
      advLabels.length === 0,
      `all-failed: NO adversarial dispatch after branches-converged (the /work 553 cascade prevented; got: ${advLabels.join(",") || "none"})`,
    );
    assert(
      seenLabels.includes("ops:handoff"),
      "all-failed: handoff DID run (ops:handoff dispatch fired)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 30. PR7 — partial failure (1-of-3 branches failed) also routes to handoff.
// /work doctrine: ANY failed branch halts; out-of-scope-fence design implies
// a failed branch leaves the decomposition incoherent.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-bc-partial-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(901, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: {
          "task-a": `${dir}/.worktrees/task-a`,
          "task-b": `${dir}/.worktrees/task-b`,
          "task-c": `${dir}/.worktrees/task-c`,
        },
        workstreams: {
          "task-a": { id: "task-a", scope: "a", paths: [], outOfScope: [] },
          "task-b": { id: "task-b", scope: "b", paths: [], outOfScope: [] },
          "task-c": { id: "task-c", scope: "c", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-901-partial",
      },
    };
    await writeState(dir, s);

    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 901,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (spec.role === "developer") {
          // task-b fails; task-a and task-c succeed.
          if (opts?.label === "developer[task-b]") {
            return mkResult({ role: "developer", ok: false, exitCode: 1, text: "" });
          }
          return mkResult({ role: "developer", text: "ok" });
        }
        if (spec.role === "explore" && opts?.label?.startsWith("explore:speculative")) {
          return mkResult({ role: "explore", text: "mock" });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 901);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "step-failed:develop",
      "1-of-3 failed: still halts (any-failure routes to handoff)",
    );
    const advLabels = seenLabels.filter((l) => l.startsWith("adversarial"));
    assert(
      advLabels.length === 0,
      "1-of-3 failed: NO adversarial dispatch (partial-success ≠ valid input)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 31. PR7 — explainCap fanout parenthetical for multi-workstream halts.
// Uses the most-recent branches-converged event to count failed branches.
{
  let s = initialState(553, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      branchName: "feature/issue-553",
    },
  };
  s = appendEvent(s, {
    kind: "branches-converged",
    step: "develop",
    verdicts: [
      { id: "task-a", ok: false },
      { id: "task-b", ok: false },
      { id: "task-c", ok: false },
    ],
    at: 1_000_500,
  });
  const sentence = explainCap("step-failed:develop", s);
  assert(
    sentence.includes("3/3 workstream branches failed"),
    `explainCap step-failed:develop surfaces fanout count (got: "${sentence}")`,
  );

  // Single-workstream / no branches-converged → no parenthetical.
  const sNoFanout = initialState(540, 1_000_000);
  const sentenceSingle = explainCap("step-failed:develop", sNoFanout);
  assert(
    !sentenceSingle.includes("workstream branches"),
    "explainCap step-failed:develop OMITS fanout text when no branches-converged event present",
  );
}

// 32. PR7 — renderHandoffUserMessage surfaces per-workstream verdicts
// when the cap-hit was multi-workstream (mirrors renderHandoffMarkdown).
{
  let s = initialState(553, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "aborted",
      branchName: "feature/issue-553",
    },
  };
  s = appendEvent(
    s,
    {
      kind: "branches-converged",
      step: "develop",
      verdicts: [
        { id: "task-a", ok: false },
        { id: "task-b", ok: false },
        { id: "task-c", ok: false },
      ],
      at: 1_000_400,
    },
    {
      kind: "cap-hit",
      at: 1_000_500,
      cap: "step-failed:develop",
      reviewRound: 0,
      nextStep: "handoff",
    },
    {
      kind: "handoff-emitted",
      at: 1_000_600,
      commentUrl: "https://github.com/x/y/issues/553#comment-1",
      labelApplied: true,
      handoffBodyPath: "/tmp/issue-553/handoff-comment.md",
    },
  );
  const msg = renderHandoffUserMessage(s, "/repo/lantern", "/repo/lantern/tmp/issue-553");
  assert(
    msg.includes("Workstream verdicts (develop fanout, 0/3 ok)"),
    "renderHandoffUserMessage: surfaces multi-workstream verdicts header with ratio",
  );
  assert(
    msg.includes("task-a: FAIL") && msg.includes("task-b: FAIL") && msg.includes("task-c: FAIL"),
    "renderHandoffUserMessage: lists each workstream's FAIL/ok verdict",
  );
}

// 33. PR8 — runAdversarial fans out per-workstream for N>1 (instead of
// reviewing a fragmented `## workstream:` merged diff). Empirical /work
// 553 2026-06-24: pre-PR8 single-shot adversarial on merged fanout
// flagged phantom CRITICALs from cross-workstream merge artifacts and
// fix-loop fragmented state by dispatching into one cwd only.
//
// This test mocks ctx.adversarialLoopFn so we can verify:
//   - one loop call per workstream (N parallel, each in its own cwd)
//   - all-approved → adversarial-approved → routes to commit-pr
//   - any-rejected → adversarial-rejected + cap-hit → routes to handoff
{
  // 33a — all 3 workstreams APPROVED → aggregate adversarial-approved.
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-fanout-ok-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(910, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: {
          "task-a": `${dir}/.worktrees/task-a`,
          "task-b": `${dir}/.worktrees/task-b`,
          "task-c": `${dir}/.worktrees/task-c`,
        },
        workstreams: {
          "task-a": { id: "task-a", scope: "a", paths: [], outOfScope: [] },
          "task-b": { id: "task-b", scope: "b", paths: [], outOfScope: [] },
          "task-c": { id: "task-c", scope: "c", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-910",
      },
    };
    await writeState(dir, s);

    const seenWorkCwds: string[] = [];
    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 910,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async (params) => {
        seenWorkCwds.push(params.workCwd ?? "<no cwd>");
        // APPROVED on round 1 for all three.
        return mkResult({
          role: "adversarial-developer",
          ok: true,
          text: "Adversarial APPROVED after round 1.\n",
        });
      },
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        // commit-pr ops returns a PR number so the cycle can advance into
        // lens-review territory; we throw there to halt the test bounded.
        if (opts?.label === "ops:commit-pr") {
          return mkResult({ role: "ops", text: "Done.\npr: 5101\n" });
        }
        throw new Error(`unexpected dispatch (halting test): ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 910);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(
      seenWorkCwds.length === 3,
      `33a all-approved: 3 adversarialLoopFn calls (one per workstream); got ${seenWorkCwds.length}`,
    );
    assert(
      seenWorkCwds.includes(`${dir}/.worktrees/task-a`) &&
        seenWorkCwds.includes(`${dir}/.worktrees/task-b`) &&
        seenWorkCwds.includes(`${dir}/.worktrees/task-c`),
      "33a all-approved: each adversarial loop runs in its own worktree's cwd (no shared cwd)",
    );
    const advBranchEvents = (after?.eventLog ?? []).filter(
      (e) => e.kind === "branch-completed" && e.step === "adversarial",
    );
    assert(
      advBranchEvents.length === 3 && advBranchEvents.every((e) => e.kind === "branch-completed" && e.ok),
      "33a all-approved: 3 branch-completed events for adversarial, all ok",
    );
    assert(
      kinds.includes("branches-converged"),
      "33a all-approved: branches-converged emitted for adversarial fanout",
    );
    assert(
      kinds.filter((k) => k === "adversarial-approved").length === 1,
      "33a all-approved: exactly one synthesised adversarial-approved aggregate event",
    );
    // The fanout-approve cycle should route forward to commit-pr.
    assert(
      seenLabels.includes("ops:commit-pr"),
      "33a all-approved: cycle advanced to commit-pr (aggregate APPROVED → nextStep=commit-pr)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 33b — 1 of 3 workstreams REJECTED → aggregate adversarial-rejected
  // + cap-hit('adversarial-loop') → cycle routes to handoff.
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-fanout-rej-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(911, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: {
          "task-a": `${dir}/.worktrees/task-a`,
          "task-b": `${dir}/.worktrees/task-b`,
          "task-c": `${dir}/.worktrees/task-c`,
        },
        workstreams: {
          "task-a": { id: "task-a", scope: "a", paths: [], outOfScope: [] },
          "task-b": { id: "task-b", scope: "b", paths: [], outOfScope: [] },
          "task-c": { id: "task-c", scope: "c", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-911",
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 911,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async (params) => {
        // task-b's workCwd → REJECTED after 3 rounds. Others APPROVED.
        if (params.workCwd?.endsWith("task-b")) {
          return mkResult({
            role: "adversarial-developer",
            ok: false,
            text:
              "Adversarial REJECTED after round 3.\n" +
              "Findings: still has the same critical issue.\n",
          });
        }
        return mkResult({
          role: "adversarial-developer",
          ok: true,
          text: "Adversarial APPROVED after round 1.\n",
        });
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 911);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(
      kinds.includes("branches-converged"),
      "33b mixed: branches-converged emitted",
    );
    const advRejected = (after?.eventLog ?? []).filter((e) => e.kind === "adversarial-rejected");
    assert(
      advRejected.length === 1,
      "33b mixed: exactly one synthesised adversarial-rejected aggregate event",
    );
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "adversarial-loop",
      "33b mixed: cap='adversarial-loop' synthesised after any-rejection",
    );
    assert(
      after?.pipelineState.status === "handoff",
      "33b mixed: cycle terminates at handoff (per cap-hit nextStep)",
    );
    // Rejection findings should preserve per-workstream provenance so the
    // handoff renderer can tell the operator WHICH workstream failed.
    const rej = advRejected[0];
    assert(
      rej?.kind === "adversarial-rejected" && rej.findings.includes("[workstream task-b]"),
      "33b mixed: aggregate findings tag the rejected workstream's slice",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 34. PR8 — parseAdversarialRounds helper covers all 3 marker shapes
// (the per-workstream max-rounds aggregation depends on this).
//
// (Helper isn't exported, so test via the synthesised adversarial-approved
// rounds field — exercise round 1/2/3 paths individually via mocked loops.)
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-rounds-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(912, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: {
          "task-a": `${dir}/.worktrees/task-a`,
          "task-b": `${dir}/.worktrees/task-b`,
        },
        workstreams: {
          "task-a": { id: "task-a", scope: "a", paths: [], outOfScope: [] },
          "task-b": { id: "task-b", scope: "b", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-912",
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 912,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async (params) => {
        // task-a APPROVED in 1 round; task-b APPROVED in 2 rounds.
        // Aggregate rounds should be max = 2.
        if (params.workCwd?.endsWith("task-a")) {
          return mkResult({
            role: "adversarial-developer",
            ok: true,
            text: "Adversarial APPROVED after round 1.\n",
          });
        }
        return mkResult({
          role: "adversarial-developer",
          ok: true,
          text: "Adversarial APPROVED after round 2.\n",
        });
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:commit-pr") {
          return mkResult({ role: "ops", text: "Done.\npr: 5102\n" });
        }
        throw new Error(`halting after commit-pr: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 912);
    const approved = (after?.eventLog ?? []).find((e) => e.kind === "adversarial-approved");
    assert(
      approved?.kind === "adversarial-approved" && approved.rounds === 2,
      `aggregate rounds = max(per-workstream) = 2 (got: ${approved?.kind === "adversarial-approved" ? approved.rounds : "missing"})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 35. PR10 — parsePerIssueVerdicts pure helper.
{
  const text = `## Verdict
- #561: NEEDS_WORK — fresh bug
- #562: ALREADY_COMPLETE — satisfied by PR #534
- #563: NEEDS_CLARIFICATION — acceptance criteria missing
`;
  const result = parsePerIssueVerdicts(text, [561, 562, 563]);
  assert(result.length === 3, "parsePerIssueVerdicts: returns one entry per requested issue");
  assert(
    result[0]?.issue === 561 && result[0]?.verdict === "NEEDS_WORK" && result[0]?.reason === "fresh bug",
    "parsePerIssueVerdicts: #561 NEEDS_WORK + reason captured",
  );
  assert(
    result[1]?.verdict === "ALREADY_COMPLETE" && result[1]?.reason.includes("PR #534"),
    "parsePerIssueVerdicts: #562 ALREADY_COMPLETE + reason captured",
  );
  assert(
    result[2]?.verdict === "NEEDS_CLARIFICATION" && result[2]?.reason.includes("acceptance criteria"),
    "parsePerIssueVerdicts: #563 NEEDS_CLARIFICATION + reason captured",
  );
  // Missing per-issue line falls back to overall verdict.
  const fallback = parsePerIssueVerdicts("VERDICT: NEEDS_WORK\n", [700, 701]);
  assert(
    fallback[0]?.verdict === "NEEDS_WORK" && fallback[1]?.verdict === "NEEDS_WORK",
    "parsePerIssueVerdicts: falls back to overall VERDICT when per-issue absent",
  );
  // Missing per-issue + no overall → default NEEDS_WORK.
  const defaulted = parsePerIssueVerdicts("no verdicts here at all", [800]);
  assert(
    defaulted[0]?.verdict === "NEEDS_WORK",
    "parsePerIssueVerdicts: defaults to NEEDS_WORK when nothing parseable (driver proceeds rather than silently drops)",
  );
}

// 36. PR10 — parseMergeCommit pure helper.
{
  assert(parseMergeCommit("merge-commit: abc1234") === "abc1234",
    "parseMergeCommit: plain marker line captured");
  assert(parseMergeCommit("**merge-commit:** `deadbee567`") === "deadbee567",
    "parseMergeCommit: markdown emphasis + backticks tolerated");
  assert(parseMergeCommit("...preamble...\nmerge-commit: 1234567890abcdef") === "1234567890abcdef",
    "parseMergeCommit: marker line found inside multi-line reply");
  assert(parseMergeCommit("no marker") === undefined,
    "parseMergeCommit: missing marker → undefined");
  assert(parseMergeCommit(undefined) === undefined,
    "parseMergeCommit: undefined input → undefined");
}

// 37. PR10 — runMerged actually dispatches ops on the happy path; the
// merged event captures the parsed merge-commit SHA. Empirical /work 561
// + /work 562 case: pre-PR10 driver said MERGED ✓ while PRs sat OPEN.
// After PR10 the dispatch fires and status flips on completion.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-merge-ok-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(950, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "merged",
        lastCompletedStep: "ci",
        branchName: "feature/issue-950",
        prNumber: 9501,
      },
    };
    await writeState(dir, s);
    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 950,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (opts?.label === "ops:merge") {
          return mkResult({
            role: "ops",
            text: "PR squash-merged + branch deleted.\nmerge-commit: abc1234def\n",
          });
        }
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, 950);
    assert(
      seenLabels.includes("ops:merge"),
      "runMerged: ops:merge dispatch DID fire (was a 0ms no-op pre-PR10)",
    );
    assert(
      after?.pipelineState.status === "merged",
      "runMerged: terminal status='merged' after successful dispatch",
    );
    const mergedEvent = (after?.eventLog ?? []).find((e) => e.kind === "merged");
    assert(
      mergedEvent?.kind === "merged" && mergedEvent.mergeCommit === "abc1234def",
      "runMerged: merged event captures parsed mergeCommit SHA",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 38. PR10 — runMerged dispatch failure → cap-hit 'step-failed:merged' →
// handoff. STEP_FAILURE_POLICY[merged] is HALT (was DEGRADED_OK pre-PR10),
// so PR5's halt-cascade router intercepts when ops can't actually merge.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-merge-fail-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(951, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "merged",
        lastCompletedStep: "ci",
        branchName: "feature/issue-951",
        prNumber: 9511,
      },
    };
    await writeState(dir, s);
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 951,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:merge") {
          return mkResult({
            role: "ops",
            ok: false,
            exitCode: 1,
            text: "[pi-ensemble] killed after 600000ms timeout",
          });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, 951);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "step-failed:merged",
      "runMerged failure: cap='step-failed:merged' synthesised (PR5 halt-cascade router fires for HALT-class merged)",
    );
    assert(
      after?.pipelineState.status === "aborted",
      "runMerged failure: terminal status='aborted' (mid-flight failure routed through handoff)",
    );
    const explanation = explainCap("step-failed:merged", after!);
    assert(
      explanation.includes("gh pr merge") && /merge manually/i.test(explanation),
      "explainCap step-failed:merged gives the operator a merge-manually recovery hint",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Tests 39-41 exercise the driver-level PR10 multi-issue bundled API
// (ctx.issues = [N, M, P]). PR15+ the /work entry point (commands.ts)
// no longer produces this shape — it fires per-issue sequential cycles
// instead, one PR per issue. These tests remain as back-compat contract
// tests for the driver-level API: programmatic callers or a future
// re-enablement path can still invoke the bundled shape. Retiring the
// bundled prompts/logic is deferred to a cleanup PR once we're sure the
// sequential shape is durable in the field.

// 39. PR10 — multi-issue happy path (driver-level API): explore returns
// per-issue NEEDS_WORK for all 3, activeIssues = [all 3], droppedIssues
// empty, plan + commit-pr see the full list.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-multi-ok-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const seenLabels: string[] = [];
    let planPrompt = "";
    let commitPrPrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 961,
      issues: [961, 962, 963],
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (opts?.label === "explore") {
          return mkResult({
            role: "explore",
            text: `## Verdict
- #961: NEEDS_WORK
- #962: NEEDS_WORK
- #963: NEEDS_WORK

## Workstreams

### default — fix the bugs
- paths: src/foo.ts
- out-of-scope: docs
`,
          });
        }
        if (opts?.label === "plan") {
          planPrompt = spec.prompt;
          throw new Error("halt at plan: captured prompt for assertion");
        }
        if (opts?.label === "ops:commit-pr") {
          commitPrPrompt = spec.prompt;
          throw new Error("halt at commit-pr: captured prompt for assertion");
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 961);
    assert(
      after?.pipelineState.activeIssues?.length === 3,
      "multi-issue happy: activeIssues includes all 3 NEEDS_WORK issues",
    );
    assert(
      (after?.pipelineState.droppedIssues ?? []).length === 0,
      "multi-issue happy: droppedIssues empty",
    );
    assert(
      planPrompt.includes("#961, #962, #963"),
      "multi-issue happy: plan prompt threads all 3 issue numbers in the headline",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 40. PR10 — multi-issue mixed verdict: NEEDS_WORK + ALREADY_COMPLETE +
// NEEDS_CLARIFICATION → activeIssues = [needs-work only], droppedIssues
// populated, commit-pr Fixes lines for active issues only.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-multi-mixed-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let commitPrPrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 970,
      issues: [970, 971, 972],
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "explore") {
          return mkResult({
            role: "explore",
            text: `## Verdict
- #970: NEEDS_WORK
- #971: ALREADY_COMPLETE — satisfied by PR #534
- #972: NEEDS_CLARIFICATION — acceptance criteria missing

## Workstreams

### default — fix it
- paths: src/foo.ts
- out-of-scope: docs
`,
          });
        }
        if (opts?.label === "ops:commit-pr") {
          commitPrPrompt = spec.prompt;
          throw new Error("halt at commit-pr: captured prompt for assertion");
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        // Stub everything else; we only care about explore + commit-pr.
        return mkResult({ role: spec.role, text: "stub" });
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 970);
    assert(
      JSON.stringify(after?.pipelineState.activeIssues) === JSON.stringify([970]),
      `multi-issue mixed: activeIssues = [970] (got ${JSON.stringify(after?.pipelineState.activeIssues)})`,
    );
    const dropped = after?.pipelineState.droppedIssues ?? [];
    assert(
      dropped.length === 2,
      "multi-issue mixed: droppedIssues contains 2 entries (971 + 972)",
    );
    assert(
      dropped.find((d) => d.issue === 971)?.verdict === "ALREADY_COMPLETE",
      "multi-issue mixed: #971 dropped as ALREADY_COMPLETE",
    );
    assert(
      dropped.find((d) => d.issue === 972)?.verdict === "NEEDS_CLARIFICATION",
      "multi-issue mixed: #972 dropped as NEEDS_CLARIFICATION",
    );
    if (commitPrPrompt) {
      assert(
        commitPrPrompt.includes("Fixes #970") && !commitPrPrompt.includes("Fixes #971"),
        "multi-issue mixed: commit-pr prompt has Fixes for active only (not for dropped 971)",
      );
      assert(
        commitPrPrompt.includes("Companion to #971"),
        "multi-issue mixed: commit-pr prompt mentions dropped #971 as Companion-to (PR body context)",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 41. PR10 — multi-issue all-dropped: every issue ALREADY_COMPLETE →
// activeIssues = [], aggregate cap-hit 'explore-already-complete' →
// handoff (existing PR6 routing). Empirical /work 533 path generalised.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-multi-all-done-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 980,
      issues: [980, 981],
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (opts?.label === "explore") {
          return mkResult({
            role: "explore",
            text: `## Verdict
- #980: ALREADY_COMPLETE — merged via PR #100
- #981: ALREADY_COMPLETE — merged via PR #101
`,
          });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, 980);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "explore-already-complete",
      "multi-issue all-dropped: cap='explore-already-complete' (aggregate)",
    );
    assert(
      after?.pipelineState.activeIssues?.length === 0,
      "multi-issue all-dropped: activeIssues = [] (all filtered)",
    );
    // No plan / branch / develop dispatches when all issues dropped.
    const cascadeLabels = seenLabels.filter((l) =>
      l === "plan" || l === "developer" || l.startsWith("developer["),
    );
    assert(
      cascadeLabels.length === 0,
      `multi-issue all-dropped: NO plan/develop dispatch (got: ${cascadeLabels.join(",") || "none"})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 42. PR10 — renderHandoffUserMessage surfaces per-issue verdicts for
// multi-issue cycles.
{
  let s = initialState(970, 1_000_000);
  s = {
    ...s,
    issues: [970, 971, 972],
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "handoff",
      branchName: "feature/issues-970-971-972",
      activeIssues: [970],
      droppedIssues: [
        { issue: 971, verdict: "ALREADY_COMPLETE", reason: "satisfied by PR #534" },
        { issue: 972, verdict: "NEEDS_CLARIFICATION", reason: "acceptance criteria missing" },
      ],
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "explore-already-complete",
    reviewRound: 0,
    nextStep: "handoff",
  });
  s = appendEvent(s, {
    kind: "handoff-emitted",
    at: 1_000_500,
    commentUrl: "https://github.com/x/y/issues/970#c1",
    labelApplied: true,
    handoffBodyPath: "/tmp/issue-970/handoff-comment.md",
  });
  const msg = renderHandoffUserMessage(s, "/repo/proj", "/repo/proj/tmp/issue-970");
  assert(
    msg.includes("issues #970, #971, #972"),
    "renderHandoffUserMessage multi-issue: header lists all 3 issues",
  );
  assert(
    msg.includes("#970: NEEDS_WORK (active in this PR)"),
    "renderHandoffUserMessage multi-issue: #970 listed as active",
  );
  assert(
    msg.includes("#971: ALREADY_COMPLETE — satisfied by PR #534"),
    "renderHandoffUserMessage multi-issue: #971 with verdict + reason surfaced",
  );
  assert(
    msg.includes("#972: NEEDS_CLARIFICATION"),
    "renderHandoffUserMessage multi-issue: #972 NEEDS_CLARIFICATION surfaced",
  );

  const md = renderHandoffMarkdown(s);
  assert(
    md.includes("`#970`, `#971`, `#972`"),
    "renderHandoffMarkdown multi-issue: header lists all 3 issues in code spans",
  );
  assert(
    md.includes("### Issues in this cycle"),
    "renderHandoffMarkdown multi-issue: 'Issues in this cycle' section emitted",
  );
}

// 43. PR11 — runLens uses merge-base diff (origin/<base>..HEAD), not
// `git diff HEAD`. Empirical /work 533+557 (v10r 2026-06-25): pre-PR11
// the empty-diff guard fired POST-commit on every cycle because the
// diff was committed and `git diff HEAD` was empty → lens-review skipped
// in 34 ms → code merged without six-pass review.
//
// This test wires a real git repo with a committed feature branch and a
// simulated origin/main, then runs runWorkDriver at lens-review and
// asserts the empty-diff guard does NOT fire (lens-review attempts to
// dispatch — captured via the dispatchFn throwing).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-postcommit-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    // Real git repo: init, commit, branch, commit, simulate origin/main
    // pointing at the initial commit so git diff origin/main..HEAD shows
    // the feature branch's change.
    await execp("git init -q", { cwd: dir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: dir,
      shell: "/bin/bash",
    });
    await fs.writeFile(path.join(dir, "base.txt"), "hello\n");
    await execp("git add base.txt && git commit -q -m initial", { cwd: dir, shell: "/bin/bash" });
    // Simulate origin/main + origin/HEAD → main without an actual remote.
    await execp("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: dir,
    });
    await execp("git checkout -qb feature/pr11-test", { cwd: dir });
    await fs.writeFile(path.join(dir, "feature.txt"), "world\n");
    await execp("git add feature.txt && git commit -q -m 'feature change'", {
      cwd: dir,
      shell: "/bin/bash",
    });

    // Confirm setup: git diff HEAD is empty, git diff origin/main..HEAD has content.
    const diffHead = await execp("git diff HEAD", { cwd: dir });
    const diffMerged = await execp("git diff origin/main..HEAD", { cwd: dir });
    assert(diffHead.stdout.trim() === "", "test setup: git diff HEAD is empty (post-commit)");
    assert(
      diffMerged.stdout.includes("feature.txt"),
      "test setup: git diff origin/main..HEAD shows the merged feature diff",
    );

    // Pre-seed state at lens-review with worktrees.default = dir so
    // runLens fetches the merged diff from this real repo. dispatchFn
    // throws on the lens-review child so we can halt and inspect.
    let s = initialState(820, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-review",
        lastCompletedStep: "commit-pr",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/pr11-test",
        prNumber: 8200,
      },
    };
    await writeState(dir, s);

    let lensDispatched = false;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 820,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (spec.role === "code-review-specialist") {
          lensDispatched = true;
          throw new Error("halt-lens-dispatch (test detected runLensReview was reached)");
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        return mkResult({ role: spec.role, text: "stub" });
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 820);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    // Either runLensReview was reached (lensDispatched=true, signalling our
    // halt was hit), OR a lens-review dispatch-completed/failed event
    // appears in the log. Both confirm the empty-diff guard did NOT fire.
    assert(
      lensDispatched ||
        kinds.includes("dispatch-completed") ||
        kinds.includes("dispatch-failed"),
      "PR11 §A: runLens did NOT skip on empty diff post-commit (merge-base fetcher saw the feature diff)",
    );
    assert(
      !kinds.includes("lens-skipped-empty-diff"),
      "PR11 §A: lens-skipped-empty-diff event was NOT emitted (the bug it prevented)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 44. PR11 — runLens still emits lens-skipped-empty-diff for genuinely
// empty cycles (feature branch == origin/main, no commits ahead).
// Regression guard so PR11 §A doesn't lose the PR6 guard's protection.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-empty-real-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    await execp("git init -q", { cwd: dir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: dir,
      shell: "/bin/bash",
    });
    await fs.writeFile(path.join(dir, "base.txt"), "hello\n");
    await execp("git add base.txt && git commit -q -m initial", { cwd: dir, shell: "/bin/bash" });
    await execp("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: dir,
    });
    await execp("git checkout -qb feature/pr11-empty", { cwd: dir });
    // No commits on the feature branch → origin/main..HEAD is empty.

    let s = initialState(821, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-review",
        lastCompletedStep: "commit-pr",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/pr11-empty",
        prNumber: 8210,
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 821,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role === "ops") return mkResult({ role: "ops", text: "CI_STATUS: success" });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 821);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(
      kinds.includes("lens-skipped-empty-diff"),
      "PR11 §A regression: lens-skipped-empty-diff still fires when origin/main..HEAD is empty (genuine no-work cycle)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 45. PR11 §B — develop prompt threads activeIssues, not ctx.issue.
// Empirical v10r incident: pre-PR11 the developer prompt hardcoded
// ctx.issue (= primary = first token) even when activeIssues = [different
// issue from explore]. Result: PR #483 implemented #479's --config work
// while branded fix(#476).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-dev-active-issue-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    // Pre-seed at develop with primary issue=479 but activeIssues=[476]
    // (the v10r-incident shape). The developer prompt must reference #476.
    let s = initialState(479, 1_000_000);
    s = {
      ...s,
      issues: [479, 480, 481, 482, 476],
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "fix the HNSW listener crash", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-476-heal-invalid-hnsw-index",
        activeIssues: [476],
        droppedIssues: [
          { issue: 479, verdict: "NEEDS_CLARIFICATION", reason: "No issue body available" },
          { issue: 480, verdict: "NEEDS_CLARIFICATION", reason: "No issue body available" },
          { issue: 481, verdict: "NEEDS_CLARIFICATION", reason: "No issue body available" },
          { issue: 482, verdict: "NEEDS_CLARIFICATION", reason: "No issue body available" },
        ],
      },
    };
    await writeState(dir, s);

    let developerPrompt = "";
    let speculativePrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 479,
      issues: [479, 480, 481, 482, 476],
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "developer") developerPrompt = spec.prompt;
        if (opts?.label === "explore:speculative") speculativePrompt = spec.prompt;
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        // Throw on any non-developer/non-speculative dispatch to halt the cycle.
        if (spec.role === "developer") {
          return mkResult({ role: "developer", text: "stub" });
        }
        if (spec.role === "explore" && opts?.label?.startsWith("explore:speculative")) {
          return mkResult({ role: "explore", text: "stub" });
        }
        throw new Error(`halt: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    // Developer prompt must reference #476 (the active issue), NOT #479
    // (the primary). The pre-PR11 bug would have the prompt say `#479`.
    assert(
      developerPrompt.includes("issue #476") && !developerPrompt.includes("issue #479"),
      `PR11 §B: developer prompt references active issue #476, NOT primary #479 (got headline: "${developerPrompt.split("\n")[0]}")`,
    );
    assert(
      developerPrompt.includes("gh issue view 476") && !developerPrompt.includes("gh issue view 479"),
      "PR11 §B: developer prompt's re-fetch instruction targets active issue #476",
    );
    if (speculativePrompt) {
      assert(
        speculativePrompt.includes("#476") && !speculativePrompt.includes("#479"),
        "PR11 §B: speculative explore prompt also references active issue #476",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 46. PR11 §C — runExplore halts on empty issue body (test-only injection).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-explore-empty-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 850,
      // Simulate the v10r incident: gh issue view returns empty stdout
      // (projectCards GraphQL deprecation / gh extension hijack /
      // auth lapse). All bodies empty → halt.
      issueBodyFetcherFn: async (_n, _cwd) => ({ stdout: "" }),
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        return mkResult({ role: spec.role, text: "stub" });
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 850);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "explore-bodies-empty",
      "PR11 §C: empty body → cap='explore-bodies-empty'",
    );
    assert(
      (after?.pipelineState.emptyBodyIssues ?? []).length === 1,
      "PR11 §C: emptyBodyIssues populated with the failed fetch",
    );
    assert(
      after?.pipelineState.emptyBodyIssues?.[0]?.issue === 850,
      "PR11 §C: emptyBodyIssues entry names the failing issue",
    );
    const cascadeLabels = seenLabels.filter(
      (l) => l === "plan" || l === "branch" || l === "developer" || l.startsWith("developer["),
    );
    assert(
      cascadeLabels.length === 0,
      `PR11 §C: NO plan/branch/develop dispatch (the v10r cascade prevented; got: ${cascadeLabels.join(",") || "none"})`,
    );
    assert(
      seenLabels.includes("ops:handoff"),
      "PR11 §C: handoff DID run (operator gets the explanation + recovery commands)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 47. PR11 §C — partial-empty (some bodies present, some empty) STILL
// halts. Strict rule per design — partial-data flow-through is what
// caused the v10r incident.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-explore-partial-empty-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let fetchCount = 0;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 860,
      issues: [860, 861, 862],
      issueBodyFetcherFn: async (n, _cwd) => {
        fetchCount++;
        // #860 succeeds; #861 + #862 return empty (v10r-shape).
        if (n === 860) return { stdout: `title:\tok\n\nreal body for #${n}` };
        return { stdout: "" };
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        return mkResult({ role: spec.role, text: "stub" });
      },
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, 860);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "explore-bodies-empty",
      "PR11 §C: ANY empty body halts (strict rule, not majority)",
    );
    const empty = after?.pipelineState.emptyBodyIssues ?? [];
    assert(
      empty.length === 2 && empty.some((e) => e.issue === 861) && empty.some((e) => e.issue === 862),
      "PR11 §C: emptyBodyIssues lists exactly the failed fetches (#861, #862)",
    );
    assert(fetchCount === 3, "PR11 §C: fetcher called once per requested issue");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 48. PR11 §E — explainCap covers the new cap shape + renderHandoffUserMessage
// surfaces empty-body details with diagnostic recovery commands.
{
  let s = initialState(479, 1_000_000);
  s = {
    ...s,
    issues: [479, 480, 481, 482, 476],
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "handoff",
      emptyBodyIssues: [
        { issue: 479, reason: "gh issue view returned empty stdout (possible projectCards GraphQL deprecation, gh extension hijack, or auth lapse)" },
        { issue: 480, reason: "gh issue view returned empty stdout" },
        { issue: 481, reason: "gh issue view returned empty stdout" },
        { issue: 482, reason: "gh issue view returned empty stdout" },
      ],
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "explore-bodies-empty",
    reviewRound: 0,
    nextStep: "handoff",
  });
  s = appendEvent(s, {
    kind: "handoff-emitted",
    at: 1_000_500,
    commentUrl: "https://github.com/x/y/issues/479#c1",
    labelApplied: true,
    handoffBodyPath: "/tmp/issue-479/handoff-comment.md",
  });

  // explainCap covers the new shape and names the failing issues.
  const explanation = explainCap("explore-bodies-empty", s);
  assert(
    explanation.includes("#479") && explanation.includes("#480"),
    "PR11 §E: explainCap explore-bodies-empty names the failing issues",
  );
  assert(
    /gh auth status/i.test(explanation),
    "PR11 §E: explainCap suggests gh auth status as part of the diagnostic",
  );

  // renderHandoffUserMessage surfaces the diagnostic recovery commands.
  const msg = renderHandoffUserMessage(s, "/repo/v10r", "/repo/v10r/tmp/issue-479");
  assert(
    msg.includes("Empty/error body fetches:"),
    "PR11 §E: renderHandoffUserMessage lists failed body fetches",
  );
  assert(
    msg.includes("gh auth status") && msg.includes("gh --version"),
    "PR11 §E: recovery commands include gh auth status + gh --version",
  );
  assert(
    msg.includes("gh api repos/") && msg.includes("--jq .body"),
    "PR11 §E: recovery commands include REST-fallback probe",
  );

  // renderHandoffMarkdown emits the empty-body section above recovery.
  const md = renderHandoffMarkdown(s);
  assert(
    md.includes("### Empty / failed issue-body fetches"),
    "PR11 §E: renderHandoffMarkdown emits 'Empty / failed issue-body fetches' section",
  );
  assert(
    md.includes("#479") && md.includes("#480"),
    "PR11 §E: renderHandoffMarkdown lists each failed issue under the section",
  );
}

// 49. PR12 — runWorkDriver on terminal state (no --restart) emits a clear
// notify and returns. Pre-PR12 this silently fell through to the end of
// the function with no user-facing message; PM ended up recommending
// /do as a workaround.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-terminal-notify-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    // Pre-seed a terminal state file (status=handoff).
    let s = initialState(900, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "handoff",
        status: "handoff",
        branchName: "feature/issue-900",
      },
    };
    await writeState(dir, s);

    const { pi, sent } = makeFakePi();
    let dispatchCalled = false;
    const ctx: DriverContext = {
      pi,
      repoRoot: dir,
      issue: 900,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, _spec, _opts) => {
        dispatchCalled = true;
        return mkResult({ role: "explore", text: "stub" });
      },
    };
    await runWorkDriver(ctx);
    assert(
      dispatchCalled === false,
      "PR12 §B: runWorkDriver on terminal-handoff state does NOT dispatch anything",
    );
    const notify = sent.join("\n");
    assert(
      /already terminated as handoff/.test(notify),
      "PR12 §B: notify names the terminal status (handoff)",
    );
    assert(
      /--restart/.test(notify),
      "PR12 §B: notify points at /work --restart as the recovery",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 50. PR12 — runWorkDriver with ctx.restart=true skips readState; existing
// state is overwritten on first writeState. Asserts that the cycle runs
// from initialState even though a terminal state file exists.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-restart-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    // Pre-seed a terminal state with a fingerprint event so we can detect
    // whether it survived the restart (it should NOT).
    let s = initialState(910, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "handoff",
        status: "handoff",
        branchName: "feature/issue-910-old",
      },
    };
    s = appendEvent(s, {
      kind: "cap-hit",
      at: 1_000_500,
      cap: "adversarial-loop",
      reviewRound: 3,
      nextStep: "handoff",
    });
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 910,
      restart: true,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        // Halt at first dispatch (explore for the fresh cycle) so the
        // test runs fast — we only need to know the cycle didn't early-
        // exit on the prior terminal state.
        throw new Error(`halt-after-restart: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 910);
    assert(
      after?.pipelineState.branchName === undefined,
      "PR12 §A: --restart wipes prior pipelineState.branchName (fresh initialState)",
    );
    // The prior cycle's cap-hit ('adversarial-loop') must be GONE.
    // The post-restart cycle may emit its own cap-hits (e.g., from the
    // dispatch-halt the test fixture triggers); we only assert the
    // pre-seeded one didn't survive.
    const preSeededCapHits = (after?.eventLog ?? []).filter(
      (e) => e.kind === "cap-hit" && e.cap === "adversarial-loop",
    );
    assert(
      preSeededCapHits.length === 0,
      "PR12 §A: --restart wipes prior eventLog (no surviving 'adversarial-loop' cap-hit from previous cycle)",
    );
    assert(
      after?.pipelineState.currentStep !== "handoff" ||
        after?.pipelineState.status === "aborted",
      "PR12 §A: --restart resets currentStep away from terminal handoff (or aborts on dispatch-halt)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 51. PR12 — parseStepBackReply extracts sddElement / diagnosis /
// proposedRevision from the @explore step-back reply. Lenient on
// markdown emphasis + multi-line values.
{
  const reply = `Analysis of the recurring lens findings:

sddElement: Outcomes — acceptance criteria

diagnosis: The issue doesn't specify what "fixed" looks like, so reviewers keep flagging missing tests for edge cases.

proposedRevision: ## Acceptance criteria

- All public functions in src/foo.ts have unit tests
- Edge cases X, Y, Z are covered
- typecheck + lint clean

alternativeApproach: Could also split into two issues — one for the impl, one for the test suite.
`;
  const r = parseStepBackReply(reply);
  assert(
    /Outcomes/.test(r.sddElement),
    `PR12: parseStepBackReply captures sddElement (got "${r.sddElement}")`,
  );
  assert(
    /reviewers keep flagging/.test(r.diagnosis),
    "PR12: parseStepBackReply captures diagnosis",
  );
  assert(
    /Acceptance criteria/.test(r.proposedRevision) && /edge cases/i.test(r.proposedRevision),
    "PR12: parseStepBackReply captures multi-line proposedRevision until the next key",
  );
  // Missing fields → empty strings (graceful degrade). sddElement captures
  // multi-line until the next recognised key or end-of-input (so when
  // ONLY sddElement is present, its capture extends to the end of the
  // reply — that's correct behaviour for graceful parsing, the renderer
  // shows whatever was captured).
  const partial = parseStepBackReply("sddElement: Constraints\n\n(no other fields)");
  assert(
    /Constraints/.test(partial.sddElement) &&
      partial.diagnosis === "" &&
      partial.proposedRevision === "",
    "PR12: parseStepBackReply returns empty strings for absent fields",
  );
}

// 52. PR12 — runStepBack appends step-back-completed AND cap-hit
// (cap='step-back-revise-spec') after the @explore dispatch. The cap-hit
// is the routing signal that lets the handoff renderer branch.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-stepback-cap-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(920, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "step-back",
        lastCompletedStep: "lens-review",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "x", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-920",
      },
    };
    s = appendEvent(s, {
      kind: "lens-issues-found",
      at: 1_000_200,
      jobId: "j1",
      round: 1,
      findings: '[{"lens":"ARCHITECTURE","severity":"HIGH","title":"missing AC"}]',
      verdict: "ISSUES_FOUND",
    });
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 920,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "explore:step-back") {
          return mkResult({
            role: "explore",
            text:
              "sddElement: Outcomes\n" +
              "diagnosis: The acceptance criteria are missing for edge case X.\n" +
              "proposedRevision: Add a 'must handle X' bullet under DoD.\n",
          });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 920);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(
      kinds.includes("step-back-completed"),
      "PR12 §C: step-back-completed event emitted",
    );
    const sb = (after?.eventLog ?? []).find((e) => e.kind === "step-back-completed");
    assert(
      sb?.kind === "step-back-completed" && /Outcomes/.test(sb.sddElement),
      "PR12 §C: step-back-completed payload carries parsed sddElement",
    );
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "step-back-revise-spec",
      "PR12 §C: cap-hit synthesised with cap='step-back-revise-spec'",
    );
    assert(
      after?.pipelineState.status === "handoff",
      "PR12 §C: cycle routes to terminal handoff (existing nextStep cap-hit branch)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 53. PR12 — explainCap + handoff renderers surface the step-back
// proposedRevision + the /plan + --restart recovery commands.
{
  let s = initialState(930, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "handoff",
      branchName: "feature/issue-930",
    },
  };
  s = appendEvent(
    s,
    {
      kind: "step-back-completed",
      at: 1_000_300,
      jobId: "j2",
      sddElement: "Outcomes — acceptance criteria",
      diagnosis: "AC are too vague; reviewers keep flagging missing edge-case coverage",
      proposedRevision: "Add explicit AC: all branches in src/foo.ts have unit tests for X, Y, Z.",
    },
    {
      kind: "cap-hit",
      at: 1_000_400,
      cap: "step-back-revise-spec",
      reviewRound: 3,
      nextStep: "handoff",
    },
    {
      kind: "handoff-emitted",
      at: 1_000_500,
      commentUrl: "https://github.com/x/y/issues/930#c1",
      labelApplied: true,
      handoffBodyPath: "/tmp/issue-930/handoff-comment.md",
    },
  );

  const explanation = explainCap("step-back-revise-spec", s);
  assert(
    /spec-level gap/i.test(explanation) && /Outcomes/.test(explanation),
    "PR12 §E: explainCap step-back-revise-spec names the sddElement",
  );
  assert(
    /--restart/.test(explanation),
    "PR12 §E: explainCap mentions /work --restart in recovery hint",
  );

  const msg = renderHandoffUserMessage(s, "/repo/proj", "/repo/proj/tmp/issue-930");
  assert(
    /Step-back analysis/i.test(msg),
    "PR12 §E: renderHandoffUserMessage emits 'Step-back analysis' section",
  );
  assert(
    msg.includes("/plan 930") && msg.includes("/work 930 --restart"),
    "PR12 §E: renderHandoffUserMessage recovery includes /plan + /work --restart",
  );
  assert(
    !msg.includes("git add -p && git commit"),
    "PR12 §E: renderHandoffUserMessage does NOT show the wrong 'git push what's there' generic recovery",
  );

  const md = renderHandoffMarkdown(s);
  assert(
    md.includes("### Step-back analysis"),
    "PR12 §E: renderHandoffMarkdown emits 'Step-back analysis' section",
  );
  assert(
    md.includes("Proposed revision") && md.includes("Add explicit AC"),
    "PR12 §E: renderHandoffMarkdown surfaces the proposedRevision verbatim",
  );
  assert(
    md.includes("/plan 930") && md.includes("/work 930 --restart"),
    "PR12 §E: renderHandoffMarkdown recovery includes /plan + /work --restart",
  );
}

// 54. PR13 — runExplore embeds the fetched issue body inline in the
// explore dispatch prompt. Empirical v0.12.12 incident (/work 563 565)
// halted on false NEEDS_CLARIFICATION because the agent's verdict
// committed BEFORE the parallel gh fetch settled and the prompt never
// referenced the body. After PR13, the body is in the prompt — agent
// reads it directly.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-explore-inline-body-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let capturedPrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 940,
      // PR13 — fetcher returns a body with a unique marker we can scan
      // for in the captured prompt.
      issueBodyFetcherFn: async (n, _cwd) => ({
        stdout: `title:\tBug in foo\nstate:\tOPEN\n\nMARKER_BODY_47x9 — body for issue #${n}\n\n## Acceptance criteria\n- thing X works`,
      }),
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "explore") {
          capturedPrompt = spec.prompt;
          // Halt the cycle after the explore dispatch so the test runs
          // fast — we only need to assert the prompt content.
          return mkResult({
            role: "explore",
            text: "VERDICT: NEEDS_WORK\n\n## Workstreams\n\n### default — fix it\n- paths: src/foo.ts\n- out-of-scope: docs",
          });
        }
        // Halt before plan executes for free.
        throw new Error(`halt-at: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    assert(
      capturedPrompt.includes("MARKER_BODY_47x9"),
      "PR13 §A: explore prompt contains the inlined body marker (no body race)",
    );
    assert(
      /### Issue #940/.test(capturedPrompt),
      "PR13 §B: explore prompt has 'Issue #940' body section header",
    );
    assert(
      capturedPrompt.includes("## Acceptance criteria"),
      "PR13 §A: explore prompt contains the full body content (acceptance criteria included)",
    );
    assert(
      /driver has fetched and embedded each issue body below/i.test(capturedPrompt),
      "PR13 §B: explore prompt instruction tells agent to read the embedded bodies",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 55. PR13 — multi-issue cycle inlines all bodies with per-issue headers.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-explore-multi-bodies-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let capturedPrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 950,
      issues: [950, 951, 952],
      issueBodyFetcherFn: async (n, _cwd) => ({
        stdout: `title:\tIssue ${n}\nstate:\tOPEN\n\nBODY_FOR_${n} — specific marker so the test can find this body in the prompt.`,
      }),
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "explore") {
          capturedPrompt = spec.prompt;
          return mkResult({
            role: "explore",
            text: `## Verdict
- #950: NEEDS_WORK
- #951: NEEDS_WORK
- #952: NEEDS_WORK

## Workstreams

### default — fix all 3
- paths: src/foo.ts
- out-of-scope: docs
`,
          });
        }
        throw new Error(`halt-at: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    for (const n of [950, 951, 952]) {
      assert(
        capturedPrompt.includes(`BODY_FOR_${n}`),
        `PR13 §B: explore prompt contains body marker for #${n}`,
      );
      assert(
        new RegExp(`### Issue #${n}`).test(capturedPrompt),
        `PR13 §B: explore prompt has per-issue header for #${n}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 56. PR13 — body > 16 KiB is truncated inline + truncation marker
// references the cached artifact (so the agent can cat for the rest).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-explore-truncated-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const hugeBody = "A".repeat(17 * 1024); // 17 KiB > 16 KiB cap
    let capturedPrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 960,
      issueBodyFetcherFn: async (_n, _cwd) => ({ stdout: hugeBody }),
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "explore") {
          capturedPrompt = spec.prompt;
          return mkResult({
            role: "explore",
            text: "VERDICT: NEEDS_WORK\n## Workstreams\n### default — x\n- paths: x\n- out-of-scope: y",
          });
        }
        throw new Error(`halt-at: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    assert(
      /truncated/i.test(capturedPrompt),
      "PR13 §B: large body prompt includes truncation marker",
    );
    // The prompt should NOT contain the full 17 KiB body — confirm by
    // counting 'A' characters. Inline cap is 16 KiB so we expect ≤ 16384.
    const aCount = (capturedPrompt.match(/A/g) ?? []).length;
    assert(
      aCount <= 16 * 1024 + 50,
      `PR13 §B: inline body capped at ~16 KiB (got ${aCount} 'A' chars in prompt)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 57. PR13 — empty-body halt fires BEFORE the explore dispatch. Pre-PR13
// the halt fired after the dispatch (wasted tokens on a doomed cycle).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-explore-halt-before-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let exploreDispatched = false;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 970,
      issueBodyFetcherFn: async (_n, _cwd) => ({ stdout: "" }), // all empty
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "explore") exploreDispatched = true;
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        return mkResult({ role: spec.role, text: "stub" });
      },
    };
    await runWorkDriver(ctx);
    assert(
      exploreDispatched === false,
      "PR13 §A: explore dispatch is NOT called when bodies are empty (halt fires above dispatch)",
    );
    const after = await readState(dir, 970);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "explore-bodies-empty",
      "PR13 §A: cap-hit 'explore-bodies-empty' synthesised before any explore tokens consumed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 58. PR14 — runCommitPr's prompt enumerates worktrees + workstreams for
// N>1 cycles. Pre-PR14 the prompt was single-tree shaped; multi-workstream
// cycles silently lost sibling worktrees' changes (v0.12.13 /work 577).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-commit-multi-prompt-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let capturedPrompt = "";
    let s = initialState(577, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "commit-pr",
        lastCompletedStep: "adversarial",
        branchName: "feature/issue-577-multi",
        worktrees: {
          "prompt-reorder": `${dir}/.worktrees/issue-577-prompt-reorder`,
          observability: `${dir}/.worktrees/issue-577-observability`,
          "config-tweak": `${dir}/.worktrees/issue-577-config-tweak`,
        },
        workstreams: {
          "prompt-reorder": {
            id: "prompt-reorder",
            scope: "reorder write-sweep step",
            paths: ["selfhost/app-config/prompts/strategy-research.md"],
            outOfScope: [],
          },
          observability: {
            id: "observability",
            scope: "WARN log on missing SWP file",
            paths: ["src/cron/mod.rs"],
            outOfScope: [],
          },
          "config-tweak": {
            id: "config-tweak",
            scope: "raise max_iterations",
            paths: ["selfhost/app-config/lantern.toml"],
            outOfScope: [],
          },
        },
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 577,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:commit-pr") {
          capturedPrompt = spec.prompt;
          // Return without pr number so the cycle exits cleanly.
          return mkResult({ role: "ops", text: "stub" });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    for (const id of ["prompt-reorder", "observability", "config-tweak"]) {
      assert(
        capturedPrompt.includes(id),
        `PR14 §B: commit-pr prompt enumerates workstream id '${id}'`,
      );
      assert(
        capturedPrompt.includes(`.worktrees/issue-577-${id}`),
        `PR14 §B: commit-pr prompt lists worktree path for '${id}'`,
      );
    }
    assert(
      capturedPrompt.includes("strategy-research.md") &&
        capturedPrompt.includes("src/cron/mod.rs") &&
        capturedPrompt.includes("lantern.toml"),
      "PR14 §B: commit-pr prompt lists each workstream's in-scope paths",
    );
    assert(
      capturedPrompt.includes("feature/issue-577-multi"),
      "PR14 §B: commit-pr prompt names the integration branch",
    );
    assert(
      /staged set includes files from ALL.*workstreams/i.test(capturedPrompt),
      "PR14 §B: commit-pr prompt includes the verify-all-workstreams check",
    );
    assert(
      capturedPrompt.includes("git apply --index"),
      "PR14 §B: commit-pr prompt includes the git apply --index consolidation recipe",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 59. PR14 — runCommitPr's prompt for N=1 keeps the single-tree shape.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-commit-single-prompt-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let capturedPrompt = "";
    let s = initialState(580, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "commit-pr",
        lastCompletedStep: "adversarial",
        branchName: "feature/issue-580",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "fix it", paths: ["src/foo.ts"], outOfScope: [] },
        },
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 580,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:commit-pr") {
          capturedPrompt = spec.prompt;
          return mkResult({ role: "ops", text: "stub" });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    assert(
      capturedPrompt.includes("`git add` the changed files"),
      "PR14 §B: N=1 prompt keeps the single-tree 'git add the changed files' script (no churn)",
    );
    assert(
      !/Multi-workstream cycle/.test(capturedPrompt),
      "PR14 §B: N=1 prompt does NOT include the multi-workstream header",
    );
    assert(
      !capturedPrompt.includes("git apply --index"),
      "PR14 §B: N=1 prompt does NOT include the consolidation recipe",
    );
    assert(
      capturedPrompt.includes("feature/issue-580"),
      "PR14 §A: N=1 prompt names the integration branch",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 60. PR14 — consolidation gate fires when the committed diff is missing
// files from one or more workstreams' `paths`. Real git repo + simulated
// origin/main + only one workstream's file committed.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-commit-gate-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);
    await execp("git init -q", { cwd: dir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: dir,
      shell: "/bin/bash",
    });
    await fs.mkdir(path.join(dir, "selfhost", "app-config", "prompts"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "selfhost", "app-config", "prompts", "strategy-research.md"),
      "base\n",
    );
    await fs.mkdir(path.join(dir, "src", "cron"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "cron", "mod.rs"), "// base\n");
    await fs.writeFile(
      path.join(dir, "selfhost", "app-config", "lantern.toml"),
      "max_iterations = 25\n",
    );
    await execp("git add . && git commit -q -m initial", { cwd: dir, shell: "/bin/bash" });
    await execp("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: dir,
    });
    await execp("git checkout -qb feature/issue-577-multi", { cwd: dir });
    // Commit ONLY config-tweak's file (simulates the v0.12.13 partial bug).
    await fs.writeFile(
      path.join(dir, "selfhost", "app-config", "lantern.toml"),
      "max_iterations = 40\n",
    );
    await execp("git add . && git commit -q -m 'partial: only config'", {
      cwd: dir,
      shell: "/bin/bash",
    });

    let s = initialState(577, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "commit-pr",
        lastCompletedStep: "adversarial",
        branchName: "feature/issue-577-multi",
        worktrees: {
          "prompt-reorder": `${dir}/.worktrees/p`,
          observability: `${dir}/.worktrees/o`,
          "config-tweak": `${dir}/.worktrees/c`,
        },
        workstreams: {
          "prompt-reorder": {
            id: "prompt-reorder",
            scope: "x",
            paths: ["selfhost/app-config/prompts/strategy-research.md"],
            outOfScope: [],
          },
          observability: {
            id: "observability",
            scope: "y",
            paths: ["src/cron/mod.rs"],
            outOfScope: [],
          },
          "config-tweak": {
            id: "config-tweak",
            scope: "z",
            paths: ["selfhost/app-config/lantern.toml"],
            outOfScope: [],
          },
        },
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 577,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:commit-pr") {
          return mkResult({ role: "ops", text: "Done.\npr: 999\n" });
        }
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 577);
    const capHit = (after?.eventLog ?? []).find(
      (e) => e.kind === "cap-hit" && e.cap === "commit-pr-incomplete-consolidation",
    );
    assert(
      capHit !== undefined,
      "PR14 §D: consolidation gate synthesises cap-hit when files from a workstream are missing from the committed diff",
    );
    const missing = after?.pipelineState.incompleteConsolidation ?? [];
    const missingIds = missing.map((m) => m.id).sort();
    assert(
      JSON.stringify(missingIds) === JSON.stringify(["observability", "prompt-reorder"]),
      `PR14 §D: incompleteConsolidation lists prompt-reorder + observability (got: ${JSON.stringify(missingIds)})`,
    );
    assert(
      after?.pipelineState.status === "handoff",
      "PR14 §D: cycle routes to handoff (gate intercepts before merge)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 61. PR14 — explainCap + handoff renderers surface missing workstreams.
{
  let s = initialState(577, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "handoff",
      branchName: "feature/issue-577-multi",
      incompleteConsolidation: [
        {
          id: "prompt-reorder",
          paths: ["selfhost/app-config/prompts/strategy-research.md"],
        },
        { id: "observability", paths: ["src/cron/mod.rs"] },
      ],
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_500,
    cap: "commit-pr-incomplete-consolidation",
    reviewRound: 0,
    nextStep: "handoff",
  });
  s = appendEvent(s, {
    kind: "handoff-emitted",
    at: 1_000_600,
    commentUrl: "https://github.com/x/y/issues/577#c1",
    labelApplied: true,
    handoffBodyPath: "/tmp/issue-577/handoff-comment.md",
  });

  const explanation = explainCap("commit-pr-incomplete-consolidation", s);
  assert(
    /prompt-reorder/.test(explanation) && /observability/.test(explanation),
    "PR14 §E: explainCap names the missing workstreams",
  );

  const msg = renderHandoffUserMessage(s, "/repo/proj", "/repo/proj/tmp/issue-577");
  assert(
    msg.includes("Missing workstreams from the committed diff:") &&
      msg.includes("prompt-reorder") &&
      msg.includes("observability"),
    "PR14 §E: renderHandoffUserMessage lists missing workstreams",
  );
  assert(
    msg.includes(".worktrees/issue-577-prompt-reorder") &&
      msg.includes(".worktrees/issue-577-observability"),
    "PR14 §E: renderHandoffUserMessage shows per-worktree recovery commands",
  );

  const md = renderHandoffMarkdown(s);
  assert(
    md.includes("prompt-reorder") && md.includes("observability"),
    "PR14 §E: renderHandoffMarkdown lists missing workstreams",
  );
  assert(
    md.includes("git apply --index"),
    "PR14 §E: renderHandoffMarkdown includes the consolidation-recovery commands",
  );
}

// PR16 — groupIssues() deterministic multi-issue grouping.
//
// These tests exercise R1-R5 rules + guardrails against fabricated issue
// bodies. Pure function → no filesystem, no dispatch, no state; the
// tests just call groupIssues() with body maps and assert shape.
{
  // R5 — Default: two unrelated issues get separate groups.
  const r5 = groupIssues(
    [100, 200],
    {
      100: "title:\t[100] frontend bug\n\nSomething in the UI",
      200: "title:\t[200] backend fix\n\nSomething in the API",
    },
  );
  assert(
    Object.keys(r5.groups).length === 2,
    "R5 default: two unrelated issues → two groups",
  );
  assert(
    Object.values(r5.groups).every((g) => g.issues.length === 1),
    "R5 default: each group contains exactly one issue",
  );

  // R1 — Explicit link markers merge issues.
  const r1 = groupIssues(
    [301, 302],
    {
      301: "title:\tsomething\n\nDepends-on: #302 — needs the API change first",
      302: "title:\tapi change\n\nStandalone body",
    },
  );
  assert(
    Object.keys(r1.groups).length === 1,
    "R1 link: depends-on marker merges the two issues into one group",
  );
  assert(
    r1.notes.some((n) => n.startsWith("R1 link:")),
    "R1 link: notes surfaces the rule that fired",
  );
  const r1Group = Object.values(r1.groups)[0];
  assert(
    r1Group?.issues.length === 2 && r1Group.issues.includes(301) && r1Group.issues.includes(302),
    "R1 link: group carries both issues",
  );

  // R1 variant — "Blocked-by" also merges.
  const r1b = groupIssues(
    [400, 401],
    {
      400: "Blocked-by: #401\n\nWaiting on the other one",
      401: "Standalone",
    },
  );
  assert(
    Object.keys(r1b.groups).length === 1,
    "R1 link: blocked-by marker also merges",
  );

  // R2 — Path overlap ≥ 50% merges.
  //
  // Bodies each list 2 file paths; both share 1 → Jaccard = 1/3 ≈ 0.33
  // (does NOT merge). Bumping to 2/2 shared → Jaccard = 1.0 (merges).
  const r2Merge = groupIssues(
    [500, 501],
    {
      500: "Fix in src/foo/bar.ts and src/foo/baz.ts",
      501: "Fix in src/foo/bar.ts and src/foo/baz.ts (parallel bug)",
    },
  );
  assert(
    Object.keys(r2Merge.groups).length === 1,
    "R2 path-overlap: identical path sets merge (jaccard=1.0)",
  );
  assert(
    r2Merge.notes.some((n) => n.startsWith("R2 path-overlap:")),
    "R2 path-overlap: notes surfaces the rule",
  );

  const r2NoMerge = groupIssues(
    [600, 601],
    {
      600: "Fix in src/foo/bar.ts and src/foo/baz.ts and src/foo/qux.ts",
      601: "Fix in src/foo/bar.ts alone",
    },
  );
  assert(
    Object.keys(r2NoMerge.groups).length === 2,
    "R2 path-overlap: below-threshold overlap does NOT merge (jaccard=1/3)",
  );

  // R3 — SPLIT marker overrides R1/R2.
  //
  // Both issues have a Depends-on link (would merge under R1), but #700
  // has the word "independent" → R3 forces it into its own group.
  const r3 = groupIssues(
    [700, 701],
    {
      700: "Depends-on: #701\n\nMust ship as an independent PR",
      701: "Standalone",
    },
  );
  assert(
    Object.keys(r3.groups).length === 2,
    "R3 SPLIT: 'independent' marker overrides R1 link — two groups",
  );
  assert(
    r3.notes.some((n) => n.startsWith("R3 split:")),
    "R3 SPLIT: notes surfaces the rule",
  );

  // R4 — Subsystem tag prefix in title merges.
  const r4 = groupIssues(
    [800, 801, 802],
    {
      800: "[frontend] fix broken button\n\nBody",
      801: "[frontend] fix another button\n\nBody",
      802: "[docs] typo fix\n\nBody",
    },
  );
  assert(
    Object.keys(r4.groups).length === 2,
    "R4 subsystem: [frontend] merges, [docs] stays separate → 2 groups",
  );
  const r4Front = Object.values(r4.groups).find((g) => g.issues.length === 2);
  assert(
    r4Front?.issues.includes(800) && r4Front?.issues.includes(801),
    "R4 subsystem: frontend group carries both 800 and 801",
  );

  // Guardrail — MAX_ISSUES_PER_GROUP splits oversized components.
  //
  // Four issues all linked pairwise via depends-on → one component.
  // MAX_ISSUES_PER_GROUP = 3, so the group of 4 splits into singletons.
  const oversized = groupIssues(
    [900, 901, 902, 903],
    {
      900: "Depends-on: #901 Depends-on: #902 Depends-on: #903",
      901: "",
      902: "",
      903: "",
    },
  );
  assert(
    Object.keys(oversized.groups).length === 4,
    `guardrail: component > ${MAX_ISSUES_PER_GROUP} splits into singletons`,
  );
  assert(
    oversized.notes.some((n) => n.includes("guardrail split")),
    "guardrail: notes explains the split",
  );

  // Deterministic ordering — same input → same output, group ids in
  // stable order.
  const runA = groupIssues([10, 20, 30], { 10: "", 20: "", 30: "" });
  const runB = groupIssues([10, 20, 30], { 10: "", 20: "", 30: "" });
  assert(
    JSON.stringify(runA) === JSON.stringify(runB),
    "deterministic: same input → identical output",
  );

  // K=1 short-circuit — returns one "default" group.
  const k1 = groupIssues([42], { 42: "body" });
  assert(
    Object.keys(k1.groups).length === 1 && k1.groups.default?.issues[0] === 42,
    "K=1: short-circuits to a single default group",
  );

  // K=0 — empty active list.
  const k0 = groupIssues([], {});
  assert(
    Object.keys(k0.groups).length === 0,
    "K=0: empty active list yields empty groups",
  );

  // Missing body — grouping falls back to R5 (separate groups).
  const noBody = groupIssues([1, 2], { 1: "", 2: "" });
  assert(
    Object.keys(noBody.groups).length === 2,
    "missing bodies: fall back to R5 (separate groups)",
  );

  // Fanout mode — K ≤ 2 = parallel; K > 2 = sequential batches.
  const fanoutSmall = groupIssues([1, 2], { 1: "body A", 2: "body B" });
  assert(
    fanoutSmall.fanout.mode === "parallel" && fanoutSmall.fanout.concurrencyCap >= 1,
    "fanout: K=2 → parallel mode",
  );
  const fanoutBig = groupIssues(
    [1, 2, 3, 4, 5],
    { 1: "a", 2: "b", 3: "c", 4: "d", 5: "e" },
  );
  assert(
    fanoutBig.fanout.mode === "sequential",
    "fanout: K > cap (2) → sequential mode",
  );

  // Group id convention — group-a, group-b, ... in order.
  const twoGroups = groupIssues(
    [1000, 2000],
    { 1000: "unrelated", 2000: "also unrelated" },
  );
  assert(
    Object.keys(twoGroups.groups).sort().join(",") === "group-a,group-b",
    "group id convention: group-a, group-b",
  );
}

// PR17 — driver-side outcome-verification gate (verifyCmdFor +
// verifyStepOutcome). These tests re-enable the gate (disabled globally
// at the top of this file) and inject verifyExecFn so no real git/gh
// runs. Types: the injected fn sees the command string and returns
// canned outputs.
{
  const prevVerify = process.env.PI_ENSEMBLE_VERIFY;
  process.env.PI_ENSEMBLE_VERIFY = "1";
  const fsSync = await import("node:fs");
  try {
    // --- verifyCmdFor discovery ---
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-cmd-"));
      try {
        // Nothing → undefined.
        assert(
          (await verifyCmdFor(dir)) === undefined,
          "verifyCmdFor: empty dir → undefined (diff-evidence-only mode)",
        );
        // package.json with test script only, no lockfile → npm run test.
        fsSync.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({ scripts: { test: "vitest run" } }),
        );
        assert(
          (await verifyCmdFor(dir)) === "npm run test",
          "verifyCmdFor: package.json test script, no lockfile → npm run test",
        );
        // typecheck preferred over test; bun lockfile → bun run.
        fsSync.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }),
        );
        fsSync.writeFileSync(path.join(dir, "bun.lock"), "");
        assert(
          (await verifyCmdFor(dir)) === "bun run typecheck",
          "verifyCmdFor: typecheck preferred over test; bun.lock → bun run",
        );
        // Explicit .pi/verify-cmd wins over everything.
        fsSync.mkdirSync(path.join(dir, ".pi"), { recursive: true });
        fsSync.writeFileSync(
          path.join(dir, ".pi", "verify-cmd"),
          "# comment line\ncargo test --workspace\n",
        );
        assert(
          (await verifyCmdFor(dir)) === "cargo test --workspace",
          "verifyCmdFor: .pi/verify-cmd wins; comments skipped",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      // Cargo.toml → cargo check.
      const rustDir = mkdtempSync(path.join(tmpdir(), "verify-cmd-rs-"));
      try {
        fsSync.writeFileSync(path.join(rustDir, "Cargo.toml"), "[package]\nname='x'\n");
        assert(
          (await verifyCmdFor(rustDir)) === "cargo check --quiet",
          "verifyCmdFor: Cargo.toml → cargo check --quiet",
        );
      } finally {
        rmSync(rustDir, { recursive: true, force: true });
      }
    }

    // --- verifyStepOutcome: develop ---
    const mkCtx = (
      repoRoot: string,
      execFn: NonNullable<DriverContext["verifyExecFn"]>,
    ): DriverContext => ({
      pi: makeFakePi().pi,
      repoRoot,
      issue: 999,
      verifyExecFn: execFn,
    });

    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-develop-"));
      try {
        // Empty diff everywhere → failure.
        let s = initialState(999, 1000);
        s = {
          ...s,
          pipelineState: { ...s.pipelineState, worktrees: { default: dir }, baseSha: "abc123" },
        };
        const emptyExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git status --porcelain") return { stdout: "" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
          return { stdout: "" };
        };
        const emptyGate = await verifyStepOutcome(mkCtx(dir, emptyExec), s, "develop");
        assert(!emptyGate.ok, "develop gate: all-empty worktrees → NOT ok");
        assert(
          emptyGate.failures.some((f) => /empty diff/.test(f)),
          "develop gate: failure names the hollow claim (empty diff)",
        );

        // Changed worktree + verify cmd passes → ok. (.pi/verify-cmd so
        // discovery finds a command; the fake exec passes it.)
        fsSync.mkdirSync(path.join(dir, ".pi"), { recursive: true });
        fsSync.writeFileSync(path.join(dir, ".pi", "verify-cmd"), "run-verify\n");
        const passExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git status --porcelain") return { stdout: " M src/foo.ts\n" };
          if (cmd === "run-verify") return { stdout: "all good" };
          return { stdout: "" };
        };
        const passGate = await verifyStepOutcome(mkCtx(dir, passExec), s, "develop");
        assert(
          passGate.ok && passGate.failures.length === 0,
          "develop gate: changed worktree + passing verify cmd → ok",
        );

        // Changed worktree + verify cmd FAILS → failure with output tail.
        const failExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git status --porcelain") return { stdout: " M src/foo.ts\n" };
          if (cmd === "run-verify") {
            const err = new Error("Command failed: run-verify") as Error & {
              stdout?: string;
              stderr?: string;
            };
            err.stdout = "";
            err.stderr = "error[E0308]: mismatched types --> src/foo.rs:42";
            throw err;
          }
          return { stdout: "" };
        };
        const failGate = await verifyStepOutcome(mkCtx(dir, failExec), s, "develop");
        assert(!failGate.ok, "develop gate: failing verify cmd → NOT ok");
        assert(
          failGate.failures.some((f) => /E0308/.test(f)),
          "develop gate: failure carries the verify-cmd output tail as evidence",
        );

        // Escape hatch.
        process.env.PI_ENSEMBLE_VERIFY = "0";
        const skipped = await verifyStepOutcome(mkCtx(dir, emptyExec), s, "develop");
        assert(
          skipped.ok && skipped.notes.some((n) => /skipped/.test(n)),
          "develop gate: PI_ENSEMBLE_VERIFY=0 → skipped with note",
        );
        process.env.PI_ENSEMBLE_VERIFY = "1";
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // --- verifyStepOutcome: commit-pr ---
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-commitpr-"));
      try {
        let s = initialState(999, 1000);
        s = {
          ...s,
          pipelineState: {
            ...s.pipelineState,
            branchName: "feature/issue-999",
            prNumber: 556,
          },
        };
        // Zero commits ahead → failure even though PR resolves.
        const zeroCommits: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
          if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
          return { stdout: "" };
        };
        const zeroGate = await verifyStepOutcome(mkCtx(dir, zeroCommits), s, "commit-pr");
        assert(!zeroGate.ok, "commit-pr gate: zero commits ahead → NOT ok");
        assert(
          zeroGate.failures.some((f) => /zero commits/.test(f)),
          "commit-pr gate: failure names the missing commits",
        );

        // Commits ahead + PR resolves → ok.
        const happy: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "2\n" };
          if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
          return { stdout: "" };
        };
        const happyGate = await verifyStepOutcome(mkCtx(dir, happy), s, "commit-pr");
        assert(happyGate.ok, "commit-pr gate: commits ahead + PR resolves → ok");

        // prNumber missing + gh pr list resolves → ok + adoptedPrNumber.
        let sNoPr = initialState(999, 1000);
        sNoPr = {
          ...sNoPr,
          pipelineState: { ...sNoPr.pipelineState, branchName: "feature/issue-999" },
        };
        const adopt: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "2\n" };
          if (cmd.startsWith("gh pr list")) return { stdout: "789\n" };
          if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
          return { stdout: "" };
        };
        const adoptGate = await verifyStepOutcome(mkCtx(dir, adopt), sNoPr, "commit-pr");
        assert(
          adoptGate.ok && adoptGate.adoptedPrNumber === 789,
          "commit-pr gate: missing pr: marker resolved via gh pr list → adoptedPrNumber (bonus repair)",
        );

        // prNumber missing + NO PR for branch → failure.
        const noPr: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "2\n" };
          if (cmd.startsWith("gh pr list")) return { stdout: "\n" };
          return { stdout: "" };
        };
        const noPrGate = await verifyStepOutcome(mkCtx(dir, noPr), sNoPr, "commit-pr");
        assert(!noPrGate.ok, "commit-pr gate: no marker + no PR on branch → NOT ok");
        assert(
          noPrGate.failures.some((f) => /not backed by an actual PR/.test(f)),
          "commit-pr gate: failure names the hollow PR claim",
        );

        // prNumber set but gh pr view errors → failure.
        const ghosted: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "2\n" };
          if (cmd.startsWith("gh pr view")) {
            const err = new Error("gh failed") as Error & { stderr?: string };
            err.stderr = "GraphQL: Could not resolve to a PullRequest with the number of 556.";
            throw err;
          }
          return { stdout: "" };
        };
        const ghostGate = await verifyStepOutcome(mkCtx(dir, ghosted), s, "commit-pr");
        assert(!ghostGate.ok, "commit-pr gate: PR number doesn't resolve via gh → NOT ok");
        assert(
          ghostGate.failures.some((f) => /does not resolve/.test(f)),
          "commit-pr gate: failure carries the gh stderr evidence",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // --- explainCap renders the evidence ---
    {
      let s = initialState(999, 1000);
      s = {
        ...s,
        pipelineState: {
          ...s.pipelineState,
          verifyEvidence: {
            step: "develop",
            failures: ["developer claimed done but every worktree has an empty diff"],
            at: 2000,
          },
        },
      };
      const text = explainCap("verify-failed:develop", s);
      assert(
        /outcome-verification gate/.test(text) && /empty diff/.test(text),
        "explainCap verify-failed:develop: names the gate + surfaces the evidence lines",
      );
      assert(
        /PI_ENSEMBLE_VERIFY=0/.test(text),
        "explainCap verify-failed: names the escape hatch",
      );
    }
  } finally {
    if (prevVerify === undefined) delete process.env.PI_ENSEMBLE_VERIFY;
    else process.env.PI_ENSEMBLE_VERIFY = prevVerify;
    // Restore the top-of-file default for any code that runs after.
    process.env.PI_ENSEMBLE_VERIFY = "0";
  }
}

// PR18 — gate hardening: R1 note-suppression fix, R6 verify-cmd
// precedence fix, R4 end-to-end cap-wiring integration tests.
{
  const prevVerify = process.env.PI_ENSEMBLE_VERIFY;
  const prevSpec = process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE;
  process.env.PI_ENSEMBLE_VERIFY = "1";
  process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE = "1";
  const fsSync = await import("node:fs");
  try {
    // --- R1: one worktree's git-status error must NOT suppress the
    // hollow-diff failure for the others (pre-PR18 it did — the exact
    // silent-pass class PR17 exists to kill).
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-r1-"));
      try {
        let s = initialState(998, 1000);
        s = {
          ...s,
          pipelineState: {
            ...s.pipelineState,
            worktrees: { "task-a": path.join(dir, "a"), "task-b": path.join(dir, "b") },
            baseSha: "abc123",
          },
        };
        const oneErrOneEmpty: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, opts) => {
          if (cmd === "git status --porcelain") {
            if (opts?.cwd?.endsWith("/a")) throw new Error("not a git repository");
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count")) {
            if (opts?.cwd?.endsWith("/a")) throw new Error("bad revision");
            return { stdout: "0\n" };
          }
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 998,
          verifyExecFn: oneErrOneEmpty,
        };
        const gate = await verifyStepOutcome(ctx, s, "develop");
        assert(
          !gate.ok && gate.failures.some((f) => /empty diff/.test(f)),
          "R1: one worktree erroring does NOT suppress the hollow-diff failure for the assessed one",
        );
        assert(
          gate.notes.some((n) => /git status failed/.test(n)),
          "R1: the erroring worktree is still surfaced as a note",
        );

        // All worktrees unassessable → degrade to pass-with-note, no failure.
        const allErr: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git status --porcelain") throw new Error("not a git repository");
          if (cmd.startsWith("git rev-list --count")) throw new Error("bad revision");
          return { stdout: "" };
        };
        const degraded = await verifyStepOutcome({ ...ctx, verifyExecFn: allErr }, s, "develop");
        assert(
          degraded.ok && degraded.notes.some((n) => /no worktree could be assessed/.test(n)),
          "R1: ALL worktrees unassessable → degrade to pass-with-note (no evidence either way)",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // --- R6: Cargo.toml beats a bare package.json `test` script; an
    // explicit `typecheck` script still wins over Cargo.toml.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-r6-"));
      try {
        fsSync.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname='x'\n");
        fsSync.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({ scripts: { test: "node tools/docs-lint.js" } }),
        );
        assert(
          (await verifyCmdFor(dir)) === "cargo check --quiet",
          "R6: Rust repo with tooling package.json (test only) → cargo check wins",
        );
        fsSync.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({ scripts: { test: "x", typecheck: "tsc --noEmit" } }),
        );
        assert(
          (await verifyCmdFor(dir)) === "npm run typecheck",
          "R6: explicit typecheck script wins even next to Cargo.toml (intentional signal)",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // --- R4: end-to-end cap wiring. Drive the FULL runWorkDriver with
    // scripted dispatchFn + verifyExecFn and assert the gate's cap-hit,
    // evidence persistence, and handoff routing through the real state
    // machine (pre-PR18 the wiring was asserted only via explainCap text).

    // R4a — hollow develop claim → cap-hit verify-failed:develop →
    // handoff terminal.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-r4a-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const hollowExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git status --porcelain") return { stdout: "" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 991,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: hollowExec,
          dispatchFn: async (_pi, spec, opts) => {
            const label = opts?.label ?? spec.role;
            if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
            if (label === "plan") return mkResult({ text: "" });
            if (label === "ops")
              return mkResult({ role: "ops", text: "branch: feature/issue-991" });
            if (label === "developer")
              return mkResult({ role: "developer", text: "done — implemented the fix" });
            if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
            throw new Error(`unexpected dispatch: ${label}`);
          },
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 991);
        const capEvent = after?.eventLog.find(
          (e) => e.kind === "cap-hit" && e.cap === "verify-failed:develop",
        );
        assert(
          capEvent !== undefined,
          "R4a: hollow develop claim fires cap-hit verify-failed:develop through the real wiring",
        );
        assert(
          after?.pipelineState.verifyEvidence?.step === "develop" &&
            (after?.pipelineState.verifyEvidence?.failures.length ?? 0) > 0,
          "R4a: verifyEvidence persisted to the state file with the failure detail",
        );
        assert(
          after?.pipelineState.status === "handoff",
          "R4a: cycle terminal status is handoff (gate failure routed through nextStep)",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // R4b — good develop evidence passes the gate; cycle reaches
    // adversarial and (with an approving loop) commit-pr, whose gate then
    // catches a zero-commit claim.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-r4b-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git status --porcelain") return { stdout: " M src/lib.rs\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 992,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: async (_pi, spec, opts) => {
            const label = opts?.label ?? spec.role;
            if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
            if (label === "plan") return mkResult({ text: "" });
            if (label === "ops")
              return mkResult({ role: "ops", text: "branch: feature/issue-992" });
            if (label === "developer")
              return mkResult({ role: "developer", text: "done — implemented" });
            if (label === "ops:commit-pr")
              return mkResult({ role: "ops", text: "Committed and pushed.\npr: 556" });
            if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
            throw new Error(`unexpected dispatch: ${label}`);
          },
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 992);
        assert(
          !after?.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "verify-failed:develop"),
          "R4b: real develop evidence passes the gate (no verify-failed:develop)",
        );
        assert(
          after?.eventLog.some((e) => e.kind === "adversarial-approved"),
          "R4b: cycle proceeded through adversarial after the develop gate",
        );
        const commitCap = after?.eventLog.find(
          (e) => e.kind === "cap-hit" && e.cap === "verify-failed:commit-pr",
        );
        assert(
          commitCap !== undefined,
          "R4b: zero-commits-ahead claim fires cap-hit verify-failed:commit-pr through the real wiring",
        );
        assert(
          after?.pipelineState.verifyEvidence?.step === "commit-pr" &&
            after?.pipelineState.verifyEvidence?.failures.some((f) => /zero commits/.test(f)),
          "R4b: commit-pr verifyEvidence persisted with the zero-commits failure",
        );
        assert(
          after?.pipelineState.status === "handoff",
          "R4b: commit-pr gate failure routes the cycle to handoff",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // R4c — pr:-marker omission repaired via gh pr list adoption; no
    // cap fires and pipelineState.prNumber is written back.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-r4c-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git status --porcelain") return { stdout: " M src/lib.rs\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "2\n" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("gh pr list")) return { stdout: "789\n" };
          if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 993,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: async (_pi, spec, opts) => {
            const label = opts?.label ?? spec.role;
            if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
            if (label === "plan") return mkResult({ text: "" });
            if (label === "ops")
              return mkResult({ role: "ops", text: "branch: feature/issue-993" });
            if (label === "developer")
              return mkResult({ role: "developer", text: "done — implemented" });
            if (label === "ops:commit-pr")
              return mkResult({ role: "ops", text: "Committed and pushed. (forgot the marker)" });
            if (label === "ops:ci") throw new Error("halt at ci: integration assertion boundary");
            if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
            throw new Error(`unexpected dispatch: ${label}`);
          },
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 993);
        assert(
          !after?.eventLog.some(
            (e) => e.kind === "cap-hit" && e.cap === "verify-failed:commit-pr",
          ),
          "R4c: missing pr: marker repaired via gh pr list — no verify-failed:commit-pr cap",
        );
        assert(
          after?.pipelineState.prNumber === 789,
          "R4c: adopted PR number written back to pipelineState.prNumber (bonus repair wired)",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    if (prevVerify === undefined) delete process.env.PI_ENSEMBLE_VERIFY;
    else process.env.PI_ENSEMBLE_VERIFY = prevVerify;
    process.env.PI_ENSEMBLE_VERIFY = "0";
    if (prevSpec === undefined) delete process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE;
    else process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE = prevSpec;
  }
}

// PR19 — mechanized commit-pr: the driver executes consolidation +
// commit + push + PR creation directly (LLM ops dispatch becomes the
// fallback). Full-driver integration tests with scripted verifyExecFn;
// dispatchFn THROWS on ops:commit-pr in the happy-path test to prove
// the LLM dispatch never fires.
{
  const prevVerify = process.env.PI_ENSEMBLE_VERIFY;
  const prevSpec = process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE;
  const prevMech = process.env.PI_ENSEMBLE_MECHANIZE_OPS;
  process.env.PI_ENSEMBLE_VERIFY = "1";
  process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE = "1";
  process.env.PI_ENSEMBLE_MECHANIZE_OPS = "1";

  // Shared fixture bits for the 3-workstream shape.
  const PLAN_REPLY = `## Workstreams

### task-a — fix module a
- paths: src/a.rs
- out-of-scope: docs

### task-b — fix module b
- paths: src/b.rs
- out-of-scope: docs

### task-c — fix module c
- paths: src/c.rs
- out-of-scope: docs
`;
  const branchReplyFor = (dir: string, issue: number) =>
    [
      `branch: feature/issue-${issue}`,
      "",
      "## Worktrees",
      "",
      `- task-a: ${dir}/wta`,
      `- task-b: ${dir}/wtb`,
      `- task-c: ${dir}/wtc`,
    ].join("\n");
  const mkDispatchFn =
    (dir: string, issue: number, opts?: { allowOpsCommitPr?: boolean }) =>
    async (
      _pi: unknown,
      spec: { role: string; prompt: string },
      dOpts?: { label?: string },
    ): Promise<DispatchResult> => {
      const label = dOpts?.label ?? spec.role;
      if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
      if (label === "plan") return mkResult({ text: PLAN_REPLY });
      if (label === "ops") return mkResult({ role: "ops", text: branchReplyFor(dir, issue) });
      if (label.startsWith("developer"))
        return mkResult({ role: "developer", text: "done — implemented" });
      if (label === "ops:commit-pr") {
        if (opts?.allowOpsCommitPr)
          return mkResult({ role: "ops", text: "Committed and pushed.\npr: 556" });
        throw new Error("ops:commit-pr dispatched — mechanized path should have handled this");
      }
      if (label === "ops:ci") throw new Error("halt at ci: integration assertion boundary");
      if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
      throw new Error(`unexpected dispatch: ${label}`);
    };

  try {
    // M1 — happy path: 3 worktrees consolidated by the driver, PR opened,
    // number parsed; the LLM ops:commit-pr dispatch never fires.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "mech-happy-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const calls: string[] = [];
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
          calls.push(cmd);
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git rev-parse --abbrev-ref HEAD")
            return { stdout: "feature/issue-994\n" };
          if (cmd === "git status --porcelain") {
            const cwd = o?.cwd ?? "";
            if (cwd.endsWith("/wta")) return { stdout: " M src/a.rs\n" };
            if (cwd.endsWith("/wtb")) return { stdout: " M src/b.rs\n" };
            if (cwd.endsWith("/wtc")) return { stdout: "?? src/c.rs\n" };
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count base123")) return { stdout: "0\n" };
          if (cmd.startsWith("git rev-list --count origin/")) return { stdout: "1\n" };
          if (cmd.startsWith("git add -- ")) return { stdout: "" };
          if (cmd === "git diff --cached")
            return { stdout: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n" };
          if (cmd.startsWith("git apply --index")) return { stdout: "" };
          if (cmd.startsWith("git commit")) return { stdout: "" };
          if (cmd.startsWith("git push")) return { stdout: "" };
          if (cmd.startsWith("gh pr create"))
            return { stdout: "https://github.com/owner/repo/pull/612\n" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git diff --name-only origin/"))
            return { stdout: "src/a.rs\nsrc/b.rs\nsrc/c.rs\n" };
          if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 994,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: mkDispatchFn(dir, 994),
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 994);
        const mechEvent = after?.eventLog.find(
          (e) =>
            e.kind === "dispatch-completed" && e.role === "driver" && e.label === "driver:commit-pr",
        );
        assert(
          mechEvent !== undefined,
          "M1: mechanized commit-pr emitted dispatch-completed (role=driver) — LLM ops never dispatched",
        );
        assert(
          after?.pipelineState.prNumber === 612,
          "M1: PR number parsed from gh pr create URL and written to pipelineState",
        );
        assert(
          calls.filter((c) => c.startsWith("git apply --index")).length === 3,
          "M1: all 3 sibling worktrees' staged diffs applied at repoRoot (3× git apply --index)",
        );
        assert(
          calls.some((c) => c.startsWith("git push")) &&
            calls.some((c) => c.startsWith("gh pr create")),
          "M1: push + gh pr create executed by the driver",
        );
        assert(
          !after?.eventLog.some(
            (e) => e.kind === "cap-hit" && e.cap === "commit-pr-incomplete-consolidation",
          ),
          "M1: consolidation oracle (verifyConsolidation) passes on the mechanized result",
        );
        assert(
          !after?.eventLog.some((e) => e.kind === "plumb-report"),
          "M1: no fallback plumb-report — mechanized path completed cleanly",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // M2 — mechanical failure (git apply conflict) → plumb-report +
    // graceful fallback to the LLM ops dispatch.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "mech-fallback-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git rev-parse --abbrev-ref HEAD")
            return { stdout: "feature/issue-995\n" };
          if (cmd === "git status --porcelain") {
            const cwd = o?.cwd ?? "";
            if (cwd.endsWith("/wta") || cwd.endsWith("/wtb") || cwd.endsWith("/wtc"))
              return { stdout: " M src/x.rs\n" };
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count base123")) return { stdout: "0\n" };
          if (cmd.startsWith("git rev-list --count origin/")) return { stdout: "1\n" };
          if (cmd.startsWith("git add -- ")) return { stdout: "" };
          if (cmd === "git diff --cached") return { stdout: "diff --git a/x b/x\n+new\n" };
          if (cmd.startsWith("git apply --index")) {
            const err = new Error("patch does not apply") as Error & { stderr?: string };
            err.stderr = "error: patch failed: src/x.rs:1";
            throw err;
          }
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git diff --name-only origin/"))
            return { stdout: "src/a.rs\nsrc/b.rs\nsrc/c.rs\n" };
          if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 995,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: mkDispatchFn(dir, 995, { allowOpsCommitPr: true }),
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 995);
        assert(
          after?.eventLog.some(
            (e) => e.kind === "plumb-report" && /fell back to the ops dispatch/.test(e.body),
          ),
          "M2: apply conflict → plumb-report explains the fallback",
        );
        assert(
          after?.eventLog.some(
            (e) =>
              e.kind === "dispatch-completed" && e.role === "ops" && e.label === "ops:commit-pr",
          ),
          "M2: LLM ops:commit-pr dispatched as fallback after mechanized failure",
        );
        assert(
          after?.pipelineState.prNumber === 556,
          "M2: fallback path's pr: marker still parsed into pipelineState",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // M3 — empty-worktree guard: one clean worktree → fallback with the
    // no-uncommitted-work reason (the LLM/ops + downstream gates decide
    // what to do; the mechanized path never ships a partial slice).
    {
      const dir = mkdtempSync(path.join(tmpdir(), "mech-empty-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git rev-parse --abbrev-ref HEAD")
            return { stdout: "feature/issue-996\n" };
          if (cmd === "git status --porcelain") {
            const cwd = o?.cwd ?? "";
            if (cwd.endsWith("/wtb")) return { stdout: "" }; // task-b clean
            if (cwd.endsWith("/wta") || cwd.endsWith("/wtc"))
              return { stdout: " M src/x.rs\n" };
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count base123")) return { stdout: "0\n" };
          if (cmd.startsWith("git rev-list --count origin/")) return { stdout: "1\n" };
          if (cmd.startsWith("git add -- ")) return { stdout: "" };
          if (cmd === "git diff --cached") return { stdout: "diff --git a/x b/x\n+new\n" };
          if (cmd.startsWith("git apply --index")) return { stdout: "" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git diff --name-only origin/"))
            return { stdout: "src/a.rs\nsrc/b.rs\nsrc/c.rs\n" };
          if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 996,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: mkDispatchFn(dir, 996, { allowOpsCommitPr: true }),
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 996);
        assert(
          after?.eventLog.some(
            (e) => e.kind === "plumb-report" && /no uncommitted work/.test(e.body),
          ),
          "M3: clean worktree → mechanized path bails with the no-uncommitted-work reason",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // M4 — escape hatch: PI_ENSEMBLE_MECHANIZE_OPS=0 → straight to the
    // LLM ops dispatch, no mechanized attempt, no plumb-report.
    {
      process.env.PI_ENSEMBLE_MECHANIZE_OPS = "0";
      const dir = mkdtempSync(path.join(tmpdir(), "mech-off-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const mechCalls: string[] = [];
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
          if (cmd === "git rev-parse --abbrev-ref HEAD") mechCalls.push(cmd);
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git status --porcelain") {
            const cwd = o?.cwd ?? "";
            if (cwd.endsWith("/wta") || cwd.endsWith("/wtb") || cwd.endsWith("/wtc"))
              return { stdout: " M src/x.rs\n" };
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count base123")) return { stdout: "0\n" };
          if (cmd.startsWith("git rev-list --count origin/")) return { stdout: "1\n" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git diff --name-only origin/"))
            return { stdout: "src/a.rs\nsrc/b.rs\nsrc/c.rs\n" };
          if (cmd.startsWith("gh pr view")) return { stdout: '{"state":"OPEN"}' };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 997,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: mkDispatchFn(dir, 997, { allowOpsCommitPr: true }),
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 997);
        assert(
          mechCalls.length === 0,
          "M4: PI_ENSEMBLE_MECHANIZE_OPS=0 → mechanized path never probes the repo",
        );
        assert(
          after?.eventLog.some(
            (e) =>
              e.kind === "dispatch-completed" && e.role === "ops" && e.label === "ops:commit-pr",
          ) && !after?.eventLog.some((e) => e.kind === "plumb-report"),
          "M4: LLM ops path used directly, no fallback plumb-report",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
        process.env.PI_ENSEMBLE_MECHANIZE_OPS = "1";
      }
    }
  } finally {
    if (prevVerify === undefined) delete process.env.PI_ENSEMBLE_VERIFY;
    else process.env.PI_ENSEMBLE_VERIFY = prevVerify;
    process.env.PI_ENSEMBLE_VERIFY = "0";
    if (prevSpec === undefined) delete process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE;
    else process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE = prevSpec;
    if (prevMech === undefined) delete process.env.PI_ENSEMBLE_MECHANIZE_OPS;
    else process.env.PI_ENSEMBLE_MECHANIZE_OPS = prevMech;
  }
}

// ============================================================================
// #297 — transient-failure retry on HALT steps
// ============================================================================

// T1 (#297) — a single provider error-stop on the branch step (HALT class)
// retries and the cycle proceeds instead of aborting.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-transient-ok-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(950, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "branch",
        lastCompletedStep: "plan",
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
      },
    };
    await writeState(dir, s);

    let branchAttempts = 0;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 950,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (spec.role === "ops" && opts?.label !== "ops:handoff") {
          branchAttempts += 1;
          if (branchAttempts === 1) {
            // Transient: provider error-stop (the "Request timed out." shape).
            return mkResult({
              role: "ops",
              ok: false,
              exitCode: 0,
              text: "",
              errorStop: { reason: "error", message: "Request timed out." },
            });
          }
          return mkResult({
            role: "ops",
            text: "branch: feature/issue-950-transient-test\nworktrees:\n  default: " + dir,
          });
        }
        // Halt cleanly once develop dispatches (out of scope for this test).
        throw new Error("smoke: halting at develop");
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 950);
    assert(branchAttempts === 2, `#297 T1: branch re-dispatched after transient (got ${branchAttempts})`);
    // (The develop-halt throw above produces its own step-failed:develop
    // cap-hit — only the BRANCH step must be cap-free here.)
    assert(
      !(after?.eventLog ?? []).some((e) => e.kind === "cap-hit" && e.cap === "step-failed:branch"),
      "#297 T1: no step-failed:branch cap-hit — transient did not abort the branch step",
    );
    assert(
      (after?.eventLog ?? []).some(
        (e) => e.kind === "step-started" && e.step === "develop",
      ),
      "#297 T1: cycle advanced past branch to develop",
    );
    assert(
      (after?.pipelineState.transientRetryAttempts?.branch ?? 0) === 0,
      "#297 T1: transient budget reset after the step succeeded",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// T2 (#297) — budget exhaustion: persistent transient failures (1 + 2
// retries) fall through to the HALT cap-hit → handoff.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-transient-exhaust-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(951, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "branch",
        lastCompletedStep: "plan",
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
      },
    };
    await writeState(dir, s);

    let branchAttempts = 0;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 951,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role === "ops") {
          branchAttempts += 1;
          return mkResult({
            role: "ops",
            ok: false,
            exitCode: 0,
            text: "",
            errorStop: { reason: "error", message: "terminated" },
          });
        }
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 951);
    assert(
      branchAttempts === 3,
      `#297 T2: 1 attempt + 2 transient retries before halt (got ${branchAttempts})`,
    );
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "step-failed:branch",
      "#297 T2: exhausted budget routes through cap-hit step-failed:branch",
    );
    assert(after?.pipelineState.status === "aborted", "#297 T2: cycle ends aborted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// T3 (#297) — escape hatch: PI_ENSEMBLE_TRANSIENT_RETRY=0 restores
// halt-on-first-failure.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-transient-off-"));
  const prev = process.env.PI_ENSEMBLE_TRANSIENT_RETRY;
  process.env.PI_ENSEMBLE_TRANSIENT_RETRY = "0";
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(952, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "branch",
        lastCompletedStep: "plan",
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
      },
    };
    await writeState(dir, s);

    let branchAttempts = 0;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 952,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role === "ops") {
          branchAttempts += 1;
          return mkResult({
            role: "ops",
            ok: false,
            exitCode: 0,
            text: "",
            errorStop: { reason: "error", message: "terminated" },
          });
        }
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 952);
    assert(branchAttempts === 1, `#297 T3: opt-out → no retry (got ${branchAttempts})`);
    assert(after?.pipelineState.status === "aborted", "#297 T3: opt-out halts immediately");
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_TRANSIENT_RETRY;
    else process.env.PI_ENSEMBLE_TRANSIENT_RETRY = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

// T4 (#296) — a killCause-carrying developer result produces an accurate
// self-kill errorTail (never provider blame) and, after transient retries
// exhaust, the developer-timeout cap shape (previously dead code).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-killcause-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(953, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-953-test",
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 953,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role === "developer") {
          return mkResult({
            role: "developer",
            ok: false,
            exitCode: 143,
            text: "partial work text that must NOT become the errorTail",
            killCause: "timeout",
            killBudgetMs: 5_400_000,
          });
        }
        if (spec.role === "explore") return mkResult({ role: "explore", text: "spec ctx" });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 953);
    const fail = (after?.eventLog ?? []).find(
      (e) => e.kind === "dispatch-failed" && e.step === "develop",
    );
    assert(
      fail?.kind === "dispatch-failed" &&
        /\[pi-ensemble\] killed after 5400000ms timeout/.test(fail.errorTail ?? ""),
      "#296 T4: kill-cause produces the self-kill errorTail naming the budget",
    );
    assert(
      fail?.kind === "dispatch-failed" &&
        (fail.errorTail ?? "").includes("PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER"),
      "#296 T4: errorTail names the per-role override knob",
    );
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "developer-timeout",
      "#296 T4: developer cap kill classifies as cap='developer-timeout'",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// #298 — adversarial loop: REJECTED is a verdict, infra failure is retried
// ============================================================================

// T5 (#298) — REJECTED verdict records dispatch-completed (not
// dispatch-failed-with-menu-errorTail) + adversarial-rejected.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-rejected-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(954, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-954",
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 954,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async () =>
        mkResult({
          role: "adversarial-loop",
          ok: false,
          exitCode: 1,
          loopOutcome: "rejected",
          text: "❌ Adversarial REJECTED after 3 rounds. Last verdict: ISSUES_FOUND\n\nreal findings here",
        }),
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 954);
    const events = after?.eventLog ?? [];
    assert(
      !events.some((e) => e.kind === "dispatch-failed" && e.step === "adversarial"),
      "#298 T5: REJECTED verdict records NO dispatch-failed event",
    );
    assert(
      events.some((e) => e.kind === "dispatch-completed" && e.step === "adversarial"),
      "#298 T5: REJECTED verdict records dispatch-completed (the review DID complete)",
    );
    assert(
      events.some((e) => e.kind === "adversarial-rejected"),
      "#298 T5: adversarial-rejected verdict event present",
    );
    assert(after?.pipelineState.status === "handoff", "#298 T5: cycle routes to handoff");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// T6 (#298) — loop infra-failure leaves dispatch-failed as the tail so the
// RETRY_ONCE router re-runs the step (pre-#298 the synthesized cap-hit made
// that branch unreachable); recovery on the second attempt approves.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-adv-infra-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(955, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-955",
      },
    };
    await writeState(dir, s);

    let loopCalls = 0;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 955,
      issueBodyFetcherFn: mockIssueBodyOk,
      adversarialLoopFn: async () => {
        loopCalls += 1;
        if (loopCalls === 1) {
          return mkResult({
            role: "adversarial-loop",
            ok: false,
            exitCode: 1,
            loopOutcome: "infra-failure",
            text: "Adversarial loop infrastructure failure: round 1 review dispatch killed by pi-ensemble (timeout) (after one retry). No verdict was produced — this is NOT a review rejection.",
          });
        }
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          loopOutcome: "approved",
          text: "Adversarial APPROVED after round 1.\n",
        });
      },
      dispatchFn: async (_pi, spec, opts) => {
        // Halt cleanly once commit-pr dispatches (out of scope here).
        throw new Error(`smoke: halting at ${spec.role}/${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(dir, 955);
    const events = after?.eventLog ?? [];
    assert(loopCalls === 2, `#298 T6: RETRY_ONCE re-ran the adversarial loop (got ${loopCalls})`);
    assert(
      !events.some((e) => e.kind === "adversarial-rejected"),
      "#298 T6: infra failure synthesises NO adversarial-rejected verdict",
    );
    assert(
      events.some((e) => e.kind === "adversarial-approved"),
      "#298 T6: second attempt's APPROVED verdict recorded",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
