/**
 * work-develop-retry — #1016: the selective, one-shot re-dispatch of a
 * develop fan-out's failed workstreams, and the per-completion persistence
 * of each workstream's `branch-completed` event.
 *
 * Only the workstreams without a green result are re-run. Greens keep their
 * worktree, commits and verdicts. Before a retry a failed workstream is reset
 * to its base, but ONLY when it has no commits ahead of that base: its partial
 * uncommitted edits are saved as a patch first (work-develop-git.ts). A
 * worktree with commits is never reset. The retry is in-process and bounded
 * to one attempt per workstream; a second failure falls through to the
 * branches-converged verdict and the handoff. Called from runDevelopTopological
 * (work-develop-topological.ts).
 */
import { trace } from "./trace.ts";
import {
  type ExecFn,
  commitsAheadOfBase,
  errText,
  isValidBaseSha,
  nextRetryAttempt,
  resetWorktreeToBase,
  retryPatchPath,
  runGit,
} from "./work-develop-git.ts";
import { downgradeReason } from "./work-develop-greens.ts";
import type { RawVerdict } from "./work-develop-verdict-source.ts";
import type { EmitSink } from "./work-state-emit.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
import { appendEvent, persistCycle } from "./workflow-state.ts";

/** One workstream's verdict in the develop fan-out. */
export type FanoutVerdict = RawVerdict;

/** #1016 — the crash-resume greens and the notes the check left behind. */
export interface PreservedGreens {
  kept: Set<string>;
  notes: string[];
  /** Workstream id → the reason a resumed workstream must not be dispatched
   *  (its uncommitted work could not be saved first). Fail closed. */
  refused?: Record<string, string>;
}

/** A shared, chained persister: each branch-completed is appended to the
 *  state ref and written as its workstream finishes. Writes are serialised
 *  because writes to one state file run in call order (workflow-state write chain). A failed write is
 *  non-fatal (the in-memory state carries on) but is pushed onto `notes`, so
 *  the handoff can say the crash-resume record may be incomplete. */
export function makeBranchCompletedPersister(
  repoRoot: string,
  stateRef: { current: WorkState },
  notes: string[],
  sink?: EmitSink,
): {
  emit: (ev: WorkEvent) => void;
  update: (fn: (s: WorkState) => WorkState) => void;
  flush: () => Promise<void>;
} {
  let chain: Promise<void> = Promise.resolve();
  const persistSnapshot = () => {
    const snapshot = stateRef.current;
    chain = chain
      .then(() => persistCycle({ repoRoot, emitSink: sink }, snapshot))
      .catch((err) => {
        const note = `state persist failed (crash-resume record may be incomplete) — ${errText(err)}`;
        trace(`work-driver: ${note}`);
        notes.push(note);
      });
  };
  return {
    emit: (ev) => {
      stateRef.current = appendEvent(stateRef.current, ev);
      persistSnapshot();
    },
    // #1016 — a non-event state change (a dependent's worktree path) written
    // through the same chain, so it never races an in-flight branch-completed write.
    update: (fn) => {
      stateRef.current = fn(stateRef.current);
      persistSnapshot();
    },
    flush: () => chain,
  };
}

/** #1016 — a kept green finished in an earlier attempt, before this window's
 *  step-started. Re-record it so a second crash still finds it green. */
export function reRecordKeptGreens(
  persister: { emit: (ev: WorkEvent) => void },
  independent: string[],
  kept: ReadonlySet<string>,
): void {
  for (const id of independent) {
    if (!kept.has(id)) continue;
    persister.emit({
      kind: "branch-completed",
      step: "develop",
      workstreamId: id,
      ok: true,
      ms: 0,
      at: Date.now(),
      resumed: true,
    });
  }
}

/** #1016 — surface non-fatal notes in the handoff: each lands in
 *  pipelineState.plumbReports (the handoff reads that field directly). */
export function withPersistNotes(state: WorkState, notes: string[]): WorkState {
  if (notes.length === 0) return state;
  const at = Date.now();
  const plumbReports = [
    ...state.pipelineState.plumbReports,
    ...notes.map((body) => ({
      step: "develop" as const,
      role: "driver",
      body,
      at,
    })),
  ];
  return { ...state, pipelineState: { ...state.pipelineState, plumbReports } };
}

/** #1016 — persist a commitless green's downgrade. The log (and any crash-resume)
 *  must not keep the ok:true that runOneWorkstream already emitted for it. The
 *  typed `downgrade` flag is the representation; the reason text comes from
 *  `downgradeReason(detail)`. */
