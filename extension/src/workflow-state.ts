/**
 * /work workflow state — schema v1.
 *
 * The state file is the durable contract that lets the work-driver:
 *   1. resume a /work cycle that crashed mid-flight (e.g., overnight session
 *      went sideways, Pi got killed, machine rebooted),
 *   2. preserve enough structural facts for the user to intervene
 *      surgically when subagent providers degrade ("switch developer to
 *      cerebras, retry step develop"),
 *   3. tell the driver what the current step is + what to do next, without
 *      asking the LLM.
 *
 * Lives at `<project>/.pi/work-state/<issue>.json`. Matches the existing
 * `.pi/permissions.json`, `.pi/decisions.json` convention (gitignored, project-
 * scoped, survives `git worktree remove`). One file per /work cycle.
 *
 * ## Schema shape
 *
 * **Discriminated union**: `pipelineState` (the reconstructed-on-read
 * snapshot of "where are we right now") + `eventLog` (append-only log of
 * typed events). Why both:
 *
 * - `pipelineState` is fast O(1) "what step are we on, what's blocking" —
 *   driver reads it on resume without replaying the whole log.
 * - `eventLog` is the source of truth for *what happened* — every dispatch,
 *   every cap-hit, every adversarial verdict. New event types are additive;
 *   new fields don't break old readers.
 *
 * On every transition the driver appends to `eventLog` THEN mutates
 * `pipelineState`. Both writes go through `writeState()` which atomically
 * replaces the JSON file. If `pipelineState` drifts from what the event log
 * implies (rare — bug or external edit), the driver should detect it and
 * either repair or surface a loud error; the eventLog is authoritative.
 *
 * ## Versioning
 *
 * `schemaVersion: 1` is MANDATORY from day 1. The reader rejects mismatched
 * versions LOUDLY rather than auto-migrating — see `assertSchemaVersion()`.
 * The recovery affordance is documented in `docs/troubleshooting.md`:
 *   - inspect the file
 *   - either resolve manually or `rm .pi/work-state/<issue>.json` to start
 *     fresh under the new schema (the user keeps their git work; only the
 *     workflow-tracker state goes).
 *
 * ## Resumability
 *
 * v1 is **observational-only**: `resumable: false` is set on every state
 * file. Resumable execution would require async-jobs to survive process
 * restart (it doesn't — jobs live in-memory). The state file lets the user
 * intervene; it does not (yet) replay completed dispatches automatically.
 * Cap-state is the explicit exception — see `pipelineState.reviewRound`
 * + `reviewCapStartedAt` — those WILL survive restart so the cap timer
 * remains coherent.
 *
 * ## GitHub-is-the-bus
 *
 * No cross-command state lookup. The GitHub issue body is the contract
 * between /plan and /work. The schema reserves an optional `upstreamRefs`
 * array for future use but the driver does not implement lookup against
 * it. Keep state intra-command.
 *
 * ## Module layout
 *
 * Split for module-size hygiene (AGENTS.md §12): event-log types live in
 * `workflow-state-events.ts`, the pipeline/state-file schema + pure
 * in-memory helpers live in `workflow-state-schema.ts`. This module is the
 * stable public entry point — it re-exports both plus the filesystem
 * persistence layer (read/write/append). Consumers should keep importing
 * from `./workflow-state.ts`.
 */

import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { type EmitSink, emitPersisted } from "./work-state-emit.ts";
import type { InterruptReason, WorkStep } from "./workflow-state-events.ts";
import { WORK_STATE_SCHEMA_VERSION, type WorkState } from "./workflow-state-schema.ts";
import { appendEvent, detectInconsistencies, initialState } from "./workflow-state-update.ts";

