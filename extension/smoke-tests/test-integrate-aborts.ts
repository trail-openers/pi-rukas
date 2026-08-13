#!/usr/bin/env bun
/**
 * Four ways ONE developer aborted the whole integration, against real git.
 *
 * Every one was reproduced on a fixture before being fixed, and every one is a
 * single-developer defect that becomes near-certain as workstream count grows
 * — which is why they had to land before parallelism widened. At N=10 the
 * chance that no workstream contains a binary, a rename, or an overlapping
 * hunk is small.
 *
 *   1. **Binary files.** `git diff --cached` was captured without `--binary`,
 *      so blobs became the textual placeholder `Binary files a/x and b/x
 *      differ`, which `git apply` refuses outright.
 *
 *   2. **Non-ASCII filenames.** `git status --porcelain` C-quotes them
 *      (`"h\303\244yh\303\244.txt"`). The old parser stripped the surrounding
 *      quotes and then `JSON.stringify`d the still-escaped string, so the
 *      shell received literal backslashes and `git add` exited 128. The quote
 *      stripping was only ever correct for the space case. `-z` never quotes.
 *
 *   3. **Staged renames.** The old comment claimed rename entries "stage both
 *      sides"; staging the OLD side of an already-staged rename is exactly
 *      what git rejects, because that path exists neither on disk nor in the
 *      index. `git mv` in a worktree exited 128. Note `-z` also REVERSES the
 *      field order (`R  <new>\0<old>\0`) — verified on this fixture, not
 *      assumed from the man page.
 *
 *   4. **`git apply --index` is all-or-nothing twice over.** One rejected hunk
 *      discarded the entire patch, so a workstream whose other nine files
 *      applied cleanly contributed nothing; and the failure `return`ed from
 *      inside the per-workstream loop, so later workstreams were never
 *      attempted at all. Worse, the early return left repoRoot on the feature
 *      branch with 0..N-1 workstreams already applied and no rollback.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { integrate } from "../src/work-driver-integrate.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-integrate-"));

/**
 * A repo with a bare origin, one commit on main, and N detached worktrees cut
 * from that commit — the exact shape the branch step leaves behind.
 */
