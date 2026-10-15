#!/usr/bin/env bun
/**
 * #1146 regression tests: a repo shaped like pi-rukas — a root manifest, a
 * non-empty gitignored root `node_modules` (Pi's jiti cache) AND the real
 * tree at `extension/node_modules` — provisions BOTH into a fresh worktree,
 * and the develop gate fails fast, by name, when a tree is missing.
 *
 * Every /work cycle on this repo parked as `verify-failed:develop`: the
 * post-hook check verified only the FIRST non-empty `node_modules` (the
 * root one, which the hook never linked), recorded `hook-failed`, and the
 * gate ran a verify command that stalled until the 10-min timeout with no
 * assertion. Real git, a real `git worktree add`, and this repo's REAL
 * `.pi/worktree-setup` (copied into the fixture) — no stubbed hook.
 */
import { exec } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { missingDepsFailure } from "../src/work-driver-deps-hint.ts";
import { runVerifyCommandGate } from "../src/work-driver-verify-verify-cmd.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { provisionWorktree } from "../src/worktree-provision.ts";
import { realExec } from "./lib/exec-fake.ts";

const pexec = promisify(exec);
const REAL_HOOK = path.resolve(import.meta.dirname, "..", "..", ".pi", "worktree-setup");
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A git repo shaped like pi-rukas, with a detached worktree under `.worktrees/`. */
async function repoShapedFixture(hook: string | undefined): Promise<{ root: string; wt: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "wt-provision-1146-"));
  const files: Record<string, string> = {
    ".gitignore": "node_modules/\nextension/node_modules/\ndist/prompts/\n.worktrees/\n",
    // The real hook runs `bun run build` and checks its output; this stands in
    // for build.sh so the hook runs end to end offline.
    "package.json": JSON.stringify({
      name: "fixture",
      scripts: {
        build: "mkdir -p dist/prompts/standard && touch dist/prompts/standard/explore.md",
      },
    }),
    "extension/package.json": '{"name": "ext"}\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  if (hook !== undefined) {
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    if (hook === REAL_HOOK) copyFileSync(REAL_HOOK, path.join(root, ".pi", "worktree-setup"));
    else writeFileSync(path.join(root, ".pi", "worktree-setup"), hook);
  }
  const git = (args: string) => pexec(`git ${args}`, { cwd: root });
  await git("init -q");
  await git("config user.email test@example.com");
  await git("config user.name test");
  await git("add -A");
  await git("commit -q -m init");
  // Installed AFTER the commit, like a real checkout: gitignored, non-empty.
  mkdirSync(path.join(root, "node_modules", ".cache", "jiti"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", ".cache", "jiti", "a.mjs"), "x\n");
  mkdirSync(path.join(root, "extension", "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(root, "extension", "node_modules", "dep", "index.js"), "x\n");
  const wt = path.join(root, ".worktrees", "issue-1-default");
  await git(`worktree add -q --detach ${JSON.stringify(wt)} HEAD`);
  return { root, wt };
}

// ---------------- the real hook links root AND extension/node_modules, no problem
{
  const { root, wt } = await repoShapedFixture(REAL_HOOK);
  try {
    const result = await provisionWorktree(realExec, root, wt);
    assert(result.via === "hook", "the real .pi/worktree-setup is the provisioning path");
    assert(
      result.problem === undefined,
      `the post-hook check passes on a pi-rukas-shaped repo — not hook-failed (problem: ${result.problem})`,
    );
    assert(
      result.linked.includes("node_modules") && result.linked.includes("extension/node_modules"),
      `both trees are verified in the worktree (linked: ${result.linked.join(", ")})`,
    );
    assert(
      existsSync(path.join(wt, "extension", "node_modules", "dep", "index.js")),
      "extension/node_modules resolves inside the worktree",
    );
    const exclude = readFileSync(path.join(root, ".git", "info", "exclude"), "utf8").split("\n");
    assert(
      exclude.includes("node_modules") && exclude.includes("extension/node_modules"),
      "the hook writes one info/exclude entry per link, with no trailing slash",
    );
    const { stdout } = await pexec("git status --porcelain", { cwd: wt });
    assert(stdout.trim() === "", `no link surfaces in git status (got: ${JSON.stringify(stdout)})`);
    assert(
      (await missingDepsFailure({ eventLog: [] } as unknown as WorkState, root, wt, "v")) ===
        undefined,
      "a provisioned worktree is not reported as missing dependencies",
    );
    const again = await provisionWorktree(realExec, root, wt);
    assert(again.problem === undefined, "re-running the hook is idempotent (no problem)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- a hook that links only the root tree is caught: the nested location is checked too
{
  const rootOnly =
    '#!/bin/sh\nset -eu\nr=$(git rev-parse --path-format=absolute --git-common-dir)\nln -s "${r%/.git}/node_modules" node_modules\n';
  const { root, wt } = await repoShapedFixture(rootOnly);
  try {
    const result = await provisionWorktree(realExec, root, wt);
    assert(
      result.problem?.includes("extension/node_modules in the worktree is absent") === true,
      `the post-hook check looks in the depth-1 package dir, not only the root (problem: ${result.problem})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------- without a hook, the symlink loop links every non-empty tree too
{
  const { root, wt } = await repoShapedFixture(undefined);
  try {
    const result = await provisionWorktree(realExec, root, wt);
    assert(
      result.via === "symlink" && result.problem === undefined,
      `hookless provisioning succeeds (via: ${result.via}, problem: ${result.problem})`,
    );
    assert(
      existsSync(path.join(wt, "extension", "node_modules", "dep", "index.js")) &&
        existsSync(path.join(wt, "node_modules", ".cache", "jiti", "a.mjs")),
      "a non-empty root node_modules no longer hides extension/node_modules",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------- the develop gate fails fast, by name, on a bare worktree
{
  const { root, wt } = await repoShapedFixture(undefined);
  try {
    const state = { eventLog: [], pipelineState: { worktrees: {} } } as unknown as WorkState;
    const ran: string[] = [];
    const failures: string[] = [];
    await runVerifyCommandGate({
      execFn: async (cmd) => {
        ran.push(cmd);
        return { stdout: "", stderr: "" };
      },
      cmd: "sleep 600",
      ctx: { repoRoot: root, issue: 1 } as unknown as Parameters<
        typeof runVerifyCommandGate
      >[0]["ctx"],
      state,
      worktrees: { default: wt },
      baseSha: undefined,
      changedWorktrees: [wt],
      workstreamBaseShas: undefined,
      failures,
      notes: [],
    });
    assert(ran.length === 0, "the verify command is NOT run in a worktree missing its deps");
    assert(
      failures.length === 1 &&
        failures[0]?.includes(`extension/node_modules missing in ${wt}`) === true &&
        failures[0]?.includes(`missing: node_modules missing in ${wt}`) === true,
      `the failure names the missing tree and the worktree (got: ${failures[0]})`,
    );
    assert(
      failures[0]?.includes("timeout") === false,
      "the failure is not a timeout — it is reported before any command runs",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

process.exit(exit);
