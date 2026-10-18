#!/usr/bin/env bun
/**
 * Smoke test (#1391): the retry save-then-clean, against real git.
 *
 * A lost step child leaves its edits in the worktree the retry dispatches into.
 * `cleanWorktreeForRetry` must save them (durable ref + patch) BEFORE it resets,
 * spare the driver's `.pi/` and `tmp/`, refuse to reset a tree with commits,
 * leave the tree untouched when the save fails, and reset a lens-fix tree to
 * its own HEAD — never the cycle base. The reposition gate must route a lost
 * attempt's dirt through the same primitive and still park on operator dirt
 * without a single git write.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";
import { cleanWorktreeForRetry, preservedRefFor } from "../src/work-retry-tree-clean.ts";
import { initialState } from "../src/workflow-state.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { realExec } from "./lib/exec-fake.ts";
import { gitIn } from "./lib/git-worktree-fixture.ts";
import { at, dirty, recorder, retryFixture } from "./lib/retry-tree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function stateFor(wt: string, baseSha: string): WorkState {
  const s = initialState(1391, 1);
  return {
    ...s,
    pipelineState: { ...s.pipelineState, baseSha, worktrees: { default: wt } },
  };
}

const status = (wt: string) => gitIn(wt, ["status", "--porcelain"]).trim();
const dirs: string[] = [];

// 1. develop: saved to a ref and a patch, then reset to the base; .pi/ and tmp/ survive.
{
  const f = retryFixture("develop");
  dirs.push(f.dir);
  // A develop tree sits at its base: put it there.
  gitIn(f.wt, ["checkout", "-q", "--detach", f.baseSha]);
  dirty(f.wt);
  const { exec, calls } = recorder();
  const r = await cleanWorktreeForRetry({
    execFn: exec,
    repoRoot: f.repo,
    issue: 1391,
    step: "develop",
    state: stateFor(f.wt, f.baseSha),
  });
  assert(r.kind === "cleaned", `develop: cleaned (got ${r.kind})`);
  if (r.kind === "cleaned") {
    assert(r.ref === preservedRefFor(1391, "develop", 1), "develop: the first save is ref -1");
    assert(
      gitIn(f.repo, ["show", `${r.ref}:new.txt`]).trim() === "new",
      "develop: the ref holds the new file",
    );
    assert(
      gitIn(f.repo, ["show", `${r.ref}:a.txt`]).trim() === "half-written",
      "develop: the ref holds the edit",
    );
    assert(existsSync(r.patch), "develop: the patch exists");
    assert(r.files.includes("a.txt") && r.files.includes("new.txt"), "develop: files named");
    gitIn(f.wt, ["apply", "--check", r.patch]);
    assert(true, "develop: the patch re-applies to the cleaned tree");
  }
  assert(
    !status(f.wt).includes("a.txt") && !status(f.wt).includes("new.txt"),
    "develop: work gone from the tree",
  );
  assert(readFileSync(path.join(f.wt, "a.txt"), "utf8") === "one\n", "develop: reset to the base");
  assert(existsSync(path.join(f.wt, ".pi", "verify-cmd")), "develop: .pi/ survives the clean");
  assert(existsSync(path.join(f.wt, "tmp", "issue-1391", "notes.txt")), "develop: tmp/ survives");
  const ref = at(calls, "update-ref");
  const diff = at(calls, "diff", "--binary", "--cached");
  const reset = at(calls, "reset", "--hard");
  const clean = at(calls, "clean", "-fd");
  assert(
    at(calls, "commit-tree") < ref && ref < diff && diff < reset && reset < clean && ref > 0,
    "develop: commit-tree → update-ref → patch diff → reset → clean, in that order",
  );
  const again = await cleanWorktreeForRetry({
    execFn: realExec,
    repoRoot: f.repo,
    issue: 1391,
    step: "develop",
    state: stateFor(f.wt, f.baseSha),
  });
  assert(again.kind === "none", "develop: a second pass over the clean tree is a no-op");
  // A second lost attempt never overwrites the first save.
  writeFileSync(path.join(f.wt, "a.txt"), "attempt two\n");
  const second = await cleanWorktreeForRetry({
    execFn: realExec,
    repoRoot: f.repo,
    issue: 1391,
    step: "develop",
    state: stateFor(f.wt, f.baseSha),
  });
  assert(
    second.kind === "cleaned" &&
      second.ref.endsWith("develop-2") &&
      second.patch.endsWith("-2.patch"),
    "develop: the second save gets its own ref and patch",
  );
}

// 2. develop with commits ahead of the base: kept, nothing touched.
{
  const f = retryFixture("ahead");
  dirs.push(f.dir);
  dirty(f.wt); // the worktree is at the branch, one commit ahead of baseSha
  const { exec, calls } = recorder();
  const r = await cleanWorktreeForRetry({
    execFn: exec,
    repoRoot: f.repo,
    issue: 1391,
    step: "develop",
    state: stateFor(f.wt, f.baseSha),
  });
  assert(r.kind === "kept", `ahead: kept (got ${r.kind})`);
  assert(at(calls, "reset") === -1 && at(calls, "add") === -1, "ahead: no stage, no reset");
  assert(readFileSync(path.join(f.wt, "a.txt"), "utf8") === "half-written\n", "ahead: work intact");
}

// 3. A failed save: the tree is untouched and nothing destructive runs.
{
  const f = retryFixture("fail");
  dirs.push(f.dir);
  gitIn(f.wt, ["checkout", "-q", "--detach", f.baseSha]);
  dirty(f.wt);
  const before = status(f.wt);
  const { exec, calls } = recorder("update-ref");
  const r = await cleanWorktreeForRetry({
    execFn: exec,
    repoRoot: f.repo,
    issue: 1391,
    step: "develop",
    state: stateFor(f.wt, f.baseSha),
  });
  assert(r.kind === "failed" && r.why.includes("could not save"), `fail: failed, naming the save`);
  assert(
    at(calls, "reset", "--hard") === -1 && at(calls, "clean") === -1,
    "fail: no reset, no clean",
  );
  assert(status(f.wt) === before, "fail: the tree and index are exactly as found");
  assert(readFileSync(path.join(f.wt, "a.txt"), "utf8") === "half-written\n", "fail: work intact");
}

// 4. lens-fix: reset to the tree's own HEAD (the branch tip), never the cycle base.
{
  const f = retryFixture("lens");
  dirs.push(f.dir);
  const tip = gitIn(f.wt, ["rev-parse", "HEAD"]).trim();
  dirty(f.wt);
  const r = await cleanWorktreeForRetry({
    execFn: realExec,
    repoRoot: f.repo,
    issue: 1391,
    step: "lens-fix",
    state: stateFor(f.wt, f.baseSha),
  });
  assert(r.kind === "cleaned", `lens: cleaned (got ${r.kind})`);
  assert(gitIn(f.wt, ["rev-parse", "HEAD"]).trim() === tip, "lens: HEAD stays at the tip");
  assert(readFileSync(path.join(f.wt, "a.txt"), "utf8") === "two\n", "lens: round-1 work kept");
  // An unpushed commit is left for the #749 integration, not reset.
  writeFileSync(path.join(f.wt, "fix.txt"), "fix\n");
  gitIn(f.wt, ["add", "fix.txt"]);
  gitIn(f.wt, ["commit", "-q", "-m", "fix"]);
  writeFileSync(path.join(f.wt, "a.txt"), "more\n");
  const kept = await cleanWorktreeForRetry({
    execFn: realExec,
    repoRoot: f.repo,
    issue: 1391,
    step: "lens-fix",
    state: stateFor(f.wt, f.baseSha),
  });
  assert(kept.kind === "kept", `lens: a committed fix is kept (got ${kept.kind})`);
}

// 5. Steps without an owned tree, and repoRoot, are never touched.
{
  const f = retryFixture("none");
  dirs.push(f.dir);
  dirty(f.wt);
  const { exec, calls } = recorder();
  const adv = await cleanWorktreeForRetry({
    execFn: exec,
    repoRoot: f.repo,
    issue: 1391,
    step: "adversarial",
    state: stateFor(f.wt, f.baseSha),
  });
  const root = await cleanWorktreeForRetry({
    execFn: exec,
    repoRoot: f.repo,
    issue: 1391,
    step: "develop",
    state: stateFor(f.repo, f.baseSha),
  });
  assert(adv.kind === "none" && root.kind === "none", "none: adversarial and repoRoot untouched");
  assert(calls.length === 0, "none: not one git call");
  const outside = await cleanWorktreeForRetry({
    execFn: exec,
    repoRoot: f.repo,
    issue: 1391,
    step: "develop",
    state: stateFor(f.wt, f.baseSha),
    tree: f.repo,
  });
  assert(outside.kind === "failed", "none: an explicit tree outside .worktrees/ is refused");
}

// 6. The reposition gate: operator dirt parks with no write; a lost attempt's dirt is cleaned.
{
  const f = retryFixture("gate");
  dirs.push(f.dir);
  writeFileSync(path.join(f.wt, "a.txt"), "operator\n");
  const op = recorder();
  const parked = await repositionLensFixWorktree(op.exec, f.wt, f.branch, [1391], "t");
  assert(parked.kind === "dirty" && parked.attemptLost !== true, "gate: operator dirt parks");
  const writes = op.calls.filter((c) =>
    ["add", "reset", "clean", "update-ref"].includes(c[0] ?? ""),
  );
  assert(writes.length === 0, "gate: operator dirt sees no stage, reset, clean or ref");
  assert(
    readFileSync(path.join(f.wt, "a.txt"), "utf8") === "operator\n",
    "gate: operator work intact",
  );

  const lost = { repoRoot: f.repo, issue: 1391, state: stateFor(f.wt, f.baseSha) };
  const rep = await repositionLensFixWorktree(realExec, f.wt, f.branch, [1391], "t", lost);
  assert(
    rep.kind === "already-at-tip",
    `gate: a lost attempt's dirt is cleaned and the gate passes (got ${rep.kind})`,
  );
  assert(
    gitIn(f.repo, ["show", `${preservedRefFor(1391, "lens-fix", 1)}:a.txt`]).trim() === "operator",
    "gate: the residue is saved under the lens-fix ref",
  );

  // A failed save under the lost-attempt flag still parks, attributed, with the tree intact.
  writeFileSync(path.join(f.wt, "a.txt"), "again\n");
  const bad = recorder("write-tree");
  const still = await repositionLensFixWorktree(bad.exec, f.wt, f.branch, [1391], "t", lost);
  assert(
    still.kind === "dirty" && still.attemptLost === true && still.detail.includes("NOT cleaned"),
    "gate: a failed save parks, attributed to the lost attempt",
  );
  assert(
    readFileSync(path.join(f.wt, "a.txt"), "utf8") === "again\n",
    "gate: the residue is intact",
  );
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
process.exit(exit);
