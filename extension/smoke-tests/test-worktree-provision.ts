#!/usr/bin/env bun
/**
 * Tests `worktree-provision.ts`: symlink loops that link gitignored dep trees
 * into detached worktrees. #481: the original only linked `node_modules`
 * at repoRoot (empty), missing nested trees. #536: provisions tracking.
 */

import { exec } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mechanizedBranchSetup } from "../src/work-driver-branch-mechanized.ts";
import {
  NEVER_SHARED,
  SHAREABLE_DEPS,
  looksLikeMissingDeps,
  provisionWorktree,
} from "../src/worktree-provision.ts";

const pexec = promisify(exec);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * An `execFn` that runs REAL git (the probe needs its three-state exit code
 * via `err.code`), with `sh <hook>` calls stubbed when `hookRuns` is given.
 * `git rev-parse --git-common-dir` (used by `hideFromGit`) returns ".git".
 */
function realExecFn(
  hookRuns?: string[],
  hookOutput = "",
): (cmd: string, opts: { cwd?: string }) => Promise<{ stdout: string }> {
  const e = (cmd: string, cwd?: string) => pexec(cmd, { cwd }).then(({ stdout }) => ({ stdout }));
  return async (cmd: string, opts: { cwd?: string }) => {
    if (cmd.startsWith("sh ")) {
      hookRuns?.push(`${cmd} @ ${opts.cwd}`);
      return { stdout: hookOutput };
    }
    if (cmd.startsWith("git rev-parse")) return { stdout: ".git" };
    return e(cmd, opts.cwd);
  };
}

/** A scratch root plus the worktree path every fixture needs. */
function fixture(name: string): { root: string; wt: string } {
  const root = mkdtempSync(path.join(tmpdir(), "wt-provision-"));
  return { root, wt: path.join(root, ".worktrees", name) };
}

