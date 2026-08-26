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

import fs from "node:fs/promises";
import path from "node:path";
import { WORK_STATE_SCHEMA_VERSION, type WorkState } from "./workflow-state-schema.ts";
import { appendEvent, detectInconsistencies, initialState } from "./workflow-state-update.ts";

export type {
  WorkStep,
  WorkEvent,
  WorkEventKind,
  CommitPrFallbackCause,
} from "./workflow-state-events.ts";
export { WORK_STATE_SCHEMA_VERSION } from "./workflow-state-schema.ts";
export type {
  ConsolidationVerdict,
  IncompleteConsolidation,
} from "./workflow-state-consolidation.ts";
export type { CommitPrRootState } from "./workflow-state-schema.ts";
export type { CapEvidence, CapedPartialState } from "./workflow-state-schema.ts";
export type { PipelineState, WorkState } from "./workflow-state-schema.ts";
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
 * Atomic state write: write to <file>.tmp then rename. Avoids leaving a
 * half-written file if the process dies mid-write. Updates `updatedAt`.
 */
export async function writeState(repoRoot: string, state: WorkState): Promise<void> {
  const file = workStateFile(repoRoot, state.issue);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const next: WorkState = { ...state, updatedAt: Date.now() };
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
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