export type {
  WorkStep,
  WorkEvent,
  WorkEventKind,
  CommitPrFallbackCause,
  DispatchSlowEvent,
} from "./workflow-state-events.ts";
export { WORK_STATE_SCHEMA_VERSION } from "./workflow-state-schema.ts";
export type {
  ConsolidationVerdict,
  IncompleteConsolidation,
} from "./workflow-state-consolidation.ts";
export type { CommitPrRootState } from "./workflow-state-schema.ts";
export type { CapEvidence, CapedPartialState } from "./workflow-state-schema.ts";
export type { PipelineState, WorkState } from "./workflow-state-schema.ts";
export type { InterruptReason } from "./workflow-state-events.ts";
export {
  filesPresentFromConsolidation,
  missingWorkstreamsFromConsolidation,
  WORK_STEPS,
} from "./workflow-state-schema.ts";
export { appendEvent, detectInconsistencies, initialState } from "./workflow-state-update.ts";
/**
 * Resolve the project-local state directory. We anchor on `cwd` rather than
 * the worktree path because state must live at the project root so
 * `git worktree remove` doesn't take it down. Matches the existing
 * `.pi/permissions.json` convention.
 *
 * `repoRoot` should be the absolute path to the git repo's worktree root
 * (NOT a sub-worktree). Callers can resolve via `git rev-parse --show-toplevel`
 * outside any worktree, or via the parent path if running inside a worktree.
 */
export function workStateDir(repoRoot: string): string {
  return path.join(repoRoot, ".pi", "work-state");
}

/** Resolve the state file path for an issue. */
export function workStateFile(repoRoot: string, issue: number): string {
  return path.join(workStateDir(repoRoot), `${issue}.json`);
}

/** Resolve the claim-check artifact path for a dispatch. */
export function dispatchArtifactPath(repoRoot: string, issue: number, dispatchId: string): string {
  return path.join(workStateDir(repoRoot), String(issue), `${dispatchId}.txt`);
}

/**
 * Read state from disk. Returns undefined when the file doesn't exist
 * (fresh /work cycle). Throws on schema mismatch — callers should surface
 * the loud error rather than auto-migrating.
 */
export async function readState(repoRoot: string, issue: number): Promise<WorkState | undefined> {
  const file = workStateFile(repoRoot, issue);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `work-state: ${file} is not valid JSON — ${(err as Error).message}. Inspect the file or rm to start fresh under the current schema (your git work is unaffected).`,
    );
  }
  return assertSchemaVersion(parsed as Record<string, unknown>, file);
}

/**
 * Reject mismatched schema versions LOUDLY. Future v2 can add a migration
 * path before the throw; for v1 this is the only path.
 */
function assertSchemaVersion(raw: Record<string, unknown>, file: string): WorkState {
  const v = raw.schemaVersion;
  if (v !== WORK_STATE_SCHEMA_VERSION) {
    throw new Error(
      `work-state: ${file} has schemaVersion=${String(v)} but this build expects ${WORK_STATE_SCHEMA_VERSION}. This /work cycle was started under a different driver version. Inspect the file or rm to start fresh (your git work is unaffected; only the workflow-state file is removed).`,
    );
  }
  return raw as unknown as WorkState;
}

/**
 * Per-state-file write chain (S4a, #1162). Every write to one file (driver
 * persists, the branch-completed persister, the step router, the interrupt) is
 * queued behind the previous one in call order, so an older snapshot can never
 * land after a newer one and the emit watermark sees persists in call order.
 */
const writeChains = new Map<string, Promise<void>>();

function enqueue<T>(file: string, task: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const run = prev.then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(file, settled);
  void settled.then(() => {
    if (writeChains.get(file) === settled) writeChains.delete(file);
  });
  return run;
}

/**
 * Atomic write of one snapshot: unique tmp name, then rename. A failed write
 * removes its tmp file and rethrows. Updates `updatedAt`. Must run inside the
 * file's `enqueue` slot.
 *
 * `sink` (S4a, #1162) receives the eventLog entries this write makes durable.
 * Emit failures never reject this promise (see work-state-emit.ts).
 */
