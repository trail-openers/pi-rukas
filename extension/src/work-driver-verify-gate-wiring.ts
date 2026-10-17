/**
 * work-driver-verify-gate-wiring — the two PRODUCTION call sites #1415 shipped
 * without (#1415 fix round).
 *
 * The gate-reuse records and the `verify-started`/`verify-completed` pair were
 * both fully built, tested against a fake caller, and imported by nobody:
 * `onGateRecorded` was never invoked, so `pipelineState.gateReuse` was never
 * written and reuse could never fire through `verifyStepOutcome`; and no
 * `emitVerify*` call existed, so the console line that is the ticket's headline
 * visibility fix was never printed. A seam with no caller is a feature that
 * does not exist — this module is the caller.
 *
 * Two rules the callers must not weaken:
 *
 *   - **Writes go through `appendEvent`, never a bare mutation of the caller's
 *     `state`.** `persistState` (`work-driver-state.ts`) re-reads the file and
 *     merges ONLY `pipelineState` + `eventLog` under a compare-and-write lock,
 *     so a mutation of a stale in-memory object silently loses the record — and
 *     a lost reuse record is invisible except as a slow cycle. `appendEvent`
 *     persists `eventLog` atomically under the same lock, and the state file's
 *     event log is where both renderers (`/work-status`, the NDJSON host
 *     stream) actually read these two kinds from.
 *   - **The events are a LOG, not a control input.** The skip decision reads the
 *     records the pass handed back, never the log it just wrote: that log lands
 *     in the file asynchronously and its `at` is a fresh `Date.now()`, so a
 *     decision that consulted it would either re-read a file mid-write or invent
 *     a timestamp. Reuse is fail-open to RUNNING: any absent, unreadable, or
 *     expired record runs the gate.
 *
 * The lifecycle payload is DERIVED from the factory's own event pair rather
 * than re-derived field-by-field: `makeVerifyRunEvents` is what guarantees a
 * `started` and its `completed` agree on step/command/target/tier, and a second
 * derivation here would be a second source of truth able to drift from it.
 */
import { emitVerifyCompleted, emitVerifyStarted } from "./lifecycle-events.ts";
import { isVerifyTimeoutFailure } from "./work-driver-verify-develop-helpers.ts";
import {
  type GatePass,
  combinedWorktreeTree,
  gatePassKey,
  gatePassRecord,
} from "./work-driver-verify-gate-reuse.ts";
import type { VerifyTarget, VerifyTier } from "./workflow-state-events-verify.ts";
import { makeVerifyRunEvents } from "./workflow-state-events-verify.ts";
import type { WorkstreamGreen } from "./workflow-state-schema-gate-reuse.ts";
import type { WorkState } from "./workflow-state.ts";
import { type WorkEvent, appendEvent } from "./workflow-state.ts";

/** What one gate pass decided, as `runVerifyCommandGate` hands it over. */
export type VerifyGateRecords = {
  pass: GatePass | undefined;
  greens: ReadonlyArray<readonly [string, WorkstreamGreen]>;
  refuted: readonly string[];
};

/** The identity + outcome of the run the pair describes. */
export type VerifyGateRun = {
  step: "develop" | "commit-pr";
  command: string;
  target: VerifyTarget;
  tier?: VerifyTier;
  /** The pass reused a verdict rather than executing the project's command. */
  reused?: boolean;
  /** Wall-clock ms of the run; absent when nothing executed. */
  ms?: number;
  /** The verdict — `ms` alone cannot tell a green gate from a killed one. */
  status?: "success" | "failure" | "skipped" | "timeout";
  issue?: number;
  /** Bounded output tail for the failure paths. */
  evidenceTail?: string;
};

/**
 * The whole-gate records a cycle still holds that describe the trees it is
 * judging NOW — the read side of the wiring, kept beside the write side so the
 * two cannot drift on what "a current record" means.
 *
 * This is the half the develop gate used to lack: `reusableGatePass` was
 * consulted, but because nothing ever WROTE `pipelineState.gateReuse` the
 * record set was permanently empty and every round ran the full gate. The read
 * stays deliberately dumb — it hands the seam what the state file holds and the
 * seam decides, because the decision re-reads every tree from git rather than
 * trusting a record (fail open to RUNNING).
 */
