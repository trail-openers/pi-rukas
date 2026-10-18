#!/usr/bin/env bun
/**
 * #1260 — without a terminal, every child leads its own process group, and a
 * killed driver job actually stops its cycle.
 *
 * 1. `leadsProcessGroup`: a group when asked, or when stdin is not a TTY; an
 *    interactive (TTY) session keeps the terminal's group.
 * 2. A real spawn with NO `processGroup` flag (the `pi --mode rpc` path) and a
 *    non-TTY stdin: aborting the dispatch kills the stub's backgrounded
 *    `sleep` grandchild too. Run once more with stdin claiming a TTY, the
 *    grandchild survives — the canary that keeps (2) from passing vacuously.
 * 3. The queue path hands each group's driver its job's abort signal (and the
 *    launching job's), so `killAllJobs` / `dispatch_kill` reach the cycle.
 * 4. The single-issue and tool entry paths forward the job signal.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchHost } from "../src/async-jobs-lifecycle.ts";
import { clearJobsForTesting, killAllJobs } from "../src/async-jobs.ts";
import { dispatchCore } from "../src/dispatch.ts";
import { leadsProcessGroup } from "../src/spawn-kill.ts";
import { runGroupedIssues } from "../src/work-entry.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function setStdinTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true, writable: true });
}
const originalTTY = process.stdin.isTTY;

process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";
const dir = mkdtempSync(path.join(tmpdir(), "child-process-group-"));

try {
  // ── 1. the decision ────────────────────────────────────────────────────
  setStdinTTY(true);
  assert(leadsProcessGroup(true), "1: asked for a group → group, even on a TTY");
  assert(
    !leadsProcessGroup(undefined) && !leadsProcessGroup(false),
    "1: interactive TTY → no group",
  );
  setStdinTTY(undefined);
  assert(leadsProcessGroup(undefined) && leadsProcessGroup(false), "1: no TTY on stdin → group");

  // ── 2. a real spawn, no processGroup flag ─────────────────────────────
  const stub = path.join(dir, "pi-stub.sh");
  writeFileSync(
    stub,
    '#!/bin/sh\n[ "$1" = "--version" ] && { echo 0.0.0; exit 0; }\nsleep 600 &\necho "$$ $!" > "$STUB_PID_FILE"\nwait\n',
  );
  chmodSync(stub, 0o755);
  process.env.PI_ENSEMBLE_PI_BIN = stub;
  /** Spawn the stub, abort it, and report whether its grandchild survived. */
  async function abortLeavesGrandchild(
    tag: string,
  ): Promise<{ started: boolean; survived: boolean; pid: number }> {
    // One stub for both runs: the resolved pi binary is cached per process,
    // so the pid file it writes is chosen through the env the child inherits.
    const pidFile = path.join(dir, `${tag}.pid`);
    process.env.STUB_PID_FILE = pidFile;
    const host: DispatchHost = { sendUserMessage: () => {} };
    const ac = new AbortController();
    const done = dispatchCore(
      host,
      { role: "developer", prompt: "stub", cwd: dir },
      { signal: ac.signal, skipDeck: true },
    );
    const started = await waitFor(() => existsSync(pidFile), 10_000);
    const [shellPid, pid] = started
      ? readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number)
      : [-1, -1];
    ac.abort("signal");
    await Promise.race([done.catch(() => undefined), sleep(15_000)]);
    await waitFor(() => !alive(shellPid), 5_000);
    // The group escalation (SIGKILL) lands within KILL_GRACE_MS.
    const gone = await waitFor(() => !alive(pid), 4_000);
    return { started, survived: !gone, pid };
  }

  setStdinTTY(undefined);
  const headlessRun = await abortLeavesGrandchild("no-tty");
  assert(headlessRun.started, "2: the stub child started");
  assert(
    !headlessRun.survived,
    "2: no TTY, no processGroup flag: the abort killed the grandchild sleep",
  );

  setStdinTTY(true);
  const ttyRun = await abortLeavesGrandchild("tty");
  assert(
    ttyRun.started && ttyRun.survived,
    "2 canary: with a TTY the leader alone is signalled and the grandchild survives",
  );
  if (ttyRun.pid > 0 && alive(ttyRun.pid)) process.kill(ttyRun.pid, "SIGKILL");
  setStdinTTY(undefined);

  // ── 3. the queue forwards the abort signal to each group's driver ─────
  {
    const seen: AbortSignal[] = [];
    const run = runGroupedIssues(
      { sendUserMessage: () => {} } as never,
      dir,
      [9101],
      { restart: false, mergeGrant: false, protectedGrant: [], headless: true },
      () => {},
      {
        fetchBodies: async () => ({ 9101: "one" }),
        runDriver: async (_primary, ctx) => {
          if (ctx.signal) seen.push(ctx.signal);
          await waitFor(() => ctx.signal?.aborted === true, 5_000);
        },
      },
    );
    await waitFor(() => seen.length === 1, 5_000);
    assert(seen.length === 1, `3: the group's driver received a signal (got ${seen.length})`);
    killAllJobs();
    await Promise.race([run.catch(() => ""), sleep(10_000)]);
    assert(
      seen.length === 1 && seen.every((s) => s.aborted),
      "3: killAllJobs aborts the group's driver signal",
    );
    clearJobsForTesting();
  }
  {
    const outer = new AbortController();
    let got: AbortSignal | undefined;
    const run = runGroupedIssues(
      { sendUserMessage: () => {} } as never,
      dir,
      [9103],
      {
        restart: false,
        mergeGrant: false,
        protectedGrant: [],
        headless: true,
        signal: outer.signal,
      },
      () => {},
      {
        fetchBodies: async () => ({ 9103: "three" }),
        runDriver: async (_primary, ctx) => {
          got = ctx.signal;
          await waitFor(() => ctx.signal?.aborted === true, 5_000);
        },
      },
    );
    await waitFor(() => got !== undefined, 5_000);
    outer.abort("killed");
    await Promise.race([run.catch(() => ""), sleep(10_000)]);
    assert(
      got?.aborted === true,
      "3: aborting the launching job's signal reaches the group's driver",
    );
    clearJobsForTesting();
  }

  // ── 4. the single-issue and tool entry paths forward the job signal ───
  const SRC = path.join(import.meta.dirname, "..", "src");
  const entry = readFileSync(path.join(SRC, "work-entry.ts"), "utf8");
  assert(
    /work: async \(signal\) => \{[\s\S]{0,80}runSingleIssue\(pi, repoRoot, soleIssue, \{ \.\.\.flags, signal \}\)/.test(
      entry,
    ),
    "4: launchWork's single-issue job passes its signal to the driver",
  );
  assert(
    /const flags = \{ \.\.\.rest, signal \}/.test(entry),
    "4: runDriver threads its signal into both paths",
  );
  const tool = readFileSync(path.join(SRC, "work-tool.ts"), "utf8");
  assert(
    /runDriver\(piSessionHost\(pi\), \{[^}]*\}[^)]*signal,?\s*\}\)/.test(tool),
    "4: start_work_driver passes the job signal",
  );
} finally {
  setStdinTTY(originalTTY);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exit);
