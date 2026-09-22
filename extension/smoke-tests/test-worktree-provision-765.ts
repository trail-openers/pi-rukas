#!/usr/bin/env bun
/**
 * #765 regression tests: `provisionWorktree` verifies hook/symlink outcomes
 * on the filesystem instead of assuming the hook's exit 0 recorded
 * provisioning. Strict-shape assertions only (no disjunctions).
 *
 * Separate file from test-worktree-provision.ts because that file is at its
 * 500-line budget; the fixture helpers below duplicate the two from the
 * main file — a small price for staying under the cap (AGENTS.md §12).
 */
import { exec } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { provisionWorktree } from "../src/worktree-provision.ts";

const pexec = promisify(exec);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function fixture(name: string): { root: string; wt: string } {
  const root = mkdtempSync(path.join(tmpdir(), "wt-provision-"));
  return { root, wt: path.join(root, ".worktrees", name) };
}

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
  const run = (...args: string[]) =>
    pexec(`git ${args.join(" ")}`, { cwd: root, env: { ...process.env, HOME: root } });
  await run("init", "-q");
  await run("config", "user.email", "test@example.com");
  await run("config", "user.name", "test");
  await run("add", "-A");
  await run("commit", "-q", "-m", "init");
}

/**
 * An `execFn` that runs REAL git (the probe needs its three-state exit code
 * via `err.code`), with `sh <hook>` calls stubbed when `hookRuns` is given.
 */
function realExecFn(
  hookRuns?: string[],
): (cmd: string, opts: { cwd?: string }) => Promise<{ stdout: string }> {
  const e = (cmd: string, cwd?: string) => pexec(cmd, { cwd }).then(({ stdout }) => ({ stdout }));
  return async (cmd: string, opts: { cwd?: string }) => {
    if (cmd.startsWith("sh ")) {
      hookRuns?.push(`${cmd} @ ${opts.cwd}`);
      return { stdout: "" };
    }
    if (cmd.startsWith("git rev-parse")) return { stdout: ".git" };
    return e(cmd, opts.cwd);
  };
}

/**
 * An `execFn` that runs EVERYTHING for real (including `sh <hook>`), so a
 * fixture hook that actually creates a symlink exercises the post-hook
 * verification against real filesystem state.
 */
function liveExecFn(): (
  cmd: string,
  opts: { cwd?: string; maxBuffer?: number },
) => Promise<{ stdout: string }> {
  return async (cmd, opts) =>
    pexec(cmd, { cwd: opts.cwd, maxBuffer: opts.maxBuffer ?? 64 * 1024 }).then((r) => ({
      stdout: r.stdout,
    }));
}

// -------------------------------------- #765: a hook that links NOTHING is not success
{
  // The #761 incident: the hook's exit 0 was recorded as `hook-ran` even when
  // it linked nothing. Post-#765 the hook path VERIFIES the filesystem: a
  // no-op hook (exit 0, nothing linked) yields a `problem` (the precondition,
  // fork-A: fresh clone — a manifest present, no source tree), which the
  // event factory maps to `hook-failed` — never an unqualified `hook-ran`.
  const { root, wt } = fixture("w");
  try {
    await initRepo(root, "node_modules/\n", { "package.json": "{\"name\": \"x\"}\n" });
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(path.join(root, ".pi", "worktree-setup"), "#!/bin/sh\nexit 0\n");
    mkdirSync(wt, { recursive: true });

    const runs: string[] = [];
    const result = await provisionWorktree(realExecFn(runs), root, wt);

    assert(
      result.problem !== undefined,
      "#765 strict: a hook that exits 0 having linked nothing yields a `problem` (NOT an unqualified success)",
    );
    assert(
      result.problem?.includes("no non-empty dependency source") === true,
      "#765 strict: the precondition (source absent/empty) is named in the problem",
    );
    assert(
      runs.length === 1 && runs[0]?.includes(wt),
      "the hook still RAN in the worktree (the deliberate exit-0 branch is untouched)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------ #765: a hook that links the expected tree is NOT a problem (no false failure)
{
  // Guard against the verification over-firing: when the source tree exists
  // and the hook links it, the strict check must PASS (no problem), not
  // report a false `hook-failed`. The hook runs for real here (liveExecFn)
  // so the link it creates is real filesystem state.
  const { root, wt } = fixture("w");
  try {
    await initRepo(root, "node_modules/\n", { "package.json": "{\"name\": \"x\"}\n" });
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "worktree-setup"),
      `#!/bin/sh\nln -s ${path.join(root, "node_modules")} ${path.join(wt, "node_modules")} || exit 1\n`,
    );
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "marker"), "x");
    mkdirSync(wt, { recursive: true });

    const result = await provisionWorktree(liveExecFn(), root, wt);

    assert(result.problem === undefined, "#765 strict: a hook that linked the expected tree is NOT a problem");
    assert(
      await fs
        .readFile(path.join(wt, "node_modules", "marker"), "utf8")
        .then((s) => s === "x")
        .catch(() => false),
      "...and the link the hook made actually resolves to the source",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------- #765: a STALE hook symlink is caught
{
  // The AC names this explicitly: "exists" is not enough — a stale symlink
  // pointing at a since-deleted tree must be caught, because the check must
  // RESOLVE to a non-empty directory. A valid source tree exists so the
  // precondition does not also fire (isolating the stale-link detection).
  const { root, wt } = fixture("w");
  try {
    await initRepo(root, "node_modules/\n", { "package.json": "{\"name\": \"x\"}\n" });
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "worktree-setup"),
      `#!/bin/sh\nln -s ${path.join(root, "node_modules", "deleted-target")} ${path.join(wt, "node_modules")} || exit 1\n`,
    );
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "marker"), "x");
    mkdirSync(wt, { recursive: true });

    const result = await provisionWorktree(liveExecFn(), root, wt);

    assert(result.problem !== undefined, "#765 strict: a hook that left a STALE (non-resolving) link yields a problem");
    assert(
      result.problem?.includes("exited 0") === true,
      "...and it is named as a no-op hook (the link did not resolve non-empty)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --------------------- #765: the SYMLINK path also verifies its links
{
  // A bare worktree for a deps-expected project (no hook, no source tree):
  // nothing is linked, and the #481 precondition (deps expected, no findable
  // tree) names it. Pins that a bare/failed symlink path NEVER reads as
  // success — the `linked`-extraction half of the verification is exercised
  // in production whenever the source disappears between scan and verify.
  const { root, wt } = fixture("w");
  try {
    await initRepo(root, "node_modules/\n", { "package.json": "{\"name\": \"x\"}\n" });
    mkdirSync(wt, { recursive: true });
    const result = await provisionWorktree(realExecFn(), root, wt);
    assert(
      !result.linked.includes("node_modules"),
      "#765 strict: the symlink path never reports a link that does not resolve to a non-empty directory",
    );
    assert(
      result.problem !== undefined && result.problem.includes("no dependency tree"),
      "#765 strict: a bare worktree for a deps-expected project is recorded as a `problem`, not silence",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
