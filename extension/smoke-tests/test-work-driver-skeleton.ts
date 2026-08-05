#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 3-8: runWorkDriver skeleton happy path, inconsistency halt, DriverNotImplementedError, parseAbort, work-widget renderStatus, parseBranchName, workspace tmp helpers.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext } from "../src/work-driver-context.ts";
import { parseAbort, parseBranchName } from "../src/work-driver-diff.ts";
import {
  scratchDir,
  setupWorkspaceTmp,
  teardownWorkspaceTmp,
} from "../src/work-driver-workspace.ts";
import { DriverNotImplementedError, runWorkDriver } from "../src/work-driver.ts";
import {
  detectInconsistencies,
  initialState,
  readState,
  writeState,
  type WorkState,
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

// #297 — transient retries are exercised by dedicated tests below; zero the
// inter-attempt backoff so persistent-failure tests don't sleep 5-10s per
// retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// Offline-suite safety net: a few flow tests deliberately reach the
// adversarial / lens steps without injecting a loopFn. Cap any such
// accidental live spawn at 2s so the suite stays deterministic and fast.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// PR17 — the outcome-verification gate is disabled globally here; dedicated
// gate tests re-enable it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";

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
          throw new Error(
            "smoke: halting before adversarial step (would call live runAdversarialLoop)",
          );
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
  assert(
    parseAbort("ABORT: --ff-only refused")?.startsWith("ABORT:") === true,
    "parseAbort: plain marker",
  );
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
  assert(
    parseBranchName("Some prose about a branch") === undefined,
    "parseBranchName: no marker line",
  );
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
    await fs.writeFile(
      path.join(dir, ".git", "info", "exclude"),
      "# user-managed\n/tmp/\nfoo.log\n",
    );
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

// #292 — branchName resolved from git; mismatch emits plumb-report; git failure falls back to reply.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-branch-verify-"));
  try {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execp = promisify(exec);
    await execp("git init -b main", { cwd: dir });
    await execp("git config user.email 't@t'", { cwd: dir });
    await execp("git config user.name 'T'", { cwd: dir });
    await execp("git commit --allow-empty -m 'init'", { cwd: dir });
    await execp("git checkout -b feature/issue-800-real-work", { cwd: dir });
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const { runBranch } = await import("../src/work-driver-branch-develop.ts");
    const { pi } = makeFakePi();
    const baseState = () => {
      const s = initialState(800, 1_000);
      s.pipelineState.workstreams = { default: { id: "default", scope: "t", paths: [], outOfScope: [] } };
      s.pipelineState.currentStep = "branch";
      return s;
    };
    const plumbs = (log: WorkState["eventLog"]) => log.filter((e) => e.kind === "plumb-report");

    // A — mismatch: ops reports a wrong branch, git resolves the real one.
    {
      const ctx: DriverContext = {
        pi,
        repoRoot: dir,
        issue: 800,
        dispatchFn: async () =>
          mkResult({ role: "ops", text: "branch: feature/issue-800-wrong-branch\n" }),
        verifyExecFn: async (cmd: string, opts: object) => execp(cmd, opts),
      };
      const result = await runBranch(ctx, baseState(), 1_000);
      assert(
        result.pipelineState.branchName === "feature/issue-800-real-work",
        "uses git-resolved branch on mismatch",
      );
      assert(plumbs(result.eventLog).length > 0, "emits plumb-report for mismatch");
    }

    // B — git failure: falls back to parsed ops reply, no crash.
    {
      const ctx: DriverContext = {
        pi,
        repoRoot: dir,
        issue: 800,
        dispatchFn: async () =>
          mkResult({ role: "ops", text: "branch: feature/issue-800-from-reply\n" }),
        verifyExecFn: async () => { throw new Error("not a git repo"); },
      };
      const result = await runBranch(ctx, baseState(), 1_000);
      assert(
        result.pipelineState.branchName === "feature/issue-800-from-reply",
        "falls back to parsed reply when git fails",
      );
      assert(plumbs(result.eventLog).length === 0, "no plumb-report when git fails");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
