#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 58-61: PR14 runCommitPr prompt shape (multi-worktree + N=1), consolidation gate, missing-workstream renderers.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext, nextStep } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import {
  appendEvent,
  filesPresentFromConsolidation,
  initialState,
  missingWorkstreamsFromConsolidation,
  readState,
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

// 58. PR14 — runCommitPr's prompt enumerates worktrees + workstreams for
// N>1 cycles. Pre-PR14 the prompt was single-tree shaped; multi-workstream
// cycles silently lost sibling worktrees' changes (v0.12.13 /work 577).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-commit-multi-prompt-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const issueBodyArtifact = path.join(dir, "issue-body.txt");
    await fs.writeFile(issueBodyArtifact, "title:\tmock issue #577\n");
    let capturedPrompt = "";
    let s = initialState(577, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "commit-pr",
        lastCompletedStep: "adversarial",
        branchName: "feature/issue-577-multi",
        issueBodyArtifact,
        worktrees: {
          "docs-research": `${dir}/.worktrees/issue-577-docs-research`,
          "app-logging": `${dir}/.worktrees/issue-577-app-logging`,
          "app-config": `${dir}/.worktrees/issue-577-app-config`,
        },
        workstreams: {
          "docs-research": {
            id: "docs-research",
            scope: "reorder write-sweep step",
            paths: ["docs/research.md"],
            outOfScope: ["src/unrelated.rs"],
          },
          "app-logging": {
            id: "app-logging",
            scope: "WARN log on missing SWP file",
            paths: ["src/cron/mod.rs"],
            outOfScope: ["docs/unrelated.md"],
          },
          "app-config": {
            id: "app-config",
            scope: "raise max_iterations",
            paths: ["config/app.toml"],
            outOfScope: [".github/workflows/unrelated.yml"],
          },
        },
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      host: makeFakePi().pi,
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

    for (const id of ["docs-research", "app-logging", "app-config"]) {
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
      capturedPrompt.includes("docs/research.md") &&
        capturedPrompt.includes("src/cron/mod.rs") &&
        capturedPrompt.includes("app.toml"),
      "PR14 §B: commit-pr prompt lists each workstream's in-scope paths",
    );
    assert(
      capturedPrompt.includes("feature/issue-577-multi"),
      "PR14 §B: commit-pr prompt names the integration branch",
    );
    assert(
      capturedPrompt.includes("src/unrelated.rs") &&
        capturedPrompt.includes("docs/unrelated.md") &&
        capturedPrompt.includes(".github/workflows/unrelated.yml") &&
        capturedPrompt.includes("mock issue #577"),
      "#284: commit-pr prompt lists out-of-scope paths and cached issue title",
    );
    assert(
      /stage ONLY paths under the listed in-scope paths or new files/i.test(capturedPrompt) &&
        /NEVER `git add -A` \/ `git add \.`/i.test(capturedPrompt),
      "#284: multi-worktree prompt forbids blanket staging",
    );
    assert(
      /staged set includes files from ALL.*workstreams/i.test(capturedPrompt),
      "PR14 §B: commit-pr prompt includes the verify-all-workstreams check",
    );
    assert(
      capturedPrompt.includes("git apply --3way --binary --index") &&
        capturedPrompt.includes("diff --cached --binary"),
      "PR14 §B: commit-pr prompt teaches the SAME recipe the mechanized path uses — stage first (git diff HEAD omits untracked files), --binary, --3way",
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
    const issueBodyArtifact = path.join(dir, "issue-body.txt");
    await fs.writeFile(issueBodyArtifact, "title:\tmock issue #580\n");
    let capturedPrompt = "";
    let s = initialState(580, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "commit-pr",
        lastCompletedStep: "adversarial",
        branchName: "feature/issue-580",
        issueBodyArtifact,
        worktrees: { default: dir },
        workstreams: {
          default: {
            id: "default",
            scope: "fix it",
            paths: ["src/foo.ts"],
            outOfScope: ["src/other.ts"],
          },
        },
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      host: makeFakePi().pi,
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
    assert(
      capturedPrompt.includes("src/other.ts") && capturedPrompt.includes("mock issue #580"),
      "#284: N=1 prompt lists the out-of-scope path and cached issue title",
    );
    assert(
      /stage ONLY paths under the listed in-scope paths or new files/i.test(capturedPrompt) &&
        /NEVER `git add -A` \/ `git add \.`/i.test(capturedPrompt),
      "#284: N=1 prompt forbids blanket staging",
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
    await fs.mkdir(path.join(dir, "docs"), { recursive: true });
    await fs.mkdir(path.join(dir, "config"), { recursive: true });
    await fs.writeFile(path.join(dir, "docs", "research.md"), "base\n");
    await fs.mkdir(path.join(dir, "src", "cron"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "cron", "mod.rs"), "// base\n");
    await fs.writeFile(
      path.join(dir, "config", "app.toml"),
      "max_iterations = 25\n",
    );
    await execp("git add . && git commit -q -m initial", { cwd: dir, shell: "/bin/bash" });
    await execp("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: dir,
    });
    await execp("git checkout -qb feature/issue-577-multi", { cwd: dir });
    // Commit ONLY app-config's file (simulates the v0.12.13 partial bug).
    await fs.writeFile(
      path.join(dir, "config", "app.toml"),
      "max_iterations = 40\n",
    );
    await execp("git add . && git commit -q -m 'partial: only config'", {
      cwd: dir,
      shell: "/bin/bash",
    });
    // #1134 — verifyConsolidation reads origin/<branch>: publish the branch as the push would.
    await execp("git update-ref refs/remotes/origin/feature/issue-577-multi HEAD", { cwd: dir });

    let s = initialState(577, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "commit-pr",
        lastCompletedStep: "adversarial",
        branchName: "feature/issue-577-multi",
        worktrees: {
          "docs-research": `${dir}/.worktrees/p`,
          "app-logging": `${dir}/.worktrees/o`,
          "app-config": `${dir}/.worktrees/c`,
        },
        workstreams: {
          "docs-research": {
            id: "docs-research",
            scope: "x",
            paths: ["docs/research.md"],
            outOfScope: [],
          },
          "app-logging": {
            id: "app-logging",
            scope: "y",
            paths: ["src/cron/mod.rs"],
            outOfScope: [],
          },
          "app-config": {
            id: "app-config",
            scope: "z",
            paths: ["config/app.toml"],
            outOfScope: [],
          },
        },
      },
    };
    await writeState(dir, s);

    const ctx: DriverContext = {
      host: makeFakePi().pi,
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
    const missing = missingWorkstreamsFromConsolidation(
      after?.pipelineState.incompleteConsolidation,
    );
    const missingIds = missing.map((m) => m.id).sort();
    assert(
      JSON.stringify(missingIds) === JSON.stringify(["app-logging", "docs-research"]),
      `PR14 §D: incompleteConsolidation lists docs-research + app-logging (got: ${JSON.stringify(missingIds)})`,
    );
    // #540 — both sides recorded: the missing verdicts AND the committed
    // file list (what actually shipped), so the handoff renders present +
    // missing.
    const filesPresent = filesPresentFromConsolidation(
      after?.pipelineState.incompleteConsolidation,
    );
    assert(
      filesPresent.includes("config/app.toml"),
      `PR14 §D (#540): filesPresent records the committed file list (got: ${JSON.stringify(filesPresent)})`,
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
      // #540 — current shape: verdicts (the missing side) + filesPresent
      // (the present side of the consolidation verdict).
      incompleteConsolidation: {
        verdicts: [
          {
            id: "docs-research",
            status: "uncovered",
            uncoveredPaths: ["docs/research.md"],
          },
          {
            id: "app-logging",
            status: "uncovered",
            uncoveredPaths: ["src/cron/mod.rs"],
          },
        ],
        filesPresent: ["config/app.toml"],
      },
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
    /docs-research/.test(explanation) && /app-logging/.test(explanation),
    "PR14 §E: explainCap names the missing workstreams",
  );

  const msg = renderHandoffUserMessage(s, "/repo/proj", "/repo/proj/tmp/issue-577");
  assert(
    msg.includes("Missing workstreams from the committed diff:") &&
      msg.includes("docs-research") &&
      msg.includes("app-logging"),
    "PR14 §E: renderHandoffUserMessage lists missing workstreams",
  );
  assert(
    msg.includes(".worktrees/issue-577-docs-research") &&
      msg.includes(".worktrees/issue-577-app-logging"),
    "PR14 §E: renderHandoffUserMessage shows per-worktree recovery commands",
  );

  const md = renderHandoffMarkdown(s);
  assert(
    md.includes("docs-research") && md.includes("app-logging"),
    "PR14 §E: renderHandoffMarkdown lists missing workstreams",
  );
  // #540 — all three renderers render the PRESENT side too (filesPresent),
  // not just the missing list.
  assert(
    /Committed \(the present side of the consolidation verdict\)/.test(md) &&
      md.includes("config/app.toml"),
    "PR14 §E: renderHandoffMarkdown renders the present side (filesPresent)",
  );
  assert(
    /Committed \(the present side of the consolidation verdict\)/.test(msg) &&
      msg.includes("config/app.toml"),
    "PR14 §E: renderHandoffUserMessage renders the present side (filesPresent)",
  );
  assert(
    /committed diff contains 1 file/.test(explanation) &&
      explanation.includes("config/app.toml"),
    "PR14 §E: explainCap renders the present side (filesPresent)",
  );
  assert(
    md.includes("git apply --3way --binary --index"),
    "PR14 §E: renderHandoffMarkdown's consolidation recovery uses the same recipe as the mechanized path",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