/** A real git repo with the given `.gitignore`; a tracked file committed. */
async function initRepo(
  root: string,
  gitignore: string,
  extraFiles: Record<string, string> = {},
): Promise<void> {
  writeFileSync(path.join(root, ".gitignore"), gitignore);
  writeFileSync(path.join(root, "tracked.txt"), "tracked\n");
  for (const [rel, content] of Object.entries(extraFiles)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  // Real git, dummy identity so commits work in CI.
  const run = (...args: string[]) =>
    pexec(`git ${args.join(" ")}`, { cwd: root, env: { ...process.env, HOME: root } });
  await run("init -q");
  await run("config", "user.email", "test@example.com");
  await run("config", "user.name", "test");
  await run("add", "-A");
  await run("commit", "-q", "-m", "init");
}

/** A `git worktree add --detach`-equivalent with a per-worktree gitdir. */
async function makeWorktreeFixture(root: string, name: string): Promise<string> {
  const wt = path.join(root, ".worktrees", name);
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", name)}\n`);
  const perWt = path.join(root, ".git", "worktrees", name);
  mkdirSync(perWt, { recursive: true });
  writeFileSync(path.join(perWt, "gitdir"), `${wt}/.git\n`);
  return wt;
}

// ------------------------------------------------- the symlink default (real git)
{
  const { root, wt } = fixture("issue-1-default");
  try {
    await initRepo(root, "node_modules/\ntarget/\n");
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "marker"), "x");
    mkdirSync(path.join(root, "target"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    const result = await provisionWorktree(realExecFn(), root, wt);

    assert(result.via === "symlink", `provisioned by symlink (got ${result.via})`);
    assert(
      result.linked.includes("node_modules"),
      "canary: a gitignored node_modules is linked into the worktree — absent before, and the develop gate failed on it",
    );
    assert(
      await fs
        .readFile(path.join(wt, "node_modules", "marker"), "utf8")
        .then((s) => s === "x")
        .catch(() => false),
      "...and the link actually resolves to repoRoot's copy",
    );
    assert(
      !result.linked.includes("target"),
      "canary: target/ is NOT linked — write-heavy, and sharing it would serialise the fan-out",
    );
    assert(result.problem === undefined, "a clean provision reports no problem");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// -------------------------------------- a TRACKED directory is never shadowed
{
  const { root, wt } = fixture("w");
  try {
    // `vendor/README.md` is committed, so `vendor` is a TRACKED directory
    // that `git worktree add` materialised; linking would shadow its real content.
    await initRepo(root, "", { "vendor/README.md": "real vendor content\n" });
    mkdirSync(wt, { recursive: true });
    // A tracked directory is not ignored, so `isIgnored` returns false.
    const result = await provisionWorktree(realExecFn(), root, wt);
    assert(
      !result.linked.includes("vendor"),
      "canary: a TRACKED directory is never replaced by a link to elsewhere",
    );
    assert(result.via === "none", "...and nothing was provisioned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------ #481: nested package dir is linked
{
  const { root, wt } = fixture("w");
  try {
    // The #479 live failure: an EMPTY `node_modules/` at the root and the
    // real tree at `pkg/node_modules` — pre-#481 the root one was linked
    // and reported as `linked: ["node_modules"]` (indistinguishable from success).
    await initRepo(root, "node_modules/\npkg/node_modules/\n", {
      "pkg/package.json": '{"name": "pkg", "dependencies": {}}\n',
    });
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    mkdirSync(path.join(root, "pkg", "node_modules", "typebox"), { recursive: true });
    writeFileSync(
      path.join(root, "pkg", "node_modules", "typebox", "index.js"),
      "module.exports={}\n",
    );
    mkdirSync(wt, { recursive: true });
    await makeWorktreeFixture(root, "w");

    const result = await provisionWorktree(realExecFn(), root, wt);

    assert(
      result.via === "symlink",
      `nested-package repo is provisioned by symlink (got ${result.via})`,
    );
    assert(
      result.linked.includes("node_modules"),
      "the nested pkg/node_modules is linked — the tree the verify command actually needs",
    );
    assert(result.problem === undefined, "no problem: the nested tree was found and linked");
    // The link lands at <worktree>/pkg/node_modules, not <worktree>/node_modules.
    assert(
      await fs
        .readFile(path.join(wt, "pkg", "node_modules", "typebox", "index.js"), "utf8")
        .then((s) => s.length > 0)
        .catch(() => false),
      "...and the link resolves to repoRoot's nested copy at the right path",
    );
    // The empty root node_modules was NOT linked over the (nonexistent)
    // worktree root — only the nested one was.
    assert(
      !(await fs
        .lstat(path.join(wt, "node_modules"))
        .then((s) => s.isSymbolicLink())
        .catch(() => false)),
      "the EMPTY root node_modules was NOT linked — it is not a useful link",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --------------------------------- #481: an empty candidate is not reported
{
  const { root, wt } = fixture("w");
  try {
    // Only an EMPTY gitignored node_modules at the root, no nested package.
    // Pre-#481: `linked: ["node_modules"]` (a claim of success for a bare worktree);
    // post-#481 it is skipped and a `problem` is set.
    await initRepo(root, "node_modules/\n", {
      "package.json": '{"name": "root", "dependencies": {}}\n',
    });
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    await makeWorktreeFixture(root, "w");

    const result = await provisionWorktree(realExecFn(), root, wt);

    assert(
      !result.linked.includes("node_modules"),
      'an EMPTY candidate is never reported as a useful link (DoD: `linked: ["node_modules"]` must not be returned for a dir with no entries)',
    );
    assert(
      result.problem !== undefined,
      "...and a lockfile-bearing project with no findable tree reports a problem, not silence (DoD: `ProvisionResult.problem` set)",
    );
    assert(
      result.problem?.includes("no dependency tree") === true,
      "...and the problem names the missing tree, not a generic error",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------- #481: problem set, but the step never fails
{
  const { root, wt } = fixture("w");
  try {
    // A Rust project (Cargo.toml) with no `target/` (never shared) and no
    // other shareable dep; `problem` set but provisioning returns cleanly.
    await initRepo(root, "target/\n", { "Cargo.toml": '[package]\nname = "demo"\n' });
    mkdirSync(wt, { recursive: true });
    await makeWorktreeFixture(root, "w");

    const result = await provisionWorktree(realExecFn(), root, wt);
    assert(
      typeof result.problem === "string" && result.problem.length > 0,
      "canary: a lockfile-bearing project with no dep tree gets a problem (not silence)",
    );
    assert(
      result.via === "none",
      "...and nothing was linked — the worktree is bare, and that is the status quo the branch step already ships",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------- the hook wins (unchanged)
{
  const { root, wt } = fixture("w");
  try {
    await initRepo(root, "node_modules/\n", { "package.json": "{}\n" });
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(path.join(root, ".pi", "worktree-setup"), "#!/bin/sh\nbun install\n");
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "marker"), "x");
    mkdirSync(wt, { recursive: true });

    const runs: string[] = [];
    const result = await provisionWorktree(realExecFn(runs), root, wt);

    assert(result.via === "hook", "the project's own hook is preferred over guessing");
    assert(runs.length === 1 && runs[0]?.includes(wt), "...and runs IN the new worktree");
    assert(
      result.linked.length === 0,
      "canary: the symlink default is skipped when a hook exists — the project said what it needs",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------- provisioning never fails the step (unchanged)
{
  const { root, wt } = fixture("w");
  try {
    await initRepo(root, "");
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(path.join(root, ".pi", "worktree-setup"), "exit 1\n");
    mkdirSync(wt, { recursive: true });
    const fn = (async (cmd: string) => {
      if (cmd.startsWith("sh ")) throw new Error("hook exited 1");
      return { stdout: "" };
    }) as never;
    const result = await provisionWorktree(fn, root, wt);
    assert(
      typeof result.problem === "string" && result.problem.includes("failed"),
      "a failing hook is REPORTED, not thrown — a worktree without deps is the status quo",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------- a link failure is reported by name
{
  const { root, wt } = fixture("w");
  try {
    await initRepo(root, "node_modules/\n", { "package.json": "{}\n" });
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "marker"), "x");
    mkdirSync(wt, { recursive: true });
    // A pre-existing entry makes symlink() throw EEXIST.
    symlinkSync(root, path.join(wt, "node_modules"), "dir");
    const result = await provisionWorktree(realExecFn(), root, wt);
    assert(
      result.problem?.includes("node_modules") === true,
      "a link that cannot be created is reported by name",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// -------------------------------------------------- the allowlists are sane (unchanged)
{
  const overlap = SHAREABLE_DEPS.filter((d) => (NEVER_SHARED as readonly string[]).includes(d));
  assert(overlap.length === 0, "no directory is both shareable and never-shared");
  assert(
    (NEVER_SHARED as readonly string[]).includes("target"),
    "canary: target/ is on the never-shared list, so a future edit cannot quietly add it",
  );
}

// ------------------------------------------- a missing-deps failure is legible (unchanged)
{
  for (const output of [
    "error: Cannot find module 'typebox'",
    "ModuleNotFoundError: No module named 'requests'",
    "sh: command not found: tsc",
    "error: Cannot find package '@sinclair/typebox'",
  ]) {
    assert(
      looksLikeMissingDeps(output),
      `recognised as a dependency problem: ${output.slice(0, 40)}`,
    );
  }
  for (const output of [
    "test-adversarial-verdict.ts: 3 assertions failed",
    "error[E0308]: mismatched types",
    "TS2345: Argument of type 'string' is not assignable",
  ]) {
    assert(
      !looksLikeMissingDeps(output),
      `canary: a REAL defect is not excused as a dependency problem: ${output.slice(0, 40)}`,
    );
  }
}

// ------------------ this repo's own develop gate runs the real §1 gate (unchanged)
{
  const { verifyCmdFor } = await import("../src/work-driver-verify-cmd.ts");
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const cmd = (await verifyCmdFor(repoRoot)) ?? "";

  assert(
    cmd !== "npm run test",
    "canary: this repo resolves to its own .pi/verify-cmd, not the three-test `npm run test` fallback",
  );
  assert(/tsc --noEmit/.test(cmd), "...and the gate typechecks");
  assert(/bun run check/.test(cmd), "...and lints");
  assert(/smoke-tests\/test-\*/.test(cmd), "...and runs the offline smoke suite");
  assert(/-live\.ts/.test(cmd), "...while excluding the live tests, as AGENTS.md §1 specifies");
}

// ------------- #481: pi-ensemble itself provisions without a hook (real repo probe)
{
  // Dogfood: `provisionWorktree` against THIS repo (hook wins if present,
  // else the symlink loop must link the nested `extension/node_modules`).
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const wt = mkdtempSync(path.join(tmpdir(), "wt-provision-"));
  try {
    const result = await provisionWorktree(realExecFn(), repoRoot, wt);
    const nestedLinked = result.linked.includes("node_modules");
    assert(
      result.via === "hook" || nestedLinked || result.problem !== undefined,
      "dogfood: pi-ensemble itself either provisions via hook, links extension/node_modules, OR reports a problem — it never claims a useful link it did not make",
    );
    if (nestedLinked) {
      assert(
        result.problem === undefined,
        "dogfood: a successfully-linked nested tree is not also a problem",
      );
      assert(
        await fs
          .access(path.join(wt, "extension", "node_modules"))
          .then(() => true)
          .catch(() => false),
        "dogfood: the link resolves inside the worktree at extension/node_modules",
      );
    }
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}

// --------------------- #533: a failed fetch must not abandon the mechanized path
{
  // Live #533: a failed `git fetch` must not abandon the mechanized path.
  // Local mainline created explicitly (init's default is runner-defined).
  const root = mkdtempSync(path.join(tmpdir(), "wt-provision-"));
  try {
    await initRepo(root, "node_modules/\n", { "package.json": "{}\n" });
    await pexec("git checkout -q -B main", { cwd: root, env: { ...process.env, HOME: root } });
    const runs: string[] = [];
    const execFn = async (cmd: string, opts: { cwd?: string; maxBuffer?: number }) => {
      runs.push(cmd);
      if (cmd.startsWith("git fetch")) throw new Error("Permission denied (publickey)");
      return pexec(cmd, { cwd: opts.cwd, maxBuffer: opts.maxBuffer ?? 64 * 1024 }).then((r) => ({
        stdout: r.stdout,
      }));
    };
    const setup = await mechanizedBranchSetup(
      execFn as never,
      root,
      533,
      [533],
      ["task-a"],
      "title",
    );
    assert(
      runs.some((c) => c.startsWith("git fetch")),
      "the fetch is attempted (a fresh origin/main is still preferred)",
    );
    assert(
      setup.baseSha.length === 40,
      "a failed fetch falls back to the LOCAL mainline ref — the mechanized path survives an SSH window instead of handing the branch step to ops",
    );
    assert(
      Object.values(setup.worktrees).length === 1,
      "...and the worktree is created by worktreeCreate, which provisions it (the hook/symlink path that the ops fallback skips)",
    );
    // #536 — provisions map is populated alongside worktrees.
    assert(
      ["hook", "symlink", "none"].includes(setup.provisions["task-a"]?.via ?? ""),
      "#536: mechanizedBranchSetup populates provisions with a valid via value",
    );
    // Neither resolvable: stub returns empty stdout for
    // `rev-parse --verify --quiet` (the code's contract for a missing ref).
    // No local `main`: switch to `trunk`, then `update-ref -d refs/heads/main`
    // (no-op if already absent — 32817064150 made this explicit). Self-asserted.
    const root2 = mkdtempSync(path.join(tmpdir(), "wt-provision-"));
    try {
      await initRepo(root2, "", {});
      const env2 = { ...process.env, HOME: root2 };
      await pexec("git checkout -q -b trunk HEAD", { cwd: root2, env: env2 });
      await pexec("git update-ref -d refs/heads/main", { cwd: root2, env: env2 });
      const mainRef = await pexec("git rev-parse --verify --quiet refs/heads/main", {
        cwd: root2,
        env: env2,
      })
        .then(() => "present")
        .catch(() => "absent");
      assert(
        mainRef === "absent",
        "fixture precondition: refs/heads/main is absent after the branch switch",
      );
      let threw = "";
      try {
        await mechanizedBranchSetup(
          (async (cmd: string, opts: { cwd?: string; maxBuffer?: number }) => {
            if (cmd.startsWith("git fetch")) throw new Error("Permission denied (publickey)");
            if (cmd.includes("rev-parse --verify --quiet")) return { stdout: "" };
            return pexec(cmd, { cwd: opts.cwd, maxBuffer: opts.maxBuffer ?? 64 * 1024 }).then(
              (r) => ({ stdout: r.stdout }),
            );
          }) as never,
          root2,
          533,
          [533],
          ["task-a"],
          "title",
        );
      } catch (e) {
        threw = (e as Error).message;
      }
      assert(
        threw.includes("could not resolve"),
        "no local mainline AND failed fetch: the throw is legible, not a raw git error",
      );
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
console.log(`\nexit ${exit}`);
process.exit(exit);
