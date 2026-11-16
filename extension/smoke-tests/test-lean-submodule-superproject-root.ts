#!/usr/bin/env bun
/**
 * lean/submodules — WHERE the seeding looks for the superproject, and what it refuses.
 *
 * The seeding's whole claim is that a worktree's submodule comes from the operator's own
 * checkout rather than from a URL. That claim rests on one lookup: which directory on this
 * host is the superproject. Get it wrong and the step is silently seeding from the run's own
 * scaffolding — `<repo>/.worktrees/` sits three path components under `<repo>`, exactly where
 * a linked worktree's own gitdir lives, so an answer derived by counting components off the
 * worktree's path names a directory that EXISTS (so no existence check can catch it), holds no
 * submodule, and is asked to supply one. The run then either hands back over bytes that were
 * on disk two directories up — the field failure this feature exists for — or reports an
 * "absent" submodule for a superproject that plainly holds it.
 *
 * `git rev-parse --git-common-dir` is the only question that can answer this, because git
 * itself knows whether the tree is a linked worktree: it answers `<repo>/.git` for a normal
 * checkout and `<repo>/.git/worktrees/<name>` for a linked one, and the main checkout is the
 * parent of the former and three up from the latter. So the case is the pair of answers, each
 * pinned over a REAL repository, plus the refusals that keep a probe this step does not
 * control from becoming a seed source.
 *
 *   (a) a normal checkout, asked from inside its own tree → the checkout;
 *   (b) a LINKED worktree, asked from inside it → the MAIN checkout, not the worktree and not
 *       the shared gitdir — the arm the field bug lived in;
 *   (c) an answer that is not a git dir at all (a probe that echoed the question back, the
 *       shape a stubbed or mislocated git hands this step) → a refusal naming the answer, not
 *       a guessed directory;
 *   (d) no answer at all (the probe died) → the same refusal, so "could not tell" never
 *       silently selects a source.
 *
 * Real repositories and the real `execp` throughout: every assertion here is about where a
 * path came from, and a stub can make any path come from anywhere.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { SpecifyInfraError } from "../src/lean/specify-reset.ts";
import { superprojectRoot } from "../src/lean/submodule-entries.ts";
import type { ExecFn } from "../src/worktree.ts";
import { trackedTempDir } from "./lib/git-test-env.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { gitIn, plainRepo } from "./lib/lean-submodule-local-fixture.ts";

const { assert, failures } = makeAssert();

/** The product's executor with the fixture's git identity, the same view the repos are built with. */
const exec: ExecFn = async (cmd, o) => execp(cmd, o);

/**
 * Whether two paths name the same directory, with symlinks resolved.
 *
 * The comparison has to survive `/tmp` being a symlink on some hosts: the fixtures build
 * their repos under the temp root, and a lexical compare would then call the superproject
 * and the run's tree different when the assertion below is precisely about them being
 * different. A path that cannot be resolved (it does not exist yet) is compared as written.
 */
function sameFile(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return path.resolve(real(a)) === path.resolve(real(b));
}

/** Ask the question the step asks, and report the verdict rather than throwing it. */
async function askSuper(wt: string): Promise<{ root?: string; err?: Error }> {
  try {
    return { root: await superprojectRoot(exec, wt) };
  } catch (err) {
    return { err: err as Error };
  }
}

// ── (a) a normal checkout is its own superproject
{
  const { repoRoot } = plainRepo("spr-a");
  const { root, err } = await askSuper(repoRoot);
  assert(
    err === undefined && root !== undefined && sameFile(root, repoRoot),
    `(a) a plain checkout answers with itself (got ${String(root)}, err ${err?.message ?? "none"})`,
  );
}

// ── (b) the linked worktree answers with the MAIN checkout
{
  // The field shape, exactly: the run's tree at `<repo>/.worktrees/lean-<issue>`, created by
  // git's own `worktree add`, which is the layout that puts a linked tree's gitdir three
  // components under the superproject and therefore the layout a component count confuses.
  const { repoRoot, baseSha } = plainRepo("spr-b");
  const wt = path.join(repoRoot, ".worktrees", "lean-7");
  gitIn(repoRoot, "worktree", "add", "-q", "--detach", wt, baseSha);
  // The preconditions that make the assertion below mean the fix rather than the fixture.
  assert(
    gitIn(wt, "rev-parse", "--git-common-dir") === path.join(repoRoot, ".git"),
    `(b) git itself puts the linked tree's common dir at the superproject's .git (got ${gitIn(wt, "rev-parse", "--git-common-dir")})`,
  );
  assert(
    gitIn(wt, "rev-parse", "--absolute-git-dir") ===
      path.join(repoRoot, ".git", "worktrees", "lean-7"),
    `(b) and its own gitdir is three components deep, the shape that fools a component count (got ${gitIn(wt, "rev-parse", "--absolute-git-dir")})`,
  );
  const { root, err } = await askSuper(wt);
  assert(
    err === undefined && root !== undefined && sameFile(root, repoRoot),
    `(b) the step still names the MAIN checkout, not the worktree (got ${String(root)}, err ${err?.message ?? "none"})`,
  );
  assert(
    root !== undefined && !sameFile(root, wt) && !sameFile(root, path.join(repoRoot, ".worktrees")),
    `(b) and it is neither the run's own tree nor the directory that holds it (got ${String(root)})`,
  );
}

// ── (c) an answer that is not a git dir is refused, not guessed at
// (No block: the three sabots are a `for` over cases, so the block would declare nothing.)
// What a probe this step does not control hands back when it cannot answer: `rev-parse`
// echoes an unrecognised `--git-*` question verbatim, and a stubbed executor returns the
// caller's sha. Either way the string is not a common dir, and taking it at face value
// makes somebody else's output decide where the submodule's bytes come from.
for (const [label, answer] of [
  ["an echoed question", "--git-common-dir"],
  ["a sha from an unrelated probe", `${"0".repeat(39)}1`],
  ["the run's own worktree scaffolding", path.join(trackedTempDir("spr-c-"), ".worktrees")],
] as const) {
  const lying: ExecFn = async (cmd, o) =>
    (o?.argv ?? []).includes("--git-common-dir")
      ? ({ stdout: `${answer}\n`, stderr: "" } as never)
      : exec(cmd, o);
  let err: Error | undefined;
  let root: string | undefined;
  try {
    root = await superprojectRoot(lying, "/tmp/not-a-tree");
  } catch (e) {
    err = e as Error;
  }
  assert(
    err instanceof SpecifyInfraError && root === undefined,
    `(c) ${label} is refused as an answer rather than taken as a directory (got root=${String(root)}, err=${err?.message ?? "none"})`,
  );
  assert(
    err?.message.includes("git rev-parse --git-common-dir") === true,
    `(c) and the refusal names the probe whose answer it could not read (got ${err?.message ?? "none"})`,
  );
}

// ── (d) no answer is refused too
{
  const silent: ExecFn = async (cmd, o) =>
    (o?.argv ?? []).includes("--git-common-dir")
      ? (Promise.reject(new Error("probe died")) as never)
      : exec(cmd, o);
  let err: Error | undefined;
  try {
    await superprojectRoot(silent, "/tmp/not-a-tree");
  } catch (e) {
    err = e as Error;
  }
  assert(
    err instanceof SpecifyInfraError && /nothing/.test(err.message ?? ""),
    `(d) a probe that returned nothing is a refusal, never a silently chosen source (got ${err?.message ?? "none"})`,
  );
}

process.exit(failures() === 0 ? 0 : 1);
