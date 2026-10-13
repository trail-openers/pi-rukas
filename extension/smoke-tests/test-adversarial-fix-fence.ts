#!/usr/bin/env bun
/**
 * #1104 round 2 — the fix-round fence, at its module seam (real git, no spawn mocks).
 *
 *   T1  typed records: `ok` derives from kind; each record renders once, with its round
 *   T2  no fence (the /work driver) → no caller snapshot, the round just runs
 *   T3  the caller check runs after a fix dispatch that throws
 *   T4  fail closed: an unreadable caller refuses the round before it runs; a
 *       snapshot lost after the round is a violation; neither can approve
 *   T5  a non-repo caller is a note only; it never blocks the round
 *   T6  workCwd must be a worktree of the caller's repo (realpath'd) — else invalid-input
 *   T7  the snapshot covers the caller repo: nested repos and symlinks are reported by
 *       name and do not fail it; a dirty-file content rewrite is still caught; the
 *       workCwd index is never read
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type FenceRecord,
  createFixFence,
  renderFenceRecords,
  withFixViolations,
} from "../src/adversarial-fix-guard.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const made: string[] = [];
const tmp = (tag: string): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), `fence-1104-${tag}-`));
  made.push(d);
  return d;
};
const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString();
const repo = (tag: string): string => {
  const dir = tmp(tag);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(path.join(dir, "f.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
};
/** A worktree of `source` on a fresh branch, at a fresh path. */
const worktreeOf = (source: string, branch: string): string => {
  const dir = path.join(tmp(`wt-${branch}`), "wt");
  git(source, "worktree", "add", "-q", "-b", branch, dir);
  return dir;
};
/** Make a repo's index unreadable: git status then fails, rev-parse still works. */
const corruptIndex = (dir: string) => {
  const gitDir = git(dir, "rev-parse", "--path-format=absolute", "--git-dir").trim();
  writeFileSync(path.join(gitDir, "index"), "corrupt");
};
const approved = (): DispatchResult =>
  ({
    role: "adversarial-loop",
    ok: true,
    text: "APPROVED",
    toolUses: [],
    ms: 1,
    exitCode: 0,
    loopOutcome: "approved",
  }) as DispatchResult;

