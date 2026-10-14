/**
 * headless/run — one-shot /work run on a headless DriverHost (headless S4, #1024).
 *
 * Awaits the compiled driver(s) and returns each issue's exit code, derived from
 * the state file the driver left behind. Interrupts:
 *
 *  - SIGTERM / SIGINT (first one only; later signals are ignored) aborts the
 *    cycle's signal with reason `signal`. The driver records the interrupt at its
 *    next step boundary (work-driver-interrupt.ts).
 *  - `timeoutMs` aborts with reason `timeout` — the same path, exit 30.
 *  - If the driver does not reach a boundary within `graceMs` of the abort, the
 *    runner writes the interrupt to disk itself (markInterrupted). Nothing else
 *    writes after that, so the disk record cannot be overwritten by a stale
 *    in-memory snapshot.
 *
 * Multi-issue invocations are grouped (groupIssues) and run one group at a time;
 * a per-group queue (runWorkQueue) is not used because it needs an interactive
 * host's job registry.
 */

import type { DriverContext } from "../work-driver-context.ts";
import { groupIssues } from "../work-driver-grouping.ts";
import { type DriverOutcome, runWorkDriver } from "../work-driver.ts";
import { fetchIssueBodies } from "../work-entry.ts";
import { createEmitSink } from "../work-state-emit.ts";
import { markInterrupted, readState, workStateFile } from "../workflow-state.ts";
import { EXIT, exitCodeForGroup, exitCodeForState } from "./exit-code.ts";
import { type LineWriter, createHeadlessHost } from "./host.ts";
import { type IssueResult, projectIssue } from "./result.ts";

export interface HeadlessRunOptions {
  repoRoot: string;
  issues: number[];
  restart: boolean;
  mergeGrant: boolean;
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

export async function runHeadless(opts: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const controller = new AbortController();
  const target = opts.signalTarget ?? process;
  const grace = opts.graceMs ?? DEFAULT_GRACE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let signalled = false;

  const onSignal = (name: string) => {
    if (signalled) return;
    signalled = true;
    controller.abort("signal");
    void name;
  };
  const sigterm = () => onSignal("SIGTERM");
  const sigint = () => onSignal("SIGINT");
  target.on("SIGTERM", sigterm);
  target.on("SIGINT", sigint);
  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort("timeout");
    }, opts.timeoutMs);
  }

  const results: IssueResult[] = [];
  const codes: number[] = [];
  try {
    const groups = await planGroups(opts);
    for (const group of groups) {
      if (controller.signal.aborted) break;
      const groupCodes = await runGroup(opts, group, controller.signal, grace, results);
      codes.push(...groupCodes);
    }
  } finally {
    if (timer) clearTimeout(timer);
    target.off("SIGTERM", sigterm);
    target.off("SIGINT", sigint);
  }
  return { exitCode: exitCodeForGroup(codes), results };
}

async function planGroups(opts: HeadlessRunOptions): Promise<number[][]> {
  if (opts.issues.length <= 1) return opts.issues.map((n) => [n]);
  const bodies = await fetchIssueBodies(opts.repoRoot, opts.issues);
  return Object.values(groupIssues(opts.issues, bodies).groups).map((g) => g.issues);
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
  const sink = createEmitSink((e) => host.emit(e));
  const driver: Promise<DriverOutcome | { crashed: string }> = runWorkDriver({
    host,
    repoRoot: opts.repoRoot,
    issue: primary,
    issues: members,
    restart: opts.restart,
    mergeGrant: opts.mergeGrant,
    signal,
    emitSink: sink,
    ...opts.driverSeams,
  }).catch((err: Error) => ({ crashed: err.message }));

  // After an abort the driver gets `grace` ms to reach a boundary; past that the
  // runner records the interrupt itself and stops waiting.
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    const arm = () => {
      fallback = setTimeout(() => resolve("expired"), grace);
    };
    if (signal.aborted) arm();
    else signal.addEventListener("abort", arm, { once: true });
  });
  const outcome = await Promise.race([driver, expired]);
  if (fallback) clearTimeout(fallback);

  if (outcome === "expired") {
    await markInterrupted(opts.repoRoot, primary, String(signal.reason ?? "signal"), sink);
  }

  const codes: number[] = [];
  for (const issue of group) {
    const file = workStateFile(opts.repoRoot, issue);
    const state = await readState(opts.repoRoot, issue);
    if (!state) {
      // A grouped member has no state of its own: it shares the primary's outcome.
      // Otherwise no state file means a refusal (40) or a crash before the first persist (30).
      const refused = outcome !== "expired" && isRefusal(outcome);
      const code =
        issue !== primary && codes[0] !== undefined
          ? codes[0]
          : refused
            ? EXIT.refused
            : EXIT.crash;
      codes.push(code);
      results.push({
        issue,
        status: "aborted",
        stateFile: file,
        durationMs: 0,
        steps: [],
        exitCode: code,
      });
      continue;
    }
    const projected = projectIssue(state, file);
    // A refused start against a state the refusal left untouched keeps the
    // state's own outcome only when that outcome is terminal; a live owner's
    // `running` state is a refusal.
    const code =
      outcome !== "expired" && isRefusal(outcome) && state.pipelineState.status === "running"
        ? EXIT.refused
        : exitCodeForState(state);
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
