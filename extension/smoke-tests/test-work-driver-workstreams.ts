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
    assert(
      verdictsByWorkstream["task-b"] === false,
      "task-b: failure recorded (partial-failure aggregate)",
    );
    assert(
      verdictsByWorkstream["task-c"] === true,
      "task-c: success recorded (NOT aborted by task-b failure)",
    );

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

console.log(`\nexit ${exit}`);
process.exit(exit);
