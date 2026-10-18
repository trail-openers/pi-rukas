#!/usr/bin/env bun
/**
 * #1024 (headless S4) — runHeadless against the real driver with a stubbed
 * dispatch that never returns, so each case ends where the test decides:
 *
 *   - SIGTERM mid-dispatch → 21, exactly one `interrupted` event, a second
 *     SIGTERM adds nothing; every stderr line validates against NDJSON v1;
 *   - --timeout → 30 (the runner's own clock, not a signal);
 *   - a live owner in another process → 40, and the state file is untouched;
 *   - a merged cycle re-invoked without --restart → 0, projected from the file.
 *
 * Offline: no Pi session, no network (gh fails and the attention check reads as
 * unchecked, which the driver tolerates).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateNdjsonLine } from "../src/headless/ndjson.ts";
import { type HeadlessRunResult, runHeadless } from "../src/headless/run.ts";
import {
  type WorkEvent,
  type WorkState,
  initialState,
  readState,
  writeState,
} from "../src/workflow-state.ts";

process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type Handler = () => void;
/** A signal target the test fires by hand, standing in for process signals. */
function fakeSignals() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(sig: string, fn: Handler) {
      if (!handlers.has(sig)) handlers.set(sig, new Set());
      handlers.get(sig)?.add(fn);
    },
    off(sig: string, fn: Handler) {
      handlers.get(sig)?.delete(fn);
    },
    fire(sig: string) {
      for (const fn of [...(handlers.get(sig) ?? [])]) fn();
    },
  };
}

const hangingDispatch = () => new Promise<never>(() => undefined);
const issueFetch = async () => ({ stdout: "title:\tmock\nstate:\tOPEN\n\nnon-empty mock body" });

function tmpRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "headless-run-"));
}

