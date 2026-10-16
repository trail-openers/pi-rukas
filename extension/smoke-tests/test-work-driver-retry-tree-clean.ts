#!/usr/bin/env bun
/**
 * #1391 (task-d) — the preserve-then-clean seam, against REAL git.
 *
 * The incident (tehas cycle 109): the lens-fix developer died mid-write, the
 * router classified it as a provider fault and re-ran the step, and the new
 * attempt met the tree the dead one left behind —
 * `lens-fix-reposition: worktree has uncommitted changes: M DESIGN.md, …` →
 * `lens-fix reposition guard parked the cycle — dirty: …`. Round 3 lasted one
 * second. Nothing had committed, stashed or discarded what the severed child
 * left, so the retry's own precondition was defeated by the failure it was
 * retrying after, and round 2's fix survives only as a scratch-dir diff.
 * Cycle 60 shows the same loss one step earlier, at `develop`.
 *
 * So a step child that is LOST first gets its worktree made clean FOR THE
 * RETRY — preserve, then clean. This file is the evidence for the seam
 * (`worktree-retry-clean.ts`, task-a; wired into the router's two retry
 * branches by task-b):
 *
 *   1. the dirt is REAL and the clean is REAL — against a real repository and
 *      a real worktree, the tree goes dirty → clean and HEAD does not move;
 *   2. preservation is PROOF, not a claim — `git apply` of the saved patch
 *      onto a fresh checkout of the base restores the dead attempt's bytes
 *      (a patch that "contains" the text but does not apply is worthless);
 *   3. a clean tree costs nothing and destroys nothing;
 *   4. preservation failure refuses the clean (fail closed — the dirt stays
 *      exactly where it is, because a clean that cannot prove it saved the
 *      work is worse than no clean at all);
 *   5. a worktree outside `.worktrees/` (the repoRoot fallback) is never
 *      touched — a retry must never reset the operator's own checkout;
 *   6. an unreadable tree is not evidence that it is clean;
 *   7. the seam is idempotent: a second run over an already-clean tree
 *      preserves nothing and cleans nothing;
 *   8. the seam's result carries the retry ACCOUNT (#1391's "the retry says
 *      what it preserved"): `cleaned` names every dirtied file and the patch
 *      it saved under the cycle's scratch dir, and a run that preserved
 *      nothing reports no files and no patch — so `lostAttemptLine` (task-b)
 *      can never claim a preservation that did not happen.
 *
 * The seam is task-a's module (`src/worktree-retry-clean.ts`). Until it lands
 * this file fails at the import, which is the point: every assertion here is
 * written against the seam's contract — the argument names, the result kinds
 * and what each one is required to prove — not against an implementation
 * guess. Wiring the seam into the router's two retry branches is task-b, and
 * task-e owns the end-to-end "retry dispatches the fixer" cycle.
 *
 * Offline: temp dirs, real git, no network, no model.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cleanWorktreeForRetry } from "../src/worktree-retry-clean.ts";
import { worktreePath } from "../src/worktree.ts";
import { realExec } from "./lib/exec-fake.ts";
import { setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();

const execFileP = promisify(execFile);
/** git with a deterministic identity, so a fixture commit is byte-stable. */
const git = (cwd: string, args: string[]) =>
  execFileP("git", ["-c", "user.email=t@t", "-c", "user.name=T", ...args], { cwd });