export function recordDowngrade(
  persister: { emit: (ev: WorkEvent) => void },
  id: string,
  detail?: string,
): void {
  persister.emit({
    kind: "branch-completed",
    step: "develop",
    workstreamId: id,
    ok: false,
    ms: 0,
    at: Date.now(),
    error: downgradeReason(detail),
    downgrade: true,
  });
}

/** #1016 — the ONE owner of the rule "a green counts only with commits ahead
 *  of base", for a fresh green and a green preserved from an interrupted
 *  attempt alike. An invalid base or an unreadable check fails it: nothing is
 *  trusted without a readable commit count. A failed preserved green is
 *  re-run, not kept. The develop step runs the #622 safety net per worktree
 *  BEFORE this check, so a developer's uncommitted edits are already commits.
 *  `detail` is set only when the check could not be read (see downgradeReason). */
export async function greenCountsAsWork(
  execFn: ExecFn,
  cwd: string,
  base: string | undefined,
): Promise<{ counts: boolean; detail?: string }> {
  if (!isValidBaseSha(base)) {
    return { counts: false, detail: "no valid base sha" };
  }
  const ahead = await commitsAheadOfBase(runGit(execFn), cwd, base);
  if ("unreadable" in ahead) {
    return {
      counts: false,
      detail: `commit check unreadable — ${ahead.unreadable}`,
    };
  }
  return ahead.commits > 0 ? { counts: true } : { counts: false };
}

/** #1016 — the crash-resume greens that still count as work. A preserved green
 *  that fails the commit rule is not kept (its workstream is re-run) and a note
 *  says why; a preserved id with no worktree is not kept either. */
export async function trustedPreservedGreens(
  preserved: ReadonlySet<string>,
  ctx: {
    execFn: ExecFn;
    worktrees: Record<string, string | undefined>;
    baseFor: (id: string) => string | undefined;
  },
): Promise<PreservedGreens> {
  const out: PreservedGreens = { kept: new Set<string>(), notes: [] };
  for (const id of preserved) {
    const cwd = ctx.worktrees[id];
    if (typeof cwd !== "string") {
      out.notes.push(`${id}: preserved green has no worktree — not kept`);
      continue;
    }
    const r = await greenCountsAsWork(ctx.execFn, cwd, ctx.baseFor(id));
    if (r.counts) out.kept.add(id);
    else out.notes.push(`${id}: preserved green not kept — ${downgradeReason(r.detail)}`);
  }
  return out;
}

/** #1016 — what a retry's reset reports: the attempt number it saved under and
 *  the patch path when partial work was saved (undefined when there was none). */
export interface ResetOutcome {
  attempt: number;
  patch?: string;
}

/** #1016 — the retry's reset for one workstream: saves its partial work to
 *  `<scratchAbs>/retry-<id>-<attempt>.patch`, where the attempt is the next
 *  free number in the scratch dir, then resets (fail closed: a refused save or
 *  reset rejects, and that workstream is not re-run). */
export function retryResetFor(args: {
  execFn: ExecFn;
  repoRoot: string;
  scratchAbs: string;
  cwdFor: (id: string) => string | undefined;
  baseFor: (id: string) => string | undefined;
}): (id: string) => Promise<ResetOutcome> {
  return async (id) => {
    const cwd = args.cwdFor(id);
    if (typeof cwd !== "string") throw new Error(`${id}: no worktree to reset`);
    const attempt = await nextRetryAttempt(args.scratchAbs, id);
    const patchPath = retryPatchPath(args.scratchAbs, id, attempt);
    const patch = await resetWorktreeToBase(runGit(args.execFn), cwd, args.baseFor(id), {
      repoRoot: args.repoRoot,
      patchPath,
    });
    return { attempt, patch };
  };
}

/** #1016 — the independent fan-out with crash-resume greens kept (verdict
 *  only, never re-dispatched) and failed workstreams re-run ONCE after a
 *  worktree reset. Workstreams in `skip` (no worktree) were already failed by
 *  the caller. `verdicts` is the pre-fan-out snapshot and is NOT mutated; the
 *  return value is the complete final verdict list, which the caller adopts
 *  as-is. `resetFor` reports the attempt and the saved patch (when partial work
 *  was saved); each save is recorded in `notes`. Resets run one at a time; the
 *  retry dispatches then run in parallel. */
