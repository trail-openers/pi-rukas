/**
 * #1170 review round 1 — the no-loss rule (worktree-loss.ts) against real git:
 *  - a non-worktree directory is refused, never read as clean (its file survives)
 *  - ignored files are loss; ignored symlinks and regenerable dirs are not
 *  - a worktree behind the base (HEAD an ancestor of fromRef) is no-loss
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { refuseDirtyCycleTrees } from "../src/work-driver-integrate-cycle.ts";
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
  // A tracked project manifest: node_modules directly inside it is regenerable.
  mkdirSync(path.join(repo, "pkg"), { recursive: true });
  writeFileSync(path.join(repo, "pkg", "package.json"), "{}\n");
  // A TRACKED vendor/ (git reports an all-ignored untracked dir collapsed, so
  // the vendor/.env case needs vendor/ to be partly tracked to see the file).
  mkdirSync(path.join(repo, "vendor"), { recursive: true });
  writeFileSync(path.join(repo, "vendor", "keep.txt"), "tracked\n");
  // Shared by every worktree: build/ and target/ are ignored, never exempt.
  writeFileSync(path.join(repo, ".git", "info", "exclude"), "build/\ntarget/\n");
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

  const addWt = async (name: string) => {
    const p = path.join(repo, ".worktrees", name);
    await git(repo, ["worktree", "add", "-q", "--detach", p, baseSha]);
    return p;
  };
  const inspect = (wt: string, ref = baseSha) => inspectWorktreeForLoss(realExec, repo, wt, ref);

  // 5. #1170 r3 — an ignored build/ entry is loss; a name alone exempts nothing.
  const bWt = await addWt("issue-9-build");
  mkdirSync(path.join(bWt, "build"), { recursive: true });
  writeFileSync(path.join(bWt, "build", "credentials.env"), "TOKEN=1\n");
  const bFinding = await inspect(bWt);
  assert(
    bFinding !== undefined && bFinding.uncommittedFiles.length > 0,
    "1170r3: an ignored build/ credentials file is loss",
  );

  // 6. #1170 r3 — an ignored vendor/.env FILE is loss (vendor/ is exempt only as a whole).
  const vWt = await addWt("issue-9-vendor");
  mkdirSync(path.join(vWt, "vendor"), { recursive: true });
  writeFileSync(path.join(vWt, "vendor", ".env"), "TOKEN=1\n");
  const vFinding = await inspect(vWt);
  assert(
    vFinding !== undefined && vFinding.uncommittedFiles.some((f) => f.includes(".env")),
    "1170r3: an ignored vendor/.env file is loss",
  );

  // 7. #1170 r3 — a root node_modules/ DIRECTORY (not a symlink) is no-loss.
  const nWt = await addWt("issue-9-nm");
  mkdirSync(path.join(nWt, "node_modules"), { recursive: true });
  writeFileSync(path.join(nWt, "node_modules", "x.js"), "//\n");
  assert(
    (await inspect(nWt)) === undefined,
    "1170r3: a root node_modules/ directory is no-loss",
  );

  // 8. #1170 r3 — a large ignored target/ tree is one collapsed entry (bounded output).
  const tWt = await addWt("issue-9-target");
  mkdirSync(path.join(tWt, "target"), { recursive: true });
  for (let i = 0; i < 2000; i++) writeFileSync(path.join(tWt, "target", `f${i}.o`), "x");
  const tFinding = await inspect(tWt);
  assert(
    tFinding !== undefined &&
      tFinding.uncommittedFiles.length === 1 &&
      (tFinding.uncommittedFiles[0] ?? "").includes("target"),
    "1170r3: an ignored target/ tree is one collapsed entry, not one per file",
  );

  // 9. #1170 r3 — add then remove leaves the tree identical, but two commits ahead → loss.
  const mWt = await addWt("issue-9-multi");
  writeFileSync(path.join(mWt, "x.txt"), "x\n");
  await git(mWt, ["add", "x.txt"]);
  await git(mWt, ["commit", "-q", "-m", "add x"]);
  await git(mWt, ["rm", "-q", "x.txt"]);
  await git(mWt, ["commit", "-q", "-m", "remove x"]);
  assert(
    (await inspect(mWt)) !== undefined,
    "1170r3: two tree-identical commits ahead of the base are loss",
  );

  // 10. One tree-identical develop commit (the downstream repro) is no-loss.
  const oWt = await addWt("issue-9-one");
  await git(oWt, ["commit", "-q", "--allow-empty", "-m", "empty develop"]);
  assert(
    (await inspect(oWt)) === undefined,
    "1170r3: one tree-identical commit ahead of the base is no-loss",
  );

  // 11. #1170 r3 — an in-cycle tree is never removed: an ignored target/ does not refuse.
  const cWt = await addWt("issue-9-cycle");
  mkdirSync(path.join(cWt, "target"), { recursive: true });
  writeFileSync(path.join(cWt, "target", "a.o"), "x");
  const integrateAbs = path.join(repo, ".worktrees", "integrate-none");
  const cycleOk = await refuseDirtyCycleTrees(realExec, [cWt], integrateAbs, repo, baseSha).then(
    () => true,
    (err: unknown) => err,
  );
  assert(cycleOk === true, "1170r3: an in-cycle tree with an ignored target/ does not refuse integration");
  writeFileSync(path.join(cWt, "stray.txt"), "x\n");
  const cycleRefused = await refuseDirtyCycleTrees(
    realExec,
    [cWt],
    integrateAbs,
    repo,
    baseSha,
  ).then(
    () => undefined,
    (err: unknown) => err,
  );
  assert(
    cycleRefused instanceof DirtyWorktreeError,
    "1170r3: an untracked file in an in-cycle tree still refuses",
  );

  // 12. #1170 r3 — a ref is argv data: a command substitution inside it never runs.
  const marker = path.join(root, "pwned");
  const badRef = await worktreeCreate(realExec, {
    repoRoot: repo,
    name: "issue-9-argv",
    fromRef: `$(touch ${marker})`,
  }).then(
    () => undefined,
    (err: unknown) => err,
  );
  assert(
    badRef !== undefined && !existsSync(marker),
    "1170r3: a ref containing $(...) is not shell-evaluated",
  );

  // 13. #1170 r3 — a probe that times out fails closed: no worktree command runs.
  const calls: string[] = [];
  const timingOut: ExecFn = async (cmd, o) => {
    calls.push(`${cmd} ${(o?.argv ?? []).join(" ")}`);
    if (o?.argv?.includes("--quiet")) {
      throw Object.assign(new Error("timed out"), { code: null, killed: true, signal: "SIGTERM" });
    }
    return { stdout: "" };
  };
  const probeErr = await worktreeCreate(timingOut, {
    repoRoot: repo,
    name: "issue-9-probe",
    fromRef: baseSha,
  }).then(
    () => undefined,
    (err: unknown) => err,
  );
  assert(
    probeErr instanceof Error &&
      !(probeErr instanceof DirtyWorktreeError) &&
      /did not complete/.test(probeErr.message) &&
      calls.every((c) => !c.includes("worktree")),
    "1170r3: a timed-out ref probe is a create error and runs no worktree command",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("exit 0");