function parseLines(lines: string[]): Record<string, unknown>[] {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ── 1. SIGTERM mid-dispatch: exit 21, one interrupted event, double signal ignored.
{
  const repo = tmpRepo();
  try {
    const lines: string[] = [];
    const sig = fakeSignals();
    let fired = false;
    const run = runHeadless({
      repoRoot: repo,
      issues: [41],
      restart: false,
      graceMs: 30,
      signalTarget: sig as unknown as NodeJS.Process,
      driverSeams: { dispatchFn: hangingDispatch, issueBodyFetcherFn: issueFetch },
      write: (l) => {
        lines.push(l);
        // The first step has started: the child is now in flight. Interrupt it, twice.
        if (!fired && (JSON.parse(l) as { kind: string }).kind === "step-started") {
          fired = true;
          sig.fire("SIGTERM");
          sig.fire("SIGINT");
        }
      },
    });
    const result: HeadlessRunResult = await run;
    const state = (await readState(repo, 41)) as WorkState;
    const interrupts = state.eventLog.filter((e: WorkEvent) => e.kind === "interrupted");
    assert(result.exitCode === 21, `SIGTERM mid-dispatch exits 21 (got ${result.exitCode})`);
    assert(state.pipelineState.status === "interrupted", "the state file reads interrupted");
    assert(interrupts.length === 1, "a second signal adds no second interrupted event");
    assert(
      interrupts[0]?.kind === "interrupted" && interrupts[0].reason === "signal",
      "the interrupted event carries reason signal",
    );
    const parsed = parseLines(lines);
    assert(
      parsed.every((p) => validateNdjsonLine(p).length === 0),
      "every stderr line validates against NDJSON v1",
    );
    assert(
      parsed.filter((p) => p.kind === "interrupted").length === 1,
      "the stream carries the interrupted event exactly once",
    );
    assert(result.results[0]?.exitCode === 21, "the JSON result carries exit 21 for the issue");

    // Re-invocation resumes the interrupted cycle rather than refusing it as terminal.
    const again = await runHeadless({
      repoRoot: repo,
      issues: [41],
      restart: false,
      graceMs: 30,
      signalTarget: fakeSignals() as unknown as NodeJS.Process,
      driverSeams: { dispatchFn: hangingDispatch, issueBodyFetcherFn: issueFetch },
      timeoutMs: 20,
      write: () => undefined,
    });
    assert(again.exitCode !== 40, "re-invocation of an interrupted cycle is not refused");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 2. --timeout: exit 30, reason timeout, not a signal.
{
  const repo = tmpRepo();
  try {
    const result = await runHeadless({
      repoRoot: repo,
      issues: [42],
      restart: false,
      timeoutMs: 20,
      graceMs: 30,
      signalTarget: fakeSignals() as unknown as NodeJS.Process,
      driverSeams: { dispatchFn: hangingDispatch, issueBodyFetcherFn: issueFetch },
      write: () => undefined,
    });
    const state = (await readState(repo, 42)) as WorkState;
    assert(result.exitCode === 30, `--timeout exits 30 (got ${result.exitCode})`);
    assert(
      state.eventLog.some((e) => e.kind === "interrupted" && e.reason === "timeout"),
      "the interrupted event carries reason timeout",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 3. A live owner in another process: exit 40, state file untouched.
{
  const repo = tmpRepo();
  try {
    const base = initialState(43);
    const owned: WorkState = {
      ...base,
      pipelineState: { ...base.pipelineState, status: "running" },
      owner: { pid: 1, at: Date.now() },
    };
    await writeState(repo, owned);
    const before = JSON.stringify(await readState(repo, 43));
    const result = await runHeadless({
      repoRoot: repo,
      issues: [43],
      restart: false,
      signalTarget: fakeSignals() as unknown as NodeJS.Process,
      driverSeams: { dispatchFn: hangingDispatch, issueBodyFetcherFn: issueFetch },
      write: () => undefined,
    });
    const after = JSON.stringify(await readState(repo, 43));
    assert(
      result.exitCode === 40,
      `a live owner in another process exits 40 (got ${result.exitCode})`,
    );
    assert(before === after, "the refused invocation leaves the state file untouched");
    // #1326 — a live owner holds the cycle: re-running cannot resume it.
    assert(result.results[0]?.resumable === false, "a refused (exit 40) result is not resumable");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 4. A merged cycle re-invoked without --restart: exit 0, read from the file.
{
  const repo = tmpRepo();
  try {
    const base = initialState(44);
    const merged: WorkState = {
      ...base,
      pipelineState: { ...base.pipelineState, status: "merged" },
      eventLog: [{ kind: "merged", at: 9, prNumber: 12 }],
    };
    await writeState(repo, merged);
    const result = await runHeadless({
      repoRoot: repo,
      issues: [44],
      restart: false,
      signalTarget: fakeSignals() as unknown as NodeJS.Process,
      driverSeams: { dispatchFn: hangingDispatch, issueBodyFetcherFn: issueFetch },
      write: () => undefined,
    });
    assert(result.exitCode === 0, `a merged cycle re-invoked exits 0 (got ${result.exitCode})`);
    assert(
      result.results[0]?.prNumber === 12,
      "the JSON result carries the PR from the state file",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 5. #1243 — a provider park is terminal: grace expiry cannot relabel its code.
//
// The park terminalises as `interrupted` (reason `provider`) so `/work N`
// re-enters it, and `exitCodeForState` gives it `EXIT.handoff`. But
// `interrupted` is ALSO the status a signal leaves behind, so when the runner's
// grace expired with the park on disk, the old `!TERMINAL_STATUSES.has(status)`
// test saw a non-terminal status and substituted the abort's code — 21 for a
// SIGTERM, 30 for `--timeout` — on a cycle that had reached its terminal
// boundary and delivered its handoff. `terminalForExitCode` is the fix; drop
// its `isProviderPark` clause and this leg reports 21.
//
// The fixture is built so the driver writes NOTHING after the park: it
// re-enters at `handoff` with `handoffDeliveredAt` already set, which
// short-circuits both the re-delivery and the step body. So the state file the
// runner reads back is the park that was on disk BEFORE the run started, and
// the runner's own decision is the only thing under test.
{
  const repo = tmpRepo();
  try {
    mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    const base = initialState(45);
    const park: WorkState = {
      ...base,
      pipelineState: {
        ...base.pipelineState,
        status: "interrupted",
        currentStep: "handoff",
        lastCompletedStep: "adversarial",
        handoffDeliveredAt: new Date().toISOString(),
      },
      eventLog: [
        { kind: "step-started", step: "adversarial", at: 1 },
        {
          kind: "dispatch-failed-provider",
          step: "adversarial",
          role: "adversarial-loop",
          jobId: "j-45",
          label: "adversarial_loop",
          ms: 1_000,
          at: 2,
          providerMessage: "Request timed out.",
        },
        {
          kind: "cap-hit",
          at: 3,
          cap: "provider-unavailable",
          reviewRound: 0,
          nextStep: "handoff",
          evidence: "Request timed out. · cause=provider-severed",
        },
        { kind: "interrupted", at: 4, reason: "provider", step: "adversarial" },
        // The park re-entered its handoff step. Without this the driver's
        // inconsistency guard sees `currentStep: handoff` behind the last
        // `step-started` and refuses the cycle outright (exit 40).
        { kind: "step-started", step: "handoff", at: 5 },
      ],
    };
    await writeState(repo, park);
    const sig = fakeSignals();
    // The abort is already raised when the run starts: `graceTimer` arms on an
    // already-aborted signal, so the runner takes its expired path — the code
    // that used to relabel the park. The park survives on disk (nothing here
    // re-persists it: `applyInterrupt` no-ops on a non-`running` cycle), so the
    // state the runner reads back is the park and `terminalForExitCode` is the
    // only thing deciding 10 vs 21. Mutation-checked: dropping the
    // `isProviderPark` clause from that helper reports 21 for both asserts below
    // (the driver's own terminal-delivery write deletes the state file, so the
    // runner falls to its not-started branch and takes the expired code there —
    // which is the same relabelling, just one branch earlier).
    sig.fire("SIGTERM");
    const result = await runHeadless({
      repoRoot: repo,
      issues: [45],
      restart: false,
      graceMs: 5,
      signalTarget: sig as unknown as NodeJS.Process,
      driverSeams: {
        // Both seams are inert and neither is reached: the cycle re-enters at
        // `handoff` with `handoffDeliveredAt` already set, so the driver's
        // re-entry short-circuits and writes NOTHING after the park. That is
        // what makes this the runner's decision — the only write after the park
        // is the runner's own expired-path `markInterrupted`, which
        // `applyInterrupt` no-ops because the cycle is not `running`. With a
        // productive seam the driver re-persists the cycle itself and the leg
        // would decide for the driver's reasons, not the runner's (mutation-
        // checked: dropping the `isProviderPark` clause flips this to 21).
        dispatchFn: async () => ({
          role: "ops" as const,
          ok: false,
          text: "smoke: inert",
          toolUses: [],
          ms: 0,
          exitCode: 1,
          transcriptPath: "/tmp/stub.json",
        }),
        issueBodyFetcherFn: async () => ({
          stdout: "title:\tmock\nstate:\tOPEN\n\nnon-empty mock body",
        }),
      },
      write: () => undefined,
    });
    const state = (await readState(repo, 45)) as WorkState;
    assert(
      state.pipelineState.status === "interrupted" &&
        state.eventLog.some((e) => e.kind === "interrupted" && e.reason === "provider"),
      "the state on disk is still the provider park",
    );
    assert(
      result.results[0]?.exitCode === 10,
      `a grace expiry after a provider park keeps EXIT.handoff (got ${result.results[0]?.exitCode})`,
    );
    assert(
      result.exitCode === 10,
      `the run's exit code is the park's, not the abort's (got ${result.exitCode})`,
    );
    assert(
      result.results[0]?.resumable === true,
      "the JSON result still reports the park resumable",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

process.exit(exit);
