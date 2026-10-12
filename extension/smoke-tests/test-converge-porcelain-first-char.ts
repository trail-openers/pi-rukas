/**
 * #1190 — the converge gate's uncommitted-path read must not lose
 * the first character of a path. A ` M path` record (unstaged edit) starts
 * with a space; trimming the line before dropping the three-character status
 * prefix turned `install.sh` into `nstall.sh`, so a present deliverable read
 * as absent. Runs against a real repository so the record shape is git's own.
 */
import { exec, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readEndOfDevelopDiff } from "../src/work-driver-converge.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const execp = promisify(exec);
const repo = mkdtempSync(path.join(tmpdir(), "converge-porcelain-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
try {
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  mkdirSync(path.join(repo, "lib"));
  writeFileSync(path.join(repo, "install.sh"), "one\n");
  writeFileSync(path.join(repo, "lib/config.sh"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "seed");
  // Unstaged edits only: every record is ` M <path>`.
  writeFileSync(path.join(repo, "install.sh"), "two\n");
  writeFileSync(path.join(repo, "lib/config.sh"), "two\n");
  writeFileSync(path.join(repo, "new file.sh"), "new\n");

  const base = initialState(9930, Date.now());
  const state = {
    ...base,
    pipelineState: { ...base.pipelineState, worktrees: { default: "repoRoot" } },
  };
  const { files, unreadable } = await readEndOfDevelopDiff(
    (cmd, opts) => execp(cmd, opts as { cwd?: string }),
    state,
    repo,
  );
  assert(!unreadable, "the worktree is readable");
  assert(files.has("install.sh"), "first ` M` record keeps its first character (install.sh)");
  assert(files.has("lib/config.sh"), "later ` M` record keeps its first character");
  assert(files.has("new file.sh"), "a quoted untracked path is unquoted");
  assert(
    ![...files].some((f) => f === "nstall.sh" || f === "ib/config.sh"),
    "no truncated path is reported",
  );
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
