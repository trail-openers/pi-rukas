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
import {
  interruptReasonOf,
  isTerminalState,
  markInterrupted,
  readState,
  workStateFile,
} from "../workflow-state.ts";
import type { WorkState } from "../workflow-state.ts";
import { EXIT, exitCodeForGroup, exitCodeForState } from "./exit-code.ts";
import { type LineWriter, createHeadlessHost } from "./host.ts";
import { prUrlResolver } from "./pr-url.ts";
import { type IssueResult, notStartedResult, projectIssue } from "./result.ts";

export interface HeadlessRunOptions {
  repoRoot: string;
  issues: number[];
  restart: boolean;
  /** #1468 — continue the issue's open PR. Absent = false. */
  continuePr?: boolean;
  /** Runner-level wall clock. Absent = no timeout. */
  timeoutMs?: number;
  /** Milliseconds the driver gets to reach a step boundary after an abort. */
  graceMs?: number;
  write: LineWriter;
  /** Where the runner listens for signals. Defaults to the process. */
  signalTarget?: Pick<NodeJS.Process, "on" | "off">;
  /** Test seams forwarded to the driver (dispatch stub, issue-body fetch stub). */
  driverSeams?: Pick<
    DriverContext,
    "dispatchFn" | "issueBodyFetcherFn" | "verifyExecFn" | "policyJudgeFn"
  >;
}

export interface HeadlessRunResult {
  exitCode: number;
  results: IssueResult[];
  /**
   * #1189 — present when the runner detected a state divergence (the
   * driver's in-memory terminal state disagreed with the state file on
   * disk). The CLI emits `error.code: "state-diverged"` in the JSON
   * output when this is set. The result is projected from the in-memory
   * state (the runner's own truth), not from the file.
   */
  error?: { code: "state-diverged"; message: string };
}

const DEFAULT_GRACE_MS = 10_000;
/** After grace expires, how long the runner waits for a driver that was mid-step. */
const LATE_DRIVER_MS = 5_000;

/**
 * #1189 — compare the driver's in-memory terminal state against the state
 * file on disk. Returns the field names that differ (empty = agree).
 * Compares the UNION of keys present on either side, so a field added to
 * disk but absent from the snapshot is also caught (undefined vs a value
 * diverges). `updatedAt` is the only exclusion: it is a write timestamp,
 * not state — the driver's in-memory copy predates the final persist that
 * rewrote it.
 */
export function detectDivergence(memory: WorkState, disk: WorkState): string[] {
  const excluded = new Set<keyof WorkState>(["updatedAt"]);
  const keys = new Set<string>([...Object.keys(memory), ...Object.keys(disk)]);
  const diffs: string[] = [];
  for (const k of keys) {
    if (excluded.has(k as keyof WorkState)) continue;
    const f = k as keyof WorkState;
    if (JSON.stringify(memory[f]) !== JSON.stringify(disk[f])) diffs.push(f);
  }
  return diffs;
}

