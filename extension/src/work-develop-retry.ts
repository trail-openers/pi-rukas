/**
 * work-develop-retry — #1016: the selective, one-shot re-dispatch of a
 * develop fan-out's failed workstreams, and the per-completion persistence
 * of each workstream's `branch-completed` event.
 *
 * Only the workstreams without a green result are re-run. Greens keep their
 * worktree, commits and verdicts. Before a retry the failed workstream's
 * worktree is reset to its base, so partial edits from the failed attempt
 * cannot leak into the retry. The retry is in-process and bounded to one
 * attempt per workstream; a second failure falls through to the
 * branches-converged verdict and the handoff. Called from
 * runDevelopTopological (work-develop-topological.ts).
 */
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
import { appendEvent, writeState } from "./workflow-state.ts";

type ExecFn = NonNullable<DriverContext["verifyExecFn"]>;

/** A git ref we are willing to splice into a shell command (no metacharacters). */
const SAFE_REF = /^[\w./-]+$/;

/** One workstream's verdict in the develop fan-out. */
export interface FanoutVerdict {
  id: string;
  ok: boolean;
  reason?: string;
}

const errText = (err: unknown): string => String((err as Error)?.message ?? err).slice(0, 200);

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

/** #1016 — surface non-fatal persist failures in the handoff: each note
 *  lands in pipelineState.plumbReports (the handoff reads that field directly). */
export function withPersistNotes(state: WorkState, notes: string[]): WorkState {
  if (notes.length === 0) return state;
  const at = Date.now();
  const plumbReports = [
    ...state.pipelineState.plumbReports,
    ...notes.map((body) => ({ step: "develop" as const, role: "driver", body, at })),
  ];
  return { ...state, pipelineState: { ...state.pipelineState, plumbReports } };
}

/** #1016 — `git rev-list --count base..HEAD` > 0 in the workstream worktree.
 *  An invalid base or an unreadable repo counts as NO commits (fail-safe). */
export async function commitsAheadOfBase(
  execFn: ExecFn,
  cwd: string,
  base: string | undefined,
): Promise<boolean> {
  if (typeof base !== "string" || !SAFE_REF.test(base)) return false;
  try {
    const { stdout } = await execFn(`git rev-list --count ${base}..HEAD`, {
      cwd,
      maxBuffer: 64 * 1024,
    });
    return Number.parseInt(stdout.trim(), 10) > 0;
  } catch {
    return false;
  }
}

/** #1016 — reset a workstream worktree to its base and drop untracked files
 *  (`git clean -fd`, no `-x`: gitignored dependency links survive). Dirty work
 *  is stashed first (`--include-untracked`, a no-op when clean), so a reset
 *  discards nothing a developer left behind. Throws on failure; the caller
 *  turns that into a failed retry. */
export async function resetWorktreeToBase(
  execFn: ExecFn,
  cwd: string,
  base: string | undefined,
): Promise<void> {
  if (typeof base !== "string" || !SAFE_REF.test(base)) {
    throw new Error(`refusing to reset ${cwd}: no valid base sha`);
  }
  await execFn("git stash push --include-untracked --quiet -m pi-ensemble-pre-retry", {
    cwd,
    maxBuffer: 64 * 1024,
  });
  await execFn(`git reset --hard ${base}`, { cwd, maxBuffer: 64 * 1024 });
  await execFn("git clean -fd", { cwd, maxBuffer: 64 * 1024 });
}

/** #1016 — a crash-resume green is trusted only when the workstream still has
 *  commits ahead of its base. A green with no commit, or with no worktree, is
 *  not kept: it is failed and re-dispatched. */
export async function trustedGreens(
  preserved: ReadonlySet<string>,
  hasCommits: (id: string) => Promise<boolean>,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const id of preserved) if (await hasCommits(id)) out.add(id);
  return out;
}

/** #1016 — the crash-resume greens that still have commits ahead of base. */
export function trustedPreservedGreens(
  preserved: ReadonlySet<string>,
  ctx: {
    execFn: ExecFn;
    worktrees: Record<string, string | undefined>;
    baseFor: (id: string) => string | undefined;
  },
): Promise<Set<string>> {
  return trustedGreens(preserved, (id) => {
    const cwd = ctx.worktrees[id];
    return typeof cwd === "string"
      ? commitsAheadOfBase(ctx.execFn, cwd, ctx.baseFor(id))
      : Promise.resolve(false);
  });
}

/** #1016 — the independent fan-out with crash-resume greens kept (verdict
 *  only, never re-dispatched) and failed workstreams re-run ONCE after a
 *  worktree reset. Workstreams in `skip` (no worktree) were already failed by
 *  the caller. `verdicts` is the pre-fan-out snapshot and is NOT mutated; the
 *  returned `verdicts` is the full final list for the caller to adopt. */
export async function runIndependentFanout(args: {
  independent: string[];
  preserved: ReadonlySet<string>;
  skip: string[];
  runAt: (id: string) => Promise<FanoutVerdict>;
  resetFor: (id: string) => Promise<void>;
  verdicts: readonly FanoutVerdict[];
  multi: boolean;
}): Promise<{ results: FanoutVerdict[]; verdicts: FanoutVerdict[] }> {
  const { independent, preserved, skip, runAt, resetFor, verdicts, multi } = args;
  const kept = independent.filter((id) => preserved.has(id));
  const toDispatch = independent.filter((id) => !skip.includes(id) && !kept.includes(id));
  const runSafely = (id: string): Promise<FanoutVerdict> =>
    runAt(id).catch((err: unknown) => ({ id, ok: false, reason: errText(err) }));
  const first = await Promise.all(toDispatch.map(runSafely));
  const finals = new Map(first.map((r) => [r.id, r]));
  const failed = first.filter((r) => !r.ok).map((r) => r.id);
  const someGreen = first.some((r) => r.ok) || kept.length > 0;
  if (multi && someGreen && failed.length > 0) {
    trace(`work-driver: re-dispatching failed workstreams once — ${failed.join(", ")}`);
    const retried = await Promise.allSettled(
      failed.map(async (id) => {
        await resetFor(id);
        return runAt(id);
      }),
    );
    retried.forEach((s, i) => {
      const id = failed[i] as string;
      finals.set(
        id,
        s.status === "fulfilled" ? s.value : { id, ok: false, reason: errText(s.reason) },
      );
    });
  }
  const dispatched = new Set(toDispatch);
  const out = verdicts.filter((v) => !dispatched.has(v.id) && !kept.includes(v.id));
  for (const id of kept) out.push({ id, ok: true });
  const results = toDispatch.map((id) => finals.get(id) ?? { id, ok: false });
  out.push(...results);
  return { results, verdicts: out };
}
