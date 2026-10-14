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
import { mkdtempSync, rmSync } from "node:fs";
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

process.exit(exit);
