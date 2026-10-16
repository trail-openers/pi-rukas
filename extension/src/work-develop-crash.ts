import type { DispatchResult } from "./types.ts";
/**
 * work-develop-crash — #1403: the ONE seam that records a develop child
 * whose engine died.
 *
 * Three things were missing in the incident, and all three are the same
 * missing fact: nobody wrote down that the child was dead.
 *
 *  1. `work-develop-run.ts` pushed a `dispatch-failed` event for a dead
 *     child but returned `{id, ok: false}` with NO `reason`. When the dead
 *     child was the ONLY workstream (N=1 — every real state file on the host
 *     that hit this), the fan-out's verdict list came out EMPTY, the step had
 *     nothing to route on, and it was reported as an ordinary
 *     `step-completed … develop, round 3, recovered: false`.
 *  2. Because the step "succeeded", the safety net's ok-verdict filter
 *     (`verdicts.filter(v => v.ok)`) excluded the dead workstream — which is
 *     why rounds 1 and 2 log `safety net skipped default — tree clean` and
 *     round 3 logs nothing at all.
 *  3. The crash survived only as free text in the factory's `capReason`,
 *     beside a cap (`adversarial-loop`) that had nothing to do with it — so
 *     the record read as if the crash had caused the park.
 *
 * This module owns (3) and the shared text of (1): a dead child becomes one
 * structured `ChildCrashRecord` on `pipelineState.childCrash` plus one
 * `child-crash` event, and a verdict reason that names the process-level
 * failure. After the safety net has run, `attachCrashedWorktreeState` fills
 * in what the worktree still holds. It never throws and never decides
 * policy — the caller does.
 */
import { type ExecFn, isDriverArtefact, runGit, worktreeStatus } from "./work-develop-git.ts";
import type { ChildCrashKind, ChildCrashRecord } from "./workflow-state-events-child-crash.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent } from "./workflow-state.ts";

/** Bounded tail for the operator-facing detail (the transcript has the rest). */
const DETAIL_LIMIT = 240;

const clip = (s: string | undefined): string | undefined => {
  const t = s?.trim();
  if (!t) return undefined;
  return t.length > DETAIL_LIMIT ? `${t.slice(-DETAIL_LIMIT)}…` : t;
};

/**
 * How this result died, or undefined when it did not die.
 *
 * Order matters and mirrors `classifyFailureCause`: a structured self-kill
 * (`killCause`) is pi-rukas ending its own child and is NOT a crash this
 * seam records — the cap machinery already names it, and double-reporting a
 * cap as a crash is the contamination #1403 is about. A non-zero exit is the
 * "engine stopped unexpectedly" shape; an exit-0 `errorStop` is the provider
 * shape.
 */
export function childCrashKind(result: DispatchResult): ChildCrashKind | undefined {
  if (result.killCause) return undefined;
  if (result.errorStop) return "provider-error-stop";
  if (result.exitCode !== null && result.exitCode !== undefined && result.exitCode !== 0) {
    return "engine-exit";
  }
  if (!result.ok) return "engine-exit";
  return undefined;
}

/** The verdict reason a dead child's workstream carries — the text the
 *  `branches-converged` verdict and both handoff renderers show. */
export function childCrashReason(kind: ChildCrashKind, exitCode?: number | null): string {
  switch (kind) {
    case "engine-exit":
      return exitCode === null || exitCode === undefined
        ? "developer child died without reporting a result (non-zero exit)"
        : `developer child died mid-pass (the engine stopped unexpectedly, exit code ${exitCode})`;
    case "provider-error-stop":
      return "developer child terminated mid-stream (provider request error)";
    case "dispatch-threw":
      return "developer dispatch threw before producing a result";
  }
}

/**
 * Build the record for one dead child. `paths` / `committed` / `note` are
 * filled by `attachCrashedWorktreeState` once the safety net has had its
 * chance — a crash recorded before then must not claim the tree was clean.
 */
export function buildChildCrash(args: {
  step: string;
  workstreamId: string;
  label: string;
  kind: ChildCrashKind;
  result: Pick<DispatchResult, "exitCode" | "ms" | "transcriptPath" | "text" | "errorStop">;
  at?: number;
}): ChildCrashRecord {
  const at = args.at ?? Date.now();
  const detail =
    args.kind === "provider-error-stop"
      ? (clip(args.result.errorStop?.message) ?? clip(args.result.text))
      : clip(args.result.text);
  return {
    at,
    step: args.step,
    workstreamId: args.workstreamId,
    label: args.label,
    crash: args.kind,
    exitCode: args.result.exitCode ?? null,
    ...(detail !== undefined ? { detail } : {}),
    ...(args.result.transcriptPath ? { transcriptPath: args.result.transcriptPath } : {}),
    ms: args.result.ms,
  };
}

