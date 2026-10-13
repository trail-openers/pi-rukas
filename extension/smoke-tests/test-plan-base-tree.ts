#!/usr/bin/env bun
/**
 * #1132 addendum (decision 3) — investigators read origin/<default>, not the
 * working tree; the investigation cache key uses that SHA.
 *
 * Real git, in temp dirs: a bare origin, a clone whose working tree is dirty
 * and stale. Asserts: one fetch yields a per-run base tree with the committed
 * origin content; the tree is removed at release; the cache key moves when
 * origin moves; withPlanBase removes its tree when the callback throws; and
 * every failure falls back to the checkout with a recorded reason.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type PlanBase,
  branchNameProblem,
  openPlanBase,
  withPlanBase,
} from "../src/plan-base-tree.ts";
import { resolvePlanGitState, setPlanGitStateFn } from "../src/plan-investigation-cache.ts";

const execFileP = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await execFileP("git", ["-C", cwd, ...args], { timeout: 60_000 })).stdout.trim();
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-base-tree-"));
// Real git ran for this test; the verify-loop disables the cache lookup by default.
process.env.PI_ENSEMBLE_PLAN_CACHE = "1";
setPlanGitStateFn(null);

const held: PlanBase[] = [];
try {
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const clone = path.join(root, "clone");
  const cfg = ["-c", "user.name=t", "-c", "user.email=t@t"];

  await execFileP("git", ["init", "--bare", "-b", "main", bare]);
  await execFileP("git", ["init", "-b", "main", seed]);
  await fs.writeFile(path.join(seed, "policy.txt"), "committed v1\n");
  await git(seed, ["add", "-A"]);
  await git(seed, [...cfg, "commit", "-m", "v1"]);
  await git(seed, ["remote", "add", "origin", bare]);
  await git(seed, ["push", "-q", "origin", "main"]);
  await execFileP("git", ["clone", "-q", bare, clone]);
  // The clone's remote HEAD must name the default branch (what the base reads).
  await git(clone, ["remote", "set-head", "origin", "main"]);

  // Dirty and stale: an uncommitted edit, and a local commit origin does not have.
  await fs.writeFile(path.join(clone, "policy.txt"), "LOCAL UNCOMMITTED EDIT\n");
  await fs.writeFile(path.join(clone, "local-only.txt"), "not on origin\n");
  await git(clone, [...cfg, "add", "-A"]);
  await git(clone, [...cfg, "commit", "-m", "local only"]);

  const originV1 = await git(bare, ["rev-parse", "main"]);
  const base1 = await openPlanBase(clone);
  held.push(base1);
  assert(base1.baseSha === originV1, "one fetch resolves origin/<default>, not the local HEAD");
  assert(base1.baseFallback === undefined, "a clean fetch records no fallback");
  assert(base1.readRoot !== clone, "investigators read a base tree, not the local checkout");
  assert(
    (await fs.readFile(path.join(base1.readRoot, "policy.txt"), "utf8")) === "committed v1\n",
    "the base tree carries the committed origin content, not the dirty edit",
  );
  assert(
    !(await exists(path.join(base1.readRoot, "local-only.txt"))),
    "the stale local-only commit is not visible to investigators",
  );

  const state = await resolvePlanGitState(clone, base1);
  assert(state?.keySha === originV1, "the cache key is the origin/<default> SHA");

  // Origin moves: a new run gets a new base; the first run's tree is still live.
  await fs.writeFile(path.join(seed, "policy.txt"), "committed v2\n");
  await git(seed, [...cfg, "add", "-A"]);
  await git(seed, [...cfg, "commit", "-m", "v2"]);
  await git(seed, ["push", "-q", "origin", "main"]);
  const base2 = await openPlanBase(clone);
  held.push(base2);
  const state2 = await resolvePlanGitState(clone, base2);
  assert(
    state2?.keySha !== undefined && state2.keySha !== state?.keySha,
    "the cache key changes when origin/<default> moves",
  );
  assert(
    (await fs.readFile(path.join(base2.readRoot, "policy.txt"), "utf8")) === "committed v2\n",
    "after origin moves the new base tree carries the new content",
  );
  assert(
    await exists(path.join(base1.readRoot, "policy.txt")),
    "a live run's base tree is not retired by another run",
  );

  // Release removes this run's tree and only this run's.
  await base1.release();
  assert(!(await exists(base1.readRoot)), "release removes the run's own base tree");
  assert(await exists(base2.readRoot), "release leaves the other run's tree in place");
  await base2.release();
  assert(!(await exists(base2.readRoot)), "release of the second run removes its tree");

  // withPlanBase removes the run's tree in its finally, even when the callback throws.
  let treeInside = "";
  await withPlanBase(clone, async (b) => {
    treeInside = b.readRoot;
    throw new Error("boom");
  }).catch(() => undefined);
  assert(
    treeInside !== "" && !(await exists(treeInside)),
    "withPlanBase removes its tree when the callback throws",
  );

  // Fail open, reason recorded: an option-like default branch name is refused.
  await git(clone, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/-bad"]);
  const badName = await openPlanBase(clone);
  assert(
    badName.readRoot === clone && (badName.baseFallback ?? "").includes("-bad"),
    "a default branch named '-bad' is refused and the run reads the checkout",
  );
  assert(
    (await resolvePlanGitState(clone, badName)) === undefined,
    "a base fallback skips the investigation cache for the run",
  );
  // A name git rejects (check-ref-format) is a bad name, and the reason says so.
  // git's check-ref-format rejects a name (exit 1) → a bad-name reason; a name it
  // accepts has no problem. (git itself refuses to read an invalid symref, so the
  // rejection is asserted on the check directly.)
  assert(
    (await branchNameProblem(clone, "bad..name"))?.includes("is not a usable branch name") === true,
    "a name check-ref-format rejects is reported as a bad name",
  );
  assert((await branchNameProblem(clone, "main")) === undefined, "a valid name has no problem");
  await git(clone, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

  // Fail open, reason recorded: a failed fetch reads the checkout (not the last fetched ref).
  await git(clone, ["remote", "set-url", "origin", path.join(root, "missing.git")]);
  const failedFetch = await openPlanBase(clone);
  assert(
    failedFetch.readRoot === clone &&
      (failedFetch.baseFallback ?? "").includes("fetch origin main failed") &&
      !(failedFetch.baseFallback ?? "").includes("Command failed"),
    "a failed fetch reads the checkout and records git's stderr, not the Command-failed header",
  );
  assert(
    (await resolvePlanGitState(clone, failedFetch)) === undefined,
    "a failed fetch skips the investigation cache (no origin key for the run)",
  );
  await git(clone, ["remote", "set-url", "origin", bare]);

  // Fail open: a repo with no origin/HEAD resolves no base and reads the checkout.
  const solo = path.join(root, "solo");
  await execFileP("git", ["init", "-b", "main", solo]);
  await fs.writeFile(path.join(solo, "a.txt"), "x\n");
  await git(solo, [...cfg, "add", "-A"]);
  await git(solo, [...cfg, "commit", "-m", "init"]);
  const soloBase = await openPlanBase(solo);
  assert(soloBase.baseSha === undefined, "no origin/HEAD: no base SHA");
  assert(
    soloBase.baseFallback === "origin/HEAD is not set; investigators read the local checkout",
    "no origin/HEAD: the fallback is disclosed",
  );
  assert(soloBase.readRoot === solo, "no origin/HEAD: investigators read the checkout");
  assert(
    (await resolvePlanGitState(solo, soloBase)) === undefined,
    "no origin/HEAD: the cache is skipped (no origin key)",
  );

  // #1132: a symbolic-ref failure that is NOT a missing ref names its real cause.
  const notARepo = path.join(root, "does-not-exist");
  const brokenRead = await openPlanBase(notARepo);
  assert(
    (brokenRead.baseFallback ?? "").startsWith("could not read origin/HEAD: ") &&
      !(brokenRead.baseFallback ?? "").includes("is not set"),
    "an unreadable repo is reported as a read failure, not as origin/HEAD unset",
  );

  // #1132: a crashed run's base tree (older than 24h) is swept on the next run;
  // a recent foreign tree and this run's own tree are left alone.
  const baseRoot = path.join(clone, ".git", "pi-plan-base");
  await fs.mkdir(baseRoot, { recursive: true });
  const stale = path.join(baseRoot, "stale-crash");
  const recent = path.join(baseRoot, "recent-run");
  await git(clone, ["worktree", "add", "--detach", stale, originV1]);
  await git(clone, ["worktree", "add", "--detach", recent, originV1]);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await fs.utimes(stale, old, old);
  const sweepRun = await openPlanBase(clone);
  held.push(sweepRun);
  assert(!(await exists(stale)), "a base tree older than 24h from a crashed run is swept");
  assert(await exists(recent), "a recent base tree from another run is left in place");
  assert(await exists(sweepRun.readRoot), "the sweeping run keeps its own base tree");
  await git(clone, ["worktree", "remove", "--force", recent]);
} finally {
  for (const b of held) await b.release();
  setPlanGitStateFn(null);
  await fs.rm(root, { recursive: true, force: true });
}

process.exit(exit);
