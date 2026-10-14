#!/usr/bin/env bun
/**
 * #1024 (headless S4, round 3) — one interrupt transition, no dropped events:
 *
 *   - applyInterrupt is the single transition: running → interrupted with one
 *     `interrupted` event; a non-running state is returned unchanged; the same
 *     interrupt applied again adds no second event;
 *   - a `--timeout` abort that lands on a stale persist ends interrupted with a
 *     `timeout` reason, and exits 30;
 *   - beginDispatch under an aborted signal never writes `running` back;
 *   - the NDJSON stream equals the final eventLog exactly once after an abort
 *     that followed a persisted dispatch-failed.
 *
 * Offline: the dispatch is a stub, the issue body is a stub.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHeadless } from "../src/headless/run.ts";
import { EXIT, exitCodeForState } from "../src/headless/exit-code.ts";
import { beginDispatch } from "../src/work-driver-resume.ts";
import type { DispatchResult } from "../src/types.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import {
  type WorkEvent,
  type WorkState,
  applyInterrupt,
  initialState,
  persistCycle,
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

const issueFetch = async () => ({ stdout: "title:\tmock\nstate:\tOPEN\n\nnon-empty mock body" });

function fakeSignals() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    on(sig: string, fn: () => void) {
      if (!handlers.has(sig)) handlers.set(sig, new Set());
      handlers.get(sig)?.add(fn);
    },
    off(sig: string, fn: () => void) {
      handlers.get(sig)?.delete(fn);
    },
    fire(sig: string) {
      for (const fn of [...(handlers.get(sig) ?? [])]) fn();
    },
  };
}

function tmpRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "headless-reason-"));
}

const interruptCount = (s: WorkState) => s.eventLog.filter((e) => e.kind === "interrupted").length;

// ── 1. applyInterrupt: the one transition.
{
  const running = initialState(70);
  const once = applyInterrupt(running, "signal", 10);
  assert(once.pipelineState.status === "interrupted", "applyInterrupt sets interrupted");
  assert(interruptCount(once) === 1, "applyInterrupt appends exactly one interrupted event");
  const twice = applyInterrupt(once, "signal", 11);
  assert(interruptCount(twice) === 1, "the same interrupt applied again adds no event");
  const merged = { ...running, pipelineState: { ...running.pipelineState, status: "merged" as const } };
  assert(applyInterrupt(merged, "signal", 12) === merged, "a terminal state is returned unchanged");
}

// ── 2. --timeout on a stale persist: interrupted, reason timeout, exit 30.
{
  const repo = tmpRepo();
  try {
    const ac = new AbortController();
    const sink = createEmitSink(() => undefined);
    const stale = initialState(71);
    await writeState(repo, stale);
    ac.abort("timeout");
    await persistCycle({ repoRoot: repo, emitSink: sink, signal: ac.signal }, stale);
    const onDisk = (await readState(repo, 71)) as WorkState;
    const last = onDisk.eventLog[onDisk.eventLog.length - 1];
    assert(onDisk.pipelineState.status === "interrupted", "a stale persist after --timeout is interrupted");
    assert(
      last?.kind === "interrupted" && last.reason === "timeout",
      "the interrupted event carries reason timeout",
    );
    assert(exitCodeForState(onDisk) === EXIT.crash, "a timeout interrupt exits 30");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 3. beginDispatch under an aborted signal never writes running back.
{
  const repo = tmpRepo();
  try {
    const ac = new AbortController();
    const sink = createEmitSink(() => undefined);
    const state = initialState(72);
    await writeState(repo, state);
    ac.abort("signal");
    await beginDispatch(
      { repoRoot: repo, emitSink: sink, signal: ac.signal },
      state,
      "explore",
      "explore",
      "explore[probe]",
      5,
    );
    const onDisk = (await readState(repo, 72)) as WorkState;
    assert(onDisk.pipelineState.status === "interrupted", "beginDispatch after an abort lands interrupted");
    assert(interruptCount(onDisk) === 1, "and records one interrupted event");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 4. The NDJSON stream equals the final eventLog exactly once.
{
  const repo = tmpRepo();
  try {
    const sig = fakeSignals();
    const lines: string[] = [];
    const dispatch = (_h: unknown, spec: { role: string }) => {
      sig.fire("SIGTERM");
      const failed: DispatchResult = {
        role: spec.role,
        ok: false,
        text: "",
        toolUses: [],
        ms: 1,
        exitCode: null,
      };
      return Promise.resolve(failed);
    };
    const result = await runHeadless({
      repoRoot: repo,
      issues: [73],
      restart: false,
      graceMs: 50,
      signalTarget: sig as unknown as NodeJS.Process,
      driverSeams: { dispatchFn: dispatch as never, issueBodyFetcherFn: issueFetch },
      write: (line) => lines.push(line),
    });
    const state = (await readState(repo, 73)) as WorkState;
    const streamKeys = lines
      .map((l) => JSON.parse(l) as { key?: string })
      .filter((p) => p.key !== undefined)
      .map((p) => p.key);
    const logKeys = state.eventLog.map(
      (e: WorkEvent, i) => `73:${i}:${(e as { at?: number }).at}`,
    );
    assert(result.exitCode === EXIT.interrupted, "the aborted run exits 21");
    assert(
      state.eventLog.some((e) => e.kind.startsWith("dispatch-failed")),
      "the log holds the dispatch-failed persisted before the abort",
    );
    assert(
      JSON.stringify(streamKeys) === JSON.stringify(logKeys),
      `the NDJSON stream equals the eventLog once (stream ${streamKeys.length}, log ${logKeys.length})`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

if (exit === 0) console.log("\nAll headless interrupt-reason checks passed.");
process.exit(exit);
