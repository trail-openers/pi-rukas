#!/usr/bin/env bun
/**
 * #1132 addendum (decision 3) — investigators read origin/<default>, not the
 * working tree; the investigation cache key uses that SHA.
 *
 * Real git, in temp dirs: a bare origin, a clone whose working tree is dirty
 * and stale. Asserts: the base tree carries the committed origin content; the
 * cache key moves when origin moves; a missing origin fails open.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fetchOriginBase, planReadRoot } from "../src/plan-base-tree.ts";
import { resolvePlanGitState, setPlanGitStateFn } from "../src/plan-investigation-cache.ts";

const execFileP = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await execFileP("git", ["-C", cwd, ...args], { timeout: 60_000 })).stdout.trim();

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
  // The clone's remote HEAD must name the default branch (what detectMainline reads).
  await git(clone, ["remote", "set-head", "origin", "main"]);

  // Dirty and stale: an uncommitted edit, and a local commit origin does not have.
  await fs.writeFile(path.join(clone, "policy.txt"), "LOCAL UNCOMMITTED EDIT\n");
  await fs.writeFile(path.join(clone, "local-only.txt"), "not on origin\n");
  await git(clone, [...cfg, "add", "-A"]);
  await git(clone, [...cfg, "commit", "-m", "local only"]);

  const originV1 = await git(bare, ["rev-parse", "main"]);
  const baseSha = await fetchOriginBase(clone);
  assert(baseSha === originV1, "fetchOriginBase resolves origin/<default>, not the local HEAD");

  const state = await resolvePlanGitState(clone);
  assert(state?.head === originV1, "the cache key is the origin/<default> SHA");
  assert(state?.baseSha === originV1, "the run records the base SHA investigators read");

  const readRoot = await planReadRoot(clone, state);
  assert(readRoot !== clone, "investigators read a base tree, not the local checkout");
  assert(
    (await fs.readFile(path.join(readRoot, "policy.txt"), "utf8")) === "committed v1\n",
    "the base tree carries the committed origin content, not the dirty edit",
  );
  let staleVisible = true;
  try {
    await fs.access(path.join(readRoot, "local-only.txt"));
  } catch {
    staleVisible = false;
  }
  assert(!staleVisible, "the stale local-only commit is not visible to investigators");
  assert(
    (await planReadRoot(clone, state)) === readRoot,
    "a second call with the same origin SHA reuses the base tree",
  );

  // Origin moves: the key moves, and the base tree is replaced (only one is kept).
  await fs.writeFile(path.join(seed, "policy.txt"), "committed v2\n");
  await git(seed, [...cfg, "add", "-A"]);
  await git(seed, [...cfg, "commit", "-m", "v2"]);
  await git(seed, ["push", "-q", "origin", "main"]);
  const state2 = await resolvePlanGitState(clone);
  assert(
    state2?.head !== undefined && state2.head !== state.head,
    "the cache key changes when origin/<default> moves",
  );
  const readRoot2 = await planReadRoot(clone, state2);
  assert(
    (await fs.readFile(path.join(readRoot2, "policy.txt"), "utf8")) === "committed v2\n",
    "after origin moves the base tree carries the new content",
  );
  let oldKept = true;
  try {
    await fs.access(readRoot);
  } catch {
    oldKept = false;
  }
  assert(!oldKept, "the superseded base tree is retired");

  // Fail open: a repo with no origin/HEAD resolves no base and reads the checkout.
  const solo = path.join(root, "solo");
  await execFileP("git", ["init", "-b", "main", solo]);
  await fs.writeFile(path.join(solo, "a.txt"), "x\n");
  await git(solo, [...cfg, "add", "-A"]);
  await git(solo, [...cfg, "commit", "-m", "init"]);
  assert((await fetchOriginBase(solo)) === undefined, "no origin: no base SHA");
  const soloState = await resolvePlanGitState(solo);
  assert(
    soloState?.baseSha === undefined && soloState?.head !== undefined,
    "no origin: the cache keys on local HEAD and the run reads the checkout",
  );
  assert(
    (await planReadRoot(solo, soloState)) === solo,
    "no origin: investigators read the checkout",
  );
} finally {
  setPlanGitStateFn(null);
  await fs.rm(root, { recursive: true, force: true });
}

process.exit(exit);
