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
import { execFile } from "node:child_process";
import {
  chmodSync,
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
import { geteuid } from "node:process";
import { promisify } from "node:util";
import { missingDepsFailure } from "../src/work-driver-deps-gate.ts";
import { runVerifyCommandGate } from "../src/work-driver-verify-verify-cmd.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { runHookProvisioning } from "../src/worktree-provision-hook.ts";
import { provisionWorktree } from "../src/worktree-provision.ts";
import { WORKTREE_SETUP_HOOK } from "../src/worktree-provision.ts";
import { ignoredStatus } from "../src/worktree-provision.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { realExec } from "./lib/exec-fake.ts";

const pexec = promisify(execFile);
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
  const git = (...args: string[]) => pexec("git", args, { cwd: root });
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");
  await git("add", "-A");
  await git("commit", "-q", "-m", "init");
  // Installed AFTER the commit, like a real checkout: gitignored, non-empty.
  mkdirSync(path.join(root, "node_modules", ".cache", "jiti"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", ".cache", "jiti", "a.mjs"), "x\n");
  mkdirSync(path.join(root, "extension", "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(root, "extension", "node_modules", "dep", "index.js"), "x\n");
  const wt = path.join(root, ".worktrees", "issue-1-default");
  await git("worktree", "add", "-q", "--detach", wt, "HEAD");
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
    const { stdout } = await pexec("git", ["status", "--porcelain"], { cwd: wt });
    assert(stdout.trim() === "", `no link surfaces in git status (got: ${JSON.stringify(stdout)})`);
    assert(
      (await missingDepsFailure(realExec, { eventLog: [] } as WorkState, root, wt, "v")) ===
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
      execFn: async (cmd, opts) => {
        // git is answered for real in BOTH forms — argv (`git`, `argv: [...]`,
        // the gate's own status probe) and shell (`git check-ignore -q -- …`,
        // the shared filter). Only the command under test is recorded: a stub
        // that logged the probe as a run would "fail" this assertion for the
        // wrong reason.
        if (cmd === "git" || commandOf(cmd, opts).startsWith("git ")) return realExec(cmd, opts);
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

// ---- a non-empty tree provisioning never links (not gitignored) does not block the gate
{
  const { root, wt } = await repoShapedFixture(undefined);
  try {
    writeFileSync(path.join(root, ".gitignore"), "extension/node_modules/\n.worktrees/\n");
    rmSync(path.join(root, "extension", "node_modules"), { recursive: true });
    const failure = await missingDepsFailure(
      realExec,
      { eventLog: [] } as WorkState,
      root,
      wt,
      "v",
    );
    assert(
      failure === undefined,
      `an untracked, non-ignored root node_modules is not reported missing (got: ${failure})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- #1146 CI root cause: /bin/sh is dash on Linux (CI) and bash on macOS.
// The hook must run under dash — `builtin` is not POSIX and dash exits 127.
if (existsSync("/bin/dash")) {
  const { root, wt } = await repoShapedFixture(REAL_HOOK);
  try {
    const underDash: typeof realExec = (cmd, opts) =>
      realExec(cmd.replace(/^sh /, "/bin/dash "), opts);
    const result = await provisionWorktree(underDash, root, wt);
    assert(
      result.problem === undefined && result.hookFailed !== true,
      `the real hook runs under dash, the Linux /bin/sh (problem: ${result.problem})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} else {
  console.log("· /bin/dash not installed — the dash hook check is skipped");
}

// ---- an ignore status git cannot give is NAMED, not silently dropped
{
  const { root, wt } = await repoShapedFixture(undefined);
  try {
    rmSync(path.join(root, "extension", "node_modules"), { recursive: true });
    const failing =
      (code: number | undefined) => async (cmd: string, opts: Parameters<typeof realExec>[1]) => {
        // argv form only — the gate's probe is `execFn("git", { argv })`, and a
        // fake that also swallowed the shell-form calls would fail this
        // assertion for the wrong reason.
        if (cmd !== "git" || !opts?.argv) return realExec(cmd, opts);
        throw Object.assign(new Error("fatal: boom"), {
          ...(code === undefined ? {} : { code }),
        });
      };
    const unknown = await missingDepsFailure(
      failing(128),
      { eventLog: [] } as unknown as WorkState,
      root,
      wt,
      "v",
    );
    assert(
      unknown?.includes("ignore status could not determine (git check-ignore") === true &&
        unknown?.includes("fatal: boom") === true,
      `a git error on check-ignore names git's own words, not just a bare state (got: ${unknown})`,
    );
    assert(
      unknown?.includes("node_modules missing in") === true,
      `...and the undetermined candidate is NOT dropped from the expectation (got: ${unknown})`,
    );
    const notIgnored = await missingDepsFailure(
      failing(1),
      { eventLog: [] } as unknown as WorkState,
      root,
      wt,
      "v",
    );
    assert(notIgnored === undefined, "exit 1 (not ignored) is never linked, so never named");
    // An executor that cannot answer at all — a spawn failure carries no exit
    // code. That is a git error too, never a clean "not ignored", so the
    // candidate survives into the named set.
    const noCode = await missingDepsFailure(
      failing(undefined),
      { eventLog: [] } as unknown as WorkState,
      root,
      wt,
      "v",
    );
    assert(
      noCode?.includes("ignore status could not determine") === true &&
        noCode?.includes("node_modules missing in") === true,
      `an executor rejection with no exit code is a git error, not "not ignored" (got: ${noCode})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- the hook's probe under dash: three states, not two (#1394)
//
// `.pi/worktree-setup` runs under CI's /bin/sh, which is dash. The probe must
// distinguish `git check-ignore`'s three outcomes — exit 0 ignored / exit 1 not
// ignored / anything else git itself failed — because the original `|| continue`
// collapsed the last two: a real git error read as "not ignored", the tree went
// unlinked, the hook exited 0, and the driver reported a missing dependency tree
// with nothing saying it was a git failure.
//
// These run the REAL hook through /bin/dash where dash exists, so the assertion
// covers the shell the fleet actually uses rather than bash's dialect.
{
  const DASH = existsSync("/bin/dash") ? "/bin/dash" : undefined;
  const dashExec: typeof realExec | undefined = DASH
    ? (cmd, opts) =>
        // `sh "<hook>"` -> `/bin/dash "<hook>"`. The space is load-bearing:
        // without it the hook path collides with the binary name.
        realExec(String(cmd).replace(/^sh(?=\s)/, DASH), opts)
    : undefined;

  // exit 1 (not ignored) must SKIP, and exit 0 (ignored) must LINK, and the two
  // must not be confused: only `extension/node_modules` is ignored here.
  if (dashExec) {
    const { root, wt } = await repoShapedFixture(REAL_HOOK);
    try {
      // Un-ignore the root tree so the hook must skip it.
      writeFileSync(
        path.join(root, ".gitignore"),
        "extension/node_modules/\ndist/prompts/\n.worktrees/\n",
      );
      const result = await provisionWorktree(dashExec, root, wt);
      assert(
        result.hookFailed !== true,
        `dash: exit 1 skips and exit 0 links, told apart by exit code (hookFailed: ${result.hookFailed})`,
      );
      assert(
        !result.linked.includes("node_modules") &&
          result.linked.some((l) => l.includes("extension/node_modules")),
        `...and only the gitignored tree is verified (linked: ${result.linked.join(", ")})`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // A git error is the third state. A corrupt `.git/index` makes `git
  // check-ignore` exit 128 ("index file smaller than expected") while every
  // other git call still works — `--git-common-dir` resolves and `git worktree
  // add` succeeded — so the hook reaches the probe and no further. That isolates
  // the ≥2 arm exactly.
  if (dashExec) {
    const { root, wt } = await repoShapedFixture(REAL_HOOK);
    try {
      const indexPath = path.join(root, ".git", "index");
      const realIndex = readFileSync(indexPath);
      writeFileSync(indexPath, "garbage");
      let result: Awaited<ReturnType<typeof provisionWorktree>> | undefined;
      try {
        result = await provisionWorktree(dashExec, root, wt);
      } finally {
        writeFileSync(indexPath, realIndex);
      }
      assert(
        result?.hookFailed === true,
        `dash: a check-ignore git error fails the hook instead of skipping the tree (hookFailed: ${result?.hookFailed})`,
      );
      assert(
        result?.problem?.includes("exit 128") === true &&
          result?.problem?.includes("index file smaller than expected") === true,
        `...and the problem names git's exit code and its own error text (problem: ${result?.problem})`,
      );
      assert(
        result?.problem?.includes("Command failed") !== true,
        "...and the operator-visible cause is git's, not the `Command failed:` wrapper",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

// ---- the hook's problem string keeps the CAUSE, not the 200-char head (#1394)
//
// `promisify(exec)` puts the hook's output in `stderr` and prefixes
// `Command failed: sh <hook>` in `message`. A head-slice of `message` at 200
// chars returned the wrapper and the build banner, and dropped the
// `worktree-setup: ERROR: …` line — the only thing the operator can act on.
//
// Placement is the point, not just retention: `provisionDepsHint` renders
// `event.problem` at its own `slice(0, 200)`, so a cause that survives into
// `problem` at char 900 is still invisible to the human who reads the hint. The
// ERROR line is hoisted to the FRONT before the cap, and the cap keeps the head.
{
  const { root, wt } = await repoShapedFixture(REAL_HOOK);
  try {
    const cause = "worktree-setup: ERROR: cannot append to .git/info/exclude: EACCES";
    const chatter = "build banner line of noise\n".repeat(30); // >200 chars first
    const longStderr = `Command failed: sh .pi/worktree-setup\n$ bun run build\n${chatter}${cause}\n`;
    const chatty: typeof realExec = (cmd, opts) => {
      if (commandOf(cmd, opts).startsWith("sh ")) {
        throw Object.assign(new Error(`Command failed: sh .pi/worktree-setup\n${longStderr}`), {
          code: 1,
          stderr: longStderr,
          stdout: "",
        });
      }
      return realExec(cmd, opts);
    };
    const result = await provisionWorktree(chatty, root, wt);
    assert(
      result.hookFailed === true && result.problem?.includes(cause) === true,
      `a >400-char hook stderr still lands its ERROR line in problem (problem: ${result.problem})`,
    );
    assert(
      result.problem?.includes("Command failed") !== true,
      "...and the wrapper is stripped before the cap, so the cause fits inside it",
    );
    // 380 is HOOK_PROBLEM_BUDGET; +1 is the ellipsis that marks the cut.
    assert(
      (result.problem?.length ?? 0) <= ".pi/worktree-setup failed (exit 1): ".length + 380 + 1,
      `...and the problem stays bounded (length: ${result.problem?.length})`,
    );
    assert(
      result.problem?.slice(0, 200).includes("EACCES") === true,
      `...and it sits inside the hint's own 200-char window (first 200: ${result.problem?.slice(0, 200)})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
