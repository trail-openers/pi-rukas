#!/usr/bin/env bun
/**
 * #1852 — the lens-fix landing arm pushes an out-of-fence change, and the gate
 * is what stops it.
 *
 * NON-VACUITY FOR THE GATE. The other #1852 tests prove the fence's parts
 * (`test-lens-fix-fence-gate.ts` judges a tree; `test-lens-fix-prompt-fence.ts`
 * pins the prompt). This one drives the STEP: a real repo, a real `.worktrees/`
 * tree, a lens-fix approval whose `lastCompletedStep` is `lens-fix`, and a
 * fixer's commit that changes a file the workstream fenced `outOfScope`.
 *
 * On base (before #1852) that commit is committed and pushed by the landing arm
 * with nobody consulting a fence: `git rev-list --count origin/<base>..HEAD`
 * grows and the push is attempted. With the gate, the round parks on
 * `lens-fix-scope`, the landing arm never runs, and NEITHER happens. The
 * assertions are on git's answer and on the push being attempted, not on a
 * string in a log.
 *
 * The revert-record cases (the `ok: true` arm, and the one-revert allowance
 * across a retried step) are in `test-lens-fix-fence-landing-revert.ts`; the
 * repo/context builders both files share are in
 * `lib/lens-fix-landing-fixtures.ts`.
 */

import { rmSync } from "node:fs";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import { git } from "./lib/adversarial-fix-fixtures.ts";
import { fixture, fixtureInFence, stateWith, stubCtx } from "./lib/lens-fix-landing-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function cleanup(repoRoot: string): void {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(`${repoRoot}-origin`, { recursive: true, force: true });
}

console.log("# an out-of-fence lens fix does not reach the branch");
{
  // #1852-4 — the base-vs-head proof is driven THROUGH this file rather than by
  // importing the new fence modules, so the same file runs against base sources
  // too: on base the driver has no lens-fix scope fence, so the SAME fixture
  // that parks here integrates the widening onto the branch. DEFAULT (no env) is
  // the HEAD expectation, because this is the file the offline suite runs.
  // `PI_1852_EXPECT=base` selects the base expectation, and the driver runs it
  // against a copy of the pre-#1852 sources — if those assertions also held
  // there, the head-side ones below would be vacuous.
  const hasFence = process.env.PI_1852_EXPECT !== "base";
  const f = fixture("land-blocked");
  const st = await stateWith(f.repoRoot, f.tree, f.branch, hasFence);
  const before = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const pushes: string[] = [];
  const ctx = stubCtx(f.repoRoot, pushes);

  const out = await runAdversarial(ctx, st, 2_000_000);
  const after = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const caps = out.eventLog
    .filter((e) => e.kind === "cap-hit")
    .map((e) => (e as { cap: string }).cap);
  if (!hasFence) {
    // BASE: no fence exists, so the widening is integrated and the branch moves.
    // If this holds on base, every assertion below would hold there too.
    assert(
      !caps.includes("lens-fix-scope"),
      `base has no lens-fix fence to park on (caps: ${JSON.stringify(caps)})`,
    );
    assert(
      Number(after) > Number(before),
      `NON-VACUITY: on base the out-of-fence change REACHES the branch (${before} -> ${after} commits) — the hole #1852 closes`,
    );
    cleanup(f.repoRoot);
    console.log(`\nexit ${exit}`);
    process.exit(exit);
  }
  assert(
    caps.includes("lens-fix-scope"),
    `the round parked on the lens-fix scope cap (caps seen: ${JSON.stringify(caps)})`,
  );
  assert(
    out.eventLog.some(
      (e) => e.kind === "cap-hit" && e.cap === "lens-fix-scope" && e.lensWorktreePath === f.tree,
    ),
    "the park names the tree the operator has to open",
  );
  assert(
    !out.eventLog.some((e) => e.kind === "lens-fix-committed"),
    "the landing arm did not commit the out-of-fence change",
  );
  assert(
    before === after,
    `the branch still has ${before} commits — the widening was not integrated`,
  );
  assert(
    !pushes.some((p) => p.includes("push")),
    `no push was attempted (attempts: ${JSON.stringify(pushes)})`,
  );
  const cap = out.eventLog.find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-scope") as
    | { evidence?: string }
    | undefined;
  assert(
    (cap?.evidence ?? "").includes("b.txt"),
    "the park reason names the file the fixer had no business touching",
  );
  cleanup(f.repoRoot);
}

console.log("# a round that RECORDS a fence failure does not land");
{
  // Fail closed. The round's own step said it could not build the fence, so the
  // record is on the log and the gate refuses rather than letting a landing arm
  // push work nothing checked.
  const f = fixture("land-lost-fence");
  const st = await stateWith(f.repoRoot, f.tree, f.branch, false, true);
  const before = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const ctx = stubCtx(f.repoRoot, []);
  const out = await runAdversarial(ctx, st, 2_000_000);
  const after = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const caps = out.eventLog
    .filter((e) => e.kind === "cap-hit")
    .map((e) => (e as { cap: string }).cap);
  assert(
    caps.includes("lens-fix-scope"),
    `a round with a recorded fence failure parks (caps: ${JSON.stringify(caps)})`,
  );
  assert(
    before === after,
    `and nothing was integrated (${before} -> ${after}) — the gate is what stopped it, not the tree`,
  );
  cleanup(f.repoRoot);
}

console.log("# a state with NO fence record is not judged by the gate");
{
  // The other half of the rule, and the one that keeps #1852 from being a
  // schema break: an older driver wrote this state, so there is no fence and no
  // fence failure. The gate does not run and the landing arms behave as before.
  const f = fixture("land-no-record");
  const st = await stateWith(f.repoRoot, f.tree, f.branch, false, false);
  const before = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const ctx = stubCtx(f.repoRoot, []);
  const out = await runAdversarial(ctx, st, 2_000_000);
  const caps = out.eventLog
    .filter((e) => e.kind === "cap-hit")
    .map((e) => (e as { cap: string }).cap);
  assert(
    !caps.includes("lens-fix-scope"),
    `no record, no gate: the round is not parked by a fence it never had (caps: ${JSON.stringify(caps)})`,
  );
  void before;
  cleanup(f.repoRoot);
}

console.log("# an in-fence lens fix still reaches the branch");
{
  // The SAME fixture shape, minus the out-of-fence commit — built rather than
  // undone, because `reset --hard` would strand that commit outside every ref
  // and `integrate()` reads the round's work through a ref range.
  const f = fixtureInFence("land-allowed");
  const st = await stateWith(f.repoRoot, f.tree, f.branch);
  const before = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const ctx = stubCtx(f.repoRoot);
  const out = await runAdversarial(ctx, st, 2_000_000);
  const caps = out.eventLog
    .filter((e) => e.kind === "cap-hit")
    .map((e) => (e as { cap: string }).cap);
  const after = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  assert(
    !caps.includes("lens-fix-scope"),
    `an in-fence round is not parked by the fence (caps: ${JSON.stringify(caps)})`,
  );
  assert(
    Number(after) > Number(before),
    `the fix landed: the branch moved from ${before} to ${after} commits — the gate does not block what it should admit`,
  );
  cleanup(f.repoRoot);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
