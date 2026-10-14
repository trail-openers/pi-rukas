/**
 * #1170 review round 1 — the no-loss rule (worktree-loss.ts) against real git:
 *  - a non-worktree directory is refused, never read as clean (its file survives)
 *  - ignored files are loss; ignored symlinks and regenerable dirs are not
 *  - a worktree behind the base (HEAD an ancestor of fromRef) is no-loss
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  DirtyWorktreeError,
  type ExecFn,
  inspectWorktreeForLoss,
  worktreeCreate,
} from "../src/worktree.ts";

const execFileP = promisify(execFile);

const realExec: ExecFn = async (cmd, o) => {
  const opts = { cwd: o?.cwd, maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024 };
  const { stdout } = o?.argv
    ? await execFileP(cmd, o.argv, opts)
    : await execFileP("/bin/sh", ["-c", cmd], opts);
  return { stdout };
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const headOf = async (cwd: string) => (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    failures++;
    console.log(`✗ ${msg}`);
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1170-loss-"));
try {
  const repo = path.join(root, "repo");
  await git(root, ["init", "-q", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  writeFileSync(path.join(repo, ".gitignore"), ".env\nnode_modules\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = await headOf(repo);

  // 1. A plain directory under .worktrees: git walks up to the parent repo.
  const plain = path.join(repo, ".worktrees", "issue-9-x");
  mkdirSync(plain, { recursive: true });
  writeFileSync(path.join(plain, "keep.txt"), "precious\n");
  const plainFinding = await inspectWorktreeForLoss(realExec, repo, plain, baseSha);
  assert(
    plainFinding !== undefined && plainFinding.notOwnWorktree === true,
    "1170: a non-worktree directory is refused, not read as clean",
  );
  const plainRefused = await worktreeCreate(realExec, {
    repoRoot: repo,
    name: "issue-9-x",
    fromRef: baseSha,
  }).then(
    () => undefined,
    (err: unknown) => err,
  );
  assert(plainRefused instanceof DirtyWorktreeError, "1170: worktreeCreate refuses the plain dir");
  assert(
    readFileSync(path.join(plain, "keep.txt"), "utf8") === "precious\n",
    "1170: the plain directory's file survives the refusal",
  );
  rmSync(plain, { recursive: true, force: true });

  // 2. Ignored .env in a tree-identical clean worktree → loss.
  const envWt = path.join(repo, ".worktrees", "issue-9-env");
  await git(repo, ["worktree", "add", "-q", "--detach", envWt, baseSha]);
  writeFileSync(path.join(envWt, ".env"), "SECRET=1\n");
  const envFinding = await inspectWorktreeForLoss(realExec, repo, envWt, baseSha);
  assert(
    envFinding !== undefined && envFinding.uncommittedFiles.some((f) => f.includes(".env")),
    "1170: an ignored .env in a tree-identical worktree is loss",
  );

  // 3. Only an ignored node_modules symlink and regenerable dir → no-loss.
  rmSync(path.join(envWt, ".env"));
  symlinkSync(repo, path.join(envWt, "node_modules"));
  mkdirSync(path.join(envWt, "pkg", "node_modules"), { recursive: true });
  writeFileSync(path.join(envWt, "pkg", "node_modules", "x.js"), "//\n");
  writeFileSync(path.join(envWt, ".gitignore"), ".env\nnode_modules\n");
  const linkFinding = await inspectWorktreeForLoss(realExec, repo, envWt, baseSha);
  assert(
    linkFinding === undefined,
    "1170: ignored symlink and regenerable dirs are not loss (tree-identical → no-loss)",
  );

  // 4. Clean worktree behind a base that advanced → no-loss.
  const behindWt = path.join(repo, ".worktrees", "issue-9-behind");
  await git(repo, ["worktree", "add", "-q", "--detach", behindWt, baseSha]);
  writeFileSync(path.join(repo, "a.txt"), "advanced\n");
  await git(repo, ["commit", "-q", "-am", "advance main"]);
  const newBase = await headOf(repo);
  const behindFinding = await inspectWorktreeForLoss(realExec, repo, behindWt, newBase);
  assert(behindFinding === undefined, "1170: clean worktree behind the base is no-loss");
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("exit 0");