export async function reusableWholeGatePass(
  execFn: Parameters<typeof combinedWorktreeTree>[0],
  state: WorkState,
  opts: { cmd: string; timeoutMs: number; changedWorktrees: readonly string[] },
): Promise<GatePass | undefined> {
  const gateReuse = state.pipelineState.gateReuse;
  if (gateReuse === undefined || Object.keys(gateReuse.passes).length === 0) return undefined;
  const combined = await combinedWorktreeTree(execFn, state.pipelineState.worktrees ?? {});
  if (combined === undefined) return undefined;
  return gateReuse.passes[gatePassKey(combined, opts.cmd, opts.timeoutMs)];
}

/**
 * #1415 fix round — what one develop-gate pass records about itself.
 *
 * Lives beside the write it produces rather than at the gate's call site, so
 * "decide what to memoise" and "persist it" are one seam: the gate used to
 * compute a record and hand it to a callback nobody called. `undefined` = this
 * pass established no verdict AND refuted no green, so it writes nothing.
 *
 * A pass that REUSED records nothing — refreshing a record's `at` every round
 * would keep a stale verdict permanently "fresh", and no new duration was
 * measured to record. A passing pass whose combined tree could not be read also
 * records no verdict: an entry needs a tree, and one guessed from a partial
 * read is the record a later skip would stand on. Its greens still land, each
 * read from its own worktree at the moment its command passed. The tree is read
 * with the same function the reuse check used, so record and decision cannot
 * describe different content.
 */
export async function decideVerifiedPassRecords(args: {
  execFn: Parameters<typeof combinedWorktreeTree>[0];
  worktrees: Record<string, string | undefined>;
  cmd: string;
  timeoutMs: number;
  reusedWholeGate: boolean;
  durationMs?: number;
  greensRecorded: ReadonlyArray<readonly [string, WorkstreamGreen]>;
  greensRefuted: readonly string[];
}): Promise<VerifyGateRecords | undefined> {
  if (args.reusedWholeGate) return { pass: undefined, greens: [], refuted: [] };
  if (args.greensRefuted.length > 0)
    return { pass: undefined, greens: [], refuted: args.greensRefuted };
  const combined = await combinedWorktreeTree(args.execFn, args.worktrees);
  return {
    pass:
      combined === undefined
        ? undefined
        : gatePassRecord(combined, args.cmd, args.timeoutMs, args.durationMs),
    greens: args.greensRecorded,
    refuted: args.greensRefuted,
  };
}

/**
 * #1415 fix round — the verdict the `verify-completed` line reports.
 *
 * Read from the gate's own signals, never from "it did not throw": a run killed
 * at its bound judged nothing and reads `timeout`, not `failure` (#1324). The
 * `timedOut` / failure-string knowledge stays with the caller that owns those
 * signals; this is the closed vocabulary the event and the console line share.
 */
export type VerifyRunStatus = "success" | "failure" | "skipped" | "timeout";

/**
 * The pass's verdict, worst-of the consolidated probe and the per-worktree leg.
 * `timedOut` outranks a plain failure because it says something different about
 * the code: the run was killed at its bound and reached no verdict (#1324).
 */
export function verifyRunStatus(
  cons: { status: string; timedOut?: boolean },
  perWorktreeFailures: readonly string[],
): VerifyRunStatus {
  if (cons.status === "failed") return cons.timedOut === true ? "timeout" : "failure";
  if (perWorktreeFailures.some(isVerifyTimeoutFailure)) return "timeout";
  if (perWorktreeFailures.length > 0) return "failure";
  return "success";
}

/** The console target string for one tree: a worktree path, or `consolidated`. */
function targetText(target: VerifyTarget): string {
  return target.kind === "worktree" ? target.path : "consolidated";
}

/**
 * Print the gate's `verify-started` line BEFORE the command executes.
 *
 * Separate from {@link recordVerifyGatePass} deliberately: a pair that only
 * lands when the command returns says nothing during the ~22 minutes the event
 * exists to fill (`workflow-state-events-verify.ts`). A cycle killed mid-run
 * therefore leaves a started with no completion, which localises the kill to
 * the gate rather than to the step at large.
 */