/**
 * Append the crash record + its event. One record per dispatch attempt: a
 * retried child that dies again produces a second row, which is what tells
 * the operator the retry did not help.
 */
export function recordChildCrash(state: WorkState, record: ChildCrashRecord): WorkState {
  const withEvent = appendEvent(state, { kind: "child-crash", ...record });
  const prior = withEvent.pipelineState.childCrash ?? [];
  return {
    ...withEvent,
    pipelineState: {
      ...withEvent.pipelineState,
      childCrash: [...prior, record],
    },
  };
}

/**
 * Fill in what the driver found in the dead child's worktree. Returns the
 * state unchanged when no record matches `label`.
 */
export function attachChildCrashWorktree(
  state: WorkState,
  label: string,
  found: { paths?: string[]; committed?: string[]; note?: string },
): WorkState {
  const records = state.pipelineState.childCrash;
  if (!records || records.length === 0) return state;
  const at = (() => {
    for (let i = records.length - 1; i >= 0; i--) if (records[i]?.label === label) return i;
    return -1;
  })();
  if (at < 0) return state;
  const target = records[at];
  if (!target) return state;
  const updated: ChildCrashRecord = {
    ...target,
    ...(found.paths !== undefined ? { paths: found.paths } : {}),
    ...(found.committed !== undefined ? { committed: found.committed } : {}),
    ...(found.note !== undefined ? { note: found.note } : {}),
  };
  return {
    ...state,
    eventLog: state.eventLog.map((e) =>
      e.kind === "child-crash" && e.label === label ? { ...e, ...updated } : e,
    ),
    pipelineState: {
      ...state.pipelineState,
      childCrash: state.pipelineState.childCrash?.map((r, i) => (i === at ? updated : r)),
    },
  };
}

/** The crash records for one workstream, newest last. Never throws. */
export function childCrashesFor(state: WorkState, workstreamId: string): ChildCrashRecord[] {
  return (state.pipelineState.childCrash ?? []).filter((r) => r.workstreamId === workstreamId);
}

/**
 * The paths the driver's #622 safety net committed for one workstream this
 * step, read out of the commits it names. `undefined` when nothing was
 * committed or a commit could not be read — the field stays absent rather
 * than claiming an empty list.
 */
export async function committedBySafetyNet(
  state: WorkState,
  workstreamId: string,
  execFn: ExecFn,
): Promise<string[] | undefined> {
  const git = runGit(execFn);
  const out: string[] = [];
  for (const e of state.eventLog) {
    if (e.kind !== "safety-net-commit" || e.workstreamId !== workstreamId) continue;
    try {
      // The event carries the file COUNT, not the paths; the commit is the
      // record, so the names come from it. An unreadable sha means "unknown".
      const { stdout } = await git(["show", "--name-only", "--format=", e.commitSha], {
        cwd: e.worktreePath,
        maxBuffer: 256 * 1024,
      });
      for (const p of stdout.split("\n")) if (p.trim()) out.push(p.trim());
    } catch {
      return undefined;
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * #1403 — after the safety net has run, record on each crash row what the
 * driver found in the dead child's worktree: the paths still uncommitted and
 * the paths it committed.
 *
 * The incident's audit gap in one line: the driver KNEW (`1 uncommitted
 * file(s) … modified: libexec/stop`, from the handoff snapshot minutes
 * later) and nothing in the develop step said so. A worktree whose status
 * cannot be read gets no `paths` field at all rather than a claim that it was
 * clean. Never throws.
 */
export async function attachCrashedWorktreeState(
  state: WorkState,
  execFn: ExecFn,
): Promise<WorkState> {
  const records = state.pipelineState.childCrash;
  if (!records || records.length === 0) return state;
  const worktrees = state.pipelineState.worktrees ?? {};
  const git = runGit(execFn);
  let next = state;
  for (const rec of records) {
    if (rec.paths !== undefined || rec.committed !== undefined) continue; // already filled
    const cwd = worktrees[rec.workstreamId];
    if (typeof cwd !== "string") continue;
    const status = await worktreeStatus(git, cwd);
    const paths = Array.isArray(status)
      ? status
          .filter((e) => !isDriverArtefact(e.path))
          .map((e) => e.path)
          .filter((p, i, all) => all.indexOf(p) === i)
      : undefined;
    const committed = await committedBySafetyNet(next, rec.workstreamId, execFn);
    if (paths === undefined && committed === undefined) continue;
    next = attachChildCrashWorktree(next, rec.label, {
      ...(paths !== undefined ? { paths } : {}),
      ...(committed !== undefined ? { committed } : {}),
    });
  }
  return next;
}
