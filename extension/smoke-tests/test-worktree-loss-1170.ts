/**
 * #1170 review round 1 — the no-loss rule (worktree-loss.ts) against real git:
 *  - a non-worktree directory is refused, never read as clean (its file survives)
 *  - ignored files are loss; ignored symlinks and regenerable dirs are not
 *  - a worktree behind the base (HEAD an ancestor of fromRef) is no-loss
 */
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
import { git, realExec } from "./lib/worktree-fake-fixture.ts";
import { refuseDirtyCycleTrees } from "../src/work-driver-integrate-cycle.ts";
import {
  DirtyWorktreeError,
  type ExecFn,
  inspectWorktreeForLoss,
  worktreeCreate,
  worktreeRemove,
} from "../src/worktree.ts";

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

  const addWt = async (name: string, ref = baseSha) => {
    const p = path.join(repo, ".worktrees", name);
    await git(repo, ["worktree", "add", "-q", "--detach", p, ref]);
    return p;
  };
  const inspect = (wt: string, ref = baseSha) => inspectWorktreeForLoss(realExec, repo, wt, ref);

  // 5. #1170 r3 — an ignored build/ entry is loss; a name alone exempts nothing.
  // #1642 narrowed the exemption to what git COLLAPSES to one directory line, so
  // this fixture keeps `build/` PARTLY tracked: git then enumerates the ignored
  // file inside it, and the original question (does the NAME `build/` exempt
  // nothing?) is still what is asked — an enumerated ignored file is loss.
  const bWt = await addWt("issue-9-build");
  mkdirSync(path.join(bWt, "build"), { recursive: true });
  writeFileSync(path.join(bWt, "build", "keep.txt"), "tracked\n");
  await git(bWt, ["add", "-f", "build/keep.txt"]);
  await git(bWt, ["commit", "-q", "-m", "track one file under build/"]);
  writeFileSync(path.join(bWt, "build", "credentials.env"), "TOKEN=1\n");
  const bFinding = await inspect(bWt);
  assert(
    bFinding?.uncommittedFiles.some((f) => f.includes("credentials.env")) === true,
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

  // 8. #1170 r3 — a large ignored tree is ONE entry, not one per file. #1642
  // exempts a COLLAPSED ignored directory from loss, so the bounded-output
  // property is now shown where git cannot collapse: a partly tracked target/
  // makes it enumerate every ignored file, and the guard still sees a bounded,
  // greppable set rather than the tree's contents being lost.
  const tWt = await addWt("issue-9-target");
  mkdirSync(path.join(tWt, "target"), { recursive: true });
  writeFileSync(path.join(tWt, "target", "keep.txt"), "tracked\n");
  await git(tWt, ["add", "-f", "target/keep.txt"]);
  await git(tWt, ["commit", "-q", "-m", "track one file under target/"]);
  for (let i = 0; i < 2000; i++) writeFileSync(path.join(tWt, "target", `f${i}.o`), "x");
  const tFinding = await inspect(tWt);
  assert(
    tFinding?.uncommittedFiles.length > 0 &&
      tFinding.uncommittedFiles.every((f) => f.includes("target")),
    "1170r3: an enumerated ignored target/ tree is loss and every entry names target/",
  );

  // 8b. #1642 — the collapsed form of that same tree is NOT loss: git declares
  // the whole directory ignored, so nothing tracked lives inside it.
  const cWt0 = await addWt("issue-9-target-clean");
  mkdirSync(path.join(cWt0, "target"), { recursive: true });
  for (let i = 0; i < 2000; i++) writeFileSync(path.join(cWt0, "target", `f${i}.o`), "x");
  assert(
    (await inspect(cWt0)) === undefined,
    "1642: a wholly ignored target/ tree (one collapsed entry) is no-loss",
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

  // 12. #1170 r3 — a ref outside the safe charset is a create error and runs no command.
  const marker = path.join(root, "pwned");
  const refCalls: string[] = [];
  const recordExec: ExecFn = async (cmd) => {
    refCalls.push(cmd);
    return { stdout: "" };
  };
  for (const badRef of [`$(touch ${marker})`, `\`touch ${marker}\``, "-x"]) {
    const refErr = await worktreeCreate(recordExec, {
      repoRoot: repo,
      name: "issue-9-argv",
      fromRef: badRef,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    assert(
      refErr instanceof Error &&
        !(refErr instanceof DirtyWorktreeError) &&
        /not a valid ref name/.test(refErr.message),
      `1170r3: base ref ${badRef} is rejected with a create error`,
    );
  }
  assert(
    refCalls.length === 0 && !existsSync(marker),
    "1170r3: a ref outside the safe charset runs no command",
  );

  // 13. #1170 r3 — a probe that times out fails closed: no worktree command runs.
  const calls: string[] = [];
  const timingOut: ExecFn = async (cmd) => {
    calls.push(cmd);
    if (cmd.includes("--quiet")) {
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

  // 14. #1642 (interactive #1557) — the ONLY dirt is an ignored build tree
  // (`!! dist/`, what `bun run build` regenerates). It is not unrecoverable
  // work: the worktree is reused/removed, not refused. This is the exact state
  // of `.worktrees/issue-1557-default`, which parked the cycle on
  // `step-failed:branch` with "1 uncommitted file(s): !! dist/".
  //
  // The ignored pattern and its one tracked file are set up on the BASE commit,
  // not after it: `git worktree add --detach` materialises tracked files only,
  // so a file tracked after the worktree's base is simply absent from it (and
  // the whole `dist/` then reads as untracked `??`, which is loss — correctly).
  writeFileSync(path.join(repo, ".gitignore"), ".env\nnode_modules\ndist/prompts\n");
  mkdirSync(path.join(repo, "dist"), { recursive: true });
  writeFileSync(path.join(repo, "dist", "keep.txt"), "tracked\n");
  await git(repo, ["add", "-f", "dist/keep.txt", ".gitignore"]);
  await git(repo, ["commit", "-q", "-m", "track one file under dist/, ignore dist/prompts"]);
  const distBase = await headOf(repo);
  const distWt = path.join(repo, ".worktrees", "issue-9-dist");
  await git(repo, ["worktree", "add", "-q", "--detach", distWt, distBase]);
  mkdirSync(path.join(distWt, "dist", "prompts", "standard"), { recursive: true });
  writeFileSync(path.join(distWt, "dist", "prompts", "standard", "explore.md"), "# x\n");
  const distFinding = await inspect(distWt, distBase);
  assert(
    distFinding === undefined,
    "1642: a worktree whose only dirt is an ignored dist/prompts is no-loss (reused, not refused)",
  );
  await worktreeRemove(realExec, repo, "issue-9-dist", true).catch(() => undefined);
  // The sibling scan (#545) inspects EVERY `issue-9-*` worktree, and the
  // fixtures above deliberately left dirty ones behind. They are the scan's
  // correct answer — and they would be reported for THIS worktree's create too,
  // hiding the thing this assertion is about. Remove them so the only candidate
  // left is the one this case is about.
  for (
    const stale of [
      "issue-9-build",
      "issue-9-vendor",
      "issue-9-nm",
      "issue-9-target",
      "issue-9-target-clean",
      "issue-9-multi",
      "issue-9-one",
      "issue-9-cycle",
      "issue-9-env",
      "issue-9-behind",
    ]
  ) {
    await worktreeRemove(realExec, repo, stale, true).catch(() => undefined);
  }
  await git(repo, ["worktree", "prune"]).catch(() => undefined);
  const distCreate = await worktreeCreate(realExec, {
    repoRoot: repo,
    name: "issue-9-dist",
    fromRef: distBase,
  }).then(
    () => true,
    (err: unknown) => err,
  );
  const distCreateMsg = String((distCreate as Error)?.message ?? "").slice(0, 200);
  assert(
    distCreate === true,
    `1642: worktreeCreate pre-removes the ignored-build-output worktree instead of refusing (${distCreateMsg})`,
  );

  // 15. #1642 — the exemption is for what git COLLAPSES to one directory line.
  // An enumerated ignored file inside the same partly tracked dist/ is still
  // loss: a secret never hides behind an exempted directory name.
  const secretWt = await addWt("issue-9-secret", distBase);
  mkdirSync(path.join(secretWt, "dist"), { recursive: true });
  writeFileSync(path.join(secretWt, "dist", "secret.env"), "TOKEN=1\n");
  const secretFinding = await inspect(secretWt, distBase);
  assert(
    secretFinding?.uncommittedFiles.some((f) => f.includes("secret.env")) === true,
    "1642: an enumerated ignored file inside dist/ is still loss",
  );

  // 16. #1642 — an untracked non-ignored file, and a tracked modification, are
  // still loss beside the ignored build output (the salvage path stays).
  const mixedWt = await addWt("issue-9-mixed", distBase);
  mkdirSync(path.join(mixedWt, "dist", "prompts"), { recursive: true });
  writeFileSync(path.join(mixedWt, "dist", "prompts", "bundle.md"), "x\n");
  writeFileSync(path.join(mixedWt, "work-in-progress.ts"), "export const x = 1;\n");
  const mixedFinding = await inspect(mixedWt, distBase);
  assert(
    mixedFinding?.uncommittedFiles.some((f) => f.includes("work-in-progress.ts")) === true &&
      !mixedFinding.uncommittedFiles.some((f) => f.includes("dist")),
    "1642: a real untracked file still refuses, and the ignored dist/ is not reported beside it",
  );
  const modWt = await addWt("issue-9-modified", distBase);
  writeFileSync(path.join(modWt, "a.txt"), "uncommitted edit\n");
  mkdirSync(path.join(modWt, "dist", "prompts"), { recursive: true });
  writeFileSync(path.join(modWt, "dist", "prompts", "cov.md"), "x\n");
  const modFinding = await inspect(modWt, distBase);
  assert(
    modFinding?.uncommittedFiles.some((f) => f.includes("a.txt")) === true &&
      !modFinding.uncommittedFiles.some((f) => f.includes("dist")),
    "1642: a tracked modification still refuses, whatever ignored trees sit beside it",
  );
  writeFileSync(path.join(repo, ".gitignore"), ".env\nnode_modules\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("exit 0");
