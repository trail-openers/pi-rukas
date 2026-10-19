/**
 * work-driver-verify-events — the develop gate's event-log entries: the
 * #1240 consolidated-verify skip and the #1415 verify-run bracket.
 *
 * Lives on the VERIFY side, not in `workflow-state-events-verify-flake.ts`.
 * That module is a pure type fragment — every sibling `workflow-state-events-*`
 * file imports types only, and `workflow-state-events.ts` composes the closed
 * `WorkEvent` union from them. A VALUE import of `appendEvent` from
 * `workflow-state.ts` inside that fragment closes a real require cycle
 * (`workflow-state.ts → workflow-state-events.ts → the fragment →
 * workflow-state.ts`), and a cycle through a module that runs top-level code
 * is exactly the shape that produced the TDZ crash in 9 CI tests on PR #1412.
 * The factory and the event type stay where the union can reach them; the
 * mutation lives here, where importing `workflow-state.ts` is ordinary.
 */
import { trace } from "./trace.ts";
import type { FenceLift } from "./work-develop-scope-fence-seam.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { type DevelopGateRecord, gatePassKey } from "./work-driver-verify-gate-reuse.ts";
import type { SelectedVerifyRecord } from "./work-driver-verify-select-exec.ts";
import type { VerifyAttributionRecord } from "./work-driver-verify-shared.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";
import { makeConsolidatedVerifySkippedEvent } from "./workflow-state-events-verify-flake.ts";
import type { VerifyRunEventFragment, VerifyStartedEvent } from "./workflow-state-events-verify.ts";
import { type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";

/**
 * #1415 — record that the develop gate's verify is starting, and PERSIST it
 * before the command runs: the persist is what puts the event on the host's
 * stream (work-state-emit.ts), so an operator sees the gate start rather than
 * a silent gap the length of the project's suite. The caller's state is not
 * replaced — the gate's caller appends the same event object later (see
 * `recordDevelopGateEvents`), at the same log index, so the emit sink sees a
 * matching prefix and does not emit it twice.
 *
 * A failed persist costs only the live line, never the gate: it is traced and
 * the verify runs. A crash mid-gate leaves `currentStep` at develop either
 * way, so re-entry re-runs the step exactly as it would without this write.
 */
export async function beginVerifyRun(
  ctx: CycleContext,
  state: WorkState,
): Promise<VerifyStartedEvent | undefined> {
  const command = await verifyCmdFor(ctx.repoRoot);
  if (command === undefined) return undefined;
  const started: VerifyStartedEvent = {
    kind: "verify-started",
    at: Date.now(),
    step: "develop",
    command,
    target: { kind: "consolidated" },
  };
  try {
    await persistCycle(ctx, appendEvent(state, started));
  } catch (err) {
    trace(`work-driver: verify-started not persisted — ${(err as Error).message?.slice(0, 160)}`);
  }
  return started;
}

/** #1415 — the bracket for one gate run: its start and how it ended. */
export function finishVerifyRun(
  started: VerifyStartedEvent | undefined,
  ok: boolean,
): VerifyRunEventFragment[] {
  if (started === undefined) return [];
  const at = Date.now();
  return [
    started,
    {
      kind: "verify-completed",
      at,
      step: "develop",
      command: started.command,
      target: started.target,
      status: ok ? "success" : "failure",
      ok,
      ms: at - started.at,
    },
  ];
}

/**
 * Record the develop gate's events on the state: the single place that turns
 * a gate result into log entries, so EVERY path that re-runs the develop gate
 * records them. The gate runs at four seams (the topological develop pass, the
 * #1005 fence merge-and-retry, the #1323 sibling-symbol merge, and the #741
 * converge corrective re-run) and each one owns its own append; a skip
 * recorded only at the first would make the gate look like it ran on the three
 * re-run paths, which is the opposite of what #1240's "never silent" promise
 * means. `workstreamCount` is read from the state here for the same reason —
 * one rule for the count cannot drift per caller.
 *
 * Callers append this FIRST after the gate: `verify-started` was already
 * persisted at the next index, and appending anything before it would read to
 * the emit sink as a rewritten log.
 */
export function recordDevelopGateEvents(
  state: WorkState,
  gate: {
    consolidatedVerifySkipped?: AlreadyVerifiedTree;
    verifyEvents?: VerifyRunEventFragment[];
    gateRecord?: DevelopGateRecord;
    selectedVerify?: SelectedVerifyRecord;
    fenceLifts?: FenceLift[];
  },
): WorkState {
  const [started, completed] = gate.verifyEvents ?? [];
  const events = [
    ...(started ? [started] : []),
    // #1405 — one event per admitted issue-fenced path, so a lifted fence is
    // explainable from the state file (no `step`, like fence-recovery-started).
    ...(gate.fenceLifts ?? []).map((l) => ({
      kind: "fence-lifted" as const,
      at: Date.now(),
      source: "precheck" as const,
      ...l,
    })),
    ...(gate.consolidatedVerifySkipped !== undefined
      ? [
          makeConsolidatedVerifySkippedEvent(
            "develop",
            gate.consolidatedVerifySkipped,
            // The degenerate N=1 shape carries no `worktrees` map (the one
            // workstream's worktree IS repoRoot), so count that as one.
            Object.keys(state.pipelineState.worktrees ?? {}).length || 1,
          ),
        ]
      : []),
    ...(completed ? [completed] : []),
  ];
  const recorded = foldVerifyAttribution(
    withGateRecord(state, gate.gateRecord),
    gate.selectedVerify,
  );
  return events.length === 0 ? recorded : appendEvent(recorded, ...events);
}

/**
 * #1415 — fold one gate pass's reuse records into `pipelineState.gateReuse`:
 * the verdict it established (keyed by its triple), the greens it established,
 * and the removal of every green it refuted. Without this the gate computed its
 * records and nothing kept them, so no develop pass could ever reuse one.
 */
function withGateRecord(state: WorkState, record: DevelopGateRecord | undefined): WorkState {
  if (record === undefined) return state;
  const prev = state.pipelineState.gateReuse ?? { passes: {}, workstreamGreens: {} };
  const passes = { ...prev.passes };
  if (record.pass !== undefined) {
    const p = record.pass;
    passes[gatePassKey(p.treeHash, p.cmd, p.timeoutMs)] = p;
  }
  const workstreamGreens = { ...prev.workstreamGreens, ...Object.fromEntries(record.greens) };
  for (const id of record.refuted) delete workstreamGreens[id];
  return {
    ...state,
    pipelineState: { ...state.pipelineState, gateReuse: { passes, workstreamGreens } },
  };
}

/**
 * #1647 — fold one selected run's flaky and baseline-red tests into
 * `pipelineState.verifyAttribution`, keeping each name once across rounds. The
 * commit-pr PR body and the handoff both render what this records.
 */
export function foldVerifyAttribution(
  state: WorkState,
  record: SelectedVerifyRecord | undefined,
): WorkState {
  if (record === undefined) return state;
  if (record.flaky.length === 0 && record.baselineRed.length === 0) return state;
  const prev = state.pipelineState.verifyAttribution ?? { flaky: [], baselineRed: [] };
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      verifyAttribution: {
        ...prev,
        flaky: [...new Set([...prev.flaky, ...record.flaky])],
        baselineRed: [...new Set([...prev.baselineRed, ...record.baselineRed])],
      },
    },
  };
}
