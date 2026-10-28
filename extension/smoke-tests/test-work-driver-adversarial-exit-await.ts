/**
 * #1863 M3 — the bounded exit await and the runner's one-document guarantee.
 *
 * Field shape this pins (issue #1863, the one the PM verified):
 *
 *   pi-rukas-headless: #1863 not-started (exit 30)
 *   error: crash — the runner process exited 0 without a result
 *   FAILED (exit=30)
 *
 * The adversarial round-review child was killed at its run bound and the
 * driver's `await once(child, "exit")` stayed pending forever, so no dispatch
 * report, no cap-hit and no handoff was ever produced, and the runner exited 0
 * with an empty stdout.
 *
 * THE HANDLE, named: the pending `exit` listener rode on the child's own libuv
 * process handle, and that handle stops being ref'd as soon as anything releases
 * it — and every supervisor around this await is unref'd (the child bound's
 * timers in `spawn-child-bound.ts`, the cap grace polls in `spawn-caps.ts`, the
 * inactivity poll in `spawn-inflight.ts`, the non-group SIGKILL escalation in
 * `spawn-kill.ts`). `registerChild` tracks the group for the exit-time reaper
 * but never re-refs the handle. So a killed-and-wedged child could leave the
 * loop with nothing ref'd behind the await, and bun drained to exit 0.
 *
 * The fixes pinned here:
 *   - `spawn-exit-await.ts` ends the wait itself, so a dispatch ALWAYS resolves;
 *   - `headless/ensure-result.ts` writes exactly one result document on every
 *     path, including a driver whose promise never settles.
 */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_AWAIT_GRACE_MS, awaitExitWithin } from "../src/spawn-exit-await.ts";
import {
  formatResultDocument,
  wedgedRun,
  withResultGuarantee,
} from "../src/headless/ensure-result.ts";
import { EXIT } from "../src/headless/exit-code.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const tmpRoot = await mkdtemp(join(tmpdir(), "pi-1863-exit-"));

async function cleanup() {
  for (const child of spawned) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  await rm(tmpRoot, { recursive: true, force: true });
}

const spawned: Array<ReturnType<typeof spawn>> = [];

