/**
 * #1016 — the green rule and the #622 safety net compose correctly. Real git
 * worktrees: a developer that leaves edits UNCOMMITTED is still work (the
 * safety net commits them after the fan-out), and a failed workstream's
 * uncommitted edits are never reset.
 */
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gitIn, makeBaseWorktrees } from "./lib/git-worktree-fixture.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { applySafetyNet, safetyNetWorktree } from "../src/work-driver-safety-net.ts";
import {
  greenCountsAsWork,
  resetWorktreeToBase,
  runIndependentFanout,
} from "../src/work-develop-retry.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

type ExecFn = NonNullable<DriverContext["verifyExecFn"]>;
const shell = promisify(exec);
const execFn: ExecFn = async (cmd, opts) => {
  const r = await shell(cmd, opts);
  return { stdout: String(r.stdout), stderr: String(r.stderr) };
};

const dir = await mkdtemp(path.join(tmpdir(), "safety-1016-"));
try {
  const ids = ["task-a", "task-b", "task-c"];
  const shas = await makeBaseWorktrees(dir, ids);
  const wt = (id: string) => path.join(dir, ".worktrees", id);

  // task-a: a committed green.
  await writeFile(path.join(wt("task-a"), "a.rs"), "a");
  gitIn(wt("task-a"), ["add", "a.rs"]);
  gitIn(wt("task-a"), ["commit", "-qm", "a"]);

  // task-b: the developer left its edit UNCOMMITTED (zero commits ahead).
  await writeFile(path.join(wt("task-b"), "b.rs"), "b");
  // The develop step's runAt commits the leftover work BEFORE the green check.
  const sn = await safetyNetWorktree("task-b", wt("task-b"), shas["task-b"] ?? "");
  assert(
    sn?.kind === "safety-net-commit",
    "#1016: the per-worktree safety net commits task-b first",
  );
  const green = await greenCountsAsWork(execFn, wt("task-b"), shas["task-b"], "task-b");
  assert(green.counts, "#1016: the safety-net commit makes task-b a green");

  // The same safety-net call develop makes after the fan-out.
  const state = {
    schemaVersion: 1,
    issue: 1,
    updatedAt: 0,
    eventLog: [],
    pipelineState: {
      baseSha: shas["task-a"],
      workstreamBaseShas: shas,
      worktrees: { "task-a": wt("task-a"), "task-b": wt("task-b") },
    },
  } as unknown as WorkState;
  const after = await applySafetyNet({} as DriverContext, state);
  assert(after.eventLog.length === 0, "#1016: the post-fan-out sweep finds nothing left to commit");
  assert(
    gitIn(wt("task-b"), ["rev-list", "--count", `${shas["task-b"]}..HEAD`]) === "1",
    "#1016: task-b is one commit ahead of its base once the safety net has run",
  );
  assert(existsSync(path.join(wt("task-b"), "b.rs")), "#1016: task-b's edit survives the commit");

  // task-c: a dispatch failed with a partial edit. A retry must never discard it.
  await writeFile(path.join(wt("task-c"), "c.rs"), "partial");
  const refused = await resetWorktreeToBase(execFn, wt("task-c"), shas["task-c"]).then(
    () => false,
    (err: Error) => /uncommitted work/.test(err.message),
  );
  assert(
    refused && existsSync(path.join(wt("task-c"), "c.rs")),
    "#1016: a reset refuses a dirty worktree and leaves the partial edit on disk",
  );

  // Through the fan-out: task-a is green, task-c fails and its retry is refused.
  const res = await runIndependentFanout({
    independent: ["task-a", "task-c"],
    preserved: new Set(),
    skip: [],
    verdicts: [],
    multi: true,
    runAt: async (id) => ({ id, ok: id === "task-a" }),
    resetFor: (id) => resetWorktreeToBase(execFn, wt(id), shas[id]),
  });
  const c = res.find((v) => v.id === "task-c");
  assert(
    c !== undefined && !c.ok && /uncommitted work/.test(c.reason ?? ""),
    "#1016: the fan-out's retry of task-c fails with the named reason",
  );
  assert(
    existsSync(path.join(wt("task-c"), "c.rs")),
    "#1016: the fan-out never discards task-c's uncommitted edit",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
