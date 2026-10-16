#!/usr/bin/env bun
/**
 * #1240 — direct unit tests for the two ELIGIBILITY seams, which decide
 * whether an identity is even computed. The end-to-end tests
 * (`test-work-driver-consolidated-verify-skip.ts`,
 * `test-work-driver-integrate-verify-skip.ts`) observe the outcome — did the
 * verify command run; this file pins the RULE, one condition at a time.
 *
 * Both seams return an *identity* (`{treeHash, worktree}`) or `undefined`,
 * and `undefined` means "nothing to compare against, so run the command".
 * Each rejection below is therefore a gate that still runs, and each is a
 * shape the skip must never take:
 *
 *   - a per-worktree failure          — nothing proved this tree green
 *   - N > 1                            — the combination is a new tree
 *   - root-as-worktree                 — the loop never ran there, no green
 *   - empty changedWorktrees           — no worktree was verified at all
 *   - a non-empty patchApplied         — uncommitted transplant, trees differ
 *   - a noDiff entry                   — the integration is not the whole tree
 *   - followup mode                    — integrating onto the branch's own tip
 *
 * Plus one positive case each, on a real repo, because a seam that always
 * returns `undefined` would pass every rejection test.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { commitPrVerifiedTree } from "../src/work-driver-integrate-eligibility.ts";
import { developVerifiedTree } from "../src/work-driver-verify-eligibility.ts";
import { verifyTreeId } from "../src/work-driver-verify-tree.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const execFn: ExecFn = async (cmd, o) => {
  const opts = { cwd: o?.cwd, maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024 };
  const { stdout } = o?.argv
    ? await execFileP(cmd, o.argv, opts)
    : await execFileP("/bin/sh", ["-c", cmd], opts);
  return { stdout };
};

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1240-elig-"));

/** A repo with a bare origin and one detached worktree per id, work committed. */
async function repo(name: string, ids: string[]) {
  const dir = path.join(root, name);
  const originDir = path.join(dir, "origin.git");
  const baseDir = path.join(dir, "repo");
  mkdirSync(dir, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "-q", "--initial-branch=main", baseDir]);
  await git(baseDir, ["config", "user.email", "t@example.com"]);
  await git(baseDir, ["config", "user.name", "T"]);
  writeFileSync(path.join(baseDir, "tracked.txt"), "base\n");
  await git(baseDir, ["add", "."]);
  await git(baseDir, ["commit", "-q", "-m", "base"]);
  await git(baseDir, ["remote", "add", "origin", originDir]);
  await git(baseDir, ["push", "-q", "-u", "origin", "main"]);
  const baseSha = (await git(baseDir, ["rev-parse", "HEAD"])).stdout.trim();
  const worktrees: Record<string, string> = {};
  for (const id of ids) {
    const wt = path.join(dir, `wt-${id}`);
    await git(baseDir, ["worktree", "add", "-q", "--detach", wt, baseSha]);
    await git(wt, ["config", "user.email", "t@example.com"]);
    await git(wt, ["config", "user.name", "T"]);
    writeFileSync(path.join(wt, `${id}.txt`), `${id}\n`);
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-q", "-m", `task: ${id}`]);
    worktrees[id] = wt;
  }
  mkdirSync(path.join(baseDir, ".pi"), { recursive: true });
  return { dir, repo: baseDir, baseSha, worktrees };
}

/** The develop-side call. Every field is passed EXPLICITLY — a defaulted
 * `??`-fallback would silently overwrite an explicit `undefined` under
 * `exactOptionalPropertyTypes`, which is exactly the case under test. */
const dev = (
  worktrees: Record<string, string | undefined>,
  over: Partial<{
    changedWorktrees: string[];
    perWorktreeVerifyFailures: unknown[];
  }> = {},
) =>
  developVerifiedTree(execFn, { repoRoot: worktrees.default } as never, {
    changedWorktrees:
      over.changedWorktrees ?? (Object.values(worktrees).filter(Boolean) as string[]),
    worktrees,
    perWorktreeVerifyFailures: over.perWorktreeVerifyFailures ?? [],
  });

/** The commit-pr-side call, with every default set to the ELIGIBLE shape and
 * `verifiedWorktree` always passed explicitly (see the note above). */
const pr = (
  f: { repo: string; dir: string; worktrees: Record<string, string> },
  over: Partial<{
    mode: "create" | "followup";
    ids: string[];
    cherryApplied: string[];
    patchApplied: string[];
    noDiff: Record<string, unknown>;
  }> = {},
  verifiedWorktree?: string,
) =>
  commitPrVerifiedTree(execFn, {
    verifiedWorktree: verifiedWorktree ?? f.worktrees.default,
    mode: over.mode ?? "create",
    ids: over.ids ?? ["default"],
    cherryApplied: over.cherryApplied ?? ["default"],
    patchApplied: over.patchApplied ?? [],
    noDiff: over.noDiff ?? {},
  });