try {
  // ── 1. A TERM-trapping child that is never reaped: the wait ENDS.
  //
  // This is the field shape. The escalation is deliberately NOT armed by the
  // caller — the module must not depend on it firing — and the escalation timer
  // it does arm is unref'd, matching `spawn-kill.ts`'s non-group policy. Before
  // the fix this awaited forever.
  const dir = await mkdtemp(join(tmpRoot, "trap-"));
  const script = join(dir, "pi");
  // No EXIT reaper: nothing in the tree ends itself, exactly as a child wedged
  // inside a model call behaves from the parent's side.
  writeFileSync(script, "#!/bin/sh\ntrap '' TERM\nwait\n");
  await chmod(script, 0o755);
  const child = spawn(script, [], { stdio: ["pipe", "pipe", "pipe"], detached: true });
  spawned.push(child);
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  await new Promise((r) => setTimeout(r, 200));
  const pid = child.pid as number;
  assert(pid !== undefined && existsSync(script), "the trapping child was spawned");

  const t0 = Date.now();
  let killed = 0;
  const result = await awaitExitWithin(child, {
    graceMs: 1_000,
    kill: () => {
      killed += 1;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
    },
  });
  const elapsed = Date.now() - t0;
  assert(
    elapsed < 5_000,
    `the exit await ENDS on its own for a child that never reports exit (resolved after ${elapsed}ms, not a permanent hang)`,
  );
  assert(
    Array.isArray(result) && result.length === 2,
    `the wedged wait still resolves the [code, signal] tuple it was awaited for (got ${JSON.stringify(result)})`,
  );
  assert(
    killed >= 1,
    "the wedged branch re-signalled the tree on the way out, so a wedged child is not left running behind the result",
  );

  // ── 2. A child that exits normally still resolves with its real exit code.
  {
    const ok = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "pipe" });
    spawned.push(ok);
    ok.stdout?.on("data", () => {});
    ok.stderr?.on("data", () => {});
    const [code] = await awaitExitWithin(ok, { graceMs: 5_000 });
    assert(
      code === 3,
      `a normally-exiting child still reports its real exit code through the bounded wait (got ${code})`,
    );
  }

  // ── 2b. THE v0.14.30 HOTFIX: the grace starts at the KILL, not at the spawn.
  //
  // The field shape this pins: `spawn.ts` enters this await for the child's
  // whole life, so a ceiling armed on entry was a 15 s death sentence for every
  // subagent. A long-running child that nobody killed must come back with its
  // REAL exit, at its real time — not with `[null, null]` at 15 s.
  {
    const slow = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 20_000)"], {
      stdio: "pipe",
    });
    spawned.push(slow);
    slow.stdout?.on("data", () => {});
    slow.stderr?.on("data", () => {});
    const tKill = Date.now();
    let reKilled = 0;
    const [slowCode] = await awaitExitWithin(slow, {
      // Shorter than the child's runtime on purpose: if the deadline still
      // started at entry, this resolves at 2 s with no exit code.
      graceMs: 2_000,
      killed: () => false, // nobody ever killed it
      kill: () => {
        reKilled += 1;
      },
    });
    const slowElapsed = Date.now() - tKill;
    assert(
      slowElapsed >= 19_000,
      `an un-killed child is awaited for its full 20 s, not cut off at the grace (${slowElapsed}ms)`,
    );
    assert(
      slowElapsed < 26_000,
      `the un-killed wait returned when the child actually exited (${slowElapsed}ms)`,
    );
    assert(
      slowCode === 0,
      `the un-killed child still reported its real exit code through an unbounded wait (got ${slowCode})`,
    );
    assert(
      reKilled === 0,
      "an un-killed child is never re-signalled on the way out — the re-kill belongs to the wedged branch only",
    );
  }

  // ── 2c. A KILLED child still gets only the grace (the #1863 behaviour, kept).
  //
  // The kill lands 4 s INTO the await. A deadline armed on entry would have
  // resolved at `graceMs` with no exit event; a deadline armed at the kill
  // resolves at kill + grace, which is what this asserts.
  {
    const dir2 = await mkdtemp(join(tmpRoot, "trap-killed-"));
    const script2 = join(dir2, "pi");
    writeFileSync(script2, "#!/bin/sh\ntrap '' TERM\nwait\n");
    await chmod(script2, 0o755);
    const wedged = spawn(script2, [], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    spawned.push(wedged);
    wedged.stdout?.on("data", () => {});
    wedged.stderr?.on("data", () => {});
    await new Promise((r) => setTimeout(r, 200));
    const pid2 = wedged.pid as number;
    const killAt = Date.now() + 4_000;
    let reKilled2 = 0;
    const tKill2 = Date.now();
    const [wedgedCode, wedgedSignal] = await awaitExitWithin(wedged, {
      graceMs: 1_000,
      killed: () => Date.now() >= killAt,
      kill: () => {
        reKilled2 += 1;
        try {
          process.kill(-pid2, "SIGKILL");
        } catch {
          /* gone */
        }
      },
    });
    const killElapsed = Date.now() - tKill2;
    assert(
      killElapsed >= 4_000,
      `a killed child's grace did NOT start before the kill happened (resolved after ${killElapsed}ms, kill armed at 4000ms)`,
    );
    assert(
      killElapsed < 4_000 + 4_000,
      `a killed-and-wedged child still resolves within kill time + grace (${killElapsed}ms, grace 1000ms)`,
    );
    assert(reKilled2 >= 1, "the killed branch re-signalled the tree on the way out");
    // What matters is that the wait ENDED on its own after the grace and still
    // handed back a well-formed tuple; the tuple's contents come from
    // `child.exitCode`/`signalCode`, which Node fills from the escalation.
    assert(
      Array.isArray(wedgedCode) === false &&
        (wedgedCode === null || typeof wedgedCode === "number") &&
        (wedgedSignal === null || typeof wedgedSignal === "string"),
      `the killed child still resolved a well-formed [code, signal] tuple (code=${wedgedCode} signal=${wedgedSignal})`,
    );
  }

  // ── 3. The default ceiling is derived from the kill policy, and is bounded.
  assert(
    EXIT_AWAIT_GRACE_MS > 0 && EXIT_AWAIT_GRACE_MS <= 60_000,
    `the exit-await ceiling is a bounded grace past the kill escalation (${EXIT_AWAIT_GRACE_MS}ms) rather than the 2-h spawn backstop`,
  );

  // ── 3b. No timer outlives the await: a resolved wait leaves the loop drainable.
  //
  // The ref'd handle is what keeps a wedged child's runner from exiting 0 with
  // no result (#1863), and clearing it is what keeps a NORMAL dispatch from
  // hanging the process for a grace window after its child is gone.
  {
    const ok2 = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "pipe" });
    spawned.push(ok2);
    ok2.stdout?.on("data", () => {});
    ok2.stderr?.on("data", () => {});
    await awaitExitWithin(ok2, { graceMs: 30_000, killed: () => false });
    // -1: the test file's own cleanup interval, the only Timeout that is not
    // this module's.
    const timers = process.getActiveResourcesInfo().filter((kind) => kind === "Timeout");
    assert(
      timers.length <= 1,
      `the resolved exit-await cleared EVERY timer it owned — no ref'd handle is left keeping the runner alive (${JSON.stringify(process.getActiveResourcesInfo())})`,
    );
  }

  // ── 4. THE RUNNER CONTRACT: exactly one result document, even on a wedged run.
  {
    const repoRoot = await mkdtemp(join(tmpRoot, "runner-"));
    const captured: string[] = [];
    const code = await withResultGuarantee({
      json: true,
      repoRoot,
      issues: [1863],
      write: (s) => captured.push(s),
      // The driver never settles: the field shape.
      work: () => new Promise(() => undefined),
      wedgeMs: 250,
    });
    assert(
      captured.length === 1,
      `a run whose driver NEVER settles still writes exactly one result document (got ${captured.length} — the bug wrote zero)`,
    );
    assert(
      code === EXIT.crash,
      `a wedged run exits 30, the honest code for a driver that never answered (got ${code})`,
    );
    const doc = JSON.parse(captured[0] as string);
    assert(
      typeof doc.error?.code === "string" && doc.error.code.length > 0,
      `the wedge document names what stopped instead of printing nothing (error=${JSON.stringify(doc.error)})`,
    );
    assert(
      doc.exitCode === EXIT.crash && Array.isArray(doc.issues) && doc.issues.length === 1,
      `the wedge document carries the per-issue projection the host acts on (issues=${JSON.stringify(doc.issues?.map((i: { issue: number; status: string }) => [i.issue, i.status]))})`,
    );
  }

  // ── 5. A run that DOES settle writes exactly one document, and no wedge.
  {
    const repoRoot = await mkdtemp(join(tmpRoot, "ok-"));
    const captured: string[] = [];
    const code = await withResultGuarantee({
      json: true,
      repoRoot,
      issues: [7],
      write: (s) => captured.push(s),
      work: async () => ({ exitCode: EXIT.merged, results: [], error: undefined }),
      wedgeMs: 5_000,
    });
    assert(
      captured.length === 1 && code === EXIT.merged,
      `a settled run writes exactly one document and keeps its own exit code (${captured.length} doc, exit ${code})`,
    );
    const doc = JSON.parse(captured[0] as string);
    assert(
      doc.error === undefined,
      `a settled run is not reported as wedged (error=${JSON.stringify(doc.error)})`,
    );
  }

  // ── 6. The wedge projection reads the state file it finds, and 30s the rest.
  {
    const repoRoot = await mkdtemp(join(tmpRoot, "proj-"));
    const run = await wedgedRun(repoRoot, [9999], "test");
    assert(
      run.exitCode === EXIT.crash && run.results.length === 1 && run.results[0]?.issue === 9999,
      "the wedge projection reports one row per issue it was asked about",
    );
    assert(
      run.error?.code === "driver-wedged",
      `the wedge error names the driver as what stopped, not a bare 'exited 0' (got ${run.error?.code})`,
    );
    const text = formatResultDocument(run, false);
    assert(
      text.includes("driver-wedged"),
      "the non-json form also names the wedge — hosts read both",
    );
  }

  console.log("OK: #1863 bounded exit await + one-document runner guarantee");
} finally {
  await cleanup();
}

process.exit(exit);
