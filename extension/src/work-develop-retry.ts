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
  resetWorktreeToBase,
  retryPatchPath,
  runGit,
} from "./work-develop-git.ts";
import { GREEN_DOWNGRADE } from "./work-develop-greens.ts";
import type { RawVerdict } from "./work-develop-verdict-source.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
import { appendEvent, writeState } from "./workflow-state.ts";

/** One workstream's verdict in the develop fan-out. */
export type FanoutVerdict = RawVerdict;

/** #1016 — the crash-resume greens and the notes the check left behind. */
export interface PreservedGreens {
  kept: Set<string>;
  notes: string[];
}

/** A shared, chained persister: each branch-completed is appended to the
 *  state ref and written as its workstream finishes. Writes are serialised
 *  because concurrent writeState calls share one tmp path. A failed write is
 *  non-fatal (the in-memory state carries on) but is pushed onto `notes`, so
 *  the handoff can say the crash-resume record may be incomplete. */
export function makeBranchCompletedPersister(
  repoRoot: string,
  stateRef: { current: WorkState },
  notes: string[],
): { emit: (ev: WorkEvent) => void; flush: () => Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  return {
    emit: (ev) => {
      stateRef.current = appendEvent(stateRef.current, ev);
      const snapshot = stateRef.current;
      chain = chain
        .then(() => writeState(repoRoot, snapshot))
        .catch((err) => {
          const note = `branch-completed persist failed (crash-resume record may be incomplete) — ${errText(err)}`;
          trace(`work-driver: ${note}`);
          notes.push(note);
        });
    },
    flush: () => chain,
  };
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
 *  must not keep the ok:true that runOneWorkstream already emitted for it. */
export function recordDowngrade(
  persister: { emit: (ev: WorkEvent) => void },
  id: string,
  reason: string,
): void {
  persister.emit({
    kind: "branch-completed",
    step: "develop",
    workstreamId: id,
    ok: false,
    ms: 0,
    at: Date.now(),
    error: reason,
    downgrade: true,
  });
}

/** #1016 — the ONE owner of the rule "a green counts only with commits ahead
 *  of base". `fresh` is a green this run just produced: an invalid base or an
 *  unreadable check fails it (fail-safe — uncommitted work is never trusted).
 *  `resume` is a green preserved from an interrupted attempt: an unreadable
 *  check keeps it, and `note` names the workstream and the git error. An
 *  invalid base is a configuration fault, not a git error: it never keeps a
 *  green, in either mode. The develop step runs the #622 safety net per
 *  worktree BEFORE the fresh check, so a developer's uncommitted edits are
 *  already commits here. */
export async function greenCountsAsWork(
  execFn: ExecFn,
  cwd: string,
  base: string | undefined,
  workstreamId: string,
  mode: "fresh" | "resume",
): Promise<{ counts: boolean; note?: string; reason?: string }> {
  if (!isValidBaseSha(base)) {
    return { counts: false, reason: `${GREEN_DOWNGRADE}: no valid base sha` };
  }
  const ahead = await commitsAheadOfBase(runGit(execFn), cwd, base);
  if ("unreadable" in ahead) {
    if (mode === "resume") {
      return {
        counts: true,
        note: `${workstreamId}: commit check unreadable, green kept — ${ahead.unreadable}`,
      };
    }
    return {
      counts: false,
      reason: `${GREEN_DOWNGRADE}: commit check unreadable — ${ahead.unreadable}`,
    };
  }
  return ahead.commits > 0 ? { counts: true } : { counts: false, reason: GREEN_DOWNGRADE };
}

/** #1016 — the crash-resume greens that still count as work. An unreadable
 *  check keeps its green and records a note; a preserved id with no worktree
 *  is not kept and records a note naming it. */
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
    const r = await greenCountsAsWork(ctx.execFn, cwd, ctx.baseFor(id), id, "resume");
    if (r.note !== undefined) out.notes.push(r.note);
    else if (!r.counts && r.reason !== undefined) {
      out.notes.push(`${id}: preserved green not kept — ${r.reason}`);
    }
    if (r.counts) out.kept.add(id);
  }
  return out;
}

/** #1016 — the retry's reset for one workstream: saves its partial work to
 *  `<scratchAbs>/retry-<id>-1.patch`, then resets (fail closed: a refused save
 *  or reset rejects, and that workstream is not re-run). */
export function retryResetFor(args: {
  execFn: ExecFn;
  repoRoot: string;
  scratchAbs: string;
  cwdFor: (id: string) => string | undefined;
  baseFor: (id: string) => string | undefined;
}): (id: string) => Promise<string | undefined> {
  return (id) => {
    const cwd = args.cwdFor(id);
    if (typeof cwd !== "string") return Promise.reject(new Error(`${id}: no worktree to reset`));
    let patchPath: string;
    try {
      patchPath = retryPatchPath(args.scratchAbs, id, 1);
    } catch (err) {
      return Promise.reject(err);
    }
    return resetWorktreeToBase(runGit(args.execFn), cwd, args.baseFor(id), {
      repoRoot: args.repoRoot,
      patchPath,
    });
  };
}

/** #1016 — the independent fan-out with crash-resume greens kept (verdict
 *  only, never re-dispatched) and failed workstreams re-run ONCE after a
 *  worktree reset. Workstreams in `skip` (no worktree) were already failed by
 *  the caller. `verdicts` is the pre-fan-out snapshot and is NOT mutated; the
 *  return value is the complete final verdict list, which the caller adopts
 *  as-is. `resetFor` returns the saved-patch path when partial work was saved;
 *  each saved patch is recorded in `notes`. */
export async function runIndependentFanout(args: {
  independent: string[];
  preserved: ReadonlySet<string>;
  skip: string[];
  runAt: (id: string) => Promise<FanoutVerdict>;
  resetFor: (id: string) => Promise<string | undefined>;
  verdicts: readonly FanoutVerdict[];
  multi: boolean;
  notes?: string[];
}): Promise<FanoutVerdict[]> {
  const { independent, preserved, skip, runAt, resetFor, verdicts, multi, notes } = args;
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
  const someGreen = first.some((r) => r.ok) || kept.length > 0;
  if (multi && someGreen && failed.length > 0) {
    trace(`work-driver: re-dispatching failed workstreams once — ${failed.join(", ")}`);
    // Resets run sequentially: they are cheap and keep git's index/ref locks
    // uncontended. A reset that refuses (commits ahead, unreadable check, bad
    // base, path outside .worktrees, unsaved work) fails that workstream with
    // its named reason and is not re-run.
    const retried: FanoutVerdict[] = [];
    for (const id of failed) {
      try {
        const patch = await resetFor(id);
        if (patch !== undefined) {
          notes?.push(`${id}: partial work saved to ${patch} before the retry reset`);
        }
        retried.push(await runSafely(id));
      } catch (err) {
        retried.push({ id, ok: false, reason: errText(err) });
      }
    }
    for (const v of retried) finals.set(v.id, v);
  }
  const dispatched = new Set(toDispatch);
  const out = verdicts.filter((v) => !dispatched.has(v.id) && !kept.includes(v.id));
  for (const id of kept) out.push({ id, ok: true });
  for (const id of toDispatch) out.push(finals.get(id) ?? { id, ok: false });
  return out;
}
