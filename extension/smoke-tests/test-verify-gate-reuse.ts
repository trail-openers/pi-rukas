#!/usr/bin/env bun
/**
 * #1415 (task C) — offline coverage for REUSING a passing consolidated verify
 * across develop rounds instead of re-running the project's whole gate.
 *
 * example-owner/orchard#261 cycle 261: the driver ran the consolidated verify after
 * EVERY develop round. Three rounds × ~22 min = ~67 of the cycle's ~150
 * minutes, with nothing written to the console while it ran. Task A's fix
 * lets a round whose tree a previous consolidated pass already judged reuse
 * that verdict instead of executing the command again.
 *
 * What is pinned here is the property the fix must keep: **a reuse is only
 * ever a saving, never a lost check.** So every case below counts executions
 * of the project's verify command and asks one question — did it run? — and
 * each negative case is paired with the positive it guards. A rule that
 * reused everything and a rule that reused nothing both pass a test that
 * only asserts "no run"; they are separated here by the paired control in
 * every block.
 *
 * Why the seam is reached through `runConsolidatedVerify` rather than the
 * reuse decision function: this file's job is to observe the outcome a
 * developer of task A cannot get wrong — no command executed, yet the pass
 * still reports the picks it applied. Reaching it through the gate
 * (`verifyStepOutcome`) is task #1240's harness
 * (`test-work-driver-consolidated-verify-skip.ts`); this file deliberately
 * does not re-test that harness. The one gate-level reuse case is included
 * (case 6) because a reuse wired only into the probe and not into the gate
 * would be invisible to the operator.
 *
 * The executor counts verify-command runs only; git reads are free, so a
 * counted run never perturbs the tree whose identity the decision rests on.
 *
 * Escape hatch under test: `PI_ENSEMBLE_VERIFY_REUSE=0` (and the pre-existing
 * `PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP=0`, which also suppresses the reuse —
 * the always-run hatch has to be able to restore the always-run shape).
 */

import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type ConsolidatedVerifyResult,
  runConsolidatedVerify,
} from "../src/work-driver-consolidated-verify.ts";
import { VERIFY_TIMEOUT_LABEL, verifyCapFor } from "../src/work-driver-verify-develop-helpers.ts";
import { recordDevelopGateEvents } from "../src/work-driver-verify-events.ts";
import { verifyTreeId } from "../src/work-driver-verify-tree.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  type Runs,
  asRecord,
  commitAndIdentify,
  consOpts,
  execFileP,
  fixture,
  git,
  installVerifyCmd,
  makeExec,
  root,
  seamReady,
} from "./lib/verify-gate-reuse-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