const headOf = async (cwd: string) => (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
const porcelainOf = async (cwd: string) =>
  (await git(cwd, ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * A repo with one base commit, plus `<id>`'s worktree detached at that base —
 * the shape the lens-fix and develop steps actually retry over. Returns the
 * repo root, the worktree path and the base SHA.
 */
async function fixture(label: string): Promise<{ root: string; tree: string; baseSha: string }> {
  // The temp dir IS the repo root: `worktreePath(repoRoot, …)` puts the tree
  // at `<repoRoot>/.worktrees/<name>`, which is the only place a retry may
  // reset (work-develop-git's assertInsideWorktrees), and `scratchDir()` is
  // `<repoRoot>/tmp/issue-<N>`. Using the temp dir directly keeps all three
  // in the arrangement production has.
  const repo = mkdtempSync(path.join(tmpdir(), `retry-tree-clean-${label}-`));
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "DESIGN.md"), "# design\n\nthe old prose\n");
  writeFileSync(path.join(repo, "view.js"), "render();\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = await headOf(repo);
  const tree = worktreePath(repo, "issue-1391-default");
  await git(repo, ["worktree", "add", "-q", "--detach", tree, baseSha]);
  return { root: repo, tree, baseSha };
}

/** The #1391 dirt: edits to tracked files plus a file nobody has ever seen. */
function makeTreeDirty(tree: string): void {
  writeFileSync(path.join(tree, "DESIGN.md"), "# design\n\nthe NEW prose from the dead attempt\n");
  writeFileSync(path.join(tree, "view.js"), "render(); // self-healing write removed\n");
  writeFileSync(path.join(tree, "front_page_test.sh"), "#!/bin/sh\necho half-written test\n");
}

/** Everything under `dir` as `rel → contents`, for a before/after comparison. */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (ent.name === ".git") continue;
    const abs = path.join(dir, ent.name);
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) Object.assign(out, snapshot(abs, rel));
    else out[rel] = readFileSync(abs, "utf8");
  }
  return out;
}