/** A compact summary of a state for trace output (not the whole JSON). */
function summarizeState(s: WorkState): Record<string, unknown> {
  return {
    status: s.pipelineState.status,
    currentStep: s.pipelineState.currentStep,
    prNumber: s.pipelineState.prNumber,
    branch: s.pipelineState.branchName,
    eventLogLength: s.eventLog.length,
  };
}

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
  let divergenceError: { code: "state-diverged"; message: string } | undefined;
  try {
    groups = await planGroups(opts);
    for (const group of groups) {
      if (controller.signal.aborted) break;
      const groupCodes = await runGroup(opts, group, controller.signal, grace, results, (msg) => {
        divergenceError = { code: "state-diverged", message: msg };
      });
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
  // #1326 — a refused start is not resumable while its owner lives; a PR URL
  // the driver did not record is resolved once from the local remote.
  for (const r of results) if (r.exitCode === EXIT.refused) r.resumable = false;
  if (results.some((r) => r.prNumber !== undefined && r.prUrl === undefined)) {
    const prUrlFor = await prUrlResolver(opts.repoRoot);
    for (const r of results) {
      if (r.prNumber === undefined || r.prUrl !== undefined) continue;
      const url = prUrlFor(r.prNumber);
      if (url) r.prUrl = url;
    }
  }
  if (unrun.length > 0) return { exitCode: interruptCode, results };
  const base = { exitCode: exitCodeForGroup(codes), results };
  if (divergenceError) return { ...base, error: divergenceError };
  return base;
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
    return notStartedResult(issue, file, exitCode);
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
  onDivergence: (message: string) => void,
): Promise<number[]> {
  const primary = group[0];
  if (primary === undefined) return [];
  const members = group.length > 1 ? group : undefined;
  const host = createHeadlessHost(primary, opts.write);
  // One sink per issue, shared with the driver and the fallback below: the watermark keeps the stream exactly-once.
  const sink = createEmitSink((e, index) => host.emit(e, index));
  // #1189 — the driver's in-memory terminal state, handed to the runner
  // for the disk-vs-memory divergence check. The state file lives inside
  // the tree the agents work in and agents run as the same user, so an
  // agent can write it — this callback is the runner's own, trusted copy
  // of the terminal state, captured from the driver rather than read back
  // from the file. `undefined` means the driver crashed before reaching
  // a terminal boundary (the file is then the only thing it left behind).
  let inMemory: WorkState | undefined;
  const onFinalState = (s: WorkState) => {
    inMemory = s;
  };
  const driver: Promise<DriverOutcome | { crashed: string }> = runWorkDriver({
    host,
    repoRoot: opts.repoRoot,
    issue: primary,
    issues: members,
    restart: opts.restart,
    continuePr: opts.continuePr,
    signal,
    processGroup: true,
    // Nobody watches a headless review window: its PR opens as a draft by default.
    headless: true,
    emitSink: sink,
    onFinalState,
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
    let state: WorkState | undefined;
    try {
      state = await readState(opts.repoRoot, issue);
    } catch (err) {
      // #1189 — a corrupt or unreadable state file is exactly the tamper case
      // the divergence check exists for. Report it as a divergence for THIS
      // issue (not-started + exit 30 + diverged) instead of letting the throw
      // escape and crash the run with every prior result lost.
      const message = `state file for issue #${issue} is corrupt or unreadable (${errorMessage(err)}); result reported as not-started`;
      trace(`headless: state file for #${issue} unreadable: ${errorMessage(err)}`);
      onDivergence(message);
      results.push(notStartedResult(issue, file, EXIT.crash, { diverged: true }));
      codes.push(EXIT.crash);
      continue;
    }
    if (!state) {
      // Fix 6: driver completed (in-memory snapshot present) but its state
      // file was deleted between the driver's final persist and this re-read.
      // Reporting "not-started" would fabricate a state the driver never
      // had; instead project from the snapshot and flag the divergence —
      // the file is missing where the driver says it should be, so exit 30.
      // Primary-scoped: the snapshot describes the primary's state, so only
      // the primary is projected from it. A secondary with a missing file has
      // no snapshot of its own → not-started.
      if (inMemory !== undefined && issue === primary) {
        const message =
          "driver completed but its state file was deleted before the runner could read it; " +
          "result projected from the driver's in-memory state";
        pushDiverged(issue, file, inMemory, message, results, codes, onDivergence);
        continue;
      }
      // No state file and no snapshot (or a secondary, which the snapshot does
      // not describe): the driver never reached its first persist for this issue.
      // Reported as not-started, never as a fabricated status.
      const code = outcome === "expired" ? expiredCode : refused ? EXIT.refused : EXIT.crash;
      codes.push(code);
      results.push(notStartedResult(issue, file, code));
      continue;
    }
    const projected = projectIssue(state, file);
    // A refused start against a state the refusal left untouched is a refusal;
    // a live owner's `running` state is one.
    const refusedHere = refused && state.pipelineState.status === "running";
    let code: number;
    if (outcome === "expired" && !isTerminalState(state)) {
      code = expiredCode;
    } else if (refusedHere) code = EXIT.refused;
    else code = exitCodeForState(state);
    // #1189 — divergence check, PRIMARY-SCOPED.
    //
    // The driver's onFinalState snapshot describes the cycle's PRIMARY issue
    // (ctx.issue). It is therefore only a valid comparison baseline for the
    // primary's state file. In a grouped run, a secondary issue's state file
    // (if present — e.g. a pre-existing file from a prior completed cycle)
    // is a DIFFERENT issue's state and is NOT compared against the primary's
    // snapshot; comparing it would spuriously report state-diverged on a
    // legitimate, untampered file. The narrow exposure this leaves — a
    // tampered secondary state file choosing that secondary's exit code — is
    // accepted: the driver does not write secondary state files, so a present
    // secondary file is pre-existing, and the pre-PR behaviour (file is the
    // authority for non-primary issues) is restored for them.
    //
    // For the primary: if the driver reached a terminal boundary and handed
    // the runner an in-memory snapshot, that snapshot must match what the
    // state file on disk says. The state file is inside the repo tree the
    // agents work in and agents run as the same user, so an agent that edits
    // its own state file could otherwise choose the runner's exit code and
    // JSON result. On disagreement we exit 30 with
    // `error.code: "state-diverged"` — the driver's in-memory state is what
    // we trust, and the file is what we flag.
    if (inMemory !== undefined && issue === primary) {
      const divergences = detectDivergence(inMemory, state);
      if (divergences.length > 0) {
        const message =
          `driver in-memory state and state file disagree on fields: ${divergences.join(", ")}; ` +
          `driver said ${JSON.stringify(summarizeState(inMemory))}, file says ${JSON.stringify(summarizeState(state))}`;
        pushDiverged(issue, file, inMemory, message, results, codes, onDivergence);
        continue;
      }
    }
    projected.exitCode = code;
    results.push(projected);
    codes.push(code);
  }
  return codes;
}

/**
 * #1189 — one divergence outcome, shared by the missing-file-with-snapshot
 * and present-file-disagree branches. The in-memory snapshot is the runner's
 * own truth; the file (or its absence) is the suspect. Projects from the
 * in-memory state (NOT the file), flags the result diverged, and exits 30.
 * `file` is only used for the projected result's `stateFile` field. The
 * message is constructed at the call site because the two branches differ.
 */
function pushDiverged(
  issue: number,
  file: string,
  inMemory: WorkState,
  message: string,
  results: IssueResult[],
  codes: number[],
  onDivergence: (message: string) => void,
): void {
  trace(`headless: state divergence on issue #${issue} — ${message}`);
  onDivergence(message);
  const projected = projectIssue(inMemory, file);
  projected.exitCode = EXIT.crash;
  projected.diverged = true;
  results.push(projected);
  codes.push(EXIT.crash);
}

/** A driver that did not start: claimed by a live cycle, labelled, or invalid. */
function isRefusal(outcome: DriverOutcome | { crashed: string }): boolean {
  if (!("started" in outcome)) return false;
  return !outcome.started && !outcome.reason.startsWith("already terminated");
}
