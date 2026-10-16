#!/usr/bin/env bun
/**
 * Smoke test: the preserve-then-clean seam itself (task-A scope of #1391).
 *
 * A lost step attempt left its edits in the worktree and the retry parked on
 * them. `cleanWorktreeForRetry` is the seam task B wires into the retry
 * branches; this file pins ITS contract:
 *
 *  - a dirty tree at the base is saved to a patch BEFORE it is reset away, and
 *    the tree is provably clean afterwards (`clean && !noop`);
 *  - a tree already clean at the base is a noop;
 *  - a tree with commits ahead of base is PRESERVED in place — never reset,
 *    tagged, or removed — and reported as not-clean;
 *  - a tree whose reset refuses is reported not-clean with a reason, and its
 *    dirt is still on disk (preserved, not destroyed);
 *  - an unsafe base ref never reaches a shell command.
 *
 * Real git on a real temp repo + real `git worktree add --detach`: the loss
 * inspection (`inspectWorktreeForLoss`) proves a directory is its own worktree
 * root ON DISK before it reads anything, so a stubbed executor cannot exercise
 * this seam at all. The end-to-end router scenario is task D's
 * test-work-driver-retry-tree-clean.ts.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/work-driver-verify.ts";
import { cleanWorktreeForRetry, retryTreeWorthPreserving } from "../src/worktree-retry-clean.ts";
import { ensureGitIdentity, gitIn } from "./lib/git-worktree-fixture.ts";

ensureGitIdentity();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const execFn = execp;
const root = await mkdtemp(path.join(tmpdir(), "retry-clean-1391-"));

function wtPath(name: string): string {
  return path.join(root, ".worktrees", name);
}
async function makeWorktree(name: string, base: string): Promise<string> {
  const p = wtPath(name);
  await mkdir(path.dirname(p), { recursive: true });
  gitIn(root, ["worktree", "add", "--detach", p, base]);
  return p;
}
const SCRATCH = path.join(root, "tmp", "issue-1391");
const clean = (name: string, base: string | undefined = BASE) =>
  cleanWorktreeForRetry({
    execFn,
    repoRoot: root,
    worktreePath: wtPath(name),
    base,
    scratchAbs: SCRATCH,
  });
const dirtyPaths = (wt: string): string[] =>
  gitIn(wt, ["status", "--porcelain"])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
/** What a retry's precondition sees: everything except the driver's OWN spared
 *  scratch dirs (`.pi/`, `tmp/`), which the clean deliberately leaves behind
 *  (RESET_CLEAN_ARGS) and a reposition guard must not read as attempt dirt. */
