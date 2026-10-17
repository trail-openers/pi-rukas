#!/usr/bin/env bun
/**
 * #1016 — driver-artefact rules on real git worktrees:
 *  - saving (the retry patch) and the reset's `git clean` use the SAME
 *    exact-case rule: an untracked `.PI/x` is saved before the reset, an
 *    untracked `.pi/y` is neither saved nor removed;
 *  - committing (the safety net) excludes every case spelling of `.pi/` and `tmp/`;
 *  - a staged rename across the `.pi/` boundary is refused by the safety net
 *    (HEAD unchanged, a note recorded), and the retry reset saves both sides.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetWorktreeToBase, runGit } from "../src/work-develop-git.ts";
import { safetyNetWorktree } from "../src/work-driver-safety-net.ts";
import { execp } from "../src/work-driver-verify.ts";
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

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1016-case-"));
const git = runGit(execp);

/** A repo with a base commit (src/a.ts tracked) and a detached worktree at `.worktrees/w`. */
function fresh(name: string): { repo: string; wt: string; base: string } {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  gitIn(repo, ["init", "-q", "--initial-branch=main"]);
  gitIn(repo, ["add", "-A"]);
  gitIn(repo, ["commit", "-qm", "base"]);
  const base = gitIn(repo, ["rev-parse", "HEAD"]);
  const wt = path.join(repo, ".worktrees", "w");
  gitIn(repo, ["worktree", "add", "-q", "--detach", wt, base]);
  return { repo, wt, base };
}

function put(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

const caseSensitive = (() => {
  const probe = path.join(root, "case-probe");
  writeFileSync(probe, "x");
  const sensitive = !existsSync(path.join(root, "CASE-PROBE"));
  rmSync(probe);
  return sensitive;
})();

// --- 1. save vs clean: exact case is the only spared spelling.
{
  const { repo, wt, base } = fresh("save");
  put(path.join(wt, ".PI", "x.json"), "upper-case driver file");
  put(path.join(wt, "src", "b.ts"), "export const b = 2;\n");
  put(path.join(wt, "src", "tmp", "n.ts"), "nested tmp dir\n");
  const patchPath = path.join(root, "scratch-save", "retry-save-1.patch");
  const saved = await resetWorktreeToBase(git, wt, base, { repoRoot: repo, patchPath });
  assert(saved === patchPath, "#1016: work under .PI/ and src/ is saved to the patch");
  const patch = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  assert(patch.includes(".PI/x.json"), "#1016: the untracked .PI/x.json is in the saved patch");
  assert(patch.includes("src/b.ts"), "#1016: the untracked src/b.ts is in the saved patch");
  assert(
    patch.includes("src/tmp/n.ts"),
    "#1016: a nested src/tmp/n.ts is saved (not a driver dir)",
  );
  assert(
    !existsSync(path.join(wt, "src", "tmp", "n.ts")),
    "#1016: nested src/tmp/n.ts is removed by the reset after the save",
  );
  if (caseSensitive) {
    assert(!existsSync(path.join(wt, ".PI", "x.json")), "#1016: .PI/x.json removed after save");
  }
  assert(!existsSync(path.join(wt, "src", "b.ts")), "#1016: src/b.ts removed after save");
}

{
  const { repo, wt, base } = fresh("spared");
  put(path.join(wt, ".pi", "y.json"), "lower-case driver file");
  const patchPath = path.join(root, "scratch-spared", "retry-spared-1.patch");
  const saved = await resetWorktreeToBase(git, wt, base, { repoRoot: repo, patchPath });
  assert(saved === undefined, "#1016: an untracked exact-case .pi/ file is not saved");
  assert(existsSync(path.join(wt, ".pi", "y.json")), "#1016: exact-case .pi/y.json is spared");
}

// --- 2. commit: every case spelling of the driver directories is excluded.
{
  const { repo, wt, base } = fresh("commit");
  put(path.join(wt, ".PI", "x.json"), "upper");
  put(path.join(wt, "TMP", "z.txt"), "tmp upper");
  put(path.join(wt, "src", "b.ts"), "export const b = 2;\n");
  const notes: string[] = [];
  const ev = await safetyNetWorktree("w", repo, wt, base, execp, notes);
  assert(ev !== undefined, "#1016: safety net commits the non-driver file");
  const files = gitIn(wt, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
  assert(
    files.join() === "src/b.ts",
    `#1016: safety-net commit holds only src/b.ts (got ${files.join(",")})`,
  );
  assert(existsSync(path.join(wt, ".PI", "x.json")), "#1016: uncommitted .PI/x.json left on disk");
}

// --- 3. staged rename into .pi/: the driver-owned side is unstaged after the commit.
{
  const { repo, wt, base } = fresh("rename");
  mkdirSync(path.join(wt, ".pi"), { recursive: true });
  gitIn(wt, ["mv", "src/a.ts", ".pi/a.ts"]);
  const notes: string[] = [];
  const ev = await safetyNetWorktree("w", repo, wt, base, execp, notes);
  assert(ev === undefined, "#1016: a staged rename across the driver boundary is not committed");
  assert(
    gitIn(wt, ["rev-parse", "HEAD"]) === base,
    "#1016: HEAD is unchanged (no commit recording the deletion of src/a.ts)",
  );
  assert(
    notes.some((n) => n.includes("crosses the driver boundary")),
    "#1016: the refusal is recorded as a note",
  );
  const renamePatch = path.join(root, "scratch-rename", "retry-rename-1.patch");
  const saved = await resetWorktreeToBase(git, wt, base, {
    repoRoot: repo,
    patchPath: renamePatch,
  });
  const body = saved ? readFileSync(saved, "utf8") : "";
  assert(
    body.includes(".pi/a.ts") && body.includes("src/a.ts"),
    "#1016: the retry reset saves both sides of the rename to the patch",
  );
}

rmSync(root, { recursive: true, force: true });
if (exit !== 0) process.exit(1);
console.log("all #1016 case/rename assertions passed");
