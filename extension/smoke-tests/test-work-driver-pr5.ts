#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 17-22: PR5 STEP_FAILURE_POLICY, explainCap cap-hit shapes, HALT-class dispatch-failed, captureWorktreeSnapshot, handoff renderers.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext, nextStep } from "../src/work-driver-context.ts";
import { STEP_FAILURE_POLICY } from "../src/work-driver-failure-policy.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { captureWorktreeSnapshot } from "../src/work-driver-handoff.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { appendEvent, initialState, readState, writeState } from "../src/workflow-state.ts";

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
      host: makeFakePi().pi,
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
            killCause: "timeout",
            killBudgetMs: 1_800_000,
            text: "[pi-rukas] killed after 1800000ms timeout",
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
    assert(kinds.includes("cap-hit"), "HALT on develop synthesises a cap-hit event");
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "developer-timeout",
      "HALT recognises SIGTERM as cap='developer-timeout' (not generic step-failed:develop)",
    );
    // The driver must NOT have dispatched adversarial after the develop
    // failure — that's the cascade we're preventing.
    const adversarialDispatches = seenLabels.filter(
      (l) => l.startsWith("adversarial") || l === "adversarial_loop",
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
    await execp("git init -q -b main", { cwd: dir });
    await execp(
      'git config user.email "smoke@test" && git config user.name "Smoke" && git commit --allow-empty -q -m init',
      { cwd: dir, shell: "/bin/bash" },
    );
    await fs.writeFile(path.join(dir, "modified.txt"), "hi");
    await execp("git add modified.txt", { cwd: dir });
    await fs.writeFile(path.join(dir, "unstaged.txt"), "hi");

    const snap = await captureWorktreeSnapshot(dir, "main");
    assert((snap.repoRootHeadSha?.length ?? 0) > 0, "captureWorktreeSnapshot: HEAD sha resolved");
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
        repoRootHeadSha: "abc1234",
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

  const msg = renderHandoffUserMessage(s, "/repo/nessie", "/repo/nessie/tmp/issue-553");
  assert(
    msg.includes("HANDOFF DISPATCH INCOMPLETE"),
    "renderHandoffUserMessage: INCOMPLETE banner when commentUrl is null",
  );
  assert(
    msg.includes("gh issue comment 553 --body-file"),
    "renderHandoffUserMessage: surfaces the manual gh-comment recovery command",
  );
  assert(
    msg.includes("developer subagent hit the wall-clock backstop"),
    "renderHandoffUserMessage: explainCap output appears in body",
  );
  assert(msg.includes("feature/issue-553-fix"), "renderHandoffUserMessage: surfaces branch name");
  assert(msg.includes("HEAD abc1234"), "renderHandoffUserMessage: surfaces HEAD sha");
  assert(
    msg.includes("modified: src/foo.ts, tests/foo.test.ts") ||
      (msg.includes("src/foo.ts") && msg.includes("tests/foo.test.ts")),
    "renderHandoffUserMessage: lists modified files",
  );
  assert(
    msg.includes("# 2. Discard the cycle and start over"),
    "renderHandoffUserMessage: recovery #2 is 'discard and start over'",
  );
  // The per-role cap is gone (one runaway backstop replaces six numbers), so
  // the old "retry with a longer cap" step is gone with it — it advised a knob
  // that no longer exists, and it duplicated step 3's command verbatim.
  assert(
    !/PI_ENSEMBLE_SPAWN_TIMEOUT_MS_[A-Z]/.test(msg),
    "renderHandoffUserMessage: no per-role timeout env var is advertised",
  );
  assert(
    msg.includes("rm /repo/nessie/.pi/work-state/553.json"),
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
        repoRootHeadSha: "deadbee",
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
  assert(
    md.includes("### What this cap means"),
    "renderHandoffMarkdown: 'What this cap means' section",
  );
  assert(
    md.includes("### Worktree state at handoff"),
    "renderHandoffMarkdown: 'Worktree state at handoff' section",
  );
  assert(
    md.includes("### Concrete recovery commands"),
    "renderHandoffMarkdown: 'Concrete recovery commands' section",
  );
  assert(md.includes("### Inspect further"), "renderHandoffMarkdown: 'Inspect further' footer");
  assert(
    md.includes("# 2. Discard the cycle and start over"),
    "renderHandoffMarkdown: recovery #2 is 'discard and start over'",
  );
  assert(
    !/PI_ENSEMBLE_SPAWN_TIMEOUT_MS_[A-Z]/.test(md),
    "renderHandoffMarkdown: no per-role timeout env var is advertised",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
