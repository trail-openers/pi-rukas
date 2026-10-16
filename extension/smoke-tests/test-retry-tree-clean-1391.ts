#!/usr/bin/env bun
/**
 * #1391 — the retry of a lost step dispatches into a CLEAN worktree, and the
 * retry line accounts for what it moved out of the way.
 *
 * The incident (tehas cycle 109): the round-2 lens-fix developer died on a
 * local failure, the driver classified it `provider-severed` and re-ran the
 * step, and the new attempt met the dead attempt's tree —
 * `lens-fix-reposition: worktree has uncommitted changes: M DESIGN.md, …` —
 * so the cycle parked with a third review round that lasted one second, and
 * the half-written work survived only as a handoff diff exported by hand.
 * Nothing committed, stashed or discarded what the severed child left, and the
 * retry's own precondition check was defeated by the failure it followed.
 *
 * Real git worktrees throughout: the assertions are about what git actually has
 * on disk afterwards, not about what a mocked exec said.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { lostAttemptLine } from "../src/work-driver-retry-context.ts";
import {
  cleanAttemptLine,
  cleanWorktreeForRetry,
  retryTargetTree,
} from "../src/work-retry-tree-clean.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { ensureGitIdentity, gitIn, makeBaseWorktrees } from "./lib/git-worktree-fixture.ts";

ensureGitIdentity();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "retry-tree-clean-"));
try {
  const shas = await makeBaseWorktrees(dir, ["default"]);
  const wt = path.join(dir, ".worktrees", "default");
  const base = shas.default as string;
  const scratch = path.join(dir, "tmp", "issue-7");

  const state = (over: Partial<WorkState["pipelineState"]> = {}): WorkState => ({
    ...initialState(7, 1_000_000),
    pipelineState: {
      ...initialState(7, 1_000_000).pipelineState,
      baseSha: base,
      worktrees: { default: wt },
      ...over,
    },
  });

  const dirtyFiles = () =>
    gitIn(wt, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean);

  // 1. The retry's tree is the step's worktree, and the clean is a no-op on a
  //    tree that has nothing to clean.
  {
    const target = retryTargetTree({ repoRoot: dir }, state(), "develop");
    assert(target === wt, `develop's retry tree is its worktree (got ${target})`);
    assert(
      retryTargetTree({ repoRoot: dir }, state(), "explore") === undefined,
      "a step with no worktree of its own has nothing to clean",
    );
    assert(
      retryTargetTree({ repoRoot: dir }, state({ worktrees: { default: dir } }), "develop") ===
        undefined,
      "repoRoot is never a retry target — the driver does not reset the operator's checkout",
    );
    const noop = await cleanWorktreeForRetry({
      execFn: execp,
      repoRoot: dir,
      issue: 7,
      step: "develop",
      attempt: 1,
      state: state(),
    });
    assert(
      noop.changed === false && noop.files.length === 0 && noop.unreadable === false,
      "a clean tree is a no-op with nothing claimed",
    );
    assert(cleanAttemptLine("develop", wt, noop) === undefined, "a no-op says nothing");
  }

  // 2. THE ISSUE: a lost attempt's uncommitted work is saved and the tree is
  //    clean before the retry — and the line accounts for every file.
  {
    writeFileSync(path.join(wt, "game-view.js"), "half a fix\n");
    writeFileSync(path.join(wt, "DESIGN.md"), "# half written\n");
    writeFileSync(path.join(dir, "outside.txt"), "not in the worktree\n");
    assert(dirtyFiles().length === 2, "fixture is dirty before the clean");

    const clean = await cleanWorktreeForRetry({
      execFn: execp,
      repoRoot: dir,
      issue: 7,
      step: "develop",
      attempt: 1,
      state: state(),
    });
    assert(clean.changed === true, "the dirty tree was cleaned");
    assert(
      clean.files.length === 2 &&
        clean.files.includes("DESIGN.md") &&
        clean.files.includes("game-view.js"),
      `the account names both files the dead attempt left (got ${clean.files.join(",")})`,
    );
    assert(dirtyFiles().length === 0, "the retry dispatches into a CLEAN worktree — the bug");

    const patch = clean.patch;
    assert(
      typeof patch === "string" && patch.includes("retry-develop-1.patch"),
      `work was saved, not silently discarded (got ${patch})`,
    );
    assert(
      patch !== undefined && readFileSync(patch, "utf8").includes("half a fix"),
      "the saved patch really contains the lost attempt's content",
    );
    assert(
      patch === path.join(scratch, "retry-develop-1.patch"),
      "the patch is in the scratch dir",
    );

    const line = cleanAttemptLine("develop", wt, clean) ?? "";
    assert(line.includes("2 uncommitted file(s)"), `line counts the files (got ${line})`);
    assert(line.includes("game-view.js"), "line names the files it removed");
    assert(
      line.includes("saved to") && line.includes(patch),
      "line says where the copy of the discarded work lives",
    );

    const failure = {
      kind: "dispatch-failed-provider" as const,
      step: "lens-fix" as const,
      role: "developer",
      jobId: "j1",
      label: "developer:lens-fix-2",
      ms: 1_369_000,
      at: 1,
      providerMessage: "saving a checkpoint part failed",
      usage: { input: 2_800_000, output: 20_000, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 40 },
    };
    const retryLine = lostAttemptLine("lens-fix", 1, failure, line);
    assert(
      retryLine.includes("lens-fix attempt 1 lost: 22m49s, 40 turns") &&
        retryLine.includes("2 uncommitted file(s)"),
      `the retry line carries BOTH halves (got ${retryLine})`,
    );
    assert(!retryLine.includes("checkpoint"), "the provider's message stays out of the line");
  }

  // 3. A second lost attempt never clobbers the first attempt's save.
  {
    writeFileSync(path.join(wt, "second.txt"), "second attempt\n");
    const second = await cleanWorktreeForRetry({
      execFn: execp,
      repoRoot: dir,
      issue: 7,
      step: "develop",
      attempt: 2,
      state: state(),
    });
    assert(
      second.patch === path.join(scratch, "retry-develop-2.patch"),
      `attempt 2 saves under its own name (got ${second.patch})`,
    );
    assert(
      readFileSync(path.join(scratch, "retry-develop-1.patch"), "utf8").includes("half a fix"),
      "attempt 1's patch is untouched",
    );
  }

  // 4. Committed work is never discarded: the clean refuses and says so.
  {
    writeFileSync(path.join(wt, "committed.txt"), "kept\n");
    gitIn(wt, ["add", "committed.txt"]);
    gitIn(wt, ["commit", "-qm", "the safety net committed this"]);
    writeFileSync(path.join(wt, "uncommitted.txt"), "risky\n");
    const clean = await cleanWorktreeForRetry({
      execFn: execp,
      repoRoot: dir,
      issue: 7,
      step: "develop",
      attempt: 3,
      state: state(),
    });
    assert(clean.changed === false, "a tree with commits ahead is never reset");
    assert((clean.why ?? "").includes("commit(s) ahead of base"), `refusal is named: ${clean.why}`);
    assert(
      readFileSync(path.join(wt, "uncommitted.txt"), "utf8") === "risky\n",
      "the dirt is left exactly where it was — nothing is destroyed on a refusal",
    );
    const line = cleanAttemptLine("develop", wt, clean) ?? "";
    assert(
      line.includes("left in place") && line.includes("commit(s) ahead of base"),
      `the operator is told nothing moved and why (got ${line})`,
    );
  }

  // 5. No base recorded → preserve, never reset (rule 2 of the seam).
  {
    gitIn(wt, ["reset", "--hard", "-q", base]);
    gitIn(wt, ["clean", "-fdq"]);
    assert(dirtyFiles().length === 0, "fixture reset to clean for the no-base case");
    writeFileSync(path.join(wt, "orphan.txt"), "no base to reset to\n");
    assert(dirtyFiles().length === 1, "only the orphan is dirty");
    const noBase = state();
    noBase.pipelineState = { ...noBase.pipelineState, baseSha: undefined };
    const clean = await cleanWorktreeForRetry({
      execFn: execp,
      repoRoot: dir,
      issue: 7,
      step: "develop",
      attempt: 4,
      state: noBase,
    });
    assert(clean.changed === false, "without a 40-hex base nothing is discarded");
    assert(
      readFileSync(path.join(wt, "orphan.txt"), "utf8") === "no base to reset to\n",
      "the work is still on disk",
    );
    const line = cleanAttemptLine("develop", wt, clean) ?? "";
    assert(
      line.includes("copied to") && line.includes(path.join("salvage", "default")),
      `and the copy is named (got ${line})`,
    );
    assert(clean.files.length === 1, `only the orphan is accounted for (got ${clean.files})`);
  }

  // 6. An unreadable tree is reported, never fatal and never claimed as clean.
  {
    const clean = await cleanWorktreeForRetry({
      execFn: async () => {
        throw new Error("git: not a repository");
      },
      repoRoot: dir,
      issue: 7,
      step: "develop",
      attempt: 5,
      state: state(),
    });
    assert(clean.unreadable === true, "an unreadable tree is unreadable, not clean");
    assert(
      cleanAttemptLine("develop", wt, clean) === undefined,
      "an unreadable tree produces no claim about files",
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(exit);
