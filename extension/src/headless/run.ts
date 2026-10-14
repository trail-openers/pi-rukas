/**
 * headless/run — one-shot /work run on a headless DriverHost (headless S4, #1024).
 *
 * Awaits the compiled driver(s) and returns each issue's exit code, derived from
 * the state file the driver left behind. Interrupts:
 *
 *  - SIGTERM / SIGINT / SIGHUP (first one only; later signals are ignored)
 *    abort the cycle's signal with reason `signal`. The driver records the
 *    interrupt at its next step boundary (work-driver-interrupt.ts). SIGHUP also
 *    SIGKILLs every live child process group at once.
 *  - `timeoutMs` aborts with reason `timeout` — the same path, exit 30.
 *  - If the driver does not reach a boundary within `graceMs` of the abort, the
 *    runner records the interrupt itself (markInterrupted), then waits up to
 *    LATE_DRIVER_MS more for a driver that was mid-step. Only then is the state
 *    read back. A run that expires exits 21 (30 for `timeout`), unless the state
 *    is already terminal (merged / handoff / aborted), which keeps its own code.
 *  - An issue no group reached (the abort landed between groups) is reported
 *    with its state file's status, or `not-started` when there is no state file,
 *    and the interrupt code.
 *  - A driver that is still running after the runner stops waiting cannot write
 *    `running` back: once the signal has fired, persistCycle writes `interrupted`.
 *
 * Multi-issue invocations are grouped (groupIssues) and run one group at a time;
 * a per-group queue (runWorkQueue) is not used because it needs an interactive
 * host's job registry.
 */

import { killLiveProcessGroups } from "../spawn-kill.ts";
import { trace } from "../trace.ts";
import type { DriverContext } from "../work-driver-context.ts";
import { groupIssues } from "../work-driver-grouping.ts";
import { releaseHeldIntegrationLocks } from "../work-driver-lock.ts";
import { type DriverOutcome, runWorkDriver } from "../work-driver.ts";
import { fetchIssueBodies } from "../work-entry.ts";
import { createEmitSink } from "../work-state-emit.ts";
import { interruptReasonOf, markInterrupted, readState, workStateFile } from "../workflow-state.ts";
import { EXIT, exitCodeForGroup, exitCodeForState } from "./exit-code.ts";
import { type LineWriter, createHeadlessHost } from "./host.ts";
import { type IssueResult, projectIssue } from "./result.ts";

export interface HeadlessRunOptions {
  repoRoot: string;
  issues: number[];
  restart: boolean;
  /** Runner-level wall clock. Absent = no timeout. */
  timeoutMs?: number;
  /** Milliseconds the driver gets to reach a step boundary after an abort. */
  graceMs?: number;
  write: LineWriter;
  /** Where the runner listens for signals. Defaults to the process. */
  signalTarget?: Pick<NodeJS.Process, "on" | "off">;
  /** Test seams forwarded to the driver (dispatch stub, issue-body fetch stub). */
  driverSeams?: Pick<DriverContext, "dispatchFn" | "issueBodyFetcherFn">;
}

export interface HeadlessRunResult {
  exitCode: number;
  results: IssueResult[];
}

const DEFAULT_GRACE_MS = 10_000;
/** States whose exit code is already decided: an expired signal does not override them. */
const TERMINAL_STATUSES = new Set<string>(["merged", "handoff", "aborted"]);
/** After grace expires, how long the runner waits for a driver that was mid-step. */
const LATE_DRIVER_MS = 5_000;

export async function runHeadless(opts: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const controller = new AbortController();
  const target = opts.signalTarget ?? process;
  const grace = opts.graceMs ?? DEFAULT_GRACE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let signalled = false;

  const onSignal = () => {
    if (signalled) return;
    signalled = true;
    controller.abort("signal");
  };
  const onHangup = () => {
    onSignal();
    killLiveProcessGroups();
  };
  // Synchronous last resort: a group child must not outlive the runner.
  const onExit = () => killLiveProcessGroups();
  target.on("SIGTERM", onSignal);
  target.on("SIGINT", onSignal);
  target.on("SIGHUP", onHangup);
  target.on("exit", onExit);
  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort("timeout");
    }, opts.timeoutMs);
  }

  const results: IssueResult[] = [];
  const codes: number[] = [];
  let groups: number[][] = [];
  try {
    groups = await planGroups(opts);
    for (const group of groups) {
      if (controller.signal.aborted) break;
      const groupCodes = await runGroup(opts, group, controller.signal, grace, results);
      codes.push(...groupCodes);
    }
  } finally {
    if (timer) clearTimeout(timer);
    target.off("SIGTERM", onSignal);
    target.off("SIGINT", onSignal);
    target.off("SIGHUP", onHangup);
    // The exit listener stays registered until the process exits: cli.ts kills
    // the live groups synchronously just before process.exit (idempotent).
    // A driver may still hold a lockfile past its grace period; it must not
    // outlive this process. Released on every path, not only on a signal.
    releaseHeldIntegrationLocks();
  }
  // Between groups, or while the issue bodies are fetched, an abort leaves
  // issues no group reached. Each is reported; none is dropped.
  const interruptCode = controller.signal.reason === "timeout" ? EXIT.crash : EXIT.interrupted;
  const unrun = groups.flat().filter((issue) => !results.some((r) => r.issue === issue));
  for (const issue of unrun) {
    results.push(await unrunResult(opts.repoRoot, issue, interruptCode));
  }
  if (unrun.length > 0) return { exitCode: interruptCode, results };
  return { exitCode: exitCodeForGroup(codes), results };
}

