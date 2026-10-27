#!/usr/bin/env bun
/**
 * #1849 — the revert's commit carries the revert's own paths and nothing else.
 *
 * The revert used to end in a bare `git commit` with no pathspec, which commits
 * **whatever the index holds**. The index is not the revert's property: a develop
 * gate, a corrective round or an earlier step can leave content staged, and then
 * it ships inside a commit whose subject says "revert out-of-fence fix-pass
 * files" — a driver commit that quietly lands someone else's work, under a
 * message that says the opposite. Reproduced before the fix: with one foreign
 * file pre-staged, `git show --name-only` of the revert commit listed
 * `[helper.ts, pre-staged-by-somebody-else.ts]`.
 *
 * The bound is a temporary index (`GIT_INDEX_FILE`, passed through the executor's
 * `env` option) seeded from HEAD and staged with only the revert's paths, so the
 * real index is never opened for writing. Two properties, one per case below:
 *
 *   1. FOREIGN STAGED CONTENT DOES NOT RIDE ALONG — and the pre-staged file is
 *      still staged afterwards, i.e. the revert did not steal it or destroy it;
 *   2. A STRAY ALREADY STAGED BY SOMEBODY ELSE still reverts correctly (the
 *      staged content is not what the commit records — the `headBefore` content
 *      is), which is the case a working-tree preflight check could not see.
 *
 * Both assert against real git, because the guarantee is about what a later
 * reader of the branch sees.
 */

import { existsSync, writeFileSync } from "node:fs";
import { runGit, type GitExec } from "../src/work-develop-git.ts";
import { execp } from "../src/exec.ts";
import { fixPassStraysIndexPath } from "../src/work-driver-fix-pass-strays-commit.ts";
import { revertFixPassStrays } from "../src/work-driver-fix-pass-strays.ts";
import { git, passTreeAt } from "./lib/adversarial-fix-fixtures.ts";

const gitExec: GitExec = runGit(execp);

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Every path one commit touches, as git reports it. */
const commitFiles = (worktree: string, rev: string): string[] =>
  git(worktree, `show --name-only --format= ${rev}`)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

const req = (
  t: { repoRoot: string; worktree: string; headBefore: string },
  strays: string[],
  untracked: string[],
) => ({
  git: gitExec,
  worktree: t.worktree,
  // #1849 item 7 — the recorded tree matches the tree under test; every case in
  // this file is about its own rule, and the mismatch/refusal cases are
  // `test-fix-pass-strays-worktree.ts`. Absent here would fail every case on the
  // target gate instead.
  recordedWorktree: t.worktree,
  repoRoot: t.repoRoot,
  issue: 1846,
  workstreamId: "default",
  attempt: 1,
  headBefore: t.headBefore,
  strays,
  untracked: new Set(untracked),
  scratchDir: `${t.repoRoot}/tmp/issue-1846`,
});

console.log("# a pre-staged file that is NOT a stray never enters the revert commit");
{
  const t = passTreeAt("1846-bounded");
  // Content in the index that belongs to no stray: what a develop gate, a
  // corrective round or a previous step can leave staged.
  writeFileSync(`${t.worktree}/pre-staged-by-somebody-else.ts`, "export const leak = 1;\n");
  git(t.worktree, "add -A -- pre-staged-by-somebody-else.ts");
  // And a pre-existing tracked file staged at modified content, i.e. a second
  // shape of "the index holds things the revert did not stage".
  git(t.worktree, "add -A -- b.txt");

  const res = await revertFixPassStrays(req(t, ["helper.ts"], []));
  if ("reason" in res) {
    assert(false, `the revert succeeded — it refused: ${res.reason}`);
  } else {
    const files = commitFiles(t.worktree, "HEAD");
    assert(
      !files.includes("pre-staged-by-somebody-else.ts"),
      `the pre-staged non-stray is NOT in the revert commit (${JSON.stringify(files)})`,
    );
    assert(
      !files.includes("b.txt"),
      `a path the revert was not given is NOT in it either (${JSON.stringify(files)})`,
    );
    assert(
      files.includes("helper.ts"),
      `and the stray IS — the bounding did not drop the thing the commit is for (${JSON.stringify(files)})`,
    );
    // Not committed is not the same as destroyed: the operator's staged work
    // must still be there, staged, when the revert finishes.
    const stillStaged = git(t.worktree, "diff --cached --name-only")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    assert(
      stillStaged.includes("pre-staged-by-somebody-else.ts"),
      `the pre-staged file is STILL STAGED — the revert left the index as it found it (${JSON.stringify(stillStaged)})`,
    );
    assert(
      existsSync(`${t.worktree}/pre-staged-by-somebody-else.ts`),
      "and it is still on disk, byte for byte",
    );
  }
}

console.log("# a stray someone else already staged still reverts to headBefore content");
{
  // The case a "refuse if the index names anything outside the strays" preflight
  // cannot see: the staged entry IS a stray, so the check passes, and the commit
  // would then record the STAGED (out-of-fence) content rather than the restored
  // one. Read what the commit actually holds.
  const t = passTreeAt("1846-bounded-staged-stray");
  git(t.worktree, "add -A -- b.txt"); // b.txt is staged at its HIJACKED content
  const res = await revertFixPassStrays(req(t, ["b.txt"], []));
  if ("reason" in res) {
    assert(false, `the revert succeeded — it refused: ${res.reason}`);
  } else {
    assert(
      git(t.worktree, `show HEAD:b.txt`) === "one\n",
      `the commit records the headBefore content, not the staged hijack (${JSON.stringify(git(t.worktree, `show HEAD:b.txt`))})`,
    );
  }
}

console.log("# the temporary index is gated to the scratch dir and cleaned up");
{
  const t = passTreeAt("1846-bounded-tmpindex");
  const p = fixPassStraysIndexPath(`${t.repoRoot}/tmp/issue-1846`, 1846, "default", 1);
  assert(p.startsWith(`${t.repoRoot}/tmp/issue-1846/`), "it lives inside the scratch dir");
  // A workstream id carrying traversal cannot reach outside the scratch dir — the
  // same grammar `retryPatchPath` enforces for the patch.
  let refused = "";
  try {
    fixPassStraysIndexPath(`${t.repoRoot}/tmp/issue-1846`, 1846, "../escape", 1);
  } catch (err) {
    refused = String((err as Error).message);
  }
  assert(
    /not a plain name/.test(refused),
    `a traversal workstream id is refused by name (${JSON.stringify(refused)})`,
  );
  const res = await revertFixPassStrays(req(t, ["helper.ts"], []));
  assert(!("reason" in res), `the revert succeeded (${JSON.stringify(res).slice(0, 120)})`);
  assert(
    !existsSync(p),
    "the temporary index file is removed after the commit — no residue in the scratch dir",
  );
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