/** The same call with the caller's claim WITHHELD — the shape that must
 * yield no identity. Written out rather than passed as `undefined` so no
 * `??` default can silently restore the claim. */
const prNoWorktree = (f: { repo: string; dir: string; worktrees: Record<string, string> }) =>
  commitPrVerifiedTree(execFn, {
    verifiedWorktree: undefined,
    mode: "create",
    ids: ["default"],
    cherryApplied: ["default"],
    patchApplied: [],
    noDiff: {},
  });

try {
  // ====================================================================
  // developVerifiedTree
  // ====================================================================
  {
    const f = await repo("dev", ["default"]);
    const wt = f.worktrees.default as string;

    // Positive control FIRST: an eligible N=1 cycle yields the worktree's own
    // tree hash, read from git.
    const ok = await dev(f.worktrees as Record<string, string | undefined>);
    const expected = await verifyTreeId(execFn, wt);
    assert(
      ok?.treeHash === expected && ok?.worktree === wt,
      `develop: N=1 with a green per-worktree run yields the worktree's tree (got: ${JSON.stringify(ok)}, want ${expected})`,
    );

    const all: Record<string, string | undefined> = { ...f.worktrees };
    const rejections: Array<[string, Awaited<ReturnType<typeof dev>>]> = [
      [
        "a per-worktree failure",
        await dev(all, { perWorktreeVerifyFailures: ["verify command failed"] }),
      ],
      ["N>1", await dev({ a: wt, b: "/nonexistent-wt" }, { changedWorktrees: [wt] })],
      [
        // The degenerate N=1 shape: the one workstream's worktree IS repoRoot.
        // The per-worktree loop never runs there, so there is no green to
        // reuse — the identity must name the root's worktree as the map's own
        // value only when the caller claims a worktree the map does not hold.
        "root-as-worktree (the claimed worktree is not the map's)",
        await dev({ default: wt }, { changedWorktrees: [f.repo] }),
      ],
      ["an empty changedWorktrees", await dev(all, { changedWorktrees: [] })],
      [
        "a changedWorktree the map does not name",
        await dev(all, { changedWorktrees: ["/some/other/tree"] }),
      ],
    ];
    for (const [why, got] of rejections) {
      assert(got === undefined, `develop: NO identity for ${why} (got: ${JSON.stringify(got)})`);
    }

    // The escape hatch still governs this seam.
    process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP = "0";
    const off = await dev(all);
    // biome-ignore lint/performance/noDelete: restoring an absent env key
    delete process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP;
    assert(
      off === undefined,
      `develop: PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP=0 yields no identity (got: ${JSON.stringify(off)})`,
    );

    // A worktree whose identity git cannot establish is not an identity.
    const goneWt = path.join(f.dir, "worktree-that-is-gone");
    const gone = await dev({ default: goneWt }, { changedWorktrees: [goneWt] });
    assert(
      gone === undefined,
      `develop: a worktree that cannot be read yields no identity (got: ${JSON.stringify(gone)})`,
    );
  }

  // ====================================================================
  // commitPrVerifiedTree
  // ====================================================================
  {
    const f = await repo("pr", ["default"]);
    const wt = f.worktrees.default as string;

    const ok = await pr(f);
    const expected = await verifyTreeId(execFn, wt);
    assert(
      ok?.treeHash === expected && ok?.worktree === wt,
      `commit-pr: N=1 create mode with one cherry-picked commit yields the tree (got: ${JSON.stringify(ok)}, want ${expected})`,
    );

    const rejections: Array<[string, Awaited<ReturnType<typeof pr>>]> = [
      ["no claimed worktree", await prNoWorktree(f)],
      ["followup mode", await pr(f, { mode: "followup" })],
      ["N>1", await pr(f, { ids: ["default", "b"], cherryApplied: ["default", "b"] })],
      ["a per-worktree failure (no cherry-picked commit)", await pr(f, { cherryApplied: [] })],
      ["a non-empty patchApplied", await pr(f, { patchApplied: ["default"] })],
      ["a noDiff entry", await pr(f, { noDiff: { default: "no diff" } })],
      [
        "a claimed worktree git cannot read",
        await pr(f, {}, path.join(f.dir, "worktree-that-is-gone")),
      ],
    ];
    for (const [why, got] of rejections) {
      assert(got === undefined, `commit-pr: NO identity for ${why} (got: ${JSON.stringify(got)})`);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