/** An issue no group reached: its state file's status if one exists, else not-started. */
async function unrunResult(
  repoRoot: string,
  issue: number,
  exitCode: number,
): Promise<IssueResult> {
  const file = workStateFile(repoRoot, issue);
  const state = await readState(repoRoot, issue);
  if (!state) {
    return { issue, status: "not-started", stateFile: file, durationMs: 0, steps: [], exitCode };
  }
  return { ...projectIssue(state, file), exitCode };
}

async function planGroups(opts: HeadlessRunOptions): Promise<number[][]> {
  if (opts.issues.length <= 1) return opts.issues.map((n) => [n]);
  const bodies = await fetchIssueBodies(opts.repoRoot, opts.issues);
  return Object.values(groupIssues(opts.issues, bodies).groups).map((g) => g.issues);
}

/** Resolves "expired" once the signal has aborted and `grace` ms have passed. */
function graceTimer(
  signal: AbortSignal,
  grace: number,
): { expired: Promise<"expired">; cancel: () => void } {
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    const arm = () => {
      fallback = setTimeout(() => resolve("expired"), grace);
    };
    if (signal.aborted) arm();
    else signal.addEventListener("abort", arm, { once: true });
  });
  return {
    expired,
    cancel: () => {
      if (fallback) clearTimeout(fallback);
    },
  };
}

/** Waits for `p` for at most `ms`; never rejects. */
function waitAtMost(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    p.then(done, done);
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run one group; returns the exit code of each issue in it and records results. */
async function runGroup(
  opts: HeadlessRunOptions,
  group: number[],
  signal: AbortSignal,
  grace: number,
  results: IssueResult[],
): Promise<number[]> {
  const primary = group[0];
  if (primary === undefined) return [];
  const members = group.length > 1 ? group : undefined;
  const host = createHeadlessHost(primary, opts.write);
  // One sink per issue, shared with the driver and the fallback below: the watermark keeps the stream exactly-once.
  const sink = createEmitSink((e, index) => host.emit(e, index));
  const driver: Promise<DriverOutcome | { crashed: string }> = runWorkDriver({
    host,
    repoRoot: opts.repoRoot,
    issue: primary,
    issues: members,
    restart: opts.restart,
    signal,
    processGroup: true,
    emitSink: sink,
    ...opts.driverSeams,
  }).catch((err: unknown) => ({ crashed: errorMessage(err) }));

  let settled = false;
  void driver.then(() => {
    settled = true;
  });
  const timer = graceTimer(signal, grace);
  const outcome = await Promise.race([driver, timer.expired]);
  timer.cancel();

  if (outcome === "expired") {
    // The driver missed its boundary: record the interrupt from here (a no-op
    // on a terminal status), then give a driver that was mid-step a bounded
    // moment to finish its persist before the state is read back.
    // A failed record must not stop the read-back below: the state file is the
    // authority, and whatever it says is what the exit code reports.
    try {
      await markInterrupted(opts.repoRoot, primary, interruptReasonOf(signal), sink);
    } catch (err) {
      trace(`headless: could not record the interrupt for issue #${primary}: ${errorMessage(err)}`);
    }
    await waitAtMost(driver, LATE_DRIVER_MS);
    // The integration locks are released in runHeadless's finally; a driver
    // still running here may take one after that, so the release is traced.
    if (!settled) {
      trace(`headless: driver for issue #${primary} still running past the late deadline`);
    }
  }

  // Computed once for the group. A refusal is a driver that did not start.
  const refused = outcome !== "expired" && isRefusal(outcome);
  // A signalled run that ran out of grace exits 21 (30 for --timeout), unless
  // the state is already terminal and decided its own code.
  const expiredCode = signal.reason === "timeout" ? EXIT.crash : EXIT.interrupted;
  const codes: number[] = [];
  for (const issue of group) {
    const file = workStateFile(opts.repoRoot, issue);
    const state = await readState(opts.repoRoot, issue);
    if (!state) {
      // No state file: the driver never reached its first persist. Reported as
      // not-started, never as a fabricated status.
      const code = outcome === "expired" ? expiredCode : refused ? EXIT.refused : EXIT.crash;
      codes.push(code);
      results.push({
        issue,
        status: "not-started",
        stateFile: file,
        durationMs: 0,
        steps: [],
        exitCode: code,
      });
      continue;
    }
    const projected = projectIssue(state, file);
    // A refused start against a state the refusal left untouched is a refusal;
    // a live owner's `running` state is one.
    const refusedHere = refused && state.pipelineState.status === "running";
    let code: number;
    if (outcome === "expired" && !TERMINAL_STATUSES.has(state.pipelineState.status)) {
      code = expiredCode;
    } else if (refusedHere) code = EXIT.refused;
    else code = exitCodeForState(state);
    projected.exitCode = code;
    results.push(projected);
    codes.push(code);
  }
  return codes;
}

/** A driver that did not start: claimed by a live cycle, labelled, or invalid. */
function isRefusal(outcome: DriverOutcome | { crashed: string }): boolean {
  if (!("started" in outcome)) return false;
  return !outcome.started && !outcome.reason.startsWith("already terminated");
}
