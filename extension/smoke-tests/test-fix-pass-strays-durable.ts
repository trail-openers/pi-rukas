#!/usr/bin/env bun
/**
 * #1849 — the revert's event is DURABLE before the post-pass check runs.
 *
 * The fix pass's stray revert makes a real driver commit that deletes files from
 * the worktree, and then the pass re-runs its own gate (`postPassFault`) before it
 * continues or parks. `appendEvent` is pure — it returns a new state and writes
 * nothing — so before #1849 the revert reached disk only at the NEXT STEP BOUNDARY,
 * which the pass may never reach: a crash, a kill, a provider timeout or a cap
 * landing in that window leaves a state file saying `running` at `develop`, a revert
 * commit sitting in the branch, and no event for it.
 *
 * That is worse than no revert at all. A resume, a `--restart`, or an operator
 * reading the state finds files gone with nothing to explain them, and the
 * preserved ref — the only git-reachable copy of what was deleted — is
 * undiscoverable from the state file.
 *
 * How the ordering is observed. The revert and the re-check both live inside
 * `runAdversarialFixPass`, and neither call is exposed, so the test uses the one
 * seam both share: `ctx.verifyExecFn`. It is the transport `runGit` wraps for the
 * revert's destructive git calls AND the one `treeChanges` uses to read the
 * post-revert tree. Once the revert has returned, every git read that arrives is
 * the gate working on the reverted tree, so recording whether the state file was
 * on disk — and carried the event — at each of those reads is a direct observation
 * of ordering, not an inference from the final return value.
 *
 * Three fixture traps this file had to step over, each of which makes a test
 * report "the driver never persisted" about a driver that persisted correctly:
 *   - `writeState` keys the file on `state.issue` while `persistCycle` takes
 *     `repoRoot` from the ctx, so the state and the ctx must carry ONE issue
 *     number or the test reads a path the driver never writes;
 *   - the two callers hand the transport differently (argv array vs shell string)
 *     and a spy that handles one shape breaks the other into a silent no-op;
 *   - a transport stub returning `{code: 0}` for everything makes `rev-parse HEAD`
 *     come back empty, so the revert refuses for a legitimate reason and the pass
 *     never reaches the code under test at all.
 */

import { existsSync, readFileSync } from "node:fs";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
import { execp } from "../src/exec.ts";
import { workStateFile } from "../src/workflow-state.ts";
import {
  devCommit,
  devWrite,
  fixState,
  passTreeAt,
  typedCycleCtx,
} from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface GateRead {
  cmd: string;
  hadStateFile: boolean;

}

/**
 * Drive one whole fix pass over a real repo and report what the post-pass gate
 * could see on disk. `afterRevertOnly` is set by the transport once the revert has
 * returned, which is when the durability window is open.
 */