async function writeSnapshot(file: string, state: WorkState, sink?: EmitSink): Promise<WorkState> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const next = { ...state, updatedAt: Date.now() };
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  if (sink) emitPersisted(sink, next);
  return next;
}

/**
 * Persist a state snapshot. Writes to one file run serially in call order (see
 * `enqueue`).
 */
export function writeState(repoRoot: string, state: WorkState, sink?: EmitSink): Promise<void> {
  const file = workStateFile(repoRoot, state.issue);
  return enqueue(file, async () => {
    await writeSnapshot(file, state, sink);
  });
}

/**
 * The driver's single persist call (S4a, #1162). Every driver-path write goes
 * through here so the emit sink is never forgotten at a call site.
 */
export function persistCycle(
  ctx: { repoRoot: string; emitSink: EmitSink; signal?: AbortSignal },
  state: WorkState,
): Promise<void> {
  // Headless S4 (#1024): once the cycle's signal has fired, a snapshot that
  // still reads `running` is written as `interrupted`, with its interrupt event.
  // The driver's in-memory copy can predate an interrupt the runner already
  // recorded on disk; this stops that stale copy writing `running` back.
  // Terminal statuses are never touched.
  const signal = ctx.signal;
  const snapshot =
    signal?.aborted === true ? applyInterrupt(state, interruptReasonOf(signal), Date.now()) : state;
  return writeState(ctx.repoRoot, snapshot, ctx.emitSink);
}

/** The interrupt reason an aborted cycle signal carries (`timeout`, else `signal`). */
export function interruptReasonOf(signal: AbortSignal): InterruptReason {
  return signal.reason === "timeout" ? "timeout" : "signal";
}

/**
 * Headless S4 (#1024) — the one pure interrupt transition. A no-op unless the
 * cycle is `running`. Otherwise it sets `interrupted` and appends exactly one
 * `interrupted` event carrying `reason`. The event is not appended again when
 * the log already ends with that same interrupt (a re-entered cycle that is
 * interrupted again before doing anything else). Every interrupt path goes
 * through here: the driver checkpoint, persistCycle and markInterrupted.
 */
export function applyInterrupt(
  state: WorkState,
  reason: InterruptReason,
  at: number,
  step?: WorkStep,
): WorkState {
  if (state.pipelineState.status !== "running") return state;
  const interrupted = {
    ...state,
    pipelineState: { ...state.pipelineState, status: "interrupted" as const },
  };
  // The driver's own provider park (#1243) is the one interrupt that is a
  // genuine boundary rather than a mid-flight halt, and the reason is the
  // discriminator — NOT the presence of `step`. A SIGTERM fired mid-step also
  // names its step (#1371: that step's own failure classification must not be
  // reported as the cycle's cap), so a step-based test would silently turn a
  // signal into a resumable park and clear its in-flight ids.
  // `parkProviderInterrupt` is the only caller that passes reason `provider`.
  const resumable = reason === "provider";
  if (resumable) {
    // The log still ends on the caller's own `cap-hit` (this appends nothing),
    // and the pipelineState keeps the halted step that re-entry resumes at —
    // both are the shape `nextStep()` / the resume classifier already route on.
    // `inFlightJobIds` is cleared for the same reason `clearForResume` clears it
    // after a crash: the dispatch that died is gone, and an id with no
    // `dispatch-started` is corrupt state that `detectInconsistencies` would
    // halt re-entry on — which is precisely what this park must not do.
    return {
      ...interrupted,
      pipelineState: { ...interrupted.pipelineState, inFlightJobIds: [] },
    };
  }
  const last = state.eventLog[state.eventLog.length - 1];
  if (last?.kind === "interrupted" && last.reason === reason) return interrupted;
  return appendEvent(interrupted, { kind: "interrupted", at, reason, ...(step ? { step } : {}) });
}