try {
  // ================================================================== case 1
  // THE REUSE ITSELF: the probe the picks produced is the tree a previous
  // consolidated pass judged → the command does NOT run, and the pass still
  // reports the picks it applied (so a reuse is not a lost cherry-pick).
  // Paired with case 2, which is the same fixture with a different tree.
  if (seamReady) {
    const f = await fixture("reuse-same-tree", ["default"]);
    const verifyCmd = installVerifyCmd(f.repo, "never-written.txt");
    const tree = await commitAndIdentify(f.worktrees.default as string, "a.txt", "task: add a");

    const runs: Runs = [];
    const res: ConsolidatedVerifyResult = await runConsolidatedVerify(
      makeExec({ runs, repoRoot: f.repo }),
      consOpts(
        f,
        { default: f.worktrees.default as string },
        verifyCmd,
        asRecord(tree, verifyCmd),
      ) as never,
    );
    assert(res.status === "passed", `reuse: a matching tree still passes the gate (${res.status})`);
    assert(
      runs.length === 0,
      `reuse: the verify command did NOT execute at repoRoot (runs: ${JSON.stringify(runs)})`,
    );
    const applied = res.status === "passed" ? res.applied : [];
    assert(
      applied.length > 0,
      `reuse: the pass still reports the workstream commits it applied (applied: ${JSON.stringify(applied)})`,
    );
    const reused =
      res.status === "passed"
        ? ((res as { reused?: AlreadyVerifiedTree }).reused ??
          (res as { reusedTree?: AlreadyVerifiedTree }).reusedTree)
        : undefined;
    assert(
      reused !== undefined && reused.treeHash === tree.treeHash,
      `reuse: the result names the pass whose verdict it carries (reused: ${JSON.stringify(reused)})`,
    );
    // The reuse must never be reported as #1240's skip — different claim, and
    // an operator reading "already passed in <worktree>" would look for a
    // per-worktree run that never happened.
    const skipShape = res.status === "passed" ? (res as { skipped?: unknown }).skipped : undefined;
    assert(
      skipShape === undefined,
      `reuse: a reused verdict is not reported as #1240's per-worktree skip (skipped: ${JSON.stringify(skipShape)})`,
    );
  }

  // ================================================================== case 2
  // ANTI-VACUITY — same fixture, a tree the previous pass never judged (the
  // recorded hash is another tree's). The command MUST run. Without this case
  // every assertion above passes when the comparison is forced to "equal".
  if (seamReady) {
    const f = await fixture("reuse-different-tree", ["a", "b"]);
    const verifyCmd = installVerifyCmd(f.repo, "never-written.txt");
    const treeA = await commitAndIdentify(f.worktrees.a as string, "a.txt", "task-a");
    await commitAndIdentify(f.worktrees.b as string, "b.txt", "task-b");

    const runs: Runs = [];
    const res = await runConsolidatedVerify(
      makeExec({ runs, repoRoot: f.repo }),
      consOpts(
        f,
        { a: f.worktrees.a as string, b: f.worktrees.b as string },
        verifyCmd,
        // The recorded identity covers workstream a's tree alone; the probe
        // now combines BOTH, so it is not the tree that passed.
        asRecord(treeA, verifyCmd),
      ) as never,
    );
    assert(
      runs.filter((r) => path.resolve(r.cwd) === path.resolve(f.repo)).length === 1,
      `reuse refused: a probe combining two workstreams is not the recorded tree — the command ran (runs: ${JSON.stringify(runs)})`,
    );
    assert(res.status === "passed", `reuse refused: and the run passed (${res.status})`);
    const reused = res.status === "passed" ? (res as { reused?: unknown }).reused : "n/a";
    assert(
      reused === undefined,
      `reuse refused: no reused verdict claimed (${JSON.stringify(reused)})`,
    );
  }

  // ================================================================== case 3
  // NO RECORDED PASS — the first consolidated verify of a cycle has nothing to
  // reuse, so the whole rule must be inert. (This is also the control that
  // makes case 1's `runs.length === 0` meaningful: same shape, one fewer
  // argument, and the command runs.)
  {
    const f = await fixture("reuse-no-record", ["default"]);
    const verifyCmd = installVerifyCmd(f.repo, "never-written.txt");
    await commitAndIdentify(f.worktrees.default as string, "a.txt", "task: add a");

    const runs: Runs = [];
    await runConsolidatedVerify(
      makeExec({ runs, repoRoot: f.repo }),
      consOpts(f, { default: f.worktrees.default as string }, verifyCmd) as never,
    );
    assert(
      runs.filter((r) => path.resolve(r.cwd) === path.resolve(f.repo)).length === 1,
      `no record: with no prior passing run the consolidated verify runs (runs: ${JSON.stringify(runs)})`,
    );
  }

  // ================================================================== case 4
  // A FAILED consolidated run must not leave a stale "this tree passed" record
  // standing: pass, then fail on the same tree, then re-enter. The third pass
  // runs the command — it cannot inherit the first pass's verdict through the
  // failure in the middle.
  if (seamReady) {
    const f = await fixture("reuse-after-failure", ["default"]);
    const verifyCmd = installVerifyCmd(f.repo, "never-written.txt");
    const tree = await commitAndIdentify(f.worktrees.default as string, "a.txt", "task: add a");
    const wt = { default: f.worktrees.default as string };

    const first: Runs = [];
    const r1 = await runConsolidatedVerify(
      makeExec({ runs: first, repoRoot: f.repo }),
      consOpts(f, wt, verifyCmd) as never,
    );
    assert(r1.status === "passed" && first.length === 1, "stale record: the first run passes");

    // A failed consolidated run invalidates the last passing one. The
    // re-entry assertion below is written against the recorded tree — the
    // only identity for which a reuse is even offered — so it isolates the
    // one thing under test: a record that a failed run sits on top of must
    // not be honoured.
    const second: Runs = [];
    const r2 = await runConsolidatedVerify(
      makeExec({ runs: second, repoRoot: f.repo }, { fail: () => true }),
      consOpts(f, wt, verifyCmd, asRecord(tree, verifyCmd)) as never,
    );
    assert(
      r2.status === "failed" && second.length === 1,
      `stale record: a failing consolidated run still fails and ran the command (${r2.status}, ${second.length} run(s))`,
    );

    const third: Runs = [];
    await runConsolidatedVerify(
      makeExec({ runs: third, repoRoot: f.repo }),
      consOpts(f, wt, verifyCmd, asRecord(tree, verifyCmd)) as never,
    );
    assert(
      third.filter((r) => path.resolve(r.cwd) === path.resolve(f.repo)).length === 1,
      `stale record: after a failed run the same tree is verified again, not reused (runs: ${JSON.stringify(third)})`,
    );
  }

  // ================================================================== case 5
  // THE ESCAPE HATCH. Identical shape to case 1 (so the hatch is the only
  // variable): PI_ENSEMBLE_VERIFY_REUSE=0 restores the always-run behaviour.
  if (seamReady) {
    const f = await fixture("reuse-hatch", ["default"]);
    const verifyCmd = installVerifyCmd(f.repo, "never-written.txt");
    const tree = await commitAndIdentify(f.worktrees.default as string, "a.txt", "task: add a");
    const wt = { default: f.worktrees.default as string };

    // Establish a genuine passing record on THIS tree with the hatch off…
    const warm: Runs = [];
    await runConsolidatedVerify(
      makeExec({ runs: warm, repoRoot: f.repo }),
      consOpts(f, wt, verifyCmd) as never,
    );
    assert(warm.length === 1, "hatch setup: the first consolidated run executed");
    const warmTree = await verifyTreeId(async (cmd, o) => {
      const opts = { cwd: o?.cwd, maxBuffer: 8 * 1024 * 1024 };
      const { stdout } = o?.argv
        ? await execFileP(cmd, o.argv, opts)
        : await execFileP("/bin/sh", ["-c", cmd], opts);
      return { stdout };
    }, f.worktrees.default as string);
    assert(warmTree === tree.treeHash, "hatch setup: the tree is unchanged by the run");

    // …then the SAME probe with the hatch off must run again.
    await withEnv({ PI_ENSEMBLE_VERIFY_REUSE: "0" }, async () => {
      const runs: Runs = [];
      await runConsolidatedVerify(
        makeExec({ runs, repoRoot: f.repo }),
        consOpts(f, wt, verifyCmd, asRecord(tree, verifyCmd)) as never,
      );
      assert(
        runs.filter((r) => path.resolve(r.cwd) === path.resolve(f.repo)).length === 1,
        `escape hatch: PI_ENSEMBLE_VERIFY_REUSE=0 runs the consolidated verify anyway (runs: ${JSON.stringify(runs)})`,
      );
    });

    // The documented always-run hatch for #1240 also covers the reuse: one
    // knob restoring "the gate always runs" must not be defeated by the newer,
    // narrower one.
    await withEnv({ PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP: "0" }, async () => {
      const runs: Runs = [];
      await runConsolidatedVerify(
        makeExec({ runs, repoRoot: f.repo }),
        consOpts(f, wt, verifyCmd, asRecord(tree, verifyCmd)) as never,
      );
      assert(
        runs.filter((r) => path.resolve(r.cwd) === path.resolve(f.repo)).length === 1,
        `escape hatch: PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP=0 also restores the run (runs: ${JSON.stringify(runs)})`,
      );
    });

    // And with both unset the reuse is available again (the hatch did not latch).
    const runs: Runs = [];
    await runConsolidatedVerify(
      makeExec({ runs, repoRoot: f.repo }),
      consOpts(f, wt, verifyCmd, asRecord(tree, verifyCmd)) as never,
    );
    assert(
      runs.length === 0,
      `escape hatch: and with the knob unset the reuse is back on (runs: ${JSON.stringify(runs)})`,
    );
  }

  // ================================================================== case 6
  // THROUGH THE DEVELOP GATE — the shape from the incident: one workstream,
  // two develop rounds, nothing written between them. The second round reuses
  // and the project's command executes ONCE at repoRoot, not twice.
  //
  // Round 2 sees round 1's records the way the driver hands them on: through
  // `recordDevelopGateEvents`, the one place every develop seam folds a gate
  // result into the state. (Passing the same state to both rounds can never
  // reuse — the records live on the state the caller owns.)
  //
  // The control runs the same two rounds with PI_ENSEMBLE_VERIFY_GATE_REUSE=0 and
  // must execute it exactly once MORE (not "twice from zero"): under #1240 the
  // first round's consolidated probe is already skipped by the per-worktree
  // pass, so an always-run control is `reused + 1`. Asserting a literal 2
  // would be a control that measures something other than what it claims.
  {
    // The probe's dirty-root preflight refuses a root holding untracked,
    // non-ignored files, so here the project's gate is COMMITTED at repoRoot:
    // an untracked verify-cmd would make the probe decline for a reason
    // unrelated to reuse, and the count would read 0 with or without the
    // feature — a control that measures nothing.
    //
    // The N=1 #1240 skip is pinned OFF for this pair. With it on, the first
    // round's probe is already skipped by its own per-worktree pass, both
    // controls would count 0, and the assertion would be about #1240 rather
    // than about this feature. With it off the ONLY thing that can drop the
    // second round's execution is the reuse.
    const developRounds = async (reuseOff: boolean): Promise<number> => {
      const f = await fixture(`gate-rounds-${reuseOff ? "off" : "on"}`, ["default"]);
      const wt = f.worktrees.default as string;
      writeFileSync(path.join(wt, "a.txt"), "a\n");
      await git(wt, ["add", "."]);
      await git(wt, ["commit", "-q", "-m", "task: add a"]);
      // The project's gate, COMMITTED so the probe's preflight stays clean.
      // `never-written` is repo-specific: the executor counts any run of this
      // command, and the same process runs both controls below, so a shared
      // marker would let the first control's runs satisfy the second's count.
      writeFileSync(
        path.join(f.repo, ".pi", "verify-cmd"),
        `sh -c 'echo run >> never-written-${reuseOff ? "off" : "on"}.txt'\n`,
      );
      await git(f.repo, ["add", "."]);
      await git(f.repo, ["commit", "-q", "-m", "chore: add the project gate"]);
      await git(f.repo, ["push", "-q", "origin", "main"]);

      const runs: Runs = [];
      const exec = makeExec({ runs, repoRoot: f.repo });
      const base = initialState(1415, 1_000_000);
      const state = {
        ...base,
        pipelineState: {
          ...base.pipelineState,
          branchName: "feature/issue-1415",
          baseSha: f.baseSha,
          worktrees: { default: wt },
          workstreams: { default: { id: "default", scope: "s", paths: [], outOfScope: [] } },
        },
      };
      const ctx = {
        host: { sendUserMessage: () => {} } as never,
        repoRoot: f.repo,
        issue: 1415,
        verifyExecFn: exec,
      } as never;
      const env = {
        PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP: "0",
        ...(reuseOff ? { PI_ENSEMBLE_VERIFY_GATE_REUSE: "0" } : {}),
      };
      await withEnv(env, async () => {
        const g1 = await verifyStepOutcome(ctx, state, "develop");
        assert(g1.ok, `gate rounds: round 1 passes (${g1.failures.join(" | ").slice(0, 200)})`);
        const g2 = await verifyStepOutcome(ctx, recordDevelopGateEvents(state, g1), "develop");
        assert(g2.ok, `gate rounds: round 2 passes (${g2.failures.join(" | ").slice(0, 200)})`);
      });
      return runs.filter((r) => path.resolve(r.cwd) === path.resolve(f.repo)).length;
    };

    const reused = await developRounds(false);
    const notReused = await developRounds(true);
    assert(
      reused === 1,
      `gate rounds: with the always-run hatch pinned off and reuse on, two develop rounds execute the consolidated verify ONCE (${reused})`,
    );
    assert(
      notReused === 2,
      `gate rounds (anti-vacuity): turning reuse off, the same two rounds execute it TWICE — so 'once' above is a saving, not a gate that never reached the probe (on: ${reused}, off: ${notReused})`,
    );
  }

  // ================================================================== case 7
  // A REUSE IS NEVER A SILENT GREEN ON A FAILED TREE: a round whose worktree
  // holds NEW work the record does not cover runs the command, even when a
  // passing record for the same repoRoot exists. This is the case that would
  // let a developer's un-judged edit ship on somebody else's verdict.
  if (seamReady) {
    const f = await fixture("reuse-new-work", ["default"]);
    const verifyCmd = installVerifyCmd(f.repo, "never-written.txt");
    const wt = f.worktrees.default as string;
    const oldTree = await commitAndIdentify(wt, "a.txt", "round 1");

    // A second round writes more work and commits it: a NEW tree.
    const newTree = await commitAndIdentify(wt, "b.txt", "round 2");
    assert(
      newTree.treeHash !== oldTree.treeHash,
      "new work: the second round really is a different tree (git says so)",
    );

    const runs: Runs = [];
    await runConsolidatedVerify(
      makeExec({ runs, repoRoot: f.repo }),
      consOpts(f, { default: wt }, verifyCmd, asRecord(oldTree, verifyCmd)) as never,
    );
    assert(
      runs.filter((r) => path.resolve(r.cwd) === path.resolve(f.repo)).length === 1,
      `new work: a tree the record does not cover is verified, never reused (runs: ${JSON.stringify(runs)})`,
    );
  }

  // ================================================================== case 8
  // THE TIMEOUT THAT REUSES IS NOT THE TIMEOUT THAT JUDGES. A gate whose whole
  // cost is reused cannot produce a verify-timeout: the bound goes unexercised
  // for that pass, and an operator must be able to tell "reused, so it was
  // quick" from "ran out of time". So a kill at the bound parks as
  // `verify-timeout:develop`, never as a code verdict — and it is the FAILED
  // run, so it cannot leave a reusable pass behind for the next round.
  if (seamReady) {
    const f = await fixture("reuse-timeout", ["default"]);
    const verifyCmd = installVerifyCmd(f.repo, "never-written.txt");
    const wt = f.worktrees.default as string;
    const tree = await commitAndIdentify(wt, "a.txt", "task: add a");

    const killed = () =>
      Object.assign(new Error(`Command failed: ${verifyCmd}`), {
        stdout: "",
        stderr: "",
        killed: true,
      });

    const runs: Runs = [];
    const exec: NonNullable<Parameters<typeof runConsolidatedVerify>[0]> = async (cmd, o) => {
      if (cmd.startsWith("sh -c 'echo run >>")) {
        runs.push({ cwd: o?.cwd ?? "?" });
        throw killed();
      }
      const opts = { cwd: o?.cwd, maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024 };
      const { stdout } = o?.argv
        ? await execFileP(cmd, o.argv, opts)
        : await execFileP("/bin/sh", ["-c", cmd], opts);
      return { stdout };
    };
    const res = await runConsolidatedVerify(
      exec,
      consOpts(f, { default: wt }, verifyCmd, { reusedVerifiedTree: tree, timeoutMs: 1 }) as never,
    );
    assert(
      res.status === "failed" && res.timedOut === true,
      `timeout: a killed consolidated run is reported as a kill, not a verdict (${res.status}, timedOut: ${String((res as { timedOut?: boolean }).timedOut)})`,
    );
    assert(
      runs.length === 1,
      `timeout: a killed run executed the command — a reuse never hides a kill (runs: ${JSON.stringify(runs)})`,
    );
    const cap = verifyCapFor("develop", [`${VERIFY_TIMEOUT_LABEL} x`]);
    assert(
      cap === "verify-timeout:develop",
      `timeout: a killed verify reaches verify-timeout:develop, not a code verdict (got: ${cap})`,
    );

    // …and the round after a kill must NOT inherit a stale pass.
    const after: Runs = [];
    await runConsolidatedVerify(
      makeExec({ runs: after, repoRoot: f.repo }),
      consOpts(f, { default: wt }, verifyCmd, { reusedVerifiedTree: tree }) as never,
    );
    assert(
      after.filter((r) => path.resolve(r.cwd) === path.resolve(f.repo)).length === 1,
      `timeout: the next round verifies again rather than reusing across the kill (runs: ${JSON.stringify(after)})`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
