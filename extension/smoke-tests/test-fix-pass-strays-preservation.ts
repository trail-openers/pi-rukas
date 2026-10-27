#!/usr/bin/env bun
/**
 * #1849 — preservation is written before the ref, and the attempt counter scans
 * the namespace it actually owns.
 *
 * Three rules, one per case, each of which is a way a revert can delete content
 * with nothing left to recover it:
 *
 *   1. ORDER. The patch is written (`wx`) BEFORE `update-ref` creates the ref.
 *      Both writes are non-destructive, so the only thing an order can cost is a
 *      record — and the previous order created the ref first, so any failure after
 *      it (the `wx` write is the one with real ways to fail: an existing file, an
 *      unwritable scratch dir, ENOSPC mid-write) left a
 *      `refs/pi-rukas/fix-pass-strays/...` pointing at a tree the driver never
 *      reverted. Somebody later reads that ref as the record of a revert that did
 *      not happen. A failure after the ref must also delete the ref again.
 *
 *   2. COUNTER SCOPE. `nextStrayAttempt` takes the max over BOTH halves of its own
 *      namespace — the patches `fix-pass-strays-<issue>-<id>-N.patch` AND the refs
 *      `refs/pi-rukas/fix-pass-strays/<issue>-<id>-N`. Reading only the patch
 *      directory lets a revert pick an N whose ref already exists from an attempt
 *      that died before writing its patch, and `update-ref` then overwrites the
 *      only git-visible record of what that revert deleted.
 *
 *   3. THE GUARD MEASURES PRESERVATION, NOT PATCH LENGTH. The "nothing to
 *      preserve" refusal is based on whether each PRESENT stray is covered by a
 *      non-empty patch or by an untracked copy that will be taken — not on the
 *      patch being non-empty or `present` being non-empty, the two readings that
 *      each pass on their own and neither of which says anything about the paths
 *      the revert is about to delete.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runGit, type GitExec } from "../src/work-develop-git.ts";
import { execp } from "../src/exec.ts";
import {
  fixPassStraysRef,
  nextStrayAttempt,
  revertFixPassStrays,
} from "../src/work-driver-fix-pass-strays.ts";
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

const req = (
  t: { repoRoot: string; worktree: string; headBefore: string },
  strays: string[],
  untracked: string[],
  attempt = 1,
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
  attempt,
  headBefore: t.headBefore,
  strays,
  untracked: new Set(untracked),
  scratchDir: `${t.repoRoot}/tmp/issue-1846`,
});

console.log("# the counter reads the ref namespace as well as the patch dir");
{
  const t = passTreeAt("1846-order-counter");
  const scratch = `${t.repoRoot}/tmp/issue-1846`;
  // The shape an aborted preservation leaves: a ref at 3, no patch at 3.
  git(t.worktree, `update-ref ${fixPassStraysRef(1846, "default", 3)} HEAD`);
  const blind = await nextStrayAttempt(scratch, 1846, "default");
  const both = await nextStrayAttempt(scratch, 1846, "default", gitExec, t.worktree);
  assert(
    both === 4,
    `the max covers refs AND patches, so the next attempt avoids the ref that exists (${both})`,
  );
  assert(
    blind < both,
    `and the patch-dir-only reading would have collided (${blind}) — this is the argument for passing the transport`,
  );
  // A revert now lands on 4 and cannot touch attempt 3's ref.
  const res = await revertFixPassStrays(req(t, ["helper.ts"], [], 4));
  assert(!("reason" in res), `the revert at attempt 4 succeeded (${JSON.stringify(res).slice(0, 90)})`);
  assert(
    git(t.worktree, "show-ref").includes(fixPassStraysRef(1846, "default", 3)),
    "the earlier attempt's ref is still there — the counter did not overwrite it",
  );
}

console.log("# a preservation that fails leaves no orphan ref");
{
  // Force a failure in the record-writing step by putting a DIRECTORY where the
  // patch file goes: `writeFileSync(..., {flag:"wx"})` must fail (EISDIR), and on
  // the pre-#1849 order `update-ref` had already run, stranding a ref that points
  // at a tree no revert ever touched. With the patch written first, the refusal
  // leaves nothing behind; the assertion is written to hold either way, because
  // what it pins is the outcome, not the line order.
  const t = passTreeAt("1846-order-orphan");
  const scratch = `${t.repoRoot}/tmp/issue-1846`;
  const { mkdirSync } = await import("node:fs");
  // attempt 9 so the name is unique to this case.
  mkdirSync(dirname(`${scratch}/fix-pass-strays-1846-default-9.patch`), { recursive: true });
  // The parent is the scratch dir, which `preserve` would otherwise have created;
  // making it read-only is what makes the `wx` write actually fail (a directory at
  // the patch's own name is not enough — `mkdirSync` would have to be reached
  // first, and the parent it wants does not exist yet).
  writeFileSync(`${scratch}/.keep`, "");
  chmodSync(`${scratch}`, 0o500);
  const res = await revertFixPassStrays(req(t, ["helper.ts"], [], 9));
  chmodSync(`${scratch}`, 0o700);
  assert("reason" in res, "the revert refused — its patch could not be written");
  assert(
    !git(t.worktree, "show-ref").includes(fixPassStraysRef(1846, "default", 9)),
    "and no ref survives for a revert that never ran — an orphan ref is a record of something that did not happen",
  );
  assert(
    existsSync(`${t.worktree}/helper.ts`),
    "the stray is still in the tree: the refusal touched nothing",
  );
}

console.log("# an empty patch with nothing to copy refuses; with an untracked stray it proceeds");
{
  // A stray that is byte-identical to its `headBefore` content and is not
  // untracked: NEITHER preservation form can hold anything, because there is
  // nothing the revert would delete. The revert must refuse rather than "succeed"
  // having recorded nothing — the guard is about coverage of the present paths,
  // which a patch-length check and a `present.size` check each get wrong alone.
  const t = passTreeAt("1846-order-empty");
  // Make `b.txt` provably identical to its headBefore content (the fixture left it
  // modified, so an untouched path has to be created rather than assumed).
  git(t.worktree, `checkout ${t.headBefore} -- a.txt`);
  const res = await revertFixPassStrays(req(t, ["a.txt"], []));
  assert(
    "reason" in res && /nothing to preserve/.test(res.reason ?? ""),
    `an unchanged, non-untracked path is refused (${JSON.stringify(res).slice(0, 140)})`,
  );
  assert(
    readFileSync(`${t.worktree}/a.txt`, "utf8") === "one\n",
    "and the refusal left it exactly as found",
  );
  // The same empty-patch shape WITH a present untracked stray is the legitimate
  // case `copyUntracked` covers, and must proceed.
  const t2 = passTreeAt("1846-order-untracked");
  const res2 = await revertFixPassStrays(req(t2, ["scratch-notes.md"], ["scratch-notes.md"]));
  assert(
    !("reason" in res2),
    `a present untracked stray is preserved by the copy, so the revert proceeds (${JSON.stringify(res2).slice(0, 120)})`,
  );
  assert(
    !existsSync(`${t2.worktree}/scratch-notes.md`),
    "and the untracked stray was still removed from the tree",
  );
  assert(
    existsSync(
      `${t2.repoRoot}/tmp/issue-1846/fix-pass-strays-untracked/scratch-notes.md`,
    ),
    "with its bytes copied beside the patch",
  );
}

console.log("# a DIRECTORY at the temp-index name refuses before the tree is touched");
{
  // The bug this case pins: `rmSync(tmpIndex, { force: true })` sat OUTSIDE the try
  // that turns a commit failure into a returned refusal, and `force` is not force
  // against a directory — it throws EISDIR. It ran AFTER `revertPaths` had already
  // deleted and restored, so the rollback was skipped and the exception escaped to
  // the step-crash handler: a worktree left half-reverted with no refusal, no
  // rollback and no disclosure of what was deleted. The preflight now refuses a
  // non-file at that path, and the clear itself lives inside the guarded try.
  const t = passTreeAt("1846-index-eisdir");
  const scratch = `${t.repoRoot}/tmp/issue-1846`;
  mkdirSync(`${scratch}/fix-pass-strays-index-1846-default-11`, { recursive: true });
  // Byte-identity of the whole tree is read as `status --porcelain` over the
  // worktree plus its HEAD: the three strays are all still there and the pass's
  // own commit is still the tip, which is the same thing "nothing was reverted"
  // has to mean for the rollback case.
  const before = `${git(t.worktree, "status --porcelain").trim()}|${git(t.worktree, "rev-parse HEAD").trim()}`;
  const res = await revertFixPassStrays(req(t, ["helper.ts", "b.txt"], [], 11));
  assert(
    "reason" in res,
    `the revert RETURNS a refusal rather than throwing (${JSON.stringify(res).slice(0, 160)})`,
  );
  assert(
    lstatSync(`${scratch}/fix-pass-strays-index-1846-default-11`).isDirectory(),
    "and the refusal is the preflight's: the directory is still there — the clear was never attempted",
  );
  assert(
    `${git(t.worktree, "status --porcelain").trim()}|${git(t.worktree, "rev-parse HEAD").trim()}` ===
      before,
    "the tree is byte-identical to what it was: no revert happened",
  );
  assert(
    existsSync(`${t.worktree}/helper.ts`) &&
      readFileSync(`${t.worktree}/b.txt`, "utf8") === "hijacked\n",
    "both strays are exactly where the pass left them",
  );
  assert(
    !git(t.worktree, "show-ref").includes(fixPassStraysRef(1846, "default", 11)),
    "and no preserved ref is left behind for a revert that never ran",
  );
}

console.log("# the happy path still writes both records, in the new order");
{
  const t = passTreeAt("1846-order-both");
  const res = await revertFixPassStrays(req(t, ["helper.ts", "b.txt"], []));
  assert(!("reason" in res), `the revert succeeded (${JSON.stringify(res).slice(0, 90)})`);
  if (!("reason" in res)) {
    assert(
      git(t.worktree, "show-ref").includes(res.preservedRef),
      "the ref exists when the revert really ran",
    );
    assert(
      existsSync(res.patchPath) && readFileSync(res.patchPath, "utf8").length > 0,
      "and so does a non-empty patch — the order change did not drop a record",
    );
  }
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
