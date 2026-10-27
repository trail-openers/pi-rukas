#!/usr/bin/env bun
/**
 * #1863 round 2 — the write-ahead marker the fan-out RE-EMITS is the record it
 * PERSISTED, field for field.
 *
 * THE BUG. `outcomeEvents` rebuilds each pass's `dispatch-started` so the marker
 * survives the splice that replaces the region it grew into. An earlier draft
 * fabricated that record — `at: 7`, `label: o.id` — instead of carrying the
 * persisted values on the outcome. Every other property of the marker was right
 * (its id, its kind, its position relative to the dispatch events), so nothing
 * in the write-ahead test noticed. What broke was a READER: `projectIssue`
 * derives the headless result document's `durationMs` from the FIRST and LAST
 * event `at`s, and one epoch stamp in the log made a cycle that ran minutes
 * report a 56-year duration. Measured on the real document.
 *
 * WHY THIS LAYER, and why the comparison is against DISK. The instrument below
 * reads the state file on every reviewer call and keeps the markers it saw, so
 * the expected values are the ones the fan-out actually wrote — not a second
 * in-memory copy of the same construction. An assertion that compared the batch
 * against the batch would pass after the regression, which is the failure mode
 * this file exists to close.
 *
 * The window test (`saneAt`) is deliberately separate from the equality test: a
 * fabricated value can be a plausible timestamp (a `Date.now()` at re-emit time
 * differs from the persisted one but is still "sane"), and a real timestamp can
 * be wrong for the wrong reason. Each catches what the other cannot.
 *
 * Offline: no spawn, no sleep.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectIssue } from "../src/headless/result.ts";
import type { DispatchResult } from "../src/types.ts";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import type { DriverHost } from "../src/work-driver-host.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import { initCleanRepo } from "./lib/clean-repo-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkResult(): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: true,
    text: "Adversarial APPROVED after round 1.\n",
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    loopOutcome: "approved",
    adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
  };
}

/** A host that swallows messages; a DriverHost is structural (#1020). */
function makeFakePi(): DriverHost {
  return {
    sendUserMessage: () => undefined,
    emit: () => undefined,
  } as unknown as DriverHost;
}

/** The step handlers take a `CycleContext`, which requires a sink (#1162). */
const SILENT_SINK: NonNullable<CycleContext["emitSink"]> = {
  emit: () => undefined,
  fingerprints: [],
};

/** The `dispatch-started` records of one step, narrowed so `.jobId`/`.at` typecheck. */
function markersOf(
  eventLog: readonly WorkEvent[],
  step: "adversarial",
): Array<Extract<WorkEvent, { kind: "dispatch-started" }>> {
  return eventLog.filter(
    (e): e is Extract<WorkEvent, { kind: "dispatch-started" }> =>
      e.kind === "dispatch-started" && e.step === step,
  );
}

/**
 * The wall-clock sanity window for a persisted event `at`. 2001 is decades before
 * this project exists and 2100 is well past any cycle's run bound, so anything
 * outside it is a fabricated timestamp rather than a slow machine.
 */
const SANE_AT_FLOOR = Date.UTC(2001, 0, 1);
const SANE_AT_CEIL = Date.UTC(2100, 0, 1);

function saneAt(at: number): boolean {
  return at >= SANE_AT_FLOOR && at <= SANE_AT_CEIL;
}

// The reviewer dispatches nothing real, and the fixture trees carry no diffs:
// both knobs exist so the pass reaches the reviewer rather than short-circuiting
// (the same pair the sibling write-ahead test sets).
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

async function markerIdentity(name: string): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-1863-identity-"));
  try {
    const s = initialState(1863, 1_000_000);
    const tree: Record<string, string> = {
      "task-a": `${dir}/.worktrees/task-a`,
      "task-b": `${dir}/.worktrees/task-b`,
    };
    const streams: Record<
      string,
      { id: string; scope: string; paths: string[]; outOfScope: string[] }
    > = {};
    for (const w of Object.keys(tree)) {
      streams[w] = { id: w, scope: w, paths: [], outOfScope: [] };
      initCleanRepo(tree[w] as string);
    }
    s.pipelineState = {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: tree,
      workstreams: streams,
      branchName: "feature/issue-1863",
    };
    await writeState(dir, s);

    // THE EVIDENCE: the markers as they sat ON DISK while the reviews ran. Read
    // on every loop call and de-duplicated by id, so whatever the fan-out
    // persisted is what the assertions below compare against.
    const persisted = new Map<string, Extract<WorkEvent, { kind: "dispatch-started" }>>();
    const ctx: CycleContext = {
      host: makeFakePi(),
      emitSink: SILENT_SINK,
      repoRoot: dir,
      issue: 1863,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async () => {
        const onDisk = await readState(dir, 1863);
        for (const m of markersOf(onDisk?.eventLog ?? [], "adversarial")) {
          if (!persisted.has(m.jobId)) persisted.set(m.jobId, m);
        }
        return mkResult();
      },
      dispatchFn: async () => {
        throw new Error("no dispatch in this instrument");
      },
    };

    const after = await runAdversarial(ctx, (await readState(dir, 1863)) as never, Date.now());
    const reEmitted = markersOf(after.eventLog, "adversarial");
    const expected = [...persisted.values()];

    assert(
      expected.length >= 2,
      `${name}: the reviewer ran for both workstreams and markers were read from disk (got ${expected.length})`,
    );
    assert(
      reEmitted.length === expected.length,
      `${name}: the splice re-emitted exactly the markers that were persisted (${reEmitted.length} vs ${expected.length})`,
    );
    assert(
      reEmitted.every((m) => {
        const p = persisted.get(m.jobId);
        return p !== undefined && p.at === m.at && p.label === m.label;
      }),
      `${name}: every re-emitted marker carries the PERSISTED at and label (${JSON.stringify(
        reEmitted.map((m) => [
          m.label,
          saneAt(m.at) ? "sane" : m.at,
          persisted.get(m.jobId)?.at === m.at ? "at=ok" : "at=DIFFERS",
          persisted.get(m.jobId)?.label === m.label ? "label=ok" : "label=DIFFERS",
        ]),
      )})`,
    );
    assert(
      reEmitted.every((m) => saneAt(m.at)),
      `${name}: no marker carries a fabricated epoch timestamp (${JSON.stringify(
        reEmitted.map((m) => m.at),
      )})`,
    );
    // The `label` regression has its own assertion because the two bugs shipped
    // together and the equality check alone would not name which field drifted.
    assert(
      reEmitted.every((m) => m.label.startsWith("adversarial")),
      `${name}: the label names the adversarial step, not the bare workstream id (${JSON.stringify(
        reEmitted.map((m) => m.label),
      )})`,
    );
    // The consumer that made this observable: the JSON document the host reads.
    // `durationMs` is LAST.at − FIRST.at, so one fabricated stamp anywhere in the
    // log poisons the one duration number the headless contract publishes.
    const projected = projectIssue(after, path.join(dir, ".pi/work-state/1863.json"));
    const firstAt = after.eventLog[0]?.at;
    const lastAt = after.eventLog[after.eventLog.length - 1]?.at;
    assert(
      firstAt !== undefined &&
        lastAt !== undefined &&
        saneAt(firstAt) &&
        saneAt(lastAt) &&
        projected.durationMs < 3_600_000,
      `${name}: the headless projection's durationMs is a plausible wall-clock span, not a fabricated epoch (durationMs ${projected.durationMs})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await markerIdentity("N>1 fan-out, approved passes");
await markerIdentity("N>1 fan-out, second invocation");

console.log(`\nexit ${exit}`);
process.exit(exit);