export function announceVerifyGateRun(run: VerifyGateRun): void {
  emitVerifyStarted({
    step: run.step,
    command: run.command,
    target: targetText(run.target),
    ...(run.tier !== undefined ? { tier: run.tier } : {}),
    ...(run.issue !== undefined ? { issue: run.issue } : {}),
  });
}

/**
 * Persist one gate pass's reuse records, append its event pair to the state
 * file, and print its two console lines.
 *
 * `records.pass === undefined` means this pass established no whole-gate
 * verdict (it reused one, ran no command, failed, or could not read its
 * combined tree) — then it RECORDS nothing, exactly as the gate decided:
 * refreshing a record's `at` every round would keep a stale verdict permanently
 * "fresh". A refuted green is DELETED: a worktree whose command just failed
 * must not license the next round's skip.
 */
export function recordVerifiedGatePass(
  state: WorkState,
  records: VerifyGateRecords,
  run: VerifyGateRun,
): void {
  const gateReuse = state.pipelineState.gateReuse ?? { passes: {}, workstreamGreens: {} };
  if (records.pass !== undefined) {
    // Keyed exactly as `reusableGatePass` looks it up: (tree, command, bound).
    gateReuse.passes[gatePassKey(records.pass.treeHash, records.pass.cmd, records.pass.timeoutMs)] =
      records.pass;
  }
  for (const [id, green] of records.greens) gateReuse.workstreamGreens[id] = green;
  for (const id of records.refuted) delete gateReuse.workstreamGreens[id];
  // A reuse is only ever granted when every workstream's own green still
  // describes the tree it holds (`greenStillHolds` re-reads it from git).
  // Deleting the refuted ones here rather than merging is the whole of the
  // "HEAD moved between rounds forces a fresh run" acceptance criterion.
  state.pipelineState.gateReuse = gateReuse;

  // The verdict an operator reads must come from the gate, never from "it did
  // not throw": a killed run judges nothing (#1324) and a reused pass executed
  // nothing — both are distinct answers and neither is inferable from `ms`.
  const status =
    run.status ?? (run.reused === true ? "success" : run.ms === undefined ? "skipped" : "success");
  // Reconcile the pair before it lands anywhere: a started and its completion
  // must carry one `at`, one identity, and a duration that is present exactly
  // when something executed. `makeVerifyRunEvents` owns the identity; this owns
  // the two facts only the caller can supply — the verdict, and whether a
  // command ran at all. A reused pass or a no-command pass carries NO `ms`
  // (`ms` is the run's wall-clock, and nothing ran), which is what the NDJSON
  // host and `/work-status` read as "no command executed for this verdict".
  const executed = run.ms !== undefined && run.reused !== true;
  const completedMs = executed ? run.ms : undefined;
  const completedStatus = executed
    ? status
    : status === "timeout" || status === "failure"
      ? status
      : "skipped";
  const pair = makeVerifyRunEvents({
    step: run.step,
    command: run.command,
    target: run.target,
    ...(run.tier !== undefined ? { tier: run.tier } : {}),
    status: completedStatus,
    ...(completedMs !== undefined ? { ms: completedMs } : {}),
    ...(run.reused === true ? { reused: true } : {}),
    ...(run.evidenceTail !== undefined ? { evidenceTail: run.evidenceTail } : {}),
  });
  appendEvent(state, pair.started as unknown as WorkEvent);
  appendEvent(state, pair.completed as unknown as WorkEvent);

  // The console pair: the line the operator sees DURING the gate, not after it.
  // Derived from the events just appended, so the two surfaces cannot disagree.
  const target = targetText(run.target);
  const issue = run.issue;
  emitVerifyStarted({
    step: run.step,
    command: run.command,
    target,
    ...(pair.started.tier !== undefined ? { tier: pair.started.tier } : {}),
    ...(issue !== undefined ? { issue } : {}),
  });
  emitVerifyCompleted({
    step: run.step,
    command: run.command,
    target,
    ...(pair.completed.tier !== undefined ? { tier: pair.completed.tier } : {}),
    status: pair.completed.status,
    ms: pair.completed.ms ?? 0,
    ...(pair.completed.reused === true ? { reused: true } : {}),
    ...(issue !== undefined ? { issue } : {}),
  });
}
