#!/usr/bin/env bun
/**
 * Tests `worktree-provision.ts` #765 regression: the hook path VERIFIES
 * (not assumes) that provisioning actually linked something.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { provisionWorktree } from "../src/worktree-provision.ts";

const pexec = promisify(exec);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else { console.error(`✗ ${msg}`); exit = 1; }
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
  for (const [rel, c] of Object.entries(extraFiles)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, c);
  }
  const run = (...args: string[]) =>
    pexec(`git ${args.join(" ")}`, { cwd: root, env: { ...process.env, HOME: root } });
  await run("init", "-q");
  await run("config", "user.email", "test@example.com");
  await run("config", "user.name", "test");
  await run("add", "-A");
  await run("commit", "-q", "-m", "init");
}
function realExecFn(hookRuns?: string[]): (cmd: string, opts: { cwd?: string }) => Promise<{ stdout: string }> {
  const e = (cmd: string, cwd?: string) => pexec(cmd, { cwd }).then(({ stdout }) => ({ stdout }));
  return async (cmd: string, opts: { cwd?: string }) => {
    if (cmd.startsWith("sh ")) { hookRuns?.push(`${cmd} @ ${opts.cwd}`); return { stdout: "" }; }
    if (cmd.startsWith("git rev-parse")) return { stdout: ".git" };
    return e(cmd, opts.cwd);
  };
}
// -------------------------------------- #765: a hook that links NOTHING is not success
{
  const { root, wt } = fixture("w");
  try {
    // Fresh-clone shape: manifest present, no node_modules source.
    await initRepo(root, "node_modules/\n", { "package.json": "{\"name\": \"x\"}\n" });
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(path.join(root, ".pi", "worktree-setup"), "#!/bin/sh\nexit 0\n");
    mkdirSync(wt, { recursive: true });
    const runs: string[] = [];
    const result = await provisionWorktree(realExecFn(runs), root, wt);
    assert(result.problem !== undefined, "#765 strict: a no-op hook yields a `problem` (NOT an unqualified success)");
    assert(
      result.problem !== undefined &&
        (result.problem.includes("no non-empty dependency source") || result.problem.includes("no dependency source tree")),
      "#765 strict: the problem names the missing source tree",
    );
    assert(runs.length === 1 && runs[0]?.includes(wt), "the hook still RAN in the worktree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
// ------------ #765: a hook WITH a valid source that links (no false failure)
{
  // Custom execFn that actually RUNS the hook (realExecFn stubs `sh` calls).
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
    const execFn = async (cmd: string, opts: { cwd?: string; maxBuffer?: number }) => {
      if (cmd.startsWith("git rev-parse")) return { stdout: ".git" };
      return pexec(cmd, { cwd: opts.cwd, maxBuffer: opts.maxBuffer ?? 64 * 1024 }).then(
        (r) => ({ stdout: r.stdout }),
      );
    };
    const result = await provisionWorktree(execFn as never, root, wt);
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
  // RESOLVE to a non-empty directory.
  const { root, wt } = fixture("w");
  try {
    await initRepo(root, "node_modules/\n", { "package.json": "{\"name\": \"x\"}\n" });
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "worktree-setup"),
      `#!/bin/sh\nln -s ${path.join(root, "node_modules", "deleted-target")} ${path.join(wt, "node_modules")} || exit 1\n`,
    );
    // A valid source tree exists so the precondition does not also fire (we
    // want to isolate the stale-link detection).
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "marker"), "x");
    mkdirSync(wt, { recursive: true });
    const runs: string[] = [];
    const result = await provisionWorktree(realExecFn(runs), root, wt);
    assert(result.problem !== undefined, "#765 strict: a STALE (non-resolving) hook link yields a problem");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
console.log(`\nexit ${exit}`);
process.exit(exit);
