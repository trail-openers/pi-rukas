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
import { outcomeEvents } from "../src/work-driver-adversarial-fanout-events.ts";
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

    const after = await runAdversarial(ctx, (await readState(dir, 1863))!, Date.now());
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

// ── #1863 round 3 — `outcomeEvents` reports a malformed marker, it does not
// abort the cycle.
//
// THE BUG. The two invariant checks this function used to carry were `throw`s,
// and they sit in the MIDDLE of `fanOutAdversarial`'s batch assembly — after
// every pass has already cleared its marker and while the step is still
// assembling the events that decide where the cycle goes. So a bookkeeping
// defect (an outcome that claims a marker without its `at`/`label`, or two
// dispatch events on one marker) escalated from "one malformed audit record"
// to "the whole /work cycle dies", which is the failure mode this step exists
// to remove. The rule now: never fabricate, never abort, always warn.
//
// This is the unit layer, and it is driven directly because the shape is not
// reachable through the fan-out any more (the leaf reads its marker fields
// after `beginDispatch` returned them). A regression that reinstates a `throw`
// here fails on the `throws === false` assertion, and one that silently drops
// the second dispatch event fails on the `dispatch-failed` count.
{
  const mkOutcome = (over: Record<string, unknown>) => ({
    id: "task-a",
    ok: true,
    rounds: 1,
    records: [],
    infra: false,
    threw: false,
    skipped: false,
    priorInfra: false,
    ...over,
  });
  const at = Date.now();
  const completion = {
    kind: "dispatch-completed" as const,
    step: "adversarial" as const,
    role: "adversarial-loop",
    jobId: "job-1",
    label: "adversarial[task-a]",
    ok: true,
    ms: 5,
    at,
  };
  const failure = {
    kind: "dispatch-failed" as const,
    step: "adversarial" as const,
    role: "adversarial-loop",
    jobId: "job-1",
    label: "adversarial[task-a]",
    ms: 5,
    at,
    errorTail: "boom",
  };

  const cases: Array<[string, ReturnType<typeof mkOutcome>, (e: WorkEvent[]) => boolean, string]> = [
    [
      "a marker claimed without its at/label",
      mkOutcome({ clearedJobId: "job-1" }),
      (e) => e.every((x) => x.kind !== "dispatch-started"),
      "emits NO re-emitted marker (the persisted record is not reproduced from a guess)",
    ],
    [
      "a marker claimed without its label alone",
      mkOutcome({ clearedJobId: "job-1", markerAt: at }),
      (e) => e.every((x) => x.kind !== "dispatch-started"),
      "emits NO re-emitted marker when only the label is missing",
    ],
    [
      "two dispatch outcome events on one marker",
      mkOutcome({ clearedJobId: "job-1", markerAt: at, dispatchLabel: "adversarial[task-a]", completionEvent: completion, failureEvent: failure }),
      (e) => e.filter((x) => x.kind === "dispatch-completed").length === 1 &&
        e.filter((x) => x.kind === "dispatch-failed").length === 1,
      "keeps BOTH dispatch events rather than deleting the only record that a dispatch happened",
    ],
  ];

  for (const [name, outcome, shape, what] of cases) {
    let throws = false;
    let events: WorkEvent[] = [];
    try {
      events = outcomeEvents([outcome as never], true);
    } catch {
      throws = true;
    }
    assert(!throws, `outcomeEvents does not throw for ${name}`);
    assert(
      !throws && shape(events),
      `outcomeEvents with ${name}: ${what} (got ${JSON.stringify(events.map((e) => e.kind))})`,
    );
  }

  // A well-formed marker is still re-emitted, so the tolerance above is not a
  // blanket suppression of the marker.
  const clean = outcomeEvents(
    [mkOutcome({ clearedJobId: "job-1", markerAt: at, dispatchLabel: "adversarial[task-a]", completionEvent: completion }) as never],
    true,
  );
  assert(
    clean.filter((e) => e.kind === "dispatch-started").length === 1,
    "a well-formed outcome still re-emits its marker (the tolerance is not a blanket suppression)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