function retryVisibleDirt(wt: string): string[] {
  return dirtyPaths(wt).filter((l) => !/(^|[\s/"])\.pi\//i.test(l) && !/(^|[\s/"])tmp\//i.test(l));
}

// ---- fixture: a repo with one base commit
await mkdir(root, { recursive: true });
gitIn(root, ["init", "-q", "-b", "main"]);
await writeFile(path.join(root, "DESIGN.md"), "# design\n");
gitIn(root, ["add", "DESIGN.md"]);
gitIn(root, ["commit", "-qm", "base"]);
const BASE = gitIn(root, ["rev-parse", "HEAD"]);

// 1. A dirty tree at the base: saved first, then reset — and provably clean.
{
  const wt = await makeWorktree("issue-1391-dirty", BASE);
  await writeFile(path.join(wt, "DESIGN.md"), "# design — half written by the dead attempt\n");
  await writeFile(path.join(wt, "new-file.ts"), "export const x = 1;\n");
  const before = dirtyPaths(wt);
  assert(
    before.some((l) => l.includes("DESIGN.md")) && before.some((l) => l.includes("new-file.ts")),
    `fixture is dirty (${before.join(", ")})`,
  );

  const res = await clean("issue-1391-dirty");
  assert(
    res.clean === true && res.noop === false,
    `dirty tree reports clean (${res.reason ?? ""})`,
  );
  assert(
    typeof res.patch === "string" && res.patch.includes("issue-1391-dirty"),
    `patch path names the worktree (${res.patch})`,
  );
  assert(dirtyPaths(wt).length === 0, "the worktree IS clean afterwards");
  assert(
    existsSync(path.join(wt, "new-file.ts")) === false,
    "the untracked file is gone from the tree (it lives in the patch now)",
  );
  // The saved diff must still be recoverable and must name the dead attempt's work.
  let patchText = "";
  try {
    patchText = await (await import("node:fs/promises")).readFile(res.patch ?? "/dev/null", "utf8");
  } catch {
    /* reported below */
  }
  assert(patchText.includes("DESIGN.md"), "the saved patch carries the tracked edit");
  assert(patchText.includes("new-file.ts"), "the saved patch carries the untracked file");
  // Re-applying it to the reset tree proves nothing was lost.
  const reapply = await execFn("git", {
    cwd: wt,
    argv: ["apply", res.patch ?? "/dev/null"],
  }).then(
    () => "",
    (e: unknown) => String((e as Error)?.message ?? e),
  );
  assert(reapply === "", `the saved patch re-applies to the reset tree (${reapply})`);
}

// 2. Already clean at base: a noop, nothing touched.
{
  const wt = await makeWorktree("issue-1391-clean", BASE);
  const res = await clean("issue-1391-clean");
  assert(res.clean === true && res.noop === true, `clean tree is a noop (${res.reason ?? "-"})`);
  assert(res.patch === undefined, "a noop writes no patch");
  assert(dirtyPaths(wt).length === 0, "a clean tree stays clean");
}

// 2b. The driver's own scratch in the worktree survives the clean: `.pi/` and
//     `tmp/` are excluded from `git clean` (RESET_CLEAN_ARGS), so a cycle's
//     verify command and its notes are not swept away with the dead attempt's
//     edits — a retry that arrives to find its own scaffolding gone is a
//     second failure manufactured by the first fix.
{
  const wt = await makeWorktree("issue-1391-artefacts", BASE);
  await writeFile(path.join(wt, "DESIGN.md"), "# design — dirty\n");
  await mkdir(path.join(wt, ".pi"), { recursive: true });
  await writeFile(path.join(wt, ".pi", "verify-cmd"), "bun run gate\n");
  await mkdir(path.join(wt, "tmp", "issue-1391"), { recursive: true });
  await writeFile(path.join(wt, "tmp", "issue-1391", "notes.txt"), "attempt notes\n");

  const res = await clean("issue-1391-artefacts");
  assert(res.clean === true && res.noop === false, `dirty tree cleaned (${res.reason ?? ""})`);
  assert(
    retryVisibleDirt(wt).length === 0,
    `no attempt dirt remains (${retryVisibleDirt(wt).join(", ") || "none"})`,
  );
  assert(
    dirtyPaths(wt).every((l) => l.includes(".pi/") || l.includes("tmp/")),
    `only the spared driver directories are left (${dirtyPaths(wt).join(", ") || "none"})`,
  );
  assert(
    existsSync(path.join(wt, ".pi", "verify-cmd")),
    "the untracked .pi/ directory is spared — a clean must not delete the project's verify command",
  );
  assert(
    existsSync(path.join(wt, "tmp", "issue-1391", "notes.txt")),
    "the untracked tmp/ directory is spared — the cycle's scratch survives its own retry",
  );
}

// 3. Commits ahead of base: preserved in place, never reset.
{
  const wt = await makeWorktree("issue-1391-commits", BASE);
  await writeFile(path.join(wt, "committed.ts"), "export const kept = 1;\n");
  gitIn(wt, ["add", "committed.ts"]);
  gitIn(wt, ["commit", "-qm", "the attempt committed its work"]);
  const headBefore = gitIn(wt, ["rev-parse", "HEAD"]);

  const res = await clean("issue-1391-commits");
  assert(res.clean === false && res.noop === false, "commits ahead → not clean");
  assert((res.reason ?? "").includes("preserved in place"), `reason says preserved: ${res.reason}`);
  assert(gitIn(wt, ["rev-parse", "HEAD"]) === headBefore, "the commit is still on HEAD");
  assert(dirtyPaths(wt).length === 0, "the committed work is intact");
  assert(
    gitIn(root, ["tag", "--list", "pi-rukas-salvage/*"]) === "",
    "nothing here tags or removes the worktree — that is the removal path's job",
  );
}

// 4. A reset that refuses reports not-clean, and the dirt survives.
//    `index.lock` is git's own "another operation is in progress" gate: reads
//    keep working, `reset --hard` fails — the fail-closed shape.
{
  const wt = await makeWorktree("issue-1391-locked", BASE);
  await writeFile(path.join(wt, "DESIGN.md"), "# design — dirty\n");
  const gitdir = gitIn(wt, ["rev-parse", "--absolute-git-dir"]);
  await writeFile(path.join(gitdir, "index.lock"), "");
  const res = await clean("issue-1391-locked");
  await rm(path.join(gitdir, "index.lock"), { force: true });
  assert(res.clean === false, `a refused reset reports not-clean (${res.reason ?? "clean?!"})`);
  assert(typeof res.reason === "string" && res.reason.length > 0, "not-clean names a reason");
  assert(
    dirtyPaths(wt).some((l) => l.includes("DESIGN.md")),
    "the dirt is still on disk — preserved, not destroyed",
  );
}

// 5. A base that is not a plain ref never reaches a shell command.
{
  await makeWorktree("issue-1391-unsafe", BASE);
  const marker = path.join(root, "should-not-exist");
  const res = await clean("issue-1391-unsafe", `$(touch ${marker})`);
  assert(res.clean === false, `an unsafe base is refused (${res.reason})`);
  assert(!existsSync(marker), "the injected command never ran");
  assert(dirtyPaths(wtPath("issue-1391-unsafe")).length === 0, "the tree was left alone");
}

// 6. The preserve predicate follows the #475 rule.
assert(
  retryTreeWorthPreserving({
    path: wtPath("x"),
    uncommittedFiles: ["a.ts"],
    unpushedCommitCount: 0,
  }),
  "uncommitted files are worth preserving",
);
assert(
  retryTreeWorthPreserving({
    path: wtPath("x"),
    uncommittedFiles: [],
    unpushedCommitCount: 1,
  }),
  "commits ahead of base are worth preserving",
);
assert(
  !retryTreeWorthPreserving({
    path: wtPath("x"),
    uncommittedFiles: [],
    unpushedCommitCount: 0,
  }),
  "HEAD at base with a clean tree is not",
);

await rm(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
