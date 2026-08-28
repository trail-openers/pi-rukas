#!/usr/bin/env bun
/**
 * Issue #284 — prompt grounding for the commit-pr fallback and CI steps.
 *
 * These tests exercise both direct prompt shapes and the injected dispatch
 * seams, so a parameter can be added to a builder without being dropped at
 * its driver call site.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommitPr } from "../src/work-driver-commit.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { inlineCiPrompt, inlineCommitPrPrompt } from "../src/work-driver-prompts-late.ts";
import { runCi } from "../src/work-driver-stepback-ci.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(condition: boolean, message: string): void {
  if (condition) console.log(`✓ ${message}`);
  else {
    console.error(`✗ ${message}`);
    exit = 1;
  }
}

const baseEventLog: never[] = [];
const scratchDir = "/tmp/pi-ensemble-issue-284";

// B — N=1 fallback prompt carries the issue title and the explicit staging
// fence, including the out-of-scope paths from the plan.
{
  const prompt = inlineCommitPrPrompt(
    [284],
    [],
    { default: "/repo/.worktrees/issue-284-default" },
    {
      default: {
        id: "default",
        scope: "ground commit-pr fallback",
        paths: ["extension/src/work-driver-commit.ts"],
        outOfScope: ["docs/", "README.md"],
      },
    },
    "feature/issue-284-ground-ops",
    undefined,
    baseEventLog,
    scratchDir,
    "Ground the ops prompts",
  );
  assert(
    prompt.includes('"Ground the ops prompts"'),
    "#284 B N=1: issue title is grounded in prompt",
  );
  assert(
    prompt.includes("DO NOT STAGE these out-of-scope paths: docs/, README.md"),
    "#284 B N=1: out-of-scope paths are an explicit do-not-stage fence",
  );
  assert(
    prompt.includes("NEVER `git add -A` / `git add .`"),
    "#284 B N=1: prompt forbids blanket staging",
  );
  assert(
    prompt.includes("PR title/body must describe the DIFF and the ISSUE") &&
      prompt.includes("do not derive prose from the branch name"),
    "#284 B N=1: PR prose is grounded in the diff and issue",
  );
}

// B — N>1 carries a separate fence for every workstream and does not retain
// the old blanket `git -C <worktree-path> add -A` recipe.
{
  const prompt = inlineCommitPrPrompt(
    [284],
    [],
    { "task-a": "/repo/.worktrees/a", "task-b": "/repo/.worktrees/b" },
    {
      "task-a": {
        id: "task-a",
        scope: "prompt grounding",
        paths: ["extension/src/work-driver-prompts-late.ts"],
        outOfScope: ["extension/src/work-driver-stepback-ci.ts"],
      },
      "task-b": {
        id: "task-b",
        scope: "CI branch interpolation",
        paths: ["extension/src/work-driver-stepback-ci.ts"],
        outOfScope: ["extension/src/work-driver-prompts-late.ts"],
      },
    },
    "feature/issue-284-ground-ops",
    undefined,
    baseEventLog,
    scratchDir,
    "Ground the ops prompts",
  );
  assert(
    prompt.includes("task-a") && prompt.includes("task-b"),
    "#284 B N>1: every workstream is named in the prompt",
  );
  assert(
    prompt.includes(
      "DO NOT STAGE these out-of-scope paths: extension/src/work-driver-stepback-ci.ts",
    ) &&
      prompt.includes(
        "DO NOT STAGE these out-of-scope paths: extension/src/work-driver-prompts-late.ts",
      ),
    "#284 B N>1: every workstream has its own out-of-scope fence",
  );
  assert(
    !prompt.includes("git -C <worktree-path> add -A") &&
      prompt.includes(
        "git -C <worktree-path> add -- <reviewed in-scope-paths-or-developer-created-new-files>",
      ),
    "#284 B N>1: consolidation recipe stages explicit reviewed paths",
  );
}

// B — the actual fallback path reads the title from the cached issue-body
// artifact before building the ops dispatch prompt.
{
  const dir = mkdtempSync(path.join(tmpdir(), "issue-284-title-artifact-"));
  try {
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const artifact = path.join(dir, "issue-body");
    writeFileSync(artifact, "title:\tGround the ops prompts\nstate:\tOPEN\n\nbody\n");
    const state = {
      ...initialState(284),
      pipelineState: {
        ...initialState(284).pipelineState,
        currentStep: "commit-pr" as const,
        lastCompletedStep: "adversarial" as const,
        baseSha: "base-sha",
        branchName: "feature/issue-284-ground-ops",
        issueBodyArtifact: artifact,
        worktrees: { default: dir },
        workstreams: {
          default: {
            id: "default",
            scope: "ground commit-pr fallback",
            paths: ["extension/src/work-driver-commit.ts"],
            outOfScope: ["README.md"],
          },
        },
      },
    };
    let captured = "";
    const ctx: DriverContext = {
      pi: {} as ExtensionAPI,
      repoRoot: dir,
      issue: 284,
      verifyExecFn: async (cmd) => {
        if (cmd === "git status --porcelain") return { stdout: "?? unrelated.txt\n" };
        return { stdout: "" };
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:commit-pr") {
          captured = spec.prompt;
          throw new Error("stop after capture");
        }
        throw new Error(`unexpected dispatch ${spec.role}`);
      },
    };
    await runCommitPr(ctx, state, Date.now());
    assert(
      captured.includes('"Ground the ops prompts"'),
      "#284 B fallback: cached issue-body title reaches the ops prompt",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// C — direct builder shape and the runCi injected dispatch both carry the
// captured branch; no prompt uses the old literal placeholder.
{
  const branch = "feature/issue-284-ground-ops";
  const direct = inlineCiPrompt(284, branch, scratchDir);
  assert(
    direct.includes(`gh run list --branch ${branch}`),
    "#284 C: CI prompt interpolates branch name",
  );
  assert(!direct.includes("<branch>"), "#284 C: CI prompt has no unsubstituted branch placeholder");

  const missing = inlineCiPrompt(284, undefined, scratchDir);
  assert(
    missing.includes("branch not captured — discover via") &&
      missing.includes("git branch --show-current"),
    "#284 C: missing branch gives an explicit discovery fallback",
  );
}

{
  const dir = mkdtempSync(path.join(tmpdir(), "issue-284-ci-capture-"));
  try {
    await mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const state = {
      ...initialState(284),
      pipelineState: {
        ...initialState(284).pipelineState,
        currentStep: "ci" as const,
        lastCompletedStep: "lens-review" as const,
        branchName: "feature/issue-284-sentinel-branch",
      },
    };
    let captured = "";
    const ctx: DriverContext = {
      pi: {} as ExtensionAPI,
      repoRoot: dir,
      issue: 284,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:ci") {
          captured = spec.prompt;
          return {
            role: "ops",
            ok: true,
            text: "CI complete\nci-status: success",
            toolUses: [],
            ms: 1,
            exitCode: 0,
            transcriptPath: "/tmp/issue-284-ci.json",
          };
        }
        throw new Error(`unexpected dispatch ${spec.role}`);
      },
    };
    const result = await runCi(ctx, state, Date.now());
    assert(
      captured.includes("feature/issue-284-sentinel-branch"),
      "#284 C end-to-end: injected CI dispatch receives captured branch",
    );
    assert(
      result.eventLog.some((event) => event.kind === "ci-status" && event.status === "success"),
      "#284 C end-to-end: CI marker is still parsed after prompt threading",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