export async function runIndependentFanout(args: {
  independent: string[];
  preserved: ReadonlySet<string>;
  skip: string[];
  runAt: (id: string) => Promise<FanoutVerdict>;
  resetFor: (id: string) => Promise<ResetOutcome>;
  verdicts: readonly FanoutVerdict[];
  multi: boolean;
  notes?: string[];
  /** Filled with every id that failed its FIRST pass, even when the retry
   *  recovers it: dependents of a recovered workstream stay skipped (#1016). */
  firstPassFailed?: Set<string>;
}): Promise<FanoutVerdict[]> {
  const { independent, preserved, skip, runAt, resetFor, verdicts, multi, notes, firstPassFailed } =
    args;
  const kept = independent.filter((id) => preserved.has(id));
  const toDispatch = independent.filter((id) => !skip.includes(id) && !kept.includes(id));
  const runSafely = (id: string): Promise<FanoutVerdict> =>
    runAt(id).catch((err: unknown) => ({
      id,
      ok: false,
      reason: errText(err),
    }));
  const first = await Promise.all(toDispatch.map(runSafely));
  // Retry only when some workstream is green (kept or fresh): a fan-out where
  // every workstream failed is a step failure and goes straight to the verdicts.
  const finals = new Map(first.map((r) => [r.id, r]));
  const failed = first.filter((r) => !r.ok).map((r) => r.id);
  for (const id of failed) firstPassFailed?.add(id);
  const someGreen = first.some((r) => r.ok) || kept.length > 0;
  if (multi && someGreen && failed.length > 0) {
    trace(`work-driver: re-dispatching failed workstreams once — ${failed.join(", ")}`);
    // Resets run sequentially: they are cheap and keep git's index/ref locks
    // uncontended. A reset that refuses (commits ahead, unreadable check, bad
    // base, path outside .worktrees, unsaved work) fails that workstream with
    // its named reason and is not re-run.
    const resetOk: string[] = [];
    for (const id of failed) {
      const r = await resetForRetry(id, () => resetFor(id), notes);
      if (r.ok) resetOk.push(id);
      else finals.set(id, r.verdict);
    }
    // The retry dispatches start together: each is independent once its reset is done.
    const retried = await Promise.all(resetOk.map(runSafely));
    for (const v of retried) finals.set(v.id, v);
  }
  const dispatched = new Set(toDispatch);
  const out = verdicts.filter((v) => !dispatched.has(v.id) && !kept.includes(v.id));
  for (const id of kept) out.push({ id, ok: true });
  for (const id of toDispatch) out.push(finals.get(id) ?? { id, ok: false });
  return out;
}

/** #1016 — the ONE rule for a retry's reset, shared by the independent fan-out
 *  and the dependent phase: a saved partial-work patch is noted; a refused reset
 *  fails that workstream with its named reason and it is not re-run. */
export async function resetForRetry(
  id: string,
  reset: () => Promise<ResetOutcome>,
  notes?: string[],
): Promise<{ ok: true } | { ok: false; verdict: FanoutVerdict }> {
  try {
    const { attempt, patch } = await reset();
    if (patch !== undefined)
      notes?.push(`${id}: retry attempt ${attempt}: partial work saved to ${patch}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, verdict: { id, ok: false, reason: errText(err) } };
  }
}

/** #1016 — the one-shot retry of ONE workstream: reset (or refuse), then dispatch
 *  once. Returns the retry's outcome; the caller settles it into the verdicts. */
export async function retryOnce(args: {
  id: string;
  reset: () => Promise<ResetOutcome>;
  runAt: () => Promise<FanoutVerdict>;
  notes?: string[];
}): Promise<FanoutVerdict> {
  const r = await resetForRetry(args.id, args.reset, args.notes);
  if (!r.ok) return r.verdict;
  return args.runAt().catch((err: unknown) => ({ id: args.id, ok: false, reason: errText(err) }));
}

/** #1016 — one verdict per workstream. Keeps the id's first position, replaces
 *  its entry and drops every other entry for the id (a retry that dispatched
 *  pushed its own entry; the first pass left a stale failed one). */
export function settleVerdict(verdicts: FanoutVerdict[], v: FanoutVerdict): void {
  const idx = verdicts.findIndex((x) => x.id === v.id);
  if (idx < 0) {
    verdicts.push(v);
    return;
  }
  verdicts[idx] = v;
  for (let i = verdicts.length - 1; i > idx; i--) {
    if (verdicts[i]?.id === v.id) verdicts.splice(i, 1);
  }
}
