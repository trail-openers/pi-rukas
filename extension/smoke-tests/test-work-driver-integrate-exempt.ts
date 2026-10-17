#!/usr/bin/env bun
/**
 * #1362 — the configured `.pi/dirty-root-exempt` list on the three repo-root
 * reads the integration path performs. Companion to
 * `test-work-driver-integrate-realgit.ts` (whose #287 always-worktree story
 * this block was split from for the file-size gate).
 *
 * Each case runs WITHOUT the list first, so the byte-identical guarantee and
 * the exemption are both observed on one fixture: the file blocks when nothing
 * is configured and blocks nothing when it is. Three consumers, three rules:
 *
 *   1. `readDirtyPorcelain` (the preflight gate) — no list: dirt; list: clean.
 *   2. `integrate()` — an untracked exempt file does not refuse; a MODIFIED
 *      tracked file refuses even with the list in force; the exempt file is
 *      never in the commit the integration makes, and is left on disk.
 *   3. `stagePorcelainPaths` — never staged at repoRoot, and staged as today
 *      inside a workstream worktree (the Settlement: repo root only).
 *
 * The branch-step gate is covered by
 * `test-work-driver-dirty-root-exempt-branch.ts`; the parser and matcher by
 * `test-dirty-root-exempt-config.ts`.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mechanizedBranchSetup } from "../src/work-driver-branch-mechanized.ts";
import { integrate, readDirtyPorcelain, restoreRepoRoot } from "../src/work-driver-integrate.ts";
import { stagePorcelainPaths } from "../src/work-driver-stage.ts";
import type { ExecFn } from "../src/worktree.ts";
import { gitTestEnv, isolateGitEnv } from "./lib/git-test-env.ts";

const execFileP = promisify(execFile);

// #1145 — fixture repos read no host git config; see lib/git-test-env.ts.
isolateGitEnv();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Real shell exec, matching the driver's ExecFn contract (`sh -c`, not a login shell). */
const realExec: ExecFn = async (cmd, o) => {
  const [file, args] = o?.argv ? [cmd, o.argv] : ["/bin/sh", ["-c", cmd]];
  const { stdout } = await execFileP(file, args, {
    env: gitTestEnv(),
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd, env: gitTestEnv() });
const gitOut = async (cwd: string, args: string[]): Promise<string> =>
  (await git(cwd, args)).stdout;

// ---- E4: #1362 — the configured `.pi/dirty-root-exempt` list on the same
// three repo-root reads. Each case runs WITHOUT the list first, so the
// byte-identical guarantee and the exemption are both observed on one fixture:
// the file blocks when nothing is configured and blocks nothing when it is.
{
  const rootE = mkdtempSync(path.join(tmpdir(), "pi-ens-exempt-"));
  const [oE, repoE, scratchE] = ["origin.git", "repo", "scratch"].map((n) => path.join(rootE, n));
  mkdirSync(scratchE, { recursive: true });
  const TOOL_FILE = path.join(".claude", "settings.local.json");
  const EXEMPT = [".claude"];

  try {
    await execFileP("git", ["init", "--bare", "--initial-branch=main", oE], { env: gitTestEnv() });
    await execFileP("git", ["init", "--initial-branch=main", repoE], { env: gitTestEnv() });
    await git(repoE, ["config", "user.email", "t@example.com"]);
    await git(repoE, ["config", "user.name", "T"]);
    writeFileSync(path.join(repoE, "tracked.txt"), "base\n");
    await git(repoE, ["add", "."]);
    await git(repoE, ["commit", "-q", "-m", "base"]);
    await git(repoE, ["remote", "add", "origin", oE]);
    await git(repoE, ["push", "-q", "-u", "origin", "main"]);

    const setupE = await mechanizedBranchSetup(realExec, repoE, 1362, [1362], [], "exempt test");
    const wtE = setupE.worktrees.default ?? "";
    writeFileSync(path.join(wtE, "fix.txt"), "fixed\n");

    /** The operator's tool writes its own local file into the main checkout. */
    function plantToolFile(): void {
      mkdirSync(path.join(repoE, ".claude"), { recursive: true });
      writeFileSync(path.join(repoE, TOOL_FILE), '{"mcpServers":{}}\n');
    }

    /**
     * Remove the files this block planted. Deliberately NOT `git clean -fd`:
     * that discards anything else untracked in the tree, which a test fixture
     * cannot know the value of. These fixtures only ever plant the named paths,
     * so only the named paths are removed.
     */
    function clearPlanted(): void {
      for (const rel of [
        TOOL_FILE,
        path.join(".claude", "a.txt"),
        ".claudefoo.txt",
        "operator-notes.txt",
      ]) {
        rmSync(path.join(repoE, rel), { force: true });
      }
      rmSync(path.join(repoE, ".claude"), { recursive: true, force: true });
    }

    // 1. readDirtyPorcelain (the preflight) — no list: dirt; with the list: clean.
    {
      plantToolFile();
      const unexempted = await readDirtyPorcelain(realExec, repoE);
      // Plain `--porcelain` (no `-uall`) collapses a wholly-untracked directory
      // to its top-level entry, so this read names `.claude/`, not the file
      // inside it. The exemption is a PREFIX match precisely so the collapsed
      // form and the expanded form both fall under it.
      // An explicit presence test, not `?.some(...)`: an optional chain yields
      // `undefined` when the list is empty, and `assert(undefined)` reads as a
      // generic failure rather than as "the dirt was missing". Kept as two
      // comparisons (`!== undefined &&`) rather than the optional chain biome
      // prefers, because the truthiness of `some()`'s return is not what is being
      // asserted here — the presence of the list is.
      const listWasPresent = unexempted !== undefined;
      const namesTheToolFile = listWasPresent && unexempted.some((l) => l.includes(".claude"));
      assert(
        namesTheToolFile,
        `#1362 preflight, no config: the tool's untracked file IS dirt (got ${JSON.stringify(unexempted)})`,
      );
      const exempted = await readDirtyPorcelain(realExec, repoE, EXEMPT);
      assert(
        exempted === undefined,
        `#1362 preflight, .claude/ listed: the tool's file is NOT dirt (got ${JSON.stringify(exempted)})`,
      );
      // The boundary still holds through the real read.
      writeFileSync(path.join(repoE, ".claudefoo.txt"), "x\n");
      const boundary = await readDirtyPorcelain(realExec, repoE, EXEMPT);
      assert(
        boundary?.some((l) => l.includes(".claudefoo.txt")) === true,
        "#1362 preflight: `.claude` does not exempt a sibling sharing its prefix",
      );
      clearPlanted();
    }

    // 2. integrate() — with the list, an untracked exempt file does not refuse,
    // and it is never swept into the commit the integration makes.
    //
    // The no-config control runs in its OWN repo: an integrate() that gets
    // through the gate commits and PUSHES, so running the passing case first
    // would leave the shared origin holding the branch and turn the control's
    // push into a non-fast-forward failure — an artifact of the fixture, not
    // of the gate under test.
    {
      const rootC = mkdtempSync(path.join(tmpdir(), "pi-ens-exempt-ctl-"));
      const repoC = path.join(rootC, "repo");
      const scratchC = path.join(rootC, "scratch");
      mkdirSync(scratchC, { recursive: true });
      try {
        await execFileP("git", [
          "init",
          "--bare",
          "--initial-branch=main",
          path.join(rootC, "origin.git"),
        ]);
        await execFileP("git", ["init", "--initial-branch=main", repoC], { env: gitTestEnv() });
        await git(repoC, ["config", "user.email", "t@example.com"]);
        await git(repoC, ["config", "user.name", "T"]);
        writeFileSync(path.join(repoC, "tracked.txt"), "base\n");
        await git(repoC, ["add", "."]);
        await git(repoC, ["commit", "-q", "-m", "base"]);
        await git(repoC, ["remote", "add", "origin", path.join(rootC, "origin.git")]);
        await git(repoC, ["push", "-q", "-u", "origin", "main"]);
        const setupC = await mechanizedBranchSetup(realExec, repoC, 1363, [1363], [], "control");
        writeFileSync(path.join(setupC.worktrees.default ?? "", "fix.txt"), "fixed\n");
        // The control plants a STRAY SOURCE file — the #741 shape the gate
        // exists for. The exemption is untracked-only, so a stray source file
        // must be dirt whether or not a list is configured, and this is the
        // case that pins it: if this file were exempted, real uncommitted
        // source would ride into a PR unnoticed.
        writeFileSync(
          path.join(repoC, "extension-stray-src.ts"),
          "// residue, not this cycle's work\n",
        );
        const blocked = await integrate(realExec, {
          repoRoot: repoC,
          branchName: setupC.branchName,
          baseSha: setupC.baseSha,
          worktrees: setupC.worktrees,
          scratchDir: scratchC,
          commitTitle: "feat: control",
          commitBody: "b",
          mode: "create",
        });
        // #776 governs this shape: untracked-only dirt is NON-blocking when
        // every workstream lives in its own worktree, because cherry-pick and
        // patch-apply never touch untracked files there. So the control's
        // evidence is not a refusal — it is that the exemption changed nothing:
        // the stray never reaches the branch with or without a list. A refusal
        // here would be a regression, not a pass.
        assert(
          existsSync(path.join(repoC, "extension-stray-src.ts")),
          "#1362 integrate, no config: the stray is preserved (the gate never deletes)",
        );
        const strayInTree = await execFileP(
          "git",
          ["ls-tree", "-r", "--name-only", setupC.branchName],
          { cwd: repoC, encoding: "utf8" },
        ).catch(() => ({ stdout: "" }));
        assert(
          !strayInTree.stdout.split("\n").some((f) => f.trim() === "extension-stray-src.ts"),
          `#1362 integrate, no config: the stray source is NOT on the branch (tree: ${JSON.stringify(strayInTree.stdout.split("\n"))})`,
        );
        // And the gate DOES refuse when the dirt is TRACKED — the case the
        // exemption must never reach — on the same fixture, list in force.
        writeFileSync(path.join(repoC, "tracked.txt"), "operator edit\n");
        const trackedDirty = await integrate(realExec, {
          repoRoot: repoC,
          branchName: setupC.branchName,
          baseSha: setupC.baseSha,
          worktrees: setupC.worktrees,
          scratchDir: scratchC,
          commitTitle: "feat: control 2",
          commitBody: "b",
          mode: "followup",
          dirtyRootExempt: EXEMPT,
        });
        // Narrow on `ok` before reading `failure`: the failure/reason fields
        // only exist on the refused arm of the discriminated result.
        assert(
          !trackedDirty.ok && trackedDirty.failure === "dirty-repoRoot",
          `#1362 integrate: a MODIFIED tracked file refuses the integration even with the list in force (got ${JSON.stringify(trackedDirty.ok ? [trackedDirty.ok] : [trackedDirty.ok, trackedDirty.failure])})`,
        );
        assert(
          existsSync(path.join(repoC, "extension-stray-src.ts")),
          "#1362: the refused stray is preserved, not deleted",
        );
      } finally {
        rmSync(rootC, { recursive: true, force: true });
      }

      // Re-plant: block 1's cleanup removed the whole `.claude/` directory, and
      // this is the passing case, so the file has to be present for the gate to
      // be shown letting it through.
      plantToolFile();
      const allowed = await integrate(realExec, {
        repoRoot: repoE,
        branchName: setupE.branchName,
        baseSha: setupE.baseSha,
        worktrees: setupE.worktrees,
        scratchDir: scratchE,
        commitTitle: "feat: exempt test",
        commitBody: "b",
        mode: "create",
        dirtyRootExempt: EXEMPT,
      });
      assert(
        allowed.ok,
        `#1362 integrate, .claude/ listed: the integration proceeds (got ${JSON.stringify(allowed.ok ? [allowed.ok] : [allowed.ok, allowed.reason])})`,
      );
      // The exempt file is invisible to the gate, not to the filesystem:
      // integration must not have deleted, moved or stashed it. Asserted here,
      // before the fixture removes anything, so it reads the tree integration
      // actually left behind.
      {
        const where = path.join(repoE, TOOL_FILE);
        let why = "";
        try {
          why = `dir holds: ${readdirSync(path.dirname(where)).join(",")}`;
        } catch (e) {
          why = `dir gone: ${(e as Error).message}`;
        }
        assert(
          existsSync(where),
          `#1362: integrating past the exempt file leaves it on disk (${why})`,
        );
      }
      // Whatever the integration committed must not contain the exempt file.
      const inCommit = await execFileP("git", ["ls-tree", "-r", "--name-only", setupE.branchName], {
        env: gitTestEnv(),
        cwd: repoE,
        encoding: "utf8",
      }).catch(() => ({ stdout: "" }));
      assert(
        !inCommit.stdout.split("\n").some((f) => f.trim() === TOOL_FILE),
        `#1362: the exempt file is never staged into the PR (branch tree: ${JSON.stringify(inCommit.stdout.split("\n"))})`,
      );
      clearPlanted();
    }

    // 3. stagePorcelainPaths — the never-staged rule, at repoRoot only. A
    // workstream worktree is passed NO list, so a deliverable inside an exempt
    // prefix is staged exactly as before.
    {
      const { stagePorcelainPaths } = await import("../src/work-driver-stage.ts");
      plantToolFile();
      writeFileSync(path.join(repoE, "operator-notes.txt"), "mine\n");
      const nRoot = await stagePorcelainPaths(realExec, repoE, EXEMPT);
      const stagedRoot = (await gitOut(repoE, ["diff", "--cached", "--name-only"]))
        .trim()
        .split("\n");
      assert(
        !stagedRoot.some((f) => f.trim() === TOOL_FILE),
        `#1362 staging at repoRoot: the exempt file is not staged (staged: ${JSON.stringify(stagedRoot)})`,
      );
      assert(
        stagedRoot.some((f) => f.trim() === "operator-notes.txt"),
        `#1362: a NON-exempt untracked file is still staged (staged: ${JSON.stringify(stagedRoot)})`,
      );
      assert(nRoot >= 1, "#1362: staging reports the paths it actually staged");
      await git(repoE, ["reset", "HEAD"]).catch(() => {});
      clearPlanted();

      // The same path inside a workstream worktree IS staged: the worktree
      // caller passes no list (Settlement: repo root only).
      const wtDeliverable = path.join(wtE, TOOL_FILE);
      mkdirSync(path.dirname(wtDeliverable), { recursive: true });
      writeFileSync(wtDeliverable, "a real deliverable\n");
      const nWt = await stagePorcelainPaths(realExec, wtE);
      const stagedWt = (await gitOut(wtE, ["diff", "--cached", "--name-only"])).trim().split("\n");
      assert(
        nWt >= 1 && stagedWt.some((f) => f.trim() === TOOL_FILE),
        `#1362: a deliverable in an exempt prefix inside a WORKTREE is staged as today (staged: ${JSON.stringify(stagedWt)})`,
      );
    }

    console.log("✓ #1362 dirty-root-exempt test passed");

    // 4. #1362 round 3 — `restoreRepoRoot`'s untracked-only decision is
    // exemption-aware. The settlement says a configured path is not saved or
    // restored by a claim, so a root whose only non-scaffolding entries are
    // exempt tool files must PARK (nothing of the cycle's is there to stash)
    // rather than run a stash/pop over a tree holding none of its work. A real
    // tracked edit beside the exempt file still decides the branch: stash and
    // pop, exactly as before the list existed.
    {
      plantToolFile();
      // (a) exempt-only porcelain → parks, and git's stash list is untouched.
      const exemptOnly = ["?? .claude/", `?? ${TOOL_FILE}`];
      const stashesBefore = (await gitOut(repoE, ["stash", "list"])).trim();
      const parked = await restoreRepoRoot(realExec, repoE, exemptOnly, EXEMPT);
      assert(
        parked.restored === false && (parked.reason ?? "").includes("only untracked"),
        `#1362 restoreRepoRoot: exempt untracked lines are not "tracked dirt", so the root parks instead of stashing (got ${JSON.stringify(parked)})`,
      );
      assert(
        (await gitOut(repoE, ["stash", "list"])).trim() === stashesBefore,
        "#1362 restoreRepoRoot: parking created no stash entry — the exempt file was neither saved nor restored",
      );
      assert(
        existsSync(path.join(repoE, TOOL_FILE)),
        "#1362 restoreRepoRoot: the exempt tool file is left on disk, unmoved",
      );

      // (b) The same list, a real tracked edit present → stash and pop as today.
      writeFileSync(path.join(repoE, "tracked.txt"), "base\nedited by the cycle\n");
      const withTracked = [" M tracked.txt", `?? ${TOOL_FILE}`];
      const done = await restoreRepoRoot(realExec, repoE, withTracked, EXEMPT);
      assert(
        done.restored === true,
        `#1362 restoreRepoRoot: a tracked edit still drives the stash+pop with the list in force (got ${JSON.stringify(done)})`,
      );
      assert(
        existsSync(path.join(repoE, TOOL_FILE)),
        "#1362 restoreRepoRoot: the exempt file survived the stash/pop untouched",
      );

      // (c) The no-list control: identical decision, because the exempt lines
      // are still `??` and the untracked-only rule is what fires.
      const noList = await restoreRepoRoot(realExec, repoE, exemptOnly);
      assert(
        noList.restored === false,
        `#1362 restoreRepoRoot: with no list the same porcelain parks too (byte-identical behaviour) (got ${JSON.stringify(noList)})`,
      );
      clearPlanted();
    }

    console.log("✓ #1362 dirty-root-exempt test passed");
  } finally {
    rmSync(rootE, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
