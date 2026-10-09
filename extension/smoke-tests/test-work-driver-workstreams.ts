#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 9-10: PR3 parseWorkstreams/parseWorktreesBlock + multi-workstream develop fanout.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseWorktreesBlock } from "../src/work-driver-branch-develop.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { parseWorkstreams } from "../src/work-driver-plan.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { readState, writeState } from "../src/workflow-state.ts";

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

- task-a: /Users/janni/projects/foo/.worktrees/issue-553-task-a
- task-b: /Users/janni/projects/foo/.worktrees/issue-553-task-b

branch: feature/issue-553-fix
`;
  const wtResult = parseWorktreesBlock(wtText, "/Users/janni/projects/foo");
  assert(
    wtResult["task-a"] === "/Users/janni/projects/foo/.worktrees/issue-553-task-a",
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

// 9b. #679 case 2(a) — parseWorkstreams must parse `- depends-on:` and
// `- integration-test:` lines (tolerant of variants, comma-separated multi-dep).
{
  const depBlock = [
    "## Workstreams",
    "",
    "### task-a — base implementation",
    "- paths: src/a.ts, src/b.ts",
    "- out-of-scope: docs/",
    "",
    "### task-b — dependent work",
    "- paths: src/c.ts",
    "- depends-on: task-a",
    "- integration-test: src/test-ab.ts",
    "- out-of-scope: docs/",
    "",
    "### task-c — multi-dep with variant spelling",
    "- paths: src/d.ts",
    "- depends_on: task-a, task-b",
    "- out-of-scope: docs/",
  ].join("\n");
  const parsed = parseWorkstreams(depBlock);
  assert(
    (parsed["task-b"]?.dependsOn ?? []).length === 1 &&
      parsed["task-b"]?.dependsOn?.[0] === "task-a",
    "#679: `- depends-on: task-a` parsed into dependsOn array",
  );
  assert(
    parsed["task-b"]?.integrationTest === "src/test-ab.ts",
    "#679: `- integration-test: src/test-ab.ts` parsed into integrationTest",
  );
  assert(
    (parsed["task-c"]?.dependsOn ?? []).length === 2,
    "#679: comma-separated multi-dep parsed into 2-element array",
  );
  assert(
    parsed["task-c"]?.dependsOn?.[0] === "task-a" && parsed["task-c"]?.dependsOn?.[1] === "task-b",
    "#679: multi-dep values correct",
  );
  assert(
    parsed["task-a"]?.dependsOn === undefined,
    "#679: a workstream with NO depends-on line has dependsOn undefined (not [])",
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
    // #1016 — task-b fails once, so exactly ONE selective re-dispatch of it:
    // 4 developer dispatches (a, b, c, then b again); a and c never re-run.
    assert(
      developerLabels.length === 4,
      "multi-workstream: 3 developer dispatches + 1 selective retry",
    );
    assert(
      developerLabels.filter((l) => l === "developer[task-b]").length === 2 &&
        developerLabels.filter((l) => l === "developer[task-a]").length === 1 &&
        developerLabels.filter((l) => l === "developer[task-c]").length === 1,
      "multi-workstream: only the failed workstream (task-b) is re-dispatched",
    );
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
    const branchCompletions = (after?.eventLog ?? []).filter(
      (e) => e.kind === "branch-completed" && e.step === "develop",
    );
    assert(
      branchCompletions.length === 4,
      "multi-workstream: 4 branch-completed events (3 branches + task-b's retry, append-only)",
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
    // The latest task-b event is the retry's green result.
    const taskBLatest = branchCompletions.filter(
      (e) => (e as Extract<typeof e, { kind: "branch-completed" }>).workstreamId === "task-b",
    );
    assert(
      taskBLatest.length === 2 &&
        (taskBLatest[0] as Extract<typeof e, { kind: "branch-completed" }>).ok === false,
      "task-b: first failure recorded before the selective retry",
    );
    assert(verdictsByWorkstream["task-b"] === true, "task-b: retry recorded green");
    assert(
      verdictsByWorkstream["task-c"] === true,
      "task-c: success recorded (NOT aborted by task-b failure)",
    );

    // branches-converged carries the per-branch verdict aggregate.
    const converged = (after?.eventLog ?? []).find((e) => e.kind === "branches-converged");
    assert(converged !== undefined, "branches-converged is present");
    if (converged?.kind === "branches-converged") {
      assert(
        converged.verdicts.filter((v) => v.ok).length === 3,
        "branches-converged verdicts: 3 of 3 ok after the selective retry",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 10b. #679 case 2(a)/2(b) — topological dispatch order + deferred worktree
// creation for a depends-on pair. The plan-quality gate guarantees a DAG;
// this test exercises the scheduler's topological ordering and the
// deferred worktree creation (from the dependency's post-commit SHA, not
// baseSha) without a real git repo (the execFn is mocked).
{
  const { topologicalDispatchOrder, computeSkipCascade } = await import(
    "../src/work-driver-dep-scheduler.ts"
  );

  // Topological order: A (independent), B depends on A, C depends on B.
  const ids = ["task-a", "task-b", "task-c"];
  const dependsOnMap = {
    "task-b": ["task-a"],
    "task-c": ["task-b"],
  };
  const { independent, dependentOrdered } = topologicalDispatchOrder(ids, dependsOnMap);
  assert(independent.length === 1 && independent[0] === "task-a", "#679: task-a is independent");
  assert(
    dependentOrdered.length === 2 &&
      dependentOrdered[0] === "task-b" &&
      dependentOrdered[1] === "task-c",
    "#679: topological order is task-b → task-c (C waits on B which waits on A)",
  );

  // Skip cascade: if task-a fails, task-b is skipped, and task-c is
  // transitively skipped (its dependency task-b was skipped).
  const failedOrSkipped = new Set(["task-a"]);
  const skips = computeSkipCascade(["task-b", "task-c"], dependsOnMap, failedOrSkipped);
  assert(skips.has("task-b"), "#679: task-b is skipped when its dependency task-a failed");
  assert(skips.has("task-c"), "#679: task-c is transitively skipped when task-b was skipped");

  // No failures → no skips.
  const noSkips = computeSkipCascade(["task-b", "task-c"], dependsOnMap, new Set());
  assert(noSkips.size === 0, "#679: no skips when no dependency failed");

  // The N=1 default path: no depends-on, all independent.
  const { independent: solo, dependentOrdered: soloDep } = topologicalDispatchOrder(
    ["default"],
    {},
  );
  assert(solo.length === 1 && solo[0] === "default", "#679: N=1 default is independent");
  assert(soloDep.length === 0, "#679: N=1 default has no dependent workstreams");
}

// 10c. #679 case 2(b) — resolveDependentBase with a mocked execFn: the
// dependent's base is the dependency's post-commit HEAD SHA (not baseSha).
{
  const { resolveDependentBase } = await import("../src/work-driver-dep-scheduler.ts");
  const FAKE_DEP_SHA = "a".repeat(40);
  const FAKE_BASE_SHA = "b".repeat(40);
  const mockExecFn = async (cmd: string) => {
    if (cmd === "git rev-parse HEAD") return { stdout: `${FAKE_DEP_SHA}\n` };
    if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" };
    return { stdout: "" };
  };
  const result = await resolveDependentBase(
    mockExecFn,
    "/repo",
    679,
    "task-b",
    ["task-a"],
    { "task-a": "/repo/.worktrees/issue-679-task-a" },
    { "task-a": FAKE_BASE_SHA },
    FAKE_BASE_SHA,
  );
  assert(
    result.fromRef === FAKE_DEP_SHA,
    "#679: the dependent's fromRef is the dependency's post-commit HEAD (not baseSha)",
  );
  assert(
    result.baseSha === FAKE_DEP_SHA,
    "#679: the dependent's effective base is the dependency's post-commit HEAD",
  );
  assert(result.skipReason === undefined, "#679: no skip reason when the dependency has commits");

  // Dependency with zero commits ahead of its base → skip (no baseSha fallback).
  const mockExecFnZero = async (cmd: string) => {
    if (cmd === "git rev-parse HEAD") return { stdout: `${FAKE_DEP_SHA}\n` };
    if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
    return { stdout: "" };
  };
  const zeroResult = await resolveDependentBase(
    mockExecFnZero,
    "/repo",
    679,
    "task-b",
    ["task-a"],
    { "task-a": "/repo/.worktrees/issue-679-task-a" },
    { "task-a": FAKE_BASE_SHA },
    FAKE_BASE_SHA,
  );
  assert(
    zeroResult.fromRef === undefined && zeroResult.skipReason !== undefined,
    "#679: a dependency with zero commits ahead of its base → the dependent is skipped (no baseSha fallback)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
