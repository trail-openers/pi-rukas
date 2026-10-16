#!/usr/bin/env bun
/**
 * #1391 — the router's side of the severed-attempt retry: WHICH steps clear
 * a worktree before a re-dispatch, and what the driver RECORDS when they do.
 *
 * `test-work-driver-retry-dirty-tree.ts` pins the git mechanics against real
 * repos. This file pins the decisions layered on top of them, which are the
 * ones that can silently invert:
 *
 *  - `develop` must NEVER clear. Its leftover is the retried developer's
 *    starting point, and `interruptedDevelopNote` tells it to continue from
 *    there. Clearing it would destroy the work the retry exists to finish —
 *    the exact opposite of the change.
 *  - `lens-fix` MUST clear, because its #981 gate refuses a dirty tree.
 *  - A preservation is recorded in the event log or it did not happen: the
 *    retry line reads the log to decide whether it may claim a save, so an
 *    unrecorded save (a no-op clean, or a refused one) must produce no event.
 *  - A refused save records nothing AND stops nothing else: with several
 *    workstreams, one worktree that cannot be saved must not hide the saves
 *    that did land.
 *
 * The clean runs against a scripted executor rather than real git: the
 * real-git behaviour is the other file's job, and here the question is purely
 * which calls the driver makes and what it writes down.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecFn } from "../src/work-develop-git.ts";
import {
  clearsWorktreeBeforeRetry,
  prepareWorktreesForRetry,
} from "../src/work-driver-retry-tree.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SAVE_SHA = "0123456789abcdef0123456789abcdef01234567";
// NUL-separated, exactly what `git status --porcelain -z --untracked-files=all`
// emits — the seam reads the argv form, so the fake must speak it too.
const DIRTY = ["M  feature.txt", "?? DESIGN.md", "?? host/game-view.js"];

/**
 * An executor that pretends the tree is dirty and reports back which git
 * argvs it was asked to run, so the test can assert both the calls made AND
 * the calls NOT made (a `reset --hard` after a refused save is the bug).
 *
 * `rev-parse HEAD` is served by CALL COUNT, not by a flag: the seam reads HEAD
 * before the save and again after it, and the second read must return the
 * saved sha — which is exactly when a `commit` has already been asked for.
 */
function scripted(opts: { dirty: boolean; failRef?: boolean }): {
  execFn: ExecFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  let revParseReads = 0;
  const execFn: ExecFn = async (_cmd, o) => {
    const argv = o?.argv ?? [];
    calls.push(argv);
    const head = argv[0] === "--literal-pathspecs" ? argv[1] : argv[0];
    switch (head) {
      case "status":
        return { stdout: opts.dirty ? `${DIRTY.join("\x00")}\x00` : "" };
      case "rev-parse": {
        revParseReads += 1;
        const sha = opts.dirty && revParseReads >= 2 ? SAVE_SHA : "a".repeat(40);
        return { stdout: `${sha}\n` };
      }
      case "add":
      case "rm":
      case "commit":
      case "reset":
      case "clean":
        return { stdout: "" };
      case "update-ref":
        if (opts.failRef) throw new Error("cannot lock ref 'refs/xxx': is ahead");
        return { stdout: "" };
      case "diff":
        return { stdout: opts.dirty ? "diff --git a/feature.txt b/feature.txt\n" : "" };
      default:
        return { stdout: "" };
    }
  };
  return { execFn, calls };
}

