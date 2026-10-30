#!/usr/bin/env bun
/**
 * lean/challenge — a budget-stopped round leaves a clean tree (#1883).
 *
 * A killed adversary can leave files behind, and `verify` refuses a dirty tree.
 * `runTestPipeline` is the only other place the worktree is reset, and a budget
 * stop returns before it, so the stop resets the tree itself, to the head the
 * step found, through the same reset and clean-tree proof the pipeline uses.
 * That reset's `clean -fdx` also takes the dependency links, so the stop
 * provisions again after it, as `build` does.
 *
 *   (a) a budget stop with a stray file in the tree -> `budget`, a clean tree, HEAD unchanged
 *   (b) a budget stop with a dependency link in the tree -> the link is provisioned again
 */

import { appendFileSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { provisionWorktree } from "../src/worktree-provision.ts";
import type { ExecFn } from "../src/worktree.ts";
import { gitEnvFor } from "./lib/lean-build-fixture.ts";
import {
  ROOTS,
  challengeFixture,
  git,
  put,
  runChallenge,
  status,
} from "./lib/lean-challenge-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ----------------------------- (a) a stop with stray work leaves a clean tree
{
  const stray = "tests/AC1-killed-half-written.test.sh";
  const r = await runChallenge({
    issue: 221,
    child: (wt) => put(wt, stray, "#!/usr/bin/env bash\necho half written\n"),
    challengeMinutes: 15,
  });
  assert(r.threw === undefined, `(a) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "budget", `(a) the outcome is budget (got ${r.outcome?.kind})`);
  assert(r.dispatched === 1, `(a) exactly one adversary dispatched (got ${r.dispatched})`);
  assert(
    status(r.worktree) === "",
    `(a) git status is empty after the stop (got ${status(r.worktree)})`,
  );
  const head = git(r.worktree, "rev-parse", "HEAD");
  assert(
    head === r.headBefore,
    `(a) HEAD equals the head the step found (${head} vs ${r.headBefore})`,
  );
}

// ----------------------- (b) a stop re-provisions the dependency links it removed
{
  // A dependency tree the main checkout ignores, linked into the worktree by the
  // same `provisionWorktree` every step's tree goes through. The exclude entry is
  // what makes the tree gitignored, so the provisioner is willing to link it.
  const built = challengeFixture(222);
  const depDir = path.join(built.repoRoot, "node_modules", "dep");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(path.join(depDir, "index.js"), "module.exports = 1;\n");
  const exclude = path.join(built.repoRoot, ".git", "info", "exclude");
  mkdirSync(path.dirname(exclude), { recursive: true });
  appendFileSync(exclude, "node_modules\n");
  const exec: ExecFn = (cmd, o) => execp(cmd, { ...o, env: gitEnvFor() });
  await provisionWorktree(exec, built.repoRoot, built.worktree);
  const link = path.join(built.worktree, "node_modules");
  assert(
    existsSync(link) && lstatSync(link).isSymbolicLink(),
    "(b) precondition: the dependency link is in the tree before the stop",
  );
  const r = await runChallenge({
    issue: 222,
    built,
    child: (wt) => put(wt, "tests/AC1-half-written.test.sh", "#!/usr/bin/env bash\n"),
    challengeMinutes: 15,
  });
  assert(r.threw === undefined, `(b) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "budget", `(b) the outcome is budget (got ${r.outcome?.kind})`);
  assert(
    existsSync(link) && lstatSync(link).isSymbolicLink(),
    "(b) the dependency link is provisioned again after the stop",
  );
  assert(existsSync(path.join(link, "dep", "index.js")), "(b) and it reaches the dependency tree");
  assert(
    status(r.worktree) === "",
    `(b) git status is still empty after the stop (got ${status(r.worktree)})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
