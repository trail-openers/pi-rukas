#!/usr/bin/env bun
/**
 * #1162 (S4a) — the `interrupted` status, the `interrupted` event, the emit
 * choke point behind DriverHost.emit, and re-entry of an interrupted cycle.
 *
 * Offline: no Pi session, no network. The re-entry case runs the real driver
 * against a stubbed dispatch that throws, so the cycle ends at its first step.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent } from "../src/workflow-state-update.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { DriverHost } from "../src/work-driver-host.ts";
import { bindStateEmitter } from "../src/work-state-emit.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { renderStatus } from "../src/work-status.ts";
import { renderCycleIndex } from "../src/work-status-index.ts";
import { singleCycleQueueEntry } from "../src/work-queue-single-entry.ts";
import {
  initialState,
  markInterrupted,
  readState,
  workStateFile,
  writeState,
  type WorkEvent,
  type WorkState,
} from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_VERIFY = "0";

function tmpRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "work-interrupted-"));
}

// ── 1. Schema: the status and the event kind are accepted; unknowns are not.
{
  const base = initialState(1);
  const interruptedState = appendEvent(
    { ...base, pipelineState: { ...base.pipelineState, status: "interrupted" } },
    { kind: "interrupted", at: 1, reason: "SIGTERM" },
  );
  assert(
    validateDiscriminants(interruptedState).length === 0,
    "validateDiscriminants accepts status `interrupted` and the `interrupted` event",
  );
  const paused = {
    ...base,
    pipelineState: { ...base.pipelineState, status: "paused" },
  };
  const findings = validateDiscriminants(paused);
  assert(
    findings.some((f) => f.includes('status has unknown value "paused"')),
    "validateDiscriminants rejects an unknown status (`paused`) with the existing message",
  );
}

// ── 2. markInterrupted sets the status, appends the event, and persists.
{
  const repo = tmpRepo();
  try {
    const state = initialState(77);
    await writeState(repo, state);
    const next = await markInterrupted(repo, state, "SIGTERM", 5);
    const back = await readState(repo, 77);
    assert(next.pipelineState.status === "interrupted", "markInterrupted returns status `interrupted`");
    assert(back?.pipelineState.status === "interrupted", "markInterrupted persists the status");
    const last = back?.eventLog[back.eventLog.length - 1];
    assert(
      last?.kind === "interrupted" && last.reason === "SIGTERM",
      "markInterrupted appends an `interrupted` event carrying the reason",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 3. Emit choke point: every eventLog entry, once, in order, at persist.
{
  const repo = tmpRepo();
  try {
    const emitted: WorkEvent[] = [];
    const unbind = bindStateEmitter(workStateFile(repo, 88), (e) => emitted.push(e));
    const at = 10;
    let state = initialState(88);
    state = appendEvent(state, { kind: "step-started", step: "explore", at });
    state = appendEvent(state, { kind: "step-started", step: "plan", at: at + 1 });
    await writeState(repo, state);
    assert(emitted.length === 2, "two appended events are emitted on the first persist");
    await writeState(repo, state);
    assert(emitted.length === 2, "a persist that adds no events emits nothing");
    const stale = { ...state, eventLog: state.eventLog.slice(0, 1) };
    await writeState(repo, stale);
    assert(emitted.length === 2, "a stale (shorter) snapshot emits nothing");
    await markInterrupted(repo, state, "SIGINT", at + 2);
    const persisted = await readState(repo, 88);
    assert(
      JSON.stringify(emitted) === JSON.stringify(persisted?.eventLog),
      "emitted events equal the final eventLog, in order",
    );
    unbind();
    await writeState(repo, appendEvent(state, { kind: "step-started", step: "branch", at }));
    assert(emitted.length === 3, "after unbind, persists emit nothing");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 4. Re-entry: an interrupted cycle with no dispatch in flight resumes.
{
  const repo = tmpRepo();
  try {
    const interruptedAt = await markInterrupted(repo, initialState(99), "SIGTERM", 1);
    const notices: string[] = [];
    const host: DriverHost = {
      sendUserMessage: (text) => {
        notices.push(text);
      },
    };
    const ctx = {
      host,
      repoRoot: repo,
      issue: 99,
      issueBodyFetcherFn: async () => ({
        stdout: "title:\tmock #99\nstate:\tOPEN\n\nnon-empty mock body",
      }),
      dispatchFn: async () => {
        throw new Error("stub: first dispatch fails");
      },
    } as unknown as DriverContext;
    await runWorkDriver(ctx).catch(() => undefined);
    const after = (await readState(repo, 99)) as WorkState;
    const interruptIdx = after.eventLog.findIndex((e) => e.kind === "interrupted");
    const resumedExplore = after.eventLog.some(
      (e, i) => i > interruptIdx && e.kind === "step-started" && e.step === "explore",
    );
    assert(
      interruptedAt.pipelineState.status === "interrupted",
      "precondition: the state is interrupted before re-entry",
    );
    assert(
      !notices.some((n) => n.includes("already terminated")),
      "re-entry does not refuse an interrupted cycle as already terminated",
    );
    assert(resumedExplore, "re-entry resumes the cycle at its first step (explore is started again)");
    assert(after.pipelineState.status !== "interrupted", "the resumed cycle leaves `interrupted`");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 5. Rendering: /work-status, the cycle index and the queue entry name it.
{
  const repo = tmpRepo();
  try {
    const base = initialState(55);
    const state = await markInterrupted(repo, base, "SIGTERM", 1);
    const status = renderStatus(state, repo);
    assert(
      status.includes("INTERRUPTED") && status.includes("reason: SIGTERM"),
      "renderStatus names the interrupted status and its reason",
    );
    const index = renderCycleIndex([{ issue: 55, state }], Date.now());
    assert(
      index.includes("interrupted at explore (SIGTERM)") && index.includes("/work 55 resumes it"),
      "the cycle index lists the interrupted cycle with its reason and resume action",
    );
    await writeState(repo, state);
    const entry = await singleCycleQueueEntry(repo, 55);
    assert(
      entry?.outcome === "parked" &&
        entry.reason === "cycle interrupted: SIGTERM" &&
        entry.humanAction === "resume with /work 55",
      "the queue summary entry for an interrupted cycle names the reason and the resume action",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

process.exit(exit);
