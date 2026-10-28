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
  //
  // WHY `sleep 60` AND NOT `wait`: the wedge has to be a process Node has NOT
  // reaped, so `exitCode`/`signalCode` stay null and the wedge branch is actually
  // reached. A bare `wait` in a script with no job table returns at once under
  // dash, so the old fixture exited immediately and the case only looked like a
  // wedge because the await resolved its exit fields — it would have passed with
  // the wait never ending and with the wait never resolving, which is to say it
  // tested nothing. `sleep` as the leader's own foreground child really blocks.
  const dir = await mkdtemp(join(tmpRoot, "trap-"));
  const script = join(dir, "pi");
  // No EXIT reaper: nothing in the tree ends itself, exactly as a child wedged
  // inside a model call behaves from the parent's side.
  writeFileSync(script, "#!/bin/sh\ntrap '' TERM\nsleep 60\n");
  await chmod(script, 0o755);
  const child = spawn(script, [], { stdio: ["pipe", "pipe", "pipe"], detached: true });
  spawned.push(child);
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  await new Promise((r) => setTimeout(r, 200));
  const pid = child.pid as number;
  assert(pid !== undefined && existsSync(script), "the trapping child was spawned");
  // THE WEDGE, POSITIVELY. Without this the case is the fiction described above:
  // an already-reaped child proves nothing about a wait that must not hang.
  assert(
    child.exitCode === null && child.signalCode === null,
    `the trapping child is genuinely STILL RUNNING when the wait starts, so the wedge branch is the branch under test (code=${child.exitCode} signal=${child.signalCode})`,
  );

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
    elapsed >= 900,
    `the wedge branch ran — the wait was NOT cut short by an early exit (${elapsed}ms, grace 1000ms)`,
  );
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
  // REAL exit, at its real time — not with `[null, null]` at the grace.
  {
    const slow = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 4_000)"], {
      stdio: "pipe",
    });
    spawned.push(slow);
    slow.stdout?.on("data", () => {});
    slow.stderr?.on("data", () => {});
    const tKill = Date.now();
    let reKilled = 0;
    const [slowCode] = await awaitExitWithin(slow, {
      // Shorter than the child's runtime on purpose: if the deadline still
      // started at entry, this resolves at 1.5 s with no exit code.
      graceMs: 1_500,
      killed: () => false, // nobody ever killed it
      kill: () => {
        reKilled += 1;
      },
    });
    const slowElapsed = Date.now() - tKill;
    assert(
      slowElapsed >= 3_900,
      `an un-killed child is awaited for its full 4 s, not cut off at the 1.5 s grace (${slowElapsed}ms)`,
    );
    assert(
      slowElapsed < 10_000,
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
    // `sleep`, not `wait` — see case 1 for why the `wait` form never wedged.
    writeFileSync(script2, "#!/bin/sh\ntrap '' TERM\nsleep 60\n");
    await chmod(script2, 0o755);
    const wedged = spawn(script2, [], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    spawned.push(wedged);
    wedged.stdout?.on("data", () => {});
    wedged.stderr?.on("data", () => {});
    await new Promise((r) => setTimeout(r, 200));
    const pid2 = wedged.pid as number;
    assert(
      wedged.exitCode === null && wedged.signalCode === null,
      `the killed child was STILL RUNNING when the wait started, so this really is the wedged branch (code=${wedged.exitCode} signal=${wedged.signalCode})`,
    );
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

  // ── 2d. AN EXITED CHILD whose exit event the await never saw: it resolves
  //      with its REAL code and is NEVER re-signalled.
  //
  // THE BUG THIS PINS: a child that has exited but whose `exit` event this await
  // has not observed used to be re-killed and reported as `[null, null]`. The
  // race is not hypothetical — `spawn.ts` has other `exit`/`close` listeners
  // (`armCapSession`, `registerChild`'s group reaper) and Node runs the whole
  // listener list in one emit, so a child can be fully reaped while this await's
  // own continuation is still queued.
  //
  // THE FIXTURE REPRODUCES THAT SHAPE EXACTLY: register the await's listeners
  // FIRST but do not attach its `once()` yet; kill the child through a listener
  // added afterwards, which Node fires BEFORE the await's; then enter the await.
  // Its `once()` now attaches after the emit, so the event is gone — only the
  // child's own `exitCode` / `signalCode` remain, and a poll that ignored them
  // would re-signal a dead child.
  {
    const dead = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(11), 250)"], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    spawned.push(dead);
    dead.stdout?.on("data", () => {});
    dead.stderr?.on("data", () => {});
    // (a) The await's own listener slot, deliberately NOT yet filled — this is
    // what makes its `once()` attach late.
    dead.on("exit", () => {});
    // The race, observed rather than assumed: recorded as a SEQUENCE of what
    // fired, so the assertion below can actually be false. A plain boolean would
    // be narrowed by the compiler to the `false` it was initialized with and the
    // comparison would be provably dead — a check that cannot fail is not a check.
    const fired: string[] = [];
    // (b) A listener added AFTER the await's, so Node runs it after that one.
    dead.once("exit", () => {
      fired.push("other-listener");
    });
    const pidDead = dead.pid as number;
    // (c) Kill it now, from the outside, like a supervisor would.
    try {
      process.kill(-pidDead, "SIGKILL");
    } catch {
      /* gone */
    }
    // (d) Let the emit complete and the process be reaped, THEN enter the await.
    await new Promise((r) => setTimeout(r, 400));
    assert(
      dead.exitCode !== null || dead.signalCode !== null,
      `the fixture really exited before the await was entered (code=${dead.exitCode} signal=${dead.signalCode})`,
    );
    assert(
      fired.includes("other-listener"),
      `the fixture really emitted \`exit\` to the child's other listener BEFORE the await attached its own (the race, reproduced; fired=${JSON.stringify(fired)})`,
    );
    const tDead = Date.now();
    let reKilledDead = 0;
    const [deadCode, deadSignal] = await awaitExitWithin(dead, {
      // Long grace, short poll: the poll must be what notices the child is gone,
      // not a grace that expires and re-kills it.
      graceMs: 30_000,
      pollMs: 25,
      killed: () => true,
      kill: () => {
        reKilledDead += 1;
        try {
          process.kill(-pidDead, "SIGKILL");
        } catch {
          /* gone */
        }
      },
    });
    const deadElapsed = Date.now() - tDead;
    assert(
      deadCode !== null || deadSignal !== null,
      `an already-exited child resolved with its REAL [code, signal], not [null, null] (got [${deadCode}, ${deadSignal}])`,
    );
    assert(
      reKilledDead === 0,
      `an already-exited child was NOT re-signalled on the way out (kill called ${reKilledDead}x)`,
    );
    assert(
      deadElapsed < 5_000,
      `the poll resolved the wait at once rather than waiting out the 30 s grace (${deadElapsed}ms)`,
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
    // Snapshot the loop's timers BEFORE the await, so the assertion is about
    // what THIS call owned rather than a global count something else can move.
    const before = process.getActiveResourcesInfo().filter((k) => k === "Timeout").length;
    await awaitExitWithin(ok2, { graceMs: 30_000, killed: () => false });
    const after = process.getActiveResourcesInfo().filter((k) => k === "Timeout").length;
    assert(
      after <= before,
      `the resolved exit-await cleared EVERY timer it owned — the loop held ${before} Timeout(s) before the call and holds ${after} after (${JSON.stringify(process.getActiveResourcesInfo())})`,
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
