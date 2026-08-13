#!/usr/bin/env bun
/**
 * Our own scaffolding must never look like the developer's work.
 *
 * `provisionWorktree` symlinks `node_modules` (and `.venv`, `vendor`) into each
 * worktree so the project's verify command can run there. But a `.gitignore`
 * entry of `node_modules/` — the trailing-slash form, which is what both this
 * repo and every project measured actually use — matches a **directory**. A
 * symlink is not a directory, so the pattern does not match it and
 * `git status --porcelain` reports `?? node_modules`.
 *
 * `stagePorcelainPaths` stages every path porcelain lists. So the link was
 * staged, captured into the patch as an absolute-path `mode 120000` entry, and
 * `git apply` at repoRoot failed:
 *
 *     error: unable to write file 'node_modules' mode 120000: Directory not empty
 *
 * — aborting mechanized integration on every Node or Python project and falling
 * back to the LLM ops dispatch. Where repoRoot happened NOT to have the
 * directory, it would instead have committed a machine-specific absolute path
 * into the PR.
 *
 * Two independent defences, because they fail in different circumstances:
 *
 *   1. `provisionWorktree` writes the link names to `$GIT_COMMON_DIR/info/exclude`.
 *      Verified empirically: a linked worktree reads the COMMON dir's exclude
 *      file; `$GIT_DIR/info/exclude` (which resolves to
 *      `.git/worktrees/<name>/info/exclude`) is ignored by git entirely.
 *      This one does nothing for worktrees provisioned before it shipped.
 *   2. `stagePorcelainPaths` refuses to stage a symlink pointing outside the
 *      worktree. This holds regardless of the project's .gitignore style, and
 *      it protects worktrees that already exist on disk.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stagePorcelainPaths } from "../src/work-driver-stage.ts";
import { provisionWorktree } from "../src/worktree-provision.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const root = mkdtempSync(path.join(tmpdir(), "pi-ens-symlink-"));

/** A repo using the trailing-slash ignore form, plus one detached worktree. */
async function fixture(name: string) {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "node_modules"), { recursive: true });
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  // The form that causes the bug, and the form real projects use.
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(repo, "src.txt"), "base\n");
  writeFileSync(path.join(repo, "node_modules", "dep.js"), "module.exports={}\n");
  await git(repo, ["add", ".gitignore", "src.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const wt = path.join(root, `${name}-wt`);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, "HEAD"]);
  return { repo, wt };
}

try {
  // ------- the premise: a trailing-slash ignore does NOT cover a symlink
  {
    const { repo, wt } = await fixture("premise");
    symlinkSync(path.join(repo, "node_modules"), path.join(wt, "node_modules"), "dir");
    const { stdout } = await git(wt, ["status", "--porcelain"]);
    assert(
      stdout.includes("node_modules"),
      `canary premise: \`node_modules/\` does NOT ignore the symlink (porcelain: ${JSON.stringify(stdout.trim())})`,
    );
  }

  // ------------------- the sink refuses to stage an escaping symlink
  {
    const { repo, wt } = await fixture("sink");
    symlinkSync(path.join(repo, "node_modules"), path.join(wt, "node_modules"), "dir");
    writeFileSync(path.join(wt, "src.txt"), "developer edit\n");

    const n = await stagePorcelainPaths(realExec, wt);
    const { stdout: cached } = await git(wt, ["diff", "--cached", "--name-only"]);
    const names = cached.split("\n").filter(Boolean);

    assert(
      !names.includes("node_modules"),
      `canary: the escaping symlink is NOT staged (staged: ${JSON.stringify(names)})`,
    );
    assert(names.includes("src.txt"), "...while the developer's real edit still is");
    assert(
      n === names.length,
      `the returned count matches what was staged (${n} vs ${names.length})`,
    );

    // The count is load-bearing: `integrate()` treats 0 as "this developer
    // wrote nothing" and refuses to ship a partial consolidation. If the
    // symlink were counted, a worktree containing ONLY scaffolding would look
    // like real work.
    const { wt: empty } = await fixture("sink-empty");
    symlinkSync(
      path.join(root, "sink-empty", "node_modules"),
      path.join(empty, "node_modules"),
      "dir",
    );
    assert(
      (await stagePorcelainPaths(realExec, empty)) === 0,
      "canary: a worktree containing ONLY the scaffolding link counts as empty, not as work",
    );
  }

  // ------------- a symlink INSIDE the worktree is ordinary source
  {
    const { wt } = await fixture("inner");
    writeFileSync(path.join(wt, "real.txt"), "target\n");
    symlinkSync(path.join(wt, "real.txt"), path.join(wt, "alias.txt"));
    await stagePorcelainPaths(realExec, wt);
    const { stdout } = await git(wt, ["diff", "--cached", "--name-only"]);
    assert(
      stdout.includes("alias.txt"),
      "a symlink pointing INSIDE the worktree is still staged — that is legitimate source",
    );
  }

  // --------------- the source: provisioning hides its own links
  {
    const { repo, wt } = await fixture("source");
    const res = await provisionWorktree(realExec, repo, wt);
    assert(
      res.linked.includes("node_modules"),
      `provisioning linked node_modules (via ${res.via})`,
    );
    const { stdout } = await git(wt, ["status", "--porcelain"]);
    assert(
      !stdout.includes("node_modules"),
      `canary: after provisioning, git does not see the link (porcelain: ${JSON.stringify(stdout.trim())})`,
    );
    // It must land in the COMMON dir — $GIT_DIR/info/exclude is ignored by git
    // for a linked worktree, which is the trap this fix had to avoid.
    const { stdout: common } = await git(wt, ["rev-parse", "--git-common-dir"]);
    const { readFileSync } = await import("node:fs");
    const excl = readFileSync(path.resolve(wt, common.trim(), "info", "exclude"), "utf8");
    assert(
      /^node_modules$/m.test(excl),
      "...via $GIT_COMMON_DIR/info/exclude, with no trailing slash so it matches the symlink",
    );

    // Idempotent: provisioning twice must not duplicate the entry.
    await provisionWorktree(realExec, repo, wt);
    const again = readFileSync(path.resolve(wt, common.trim(), "info", "exclude"), "utf8");
    assert(
      (again.match(/^node_modules$/gm) ?? []).length === 1,
      "re-provisioning does not duplicate the exclude entry",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
