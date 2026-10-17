/**
 * #1170 round 4 — every ref that reaches a shell string is validated first, and
 * an unresolved ref deletes nothing (real git):
 *  - inspectWorktreeForLoss with a shell-expanding fromRef is refused as an
 *    unreadable worktree, and the injected command never runs;
 *  - worktreeCreate with an unresolvable (safe-charset) fromRef returns before
 *    the pre-remove: the dirty worktree at the target path keeps its file and
 *    stays registered, and `git worktree add` refuses the path.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectWorktreeForLoss, worktreeCreate } from "../src/worktree.ts";
import { git, realExec } from "./lib/worktree-fake-fixture.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    failures++;
    console.log(`✗ ${msg}`);
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1170-refs-"));
try {
  const repo = path.join(root, "repo");
  await git(root, ["init", "-q", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();

  // 1. An unsafe fromRef never reaches a shell: refused, nothing created.
  const wt = path.join(repo, ".worktrees", "issue-5-a");
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  const pwned = path.join(root, "pwned");
  const finding = await inspectWorktreeForLoss(realExec, repo, wt, `$(touch ${pwned})`);
  assert(
    finding !== undefined && typeof finding.inspectError === "string",
    "1170r4: an unsafe fromRef is refused as an unreadable worktree (fail closed)",
  );
  assert(!existsSync(pwned), "1170r4: the shell-expanding ref never runs its command");

  // 2. Unresolved ref + dirty worktree at the target path: no deletion.
  writeFileSync(path.join(wt, "dirty.txt"), "precious\n");
  const createErr = await worktreeCreate(realExec, {
    repoRoot: repo,
    name: "issue-5-a",
    fromRef: "no-such-ref-1170",
  }).then(
    () => undefined,
    (err: unknown) => err,
  );
  assert(createErr instanceof Error, "1170r4: an unresolved ref fails worktreeCreate");
  assert(
    readFileSync(path.join(wt, "dirty.txt"), "utf8") === "precious\n",
    "1170r4: the dirty file at the target path survives an unresolved ref",
  );
  const list = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
  assert(list.includes(wt), "1170r4: the worktree is still registered after the failed create");
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall ref-validation assertions passed");