async function fixture(name: string, workstreams: string[], seed: Record<string, string> = {}) {
  const dir = path.join(root, name);
  const originDir = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  const scratch = path.join(dir, "scratch");
  mkdirSync(scratch, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  for (const [rel, body] of Object.entries(seed)) {
    writeFileSync(path.join(repo, rel), body);
  }
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const { stdout: sha } = await git(repo, ["rev-parse", "HEAD"]);
  const baseSha = sha.trim();
  const worktrees: Record<string, string> = {};
  for (const id of workstreams) {
    const wt = path.join(dir, `wt-${id}`);
    await git(repo, ["worktree", "add", "--detach", wt, baseSha]);
    worktrees[id] = wt;
  }
  return { repo, scratch, baseSha, worktrees };
}

const run = (f: Awaited<ReturnType<typeof fixture>>, branch: string) =>
  integrate(realExec, {
    repoRoot: f.repo,
    branchName: branch,
    baseSha: f.baseSha,
    worktrees: f.worktrees,
    scratchDir: f.scratch,
    commitTitle: "feat: integrate",
    commitBody: "body",
    mode: "create",
    requireAllNonEmpty: true,
  });

try {
  // ------------------------------------------------------- 1. binary files
  {
    const f = await fixture("binary", ["a"]);
    const wt = f.worktrees.a as string;
    writeFileSync(path.join(wt, "icon.ico"), Buffer.from([0, 1, 2, 3, 255, 254, 0, 7]));
    writeFileSync(path.join(wt, "note.txt"), "text too\n");
    const r = await run(f, "feature/binary");
    assert(
      r.ok,
      `canary: a workstream containing a binary integrates (got ${r.ok ? "ok" : `"${r.reason}"`})`,
    );
    const { stdout } = await git(f.repo, ["show", "--stat", "--name-only", "HEAD"]);
    assert(stdout.includes("icon.ico"), "...and the binary is actually in the commit");
  }

  // ------------------------------------------------ 2. non-ASCII filenames
  {
    const f = await fixture("utf8", ["a"]);
    const wt = f.worktrees.a as string;
    writeFileSync(path.join(wt, "häyhä.txt"), "sniper\n");
    writeFileSync(path.join(wt, "with space.txt"), "spaced\n");
    const r = await run(f, "feature/utf8");
    assert(
      r.ok,
      `canary: a non-ASCII filename integrates (got ${r.ok ? "ok" : `"${r.reason}"`}) — porcelain C-quoting made git add exit 128`,
    );
    // `core.quotepath=false` or git C-quotes non-ASCII in its OWN output too,
    // which is a display convention and not what landed in the commit.
    const { stdout } = await git(f.repo, [
      "-c",
      "core.quotepath=false",
      "show",
      "--name-only",
      "--format=",
      "HEAD",
    ]);
    assert(
      stdout.includes("häyhä.txt") && stdout.includes("with space.txt"),
      `...and both the non-ASCII and the spaced path are in the commit (got ${JSON.stringify(stdout.trim())})`,
    );
  }

  // ---------------------------------------------------- 3. staged renames
  {
    const f = await fixture("rename", ["a"], { "tomove.txt": "movable\n" });
    const wt = f.worktrees.a as string;
    await git(wt, ["mv", "tomove.txt", "moved.txt"]);
    const r = await run(f, "feature/rename");
    assert(
      r.ok,
      `canary: a staged rename integrates (got ${r.ok ? "ok" : `"${r.reason}"`}) — staging the OLD side exited 128`,
    );
    const { stdout } = await git(f.repo, ["show", "--name-status", "--format=", "HEAD"]);
    assert(
      /moved\.txt/.test(stdout) && !/^A\s+tomove/m.test(stdout),
      "...as a rename, not as an add of the old path",
    );
  }

  // ------------------------------- 4. a conflict must not cost clean work
  {
    // Both workstreams edit `shared.txt` at the same line, so B genuinely
    // conflicts. B ALSO edits a file nobody else touches — under the old
    // all-or-nothing apply that clean file was discarded with the conflicting
    // one, and workstream C was never attempted at all.
    const f = await fixture("conflict", ["a", "b", "c"], {
      "shared.txt": "one\n",
      "afile.txt": "a\n",
      "bfile.txt": "b\n",
      "cfile.txt": "c\n",
    });
    writeFileSync(path.join(f.worktrees.a as string, "shared.txt"), "A wins\n");
    writeFileSync(path.join(f.worktrees.a as string, "afile.txt"), "a edited\n");
    writeFileSync(path.join(f.worktrees.b as string, "shared.txt"), "B wins\n");
    writeFileSync(path.join(f.worktrees.b as string, "bfile.txt"), "b edited\n");
    writeFileSync(path.join(f.worktrees.c as string, "cfile.txt"), "c edited\n");

    const { stdout: before } = await git(f.repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const r = await run(f, "feature/conflict");

    assert(!r.ok, "a genuine content conflict still fails the integration — it must not ship");
    const reason = r.ok ? "" : r.reason;
    assert(
      /\bb\b/.test(reason),
      `canary: the failure names the conflicting workstream (got "${reason}")`,
    );
    assert(
      /not attempted[^.]*\bc\b/i.test(reason),
      `canary: the failure says workstream 'c' was never attempted (got "${reason}") — the old early return left that silent`,
    );

    // The load-bearing half: repoRoot must be exactly as we found it.
    const { stdout: dirt } = await git(f.repo, ["status", "--porcelain"]);
    assert(
      dirt.trim() === "",
      `canary: repoRoot is clean after a failed integration (got "${dirt.trim().slice(0, 120)}") — it was left half-applied with no rollback`,
    );
    const { stdout: after } = await git(f.repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert(
      after.trim() === before.trim(),
      `canary: repoRoot is back on ${before.trim()} (got ${after.trim()}) — a failed integration stranded it on the feature branch`,
    );
  }

  // ------------- 5. two workstreams, same file, different regions
  {
    // The single highest-value case for widening parallelism. Two workstreams
    // both touch a shared registry/barrel/mod file at opposite ends — a
    // near-certainty once N grows. `git apply --index` rejects the second
    // patch outright, because A's commit moved the context B's patch expects.
    // A 3-way merge has the blobs (worktrees share the object database) and
    // resolves it without either developer knowing.
    const lines = (mark: string) =>
      ["pub mod alpha;", "pub mod beta;", "pub mod gamma;", "pub mod delta;", mark].join("\n");
    const f = await fixture("sharedfile", ["a", "b"], {
      "mod.rs": `${lines("// end")}\n`,
    });
    // A rewrites the TOP of the file, B appends at the BOTTOM.
    writeFileSync(
      path.join(f.worktrees.a as string, "mod.rs"),
      `pub mod aardvark;\n${lines("// end")}\n`,
    );
    writeFileSync(
      path.join(f.worktrees.b as string, "mod.rs"),
      `${lines("// end")}\npub mod zebra;\n`,
    );
    const r = await run(f, "feature/sharedfile");
    assert(
      r.ok,
      `canary: two workstreams editing different regions of ONE file integrate (got ${r.ok ? "ok" : `"${r.reason}"`}) — --index rejected this outright`,
    );
    if (r.ok) {
      const { stdout } = await git(f.repo, ["show", "HEAD:mod.rs"]);
      assert(
        stdout.includes("aardvark") && stdout.includes("zebra"),
        "...and BOTH edits survive — neither developer's work is silently dropped",
      );
      assert(!stdout.includes("<<<<<<<"), "...with no conflict markers left in the tree");
    }
  }

  // ------------------------------------ the happy multi-workstream path
  {
    const f = await fixture("multi", ["a", "b"], { "afile.txt": "a\n", "bfile.txt": "b\n" });
    writeFileSync(path.join(f.worktrees.a as string, "afile.txt"), "a edited\n");
    writeFileSync(path.join(f.worktrees.b as string, "bfile.txt"), "b edited\n");
    const r = await run(f, "feature/multi");
    assert(r.ok, "two non-overlapping workstreams still consolidate into ONE commit");
    const { stdout } = await git(f.repo, ["show", "--name-only", "--format=", "HEAD"]);
    assert(
      stdout.includes("afile.txt") && stdout.includes("bfile.txt"),
      "...containing both workstreams' files — the PR 679 shape",
    );
    const { stdout: count } = await git(f.repo, ["rev-list", "--count", "main..HEAD"]);
    assert(count.trim() === "1", `...as exactly one commit (got ${count.trim()})`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
