/**
 * #1170 — a FOREIGN sibling worktree (not in any cycle set) that is clean but
 * holds a commit whose tree differs from the base is loss: `worktreeCreate`
 * must refuse it with a DirtyWorktreeError rather than force-remove it.
 * Split out of test-worktree-dirty-preremove.ts to keep that file under the
 * 500-line cap (AGENTS.md §12).
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DirtyWorktreeError, type ExecFn, worktreeCreate } from "../src/worktree.ts";

const execFileP = promisify(execFile);

const realExec: ExecFn = async (cmd, o) => {
  const opts = { cwd: o?.cwd, maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024 };
  const { stdout } = o?.argv
    ? await execFileP(cmd, o.argv, opts)
    : await execFileP("/bin/sh", ["-c", cmd], opts);
  return { stdout };
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    failures++;
    console.log(`✗ ${msg}`);
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1170-foreign-"));
try {
  const repo = path.join(root, "repo");
  await git(root, ["init", "-q", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const { stdout: baseOut } = await git(repo, ["rev-parse", "HEAD"]);
  const baseSha = baseOut.trim();

  const wt = path.join(repo, ".worktrees", "issue-475-default");
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, "a.txt"), "other\n");
  await git(wt, ["commit", "-q", "-am", "different tree"]);

  const refused = await worktreeCreate(realExec, {
    repoRoot: repo,
    name: "issue-475-integrate",
    fromRef: baseSha,
  }).then(
    () => undefined,
    (err: unknown) => err,
  );
  assert(
    refused instanceof DirtyWorktreeError && refused.finding.treeDiffers === true,
    "#1170: a foreign clean sibling with a different-tree commit refuses worktreeCreate (DirtyWorktreeError)",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("exit 0");