/**
 * #1243 — park a cycle whose step died of the model ENDPOINT, once its handoff
 * was delivered.
 *
 * A `handoff` status is TERMINAL: `runWorkDriverInner` refuses to re-enter it
 * without `--restart`, which wipes the state file and rebuilds steps that are
 * all still there to resume from. That is the wrong shape for a park the
 * endpoint caused — nothing in the cycle's code was judged, there is no defect
 * for a person to inspect, and the whole point of the `provider-unavailable`
 * cap is that the caller re-queues it when the endpoint answers again. So the
 * park reuses the one status the driver already re-enters without a fight:
 * `interrupted`, with reason `provider` and the halted step named.
 *
 * Every property that made `handoff` the right status is kept: the event log
 * ends on the same `cap-hit` it did before (this appends nothing when the log
 * already ends on an interrupted event, and the caller persists AFTER the
 * handoff wrote its record), the handoff comment and label are already out, and
 * the host's exit code is unchanged (see `headless/exit-code.ts`, which maps
 * `interrupted` + this reason to `EXIT.handoff`). What changes is only that
 * `/work N` re-enters at the halted step instead of refusing.
 */
export function parkProviderInterrupt(state: WorkState, step: WorkStep, at: number): WorkState {
  return applyInterrupt(state, "provider", at, step);
}

/**
 * S4a (#1162) — record an interrupt (SIGTERM / SIGINT) on disk. This is the
 * fallback for a driver that can no longer persist its own interrupt (the
 * process is exiting): the live driver normally checks its AbortSignal at a
 * step boundary and persists `interrupted` itself (work-driver.ts).
 *
 * Re-reads the state inside the file's write slot (the caller's snapshot may be
 * stale). Applies only while the cycle is `running`: a terminal status
 * (`merged`, `handoff`, `aborted`) is never rewritten, and an already
 * `interrupted` cycle gets no second event. Returns the state as it stands
 * when nothing was written; undefined when no state file exists.
 *
 * Re-entry resumes the cycle (see reenterInterrupted in work-driver-resume.ts).
 */
export function markInterrupted(
  repoRoot: string,
  issue: number,
  reason: InterruptReason,
  sink?: EmitSink,
  at: number = Date.now(),
): Promise<WorkState | undefined> {
  const file = workStateFile(repoRoot, issue);
  return enqueue(file, async () => {
    const state = await readState(repoRoot, issue);
    if (!state) return undefined;
    const next = applyInterrupt(state, reason, at);
    if (next === state) return state;
    return writeSnapshot(file, next, sink);
  });
}

/**
 * `writeState`, synchronously — for the one caller that cannot rely on the
 * event loop outliving its `await`: the session-shutdown record
 * (work-driver-shutdown.ts) is written from a process that is exiting.
 *
 * Caveats: this bypasses the per-file write chain (`enqueue`) and the emit
 * sink (`emitPersisted`), so the record is not emitted to the host. It can
 * also race an in-flight async `writeState` on the same file: a snapshot
 * queued before shutdown can land after this write and overwrite it. Callers
 * must only use it where no async write to that file is pending.
 */
export function writeStateSync(repoRoot: string, state: WorkState): void {
  const file = workStateFile(repoRoot, state.issue);
  const tmp = `${file}.${process.pid}.${randomUUID()}.sync.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    // Best-effort: the original error is rethrown below, which is the one that matters.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the tmp file is left behind; the caller already has the real error */
    }
    throw err;
  }
}

/**
 * Persist a claim-check artifact (large subagent output) and return the
 * path. Used by the driver when a dispatch result's `text` exceeds a
 * threshold — keeping the state file small lets the driver stay fast on
 * reads.
 */
export async function writeDispatchArtifact(
  repoRoot: string,
  issue: number,
  dispatchId: string,
  body: string,
): Promise<string> {
  const file = dispatchArtifactPath(repoRoot, issue, dispatchId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
  return file;
}