async function main() {
  // ---------------------------------------------------------------- T1 typed records
  {
    const notes: FenceRecord[] = [{ kind: "note", round: 1, text: "caller-repo check did not run (x)" }];
    const r1 = withFixViolations(approved(), notes);
    assert(r1.ok === true && r1.loopOutcome === "approved", "T1: a note leaves ok and the approval alone");
    assert(
      r1.text.startsWith("note: fix round 1 caller-repo check did not run (x)"),
      "T1: a note renders once, with its round",
    );
    const v: FenceRecord[] = [{ kind: "violation", round: 2, text: "stray" }];
    const r2 = withFixViolations(approved(), [...notes, ...v]);
    assert(r2.ok === false, "T1: a violation record fails ok");
    assert(r2.loopOutcome === "rejected", "T1: a violation turns an approval into a rejection");
    assert(
      r2.text.split("VIOLATION: fix round 2 stray").length === 2,
      "T1: the violation text appears exactly once",
    );
    assert(renderFenceRecords(v)[0] === "VIOLATION: fix round 2 stray", "T1: the label comes from kind");
    const same = approved();
    assert(withFixViolations(same, []) === same, "T1: no records → the result is returned as-is");
  }

  // ---------------------------------------------------- T2 no fence (driver) → inert
  {
    const caller = repo("t2c");
    const work = worktreeOf(caller, "wt-t2");
    const recs: FenceRecord[] = [];
    const res = await createFixFence(undefined, recs).round(1, work, async () => {
      writeFileSync(path.join(caller, "stray.txt"), "x");
      return 7;
    });
    assert(res.ran && res.value === 7 && recs.length === 0, "T2: no fence → the round runs, no caller check");
  }

  // ------------------------------------------- T3 check runs even when dispatch throws
  {
    const caller = repo("t3c");
    const work = worktreeOf(caller, "wt-t3");
    const recs: FenceRecord[] = [];
    let threw = false;
    try {
      await createFixFence({ callerCwd: caller }, recs).round(1, work, async () => {
        writeFileSync(path.join(caller, "stray.txt"), "x");
        throw new Error("dispatch boom");
      });
    } catch {
      threw = true;
    }
    assert(threw, "T3: the dispatch error still propagates");
    assert(
      recs.some((r) => r.kind === "violation" && r.text.includes("stray.txt")),
      "T3: the caller check ran after the throwing dispatch",
    );
  }

  // ---------------------------------------------------------- T4 fail closed
  {
    const caller = repo("t4a");
    const work = worktreeOf(caller, "wt-t4a");
    corruptIndex(caller);
    let dispatched = false;
    const recs: FenceRecord[] = [];
    const res = await createFixFence({ callerCwd: caller }, recs).round(1, work, async () => {
      dispatched = true;
      return 1;
    });
    assert(!dispatched, "T4: an unreadable caller never dispatches the fix round");
    assert(
      !res.ran && res.outcome === "infra-failure" && res.reason.includes("could not be armed"),
      "T4: an unreadable caller refuses the round as infra-failure",
    );
  }
  {
    const caller = repo("t4b");
    const work = worktreeOf(caller, "wt-t4b");
    const recs: FenceRecord[] = [];
    const res = await createFixFence({ callerCwd: caller }, recs).round(1, work, async () => {
      corruptIndex(caller);
      return "done";
    });
    assert(res.ran === true, "T4: the round itself ran");
    assert(
      recs.some((r) => r.kind === "violation" && r.text.includes("not completed")),
      "T4: a snapshot lost after the round is a violation",
    );
    const r = withFixViolations(approved(), recs);
    assert(r.ok === false && r.loopOutcome === "rejected", "T4: a lost snapshot never leaves an approval");
  }

  // -------------------------------------------- T5 non-repo caller: note, never blocks
  {
    const notRepo = tmp("t5-notrepo");
    const work = worktreeOf(repo("t5c"), "wt-t5");
    const recs: FenceRecord[] = [];
    const res = await createFixFence({ callerCwd: notRepo }, recs).round(1, work, async () => "x");
    assert(res.ran === true, "T5: a never-a-repo caller does not block the round");
    assert(
      recs.length === 1 && recs[0]?.kind === "note" && recs[0].text.includes("not a git repository"),
      "T5: a never-a-repo caller is recorded as a note",
    );
    assert(withFixViolations(approved(), recs).ok === true, "T5: a note leaves the result ok");
  }

  // ----------------------------------------------- T6 workCwd must be a caller worktree
  {
    const caller = repo("t6c");
    const unrelated = repo("t6u");
    let called = false;
    const fn = async () => {
      called = true;
      return 1;
    };
    const r1 = await createFixFence({ callerCwd: caller }, []).round(1, unrelated, fn);
    assert(
      !r1.ran && r1.outcome === "invalid-input" && r1.reason.includes("not a worktree of the calling repository"),
      "T6: a workCwd from an unrelated repository is invalid-input",
    );
    const missing = path.join(tmp("t6-missing"), "nope");
    const r2 = await createFixFence({ callerCwd: caller }, []).round(1, missing, fn);
    assert(!r2.ran && r2.outcome === "invalid-input", "T6: a nonexistent workCwd is invalid-input");
    assert(!called, "T6: no fix dispatch runs for an invalid workCwd");

    const real = worktreeOf(caller, "wt-t6");
    const linkDir = tmp("t6-link");
    const link = path.join(linkDir, "link");
    symlinkSync(real, link);
    const r3 = await createFixFence({ callerCwd: caller }, []).round(1, link, async () => "ok");
    assert(r3.ran === true, "T6: a symlink to the caller's worktree is accepted (realpath'd)");

    const r4 = await createFixFence({ callerCwd: caller }, []).round(1, caller, async () => "ok");
    assert(r4.ran === true, "T6: workCwd that is the caller's own worktree runs with the check off");
  }

  // --------------------------------------------- T7 snapshot scope (caller only, by name)
  {
    const caller = repo("t7c");
    const work = worktreeOf(caller, "wt-t7");
    // An untracked nested repository (a directory) and an untracked symlink.
    const nested = path.join(caller, "nested");
    mkdirSync(nested);
    git(nested, "init", "-q", "-b", "main");
    writeFileSync(path.join(nested, "n.txt"), "n\n");
    symlinkSync("f.txt", path.join(caller, "link"));
    // The workCwd's index is corrupt: its status must never be read.
    corruptIndex(work);

    const recs: FenceRecord[] = [];
    const fence = createFixFence({ callerCwd: caller }, recs);
    const clean = await fence.round(1, work, async () => "nothing written");
    assert(clean.ran === true, "T7: directories and symlinks do not fail the snapshot");
    assert(recs.length === 0, "T7: an unchanged caller with a nested repo and a symlink is clean");
    assert(
      (await createFixFence({ callerCwd: caller }, []).round(1, work, async () => 1)).ran === true,
      "T7: a corrupt workCwd index is never read, so the round still runs",
    );

    await fence.round(2, work, async () => {
      writeFileSync(path.join(caller, "new.txt"), "x\n");
    });
    assert(
      recs.length === 1 && recs[0]?.kind === "violation" && recs[0].text.includes("new.txt"),
      "T7: a new untracked file in the caller is the violation, named",
    );
  }
  {
    // A content-only rewrite of an already-dirty tracked file is still caught.
    const caller = repo("t7d");
    const work = worktreeOf(caller, "wt-t7d");
    writeFileSync(path.join(caller, "f.txt"), "dirty before\n");
    const recs: FenceRecord[] = [];
    await createFixFence({ callerCwd: caller }, recs).round(1, work, async () => {
      writeFileSync(path.join(caller, "f.txt"), "dirty rewritten\n");
    });
    assert(
      recs.some((r) => r.kind === "violation" && r.text.includes("f.txt")),
      "T7: a content-only rewrite of a dirty caller file is a violation",
    );
  }
}

try {
  await main();
} finally {
  for (const d of made) rmSync(d, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
