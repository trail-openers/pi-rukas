#!/usr/bin/env bun
/**
 * #1634 (M1/M3) — `readWorktreeDiff`'s own contract: the three answers a
 * per-worktree diff read must be able to give, and the two it must never give.
 * Split out of test-adversarial-unreadable-diff.ts (§12 file size limit); that
 * file covers the GATE's use of the read, this one the read itself.
 *
 * The distinction the whole issue turns on: `""` used to be the answer to both
 * "nothing to review" and "the read failed", and the gate renders `""` as a
 * pass. So a blank diff is only reported EMPTY when the tree is positively
 * proven clean, and every read failure is UNREADABLE.
 *
 * Offline: no spawn, no network.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readWorktreeDiff } from "../src/work-driver-diff.ts";
import {
  commitAll,
  failingExec,
  execFailingArgs,
  gitFixture,
  initScratchRepoFresh,
  scratchDirWithoutGit,
  seedFile,
  stageFile,
} from "./lib/git-worktree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

/** The dirt probe `readWorktreeDiff` runs to decide what a BLANK diff means. */
const DIRTY_PROBE_READ = "git status --porcelain -z --untracked-files=all";

/**
 * M4 — the best-effort string projections are gone from the module's exports.
 * Read off the module object rather than the source text, so a re-added
 * `fetchDiff` (or any `""`-on-failure sibling) fails here rather than silently
 * handing a future caller back the value #1634 removed.
 */
async function noStringProjection(): Promise<boolean> {
  const mod = (await import("../src/work-driver-diff.ts")) as Record<string, unknown>;
  return (
    !Object.keys(mod).includes("fetchDiff") && !Object.keys(mod).includes("fetchIntegratedDiff")
  );
}

const dirs: string[] = [];
function tempRepo(): string {
  const dir = initScratchRepoFresh("adv-readcontract-");
  dirs.push(dir);
  return dir;
}

// ===========================================================================
// T5 — readWorktreeDiff's own contract: empty vs unreadable vs non-empty
// ===========================================================================
{
  const noCwd = await readWorktreeDiff(undefined, undefined);
  assert(noCwd.ok === false, "T5a: no cwd is unreadable, never an empty diff");

  const dirty = tempRepo();
  seedFile(dirty, "untracked-new.ts", "x\n");
  const d = await readWorktreeDiff(dirty, undefined);
  assert(d.ok === false, "T5c: an untracked file with a blank diff is unreadable, not empty");
  assert(
    d.ok === false && /not clean/.test(d.reason),
    "T5c: the reason says the tree is not clean",
  );

  // A tracked modification still reads as a diff (no behaviour change).
  const modified = tempRepo();
  seedFile(modified, "a.txt", "one\n");
  commitAll(modified, "one");
  seedFile(modified, "a.txt", "two\n");
  const m = await readWorktreeDiff(modified, undefined);
  assert(m.ok === true && m.empty === false, "T5d: a tracked modification is a non-empty diff");

  // A non-repository directory with files in it is unreadable, not empty — the
  // case `git diff HEAD` answers blank for.
  const plain = scratchDirWithoutGit("adv-unreadable-plain2-", { "a.ts": "a\n" });
  dirs.push(plain);
  const p = await readWorktreeDiff(plain, undefined);
  assert(p.ok === false, "T5f: a directory that is not a git repo is unreadable, not empty");

  // With a failing executor injected, a REAL clean worktree is unreadable too.
  // (M3a: the read takes `exec`, so this needs no PATH surgery and cannot race
  // a sibling test that spawns git.)
  const real = tempRepo();
  const broken = await readWorktreeDiff(real, undefined, failingExec());
  assert(broken.ok === false, "T5g: a git binary that fails makes the read unreadable");

  // M3a — the executor seam decides WHICH read fails: with only the dirt probe
  // broken, a blank diff is "could not tell", never a proven empty. The old
  // shape could only reach this by removing git from PATH entirely.
  const blank = tempRepo();
  const probeBroken = await readWorktreeDiff(
    blank,
    undefined,
    execFailingArgs(["status", "--porcelain"]),
  );
  assert(
    probeBroken.ok === false && /could not establish/.test(probeBroken.reason),
    `T5h: a blank diff whose dirt probe failed is unreadable, never empty (${probeBroken.ok ? "read ok" : probeBroken.reason})`,
  );
  assert(
    probeBroken.ok === false && probeBroken.readFailed === DIRTY_PROBE_READ,
    "T5h: the read names WHICH git command failed (the operator needs the command, not just the class)",
  );

  // M4 — there is NO best-effort string projection of this read any more
  // (`fetchDiff` had no production caller, and ""-on-failure is the very value
  // this type exists to make unrepresentable). Canary-checked at compile time
  // by this file's imports; a re-added export would not be seen here, so the
  // assertion below is the one that says so out loud.
  assert(
    await noStringProjection(),
    "T5e: work-driver-diff.ts exports no `\"\"`-on-failure string read",
  );
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
