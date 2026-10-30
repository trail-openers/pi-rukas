#!/usr/bin/env bun
/**
 * lean/challenge — a budget-stopped round leaves a clean tree (#1883).
 *
 * A killed adversary can leave files behind, and `verify` refuses a dirty tree.
 * `runTestPipeline` is the only other place the worktree is reset, and a budget
 * stop returns before it, so the stop resets the tree itself, to the head the
 * step found, through the same reset and clean-tree proof the pipeline uses.
 *
 *   (a) a budget stop with a stray file in the tree -> `budget`, a clean tree, HEAD unchanged
 */

import { ROOTS, git, put, runChallenge, status } from "./lib/lean-challenge-fixture.ts";

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

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