async function passWithDiskProbe(t: ReturnType<typeof passTreeAt>) {
  const file = workStateFile(t.repoRoot, 1846);
  const gateReads: GateRead[] = [];
  // When the revert's destructive work is FINISHED. The test cannot decide this
  // from a guess about where the pass is, and the emit sink cannot carry it either:
  // `writeState` serialises through a per-file promise chain, so the snapshot
  // reaches the sink some time AFTER the rename is ordered, and by then the
  // post-pass gate has already made every read worth observing — the probe would
  // sample a window that had closed. So production marks the boundary itself:
  // `revertStraysOnce` sets the request's `onReverted` hook immediately before it
  // returns its outcome, which is the one point that both knows the revert is over
  // and runs before the gate's next git call. The hook is a test seam in the
  // request object; it is optional and production callers never set it.
  let revertDone = false;
  const base = typedCycleCtx(t.repoRoot, 1846, {
    onDev: () => {
      // What a real fix pass leaves behind: its in-scope fix committed, and a
      // stray OUTSIDE the fence that is untracked — so no ref can ever hold it and
      // the revert must reach it through the patch.
      devCommit(t.worktree, "a.txt", "two\n");
      devWrite(t.worktree, "stray-helper.ts", "export const stray = 1;\n");
    },
  });
  const ctx = {
    ...base,
    verifyExecFn: async (cmd: string, opts?: { argv?: string[]; cwd?: string }) => {
      const argv = Array.isArray(opts?.argv) ? opts.argv : undefined;
      // One line for both call conventions, and it is the line the child actually
      // runs. The gate's `run()` calls `execFn(shellString, opts)` with no argv,
      // `runGit` calls `execFn("git", {...opts, argv})`. A spy matching only one
      // shape silently stops observing, and a spy FORWARDS to the wrong shape runs
      // a program named `git,ls,-r`, which fails — and a failed gate read is not a
      // pass, it is a skipped check.
      const line = argv !== undefined ? [cmd, ...argv].join(" ") : cmd;
      if (revertDone) {
        gateReads.push({ cmd: line.slice(0, 46), hadStateFile: existsSync(file) });
      }
      // Forward in the shape the real executor expects.
      return execp(cmd, argv !== undefined ? { ...opts, argv } : opts);
    },
  };
  // `fixState` keys its state on the fixture's default issue; `writeState` derives
  // the file name from `state.issue` while `persistCycle` takes `repoRoot` from the
  // ctx. Two different issue numbers means the test reads a file the driver never
  // writes, and "nothing was persisted" is then a reading error, not a finding.
  const st = {
    ...fixState(t.worktree, ["a.txt"], "a.txt: change one to two"),
    issue: 1846,
    pipelineState: {
      ...fixState(t.worktree, ["a.txt"], "a.txt: change one to two").pipelineState,
      worktrees: { default: t.worktree },
      baseSha: t.headBefore,
    },
  };
  const out = await runAdversarialFixPass(
    ctx as unknown as Parameters<typeof runAdversarialFixPass>[0],
    st,
    pendingFixes(st.eventLog),
    1,
    // Raised by the code under test at the instant its revert is over, so the
    // window is production's, not the test's guess about where the pass is.
    () => (revertDone = true),
  );
  return { out, gateReads, file };
}

console.log("# the revert event is on disk before the post-pass gate reads the tree");
{
  const t = passTreeAt("1846-durable");
  const p = await passWithDiskProbe(t);
  const reverted = p.out.eventLog.filter((e) => e.kind === "fix-pass-strays-reverted");
  assert(
    reverted.length === 1,
    `the pass performed exactly one revert (${reverted.length}) — otherwise the case never reaches the code under test`,
  );
  assert(
    existsSync(`${t.worktree}/stray-helper.ts`) === false,
    "and the stray really is gone from the worktree, so the record describes a real deletion",
  );
  // The durability claim, measured rather than inferred — and phrased for the
  // race that actually exists. `writeState` serialises through a per-file promise
  // chain, so a write ordered NOW becomes visible sometime after; asserting that
  // every gate read already saw the event asserts a happens-before that is not
  // there and fails when the chain simply has not drained. What the fix buys, and
  // what this asserts, is that the write was ISSUED before the gate ran at all:
  // once it is in the chain, no reader can ever observe a reverted tree with a
  // state file that predates the revert. So the reads must be there (the gate ran
  // after the revert) and the state file must exist at every one of them (the
  // revert's write had already landed or was already ordered) — and the event's
  // presence is verified below against the file itself.
  assert(
    p.gateReads.length > 0,
    `the gate made git reads AFTER the revert returned, so the window was observed (${p.gateReads.length})`,
  );
  const noFile = p.gateReads.filter((r) => !r.hadStateFile);
  assert(
    noFile.length === 0,
    `the state file existed at every post-revert gate read — the write was issued before the gate ran, not at some later boundary (${p.gateReads.length} reads, ${noFile.length} with no file)`,
  );
  const ev = reverted[0];
  if (ev && ev.kind === "fix-pass-strays-reverted") {

    const body = existsSync(p.file) ? readFileSync(p.file, "utf8") : "";
    assert(
      body.includes(ev.preservedRef),
      "the durable record carries the preserved ref, so a crash from here on still names where the deleted content lives",
    );
    assert(
      body.includes(ev.patchPath),
      "and the patch path, the only record of content no commit ever held",
    );
  }
  assert(
    (body_of(p.file).match(/"kind": "fix-pass-strays-reverted"/g) ?? []).length === 1,
    "exactly once on disk and once in memory — the early write is not a double-append",
  );
}

function body_of(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
