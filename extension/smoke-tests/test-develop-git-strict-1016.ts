#!/usr/bin/env bun
/**
 * #1016 — strict git parsing and index hygiene for the develop-path primitives:
 * the resume backup leaves the index as it found it, an incomplete save throws
 * before any reset, a malformed status read is unreadable (never a silent
 * skip), and driver artefacts are matched case-insensitively.
 * Real git worktrees for the save/backup paths; a GitExec fake for the
 * malformed-output and incomplete-index cases.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type GitExec,
  isDriverArtefact,
  resetWorktreeToBase,
  runGit,
  savePartialWork,
  worktreeStatus,
} from "../src/work-develop-git.ts";
import { backupInterruptedWorktrees } from "../src/work-develop-resume-backup.ts";
import { execp } from "../src/work-driver-verify.ts";
import { ensureGitIdentity, gitIn, makeBaseWorktrees } from "./lib/git-worktree-fixture.ts";

ensureGitIdentity();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

const dir = await mkdtemp(path.join(tmpdir(), "git-strict-1016-"));
try {
  const ids = ["pi-ws", "nested-ws", "clean-ws"];
  const shas = await makeBaseWorktrees(dir, ids);
  const wt = (id: string) => path.join(dir, ".worktrees", id);
  const scratch = path.join(dir, "tmp", "issue-1");

  // 1. Resume backup: a tracked .pi/verify-cmd edit is saved, the index is left
  //    clean, and the working-tree edit is untouched.
  const pw = wt("pi-ws");
  await mkdir(path.join(pw, ".pi"), { recursive: true });
  await writeFile(path.join(pw, ".pi", "verify-cmd"), "bun test-tracked\n");
  gitIn(pw, ["add", "-f", ".pi/verify-cmd"]);
  gitIn(pw, ["commit", "-qm", "track .pi/verify-cmd"]);
  const piBase = gitIn(pw, ["rev-parse", "HEAD"]);
  await writeFile(path.join(pw, ".pi", "verify-cmd"), "edited by developer\n");
  await writeFile(path.join(pw, "new.txt"), "new\n");
  const backup = await backupInterruptedWorktrees({
    execFn: execp,
    repoRoot: dir,
    scratchAbs: scratch,
    ids: ["pi-ws"],
    worktrees: { "pi-ws": pw },
    baseFor: () => piBase,
  });
  const savedPatch = backup.saved["pi-ws"];
  assert(
    savedPatch !== undefined && backup.refused["pi-ws"] === undefined,
    "#1016: the backup saves the tracked .pi/ edit",
  );
  assert(
    savedPatch !== undefined &&
      (await readFile(savedPatch, "utf8")).includes("+edited by developer"),
    "#1016: the saved patch carries the .pi/ edit",
  );
  assert(
    gitIn(pw, ["diff", "--cached", "--name-only"]) === "",
    "#1016: the backup leaves nothing staged",
  );
  assert(
    (await readFile(path.join(pw, ".pi", "verify-cmd"), "utf8")) === "edited by developer\n" &&
      existsSync(path.join(pw, "new.txt")),
    "#1016: the backup does not touch the working tree",
  );

  // 2. An incomplete save throws (and writes no patch): a work path git did not
  //    stage, or a staged index that yields an empty patch.
  const patchA = path.join(scratch, "incomplete-a.patch");
  const unstagedFake: GitExec = async () => ({ stdout: "" });
  let threwUnstaged = false;
  try {
    await savePartialWork(unstagedFake, dir, piBase, ["a.txt"], patchA);
  } catch {
    threwUnstaged = true;
  }
  assert(
    threwUnstaged && !existsSync(patchA),
    "#1016: a work path missing from the index refuses the save",
  );

  const emptyFake: GitExec = async (args) => {
    if (args.includes("--name-only")) return { stdout: "a.txt\0" };
    return { stdout: "  \n" };
  };
  let threwEmpty = false;
  try {
    await savePartialWork(
      emptyFake,
      dir,
      piBase,
      ["a.txt"],
      path.join(scratch, "incomplete-b.patch"),
    );
  } catch {
    threwEmpty = true;
  }
  assert(threwEmpty, "#1016: an empty patch for non-empty work refuses the save");

  // An unstageable nested git repo: `git add` refuses a path inside it, so the
  // save throws before anything is written and the nested work stays on disk.
  const nw = wt("nested-ws");
  await mkdir(path.join(nw, "inner"), { recursive: true });
  gitIn(path.join(nw, "inner"), ["init", "-q"]);
  await writeFile(path.join(nw, "inner", "x.txt"), "inside a nested repo\n");
  const nestedBase = gitIn(nw, ["rev-parse", "HEAD"]);
  const patchN = path.join(scratch, "nested.patch");
  let threwNested = false;
  try {
    await savePartialWork(runGit(execp), nw, nestedBase, ["inner/x.txt"], patchN);
  } catch {
    threwNested = true;
  }
  assert(
    threwNested && !existsSync(patchN),
    "#1016: a nested-repo path that cannot be staged refuses the save",
  );
  assert(
    existsSync(path.join(nw, "inner", "x.txt")),
    "#1016: the nested-repo work is left on disk",
  );

  // A save that fails AFTER staging (the patch build throws) leaves nothing staged,
  // driver-owned tracked .pi/ paths included.
  await writeFile(path.join(pw, "late.txt"), "late\n");
  const failAfterStage: GitExec = (args, o) =>
    args.includes("--binary") ? Promise.reject(new Error("boom")) : runGit(execp)(args, o);
  let threwLate = false;
  try {
    await savePartialWork(
      failAfterStage,
      pw,
      piBase,
      ["late.txt", ".pi/verify-cmd"],
      path.join(scratch, "late.patch"),
    );
  } catch {
    threwLate = true;
  }
  assert(
    threwLate && gitIn(pw, ["diff", "--cached", "--name-only"]) === "",
    "#1016: a save that fails after staging leaves the index clean",
  );

  // 2b. Untracked directories are listed file by file; the save and the reset's
  // clean share one exact-case rule, so an untracked upper-case TMP/ file is saved.
  const cw = wt("clean-ws");
  const cleanBase = shas["clean-ws"] ?? "";
  await mkdir(path.join(cw, "newdir"), { recursive: true });
  await writeFile(path.join(cw, "newdir", "a.ts"), "a\n");
  await mkdir(path.join(cw, "TMP"), { recursive: true });
  await writeFile(path.join(cw, "TMP", "notes.txt"), "keep me\n");
  const cwStatus = await worktreeStatus(runGit(execp), cw);
  const cwPaths = Array.isArray(cwStatus) ? cwStatus.map((e) => e.path) : [];
  assert(
    cwPaths.includes("newdir/a.ts") && !cwPaths.some((p) => p.endsWith("/")),
    "#1016: an untracked directory is reported as its files, never as a `dir/` entry",
  );
  const cleanPatch = path.join(dir, "tmp", "issue-1", "clean-ws.patch");
  const savedClean = await resetWorktreeToBase(runGit(execp), cw, cleanBase, {
    repoRoot: dir,
    patchPath: cleanPatch,
  });
  assert(
    savedClean === cleanPatch &&
      (await readFile(cleanPatch, "utf8")).includes("newdir/a.ts") &&
      !existsSync(path.join(cw, "newdir", "a.ts")),
    "#1016: an untracked directory's file is saved to the patch, then reset",
  );
  // Only the EXACT-case tmp/ and .pi/ are spared by the reset's clean; an
  // untracked upper-case TMP/ file is saved to the patch first, then removed.
  assert(
    (await readFile(cleanPatch, "utf8")).includes("TMP/notes.txt") &&
      !existsSync(path.join(cw, "TMP", "notes.txt")),
    "#1016: an untracked upper-case TMP/ file is saved to the patch, then removed",
  );

  // 3. worktreeStatus: a malformed entry or a rename without its origin is
  //    unreadable; a well-formed -z listing parses.
  const statusOf = (stdout: string) => worktreeStatus(async () => ({ stdout }), "/w");
  const malformed = await statusOf("?? a.txt\0xy\0");
  assert(!Array.isArray(malformed), "#1016: a malformed non-empty status token is unreadable");
  const noOrigin = await statusOf("R  new.txt\0");
  assert(!Array.isArray(noOrigin), "#1016: a rename without its origin path is unreadable");
  const wellFormed = await statusOf("?? a.txt\0 M b.txt\0");
  assert(
    Array.isArray(wellFormed) && wellFormed.length === 2,
    "#1016: a well-formed -z listing parses",
  );

  // 4. Driver artefacts: the first segment is compared case-insensitively.
  assert(
    isDriverArtefact(".PI/verify-cmd") &&
      isDriverArtefact("TMP/x.txt") &&
      isDriverArtefact(".pi/x") &&
      isDriverArtefact("tmp/x"),
    "#1016: .PI/ and TMP/ paths are driver artefacts",
  );
  assert(
    !isDriverArtefact("src/tmp/x.ts") && !isDriverArtefact("tmp") && !isDriverArtefact("my.pi/x"),
    "#1016: only a first-segment .pi or tmp is a driver artefact",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