// ───────────────────────── 1. dirty tree → clean tree, work preserved
{
  const { root, tree, baseSha } = await fixture("dirty");
  const scratch = path.join(root, "tmp", "issue-1391");
  try {
    makeTreeDirty(tree);
    const before = await porcelainOf(tree);
    assert(
      before.includes("DESIGN.md") && before.includes("front_page_test.sh"),
      `precondition: the tree really is dirty — ${before.split("\n").length} porcelain entries`,
    );
    const headBefore = await headOf(tree);

    const r = await cleanWorktreeForRetry({
      execFn: realExec,
      repoRoot: root,
      worktreePath: tree,
      baseSha,
      scratchAbs: scratch,
      step: "lens-fix",
      attempt: 1,
    });

    assert(r.kind === "cleaned", `a dirty worktree is cleaned (got ${r.kind})`);
    assert(
      (await porcelainOf(tree)) === "",
      "the retry's precondition now holds: git status --porcelain is EMPTY",
    );
    assert((await headOf(tree)) === headBefore, "cleaning does not move HEAD");
    const files = r.kind === "cleaned" ? r.files : [];
    assert(
      files.some((f) => f.includes("DESIGN.md")) &&
        files.some((f) => f.includes("front_page_test.sh")),
      `the result names every dirtied file (got ${JSON.stringify(files)})`,
    );

    // --- The proof of preservation: the patch APPLIES, and restores the bytes.
    const patch = r.kind === "cleaned" ? r.patch : undefined;
    assert(typeof patch === "string" && patch !== "", `a patch path is reported (${patch})`);
    let text = "";
    try {
      text = readFileSync(patch ?? "/nonexistent", "utf8");
    } catch {
      assert(false, "the saved patch exists on disk");
    }
    if (text) {
      assert(
        text.includes("the NEW prose from the dead attempt") && text.includes("half-written test"),
        "the patch carries the dead attempt's own words (tracked edit + untracked file)",
      );
      const restore = path.join(root, "restore");
      mkdirSync(restore, { recursive: true });
      await git(root, ["worktree", "add", "-q", "--detach", restore, baseSha]);
      const applied = await git(restore, ["apply", "--whitespace=nowarn", patch ?? ""])
        .then(() => true)
        .catch(() => false);
      assert(applied, "git apply of the saved patch onto a fresh base checkout SUCCEEDS");
      if (applied) {
        assert(
          readFileSync(path.join(restore, "DESIGN.md"), "utf8").includes(
            "the NEW prose from the dead attempt",
          ) &&
            readFileSync(path.join(restore, "front_page_test.sh"), "utf8").includes(
              "half-written test",
            ),
          "the applied patch restores the dead attempt's files byte-for-byte",
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ───────────────────────── 2. a clean tree costs nothing
{
  const { root, tree, baseSha } = await fixture("clean");
  const scratch = path.join(root, "tmp", "issue-1391");
  try {
    const before = snapshot(root);
    const r = await cleanWorktreeForRetry({
      execFn: realExec,
      repoRoot: root,
      worktreePath: tree,
      baseSha,
      scratchAbs: scratch,
      step: "lens-fix",
      attempt: 1,
    });
    assert(
      r.kind === "clean",
      `an already-clean tree is not cleaned — nothing to preserve (got ${r.kind})`,
    );
    const saved = (() => {
      try {
        return readdirSync(scratch);
      } catch {
        return [];
      }
    })();
    assert(
      saved.length === 0,
      `no patch was written for a clean tree (got ${JSON.stringify(saved)})`,
    );
    assert(
      JSON.stringify(snapshot(root)) === JSON.stringify(before),
      "a clean retry touches nothing on disk",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ───────────────────────── 3. preservation failure REFUSES the clean
{
  const { root, tree, baseSha } = await fixture("save-fails");
  const scratch = path.join(root, "tmp", "issue-1391");
  try {
    makeTreeDirty(tree);
    const dirtBefore = await porcelainOf(tree);
    const bytesBefore = snapshot(tree);
    // The seam saves the dirt before it discards anything. Make THAT save fail
    // for a reason that cannot be mistaken for a bug in the seam: the scratch
    // dir exists as a FILE, so no patch can be written into it.
    mkdirSync(path.dirname(scratch), { recursive: true });
    writeFileSync(scratch, "not a directory\n");

    const r = await cleanWorktreeForRetry({
      execFn: realExec,
      repoRoot: root,
      worktreePath: tree,
      baseSha,
      scratchAbs: scratch,
      step: "lens-fix",
      attempt: 1,
    });
    assert(r.kind === "refused", `an unsavable tree refuses the clean (got ${r.kind})`);
    assert(
      typeof r.reason === "string" && r.reason.length > 0,
      `the refusal names why (${r.kind === "refused" ? r.reason : ""})`,
    );
    assert(
      (await porcelainOf(tree)) === dirtBefore,
      "fail closed: the dirt is STILL THERE — nothing was discarded",
    );
    assert(
      JSON.stringify(snapshot(tree)) === JSON.stringify(bytesBefore),
      "fail closed: not one file changed when the save failed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ───────────────────────── 4. a tree outside .worktrees/ is never touched
{
  const { root, tree: _tree, baseSha } = await fixture("outside");
  const scratch = path.join(root, "tmp", "issue-1391");
  try {
    // The repoRoot fallback: runLensFix dispatches at repoRoot when the state
    // carries no worktrees. That checkout is the OPERATOR's tree — a retry
    // must never reset it. (The worktree itself is still dirty: the seam's
    // refusal is about the path it was handed, not about that path's state.)
    writeFileSync(path.join(root, "DESIGN.md"), "# design\n\noperator's own edit\n");
    writeFileSync(path.join(root, "operator-notes.md"), "the operator's file\n");
    // The operator's own edits, in the checkout the retry must not touch.
    const repoBefore = snapshot(root);
    const r = await cleanWorktreeForRetry({
      execFn: realExec,
      repoRoot: root,
      worktreePath: root,
      baseSha,
      scratchAbs: scratch,
      step: "lens-fix",
      attempt: 1,
    });
    assert(r.kind === "refused", `a tree outside .worktrees/ is refused (got ${r.kind})`);
    assert(
      JSON.stringify(snapshot(root)) === JSON.stringify(repoBefore),
      "the operator's checkout is byte-identical after the refusal",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ───────────────────────── 5. an unreadable tree is not "clean"
{
  const { root, baseSha } = await fixture("unreadable");
  const scratch = path.join(root, "tmp", "issue-1391");
  try {
    // A path under `.worktrees/` with NO directory on disk. The seam must not
    // report it as preserved-and-cleaned: there is no worktree to clean, and
    // the retry has no tree to dispatch into. The safe answer is a refusal
    // naming the path (or a no-op `clean`) — never the `cleaned` kind, which
    // asserts a patch was taken of work that does not exist.
    const missing = path.join(root, ".worktrees", "issue-1391-gone");
    const r = await cleanWorktreeForRetry({
      execFn: realExec,
      repoRoot: root,
      worktreePath: missing,
      baseSha,
      scratchAbs: scratch,
      step: "develop",
      attempt: 1,
    });
    assert(
      r.kind !== "cleaned",
      `a path with no worktree on disk is never reported as preserved-and-cleaned (got ${r.kind})`,
    );
    assert(
      r.kind !== "cleaned" || (r.kind === "cleaned" && r.files.length > 0),
      "the `cleaned` kind always names at least one preserved file",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ───────────────────────── 6. idempotence: a second retry costs nothing
{
  const { root, tree, baseSha } = await fixture("twice");
  const scratch = path.join(root, "tmp", "issue-1391");
  try {
    makeTreeDirty(tree);
    const first = await cleanWorktreeForRetry({
      execFn: realExec,
      repoRoot: root,
      worktreePath: tree,
      baseSha,
      scratchAbs: scratch,
      step: "lens-fix",
      attempt: 1,
    });
    assert(first.kind === "cleaned", `first retry cleans the tree (got ${first.kind})`);
    const afterFirst = snapshot(tree);
    const second = await cleanWorktreeForRetry({
      execFn: realExec,
      repoRoot: root,
      worktreePath: tree,
      baseSha,
      scratchAbs: scratch,
      step: "lens-fix",
      attempt: 2,
    });
    assert(
      second.kind === "clean",
      `second retry sees a clean tree and does nothing (got ${second.kind})`,
    );
    assert(
      JSON.stringify(snapshot(tree)) === JSON.stringify(afterFirst),
      "the second run changes nothing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ───────────────────────── 7. the retry account names what it preserved
{
  const { root, tree, baseSha } = await fixture("account");
  const scratch = path.join(root, "tmp", "issue-1391");
  try {
    makeTreeDirty(tree);
    const r = await cleanWorktreeForRetry({
      execFn: realExec,
      repoRoot: root,
      worktreePath: tree,
      baseSha,
      scratchAbs: scratch,
      step: "lens-fix",
      attempt: 1,
    });
    assert(r.kind === "cleaned", `cleaned before the account is written (got ${r.kind})`);
    // task-b renders the seam result into `lostAttemptLine`'s tail. The seam's
    // own result must carry both halves of that sentence: the file count and
    // where the bytes went. `patch === undefined` on a clean tree is what
    // keeps the account silent when nothing was preserved.
    if (r.kind === "cleaned") {
      assert(r.files.length > 0, "the account has files to name");
      assert(
        typeof r.patch === "string" && r.patch.includes("issue-1391"),
        `the account points at the saved patch inside the cycle's scratch dir (${r.patch})`,
      );
      assert(
        r.patch.startsWith(scratch),
        "the patch lives under the cycle's scratch dir, not the worktree",
      );
    }
    const noWork = await cleanWorktreeForRetry({
      execFn: realExec,
      repoRoot: root,
      worktreePath: tree,
      baseSha,
      scratchAbs: scratch,
      step: "lens-fix",
      attempt: 2,
    });
    assert(
      noWork.kind === "clean" && noWork.patch === undefined && noWork.files.length === 0,
      "a run that preserved nothing reports no files and no patch — the account cannot claim a preservation that did not happen",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

process.exit(exit);