function stateWith(worktrees: Record<string, string>): WorkState {
  const s = initialState(1391, 1_000_000);
  return { ...s, pipelineState: { ...s.pipelineState, worktrees } };
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1391-router-"));

try {
  // --------------------------------------------------------------------------
  // 1. Which steps clear. develop's answer is the load-bearing one.
  // --------------------------------------------------------------------------
  assert(
    clearsWorktreeBeforeRetry("lens-fix") === true,
    "lens-fix clears its worktree before a retry",
  );
  assert(
    clearsWorktreeBeforeRetry("develop") === false,
    "develop NEVER clears — its leftover is the retried developer's starting point (interruptedDevelopNote)",
  );
  for (const step of [
    "explore",
    "plan",
    "adversarial",
    "commit-pr",
    "ci",
    "lens-review",
  ] as const) {
    assert(
      clearsWorktreeBeforeRetry(step) === false,
      `${step} is not told to clear (only steps whose gate rejects a dirty tree do)`,
    );
  }

  // --------------------------------------------------------------------------
  // 2. A non-clearing step touches nothing: no status read, no event, no state
  //    churn. This is the "retry behaves exactly as before #1391" guarantee for
  //    every step except lens-fix.
  // --------------------------------------------------------------------------
  {
    const { execFn, calls } = scripted({ dirty: true });
    const before = stateWith({ default: path.join(root, "wt-develop") });
    const out = await prepareWorktreesForRetry({
      execFn,
      state: before,
      repoRoot: root,
      issue: 1391,
      step: "develop",
      attempt: 1,
    });
    assert(
      out.state === before,
      "a develop retry gets its state back unchanged — no clear, no record",
    );
    assert(out.clean === undefined, "a develop retry reports no clean at all");
    assert(calls.length === 0, `a develop retry makes ZERO git calls (got ${calls.length})`);
  }

  // --------------------------------------------------------------------------
  // 3. lens-fix preserves, clears, and RECORDS. The event is what lets the
  //    retry line claim a save at all.
  // --------------------------------------------------------------------------
  {
    const { execFn, calls } = scripted({ dirty: true });
    const out = await prepareWorktreesForRetry({
      execFn,
      state: stateWith({ default: path.join(root, ".worktrees", "issue-1391-a") }),
      repoRoot: root,
      issue: 1391,
      step: "lens-fix",
      attempt: 2,
    });
    const saved = out.state.eventLog.filter((e) => e.kind === "lens-fix-attempt-preserved");
    assert(saved.length === 1, `one preservation event is recorded (got ${saved.length})`);
    const e = saved[0];
    assert(
      e?.kind === "lens-fix-attempt-preserved" && e.files.length === 3,
      `the event names every preserved path (got ${JSON.stringify(e?.kind === "lens-fix-attempt-preserved" ? e.files : null)})`,
    );
    assert(
      e?.kind === "lens-fix-attempt-preserved" && e.attempt === 2 && e.step === "lens-fix",
      "the event names the lost attempt and the step, so the handoff can say which round was saved",
    );
    assert(
      e?.kind === "lens-fix-attempt-preserved" && e.preservedRef.startsWith("refs/pi-rukas/"),
      "the event carries the durable ref, not just a sha that will be orphaned",
    );
    const cleared = calls.some((c) => c[0] === "reset" && c[1] === "--hard");
    assert(cleared, "the tree is reset for the retry — the gate that parked will now pass");
  }

  // --------------------------------------------------------------------------
  // 4. A clean tree records nothing: the retry line must not claim a phantom
  //    save for a tree that never needed one.
  // --------------------------------------------------------------------------
  {
    const { execFn } = scripted({ dirty: false });
    const out = await prepareWorktreesForRetry({
      execFn,
      state: stateWith({ default: path.join(root, ".worktrees", "issue-1391-b") }),
      repoRoot: root,
      issue: 1391,
      step: "lens-fix",
      attempt: 1,
    });
    assert(
      out.state.eventLog.filter((e) => e.kind === "lens-fix-attempt-preserved").length === 0,
      "a tree that needed nothing records no preservation",
    );
    assert(out.clean?.kind === "clean", `and it reports a no-op clean (got ${out.clean?.kind})`);
  }

  // --------------------------------------------------------------------------
  // 5. A save that cannot land records nothing and clears nothing. With TWO
  //    workstreams, the one that saved is still recorded — a sibling's refusal
  //    must not hide the saves that landed.
  // --------------------------------------------------------------------------
  {
    const { execFn, calls } = scripted({ dirty: true, failRef: true });
    const out = await prepareWorktreesForRetry({
      execFn,
      state: stateWith({
        default: path.join(root, ".worktrees", "issue-1391-c"),
        second: path.join(root, ".worktrees", "issue-1391-d"),
      }),
      repoRoot: root,
      issue: 1391,
      step: "lens-fix",
      attempt: 1,
    });
    assert(
      out.state.eventLog.filter((e) => e.kind === "lens-fix-attempt-preserved").length === 0,
      "a refused save records no preservation — the retry line cannot claim it",
    );
    assert(
      out.clean?.kind === "failed",
      `the refusal is reported to the router (got ${out.clean?.kind})`,
    );
    assert(
      out.clean?.kind === "failed" && out.clean.reason.includes("cannot lock ref"),
      "the git error travels with the refusal, so the handoff says why",
    );
    const resets = calls.filter((c) => c[0] === "reset").length;
    const cleans = calls.filter((c) => c[0] === "clean").length;
    assert(
      resets === 0 && cleans === 0,
      `nothing is cleared when the save failed — no reset, no clean (got ${resets} reset, ${cleans} clean)`,
    );
  }

  // --------------------------------------------------------------------------
  // 6. No worktrees recorded (a step retried before branch created any) is a
  //    no-op rather than a crash.
  // --------------------------------------------------------------------------
  {
    const { execFn, calls } = scripted({ dirty: true });
    const out = await prepareWorktreesForRetry({
      execFn,
      state: stateWith({}),
      repoRoot: root,
      issue: 1391,
      step: "lens-fix",
      attempt: 1,
    });
    assert(
      out.clean === undefined && calls.length === 0,
      "no worktree → nothing to preserve, nothing called",
    );
  }

  // --------------------------------------------------------------------------
  // 7. A worktree outside `.worktrees/` is refused rather than cleared: the
  //    seam inherits develop's fence, and the router must not route around it.
  // --------------------------------------------------------------------------
  {
    const { execFn } = scripted({ dirty: true });
    const out = await prepareWorktreesForRetry({
      execFn,
      state: stateWith({ default: path.join(root, "repo") }),
      repoRoot: root,
      issue: 1391,
      step: "lens-fix",
      attempt: 1,
    });
    assert(
      out.clean?.kind === "failed" && out.clean.reason.includes("not inside"),
      `a worktree outside .worktrees/ is refused, not reset (got ${JSON.stringify(out.clean)})`,
    );
    assert(
      out.state.eventLog.filter((e) => e.kind === "lens-fix-attempt-preserved").length === 0,
      "a refused path records no preservation",
    );
  }

  rmSync(root, { recursive: true, force: true });
} catch (err) {
  console.error(`✗ unexpected error: ${(err as Error).stack?.slice(0, 800) ?? err}`);
  exit = 1;
}

console.log(`\nexit ${exit}`);
process.exit(exit);
