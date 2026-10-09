/**
 * work-develop-retry — #1016: the selective, one-shot re-dispatch of a
 * develop fan-out's failed workstreams, and the per-completion persistence
 * of each workstream's `branch-completed` event.
 *
 * Only the workstreams without a green result are re-run. Greens keep their
 * worktree, commits and verdicts. The retry is in-process and bounded to one
 * attempt per workstream; a second failure falls through to the
 * branches-converged verdict and the handoff. Called from
 * runDevelopTopological (work-develop-topological.ts).
 */
import { trace } from "./trace.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
import { appendEvent, writeState } from "./workflow-state.ts";

/** A shared, chained persister: each branch-completed is appended to the
 *  state ref and written as its workstream finishes. Writes are serialised
 *  because concurrent writeState calls share one tmp path. */
export function makeBranchCompletedPersister(
  repoRoot: string,
  stateRef: { current: WorkState },
): { emit: (ev: WorkEvent) => void; flush: () => Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  return {
    emit: (ev) => {
      stateRef.current = appendEvent(stateRef.current, ev);
      const snapshot = stateRef.current;
      chain = chain
        .then(() => writeState(repoRoot, snapshot))
        .catch((err) => trace(`work-driver: branch-completed persist failed — ${String(err)}`));
    },
    flush: () => chain,
  };
}

/** #1016 — the independent fan-out with crash-resume greens kept (verdict
 *  only, never re-dispatched) and failed workstreams re-run ONCE. Workstreams
 *  in `skip` (no worktree) were already failed by the caller. */
export async function runIndependentFanout(args: {
  independent: string[];
  preserved: ReadonlySet<string>;
  skip: string[];
  runAt: (id: string) => Promise<{ id: string; ok: boolean }>;
  verdicts: Array<{ id: string; ok: boolean; reason?: string }>;
  multi: boolean;
}): Promise<Array<{ id: string; ok: boolean }>> {
  const { independent, preserved, skip, runAt, verdicts, multi } = args;
  const kept = independent.filter((id) => preserved.has(id));
  for (const id of kept) verdicts.push({ id, ok: true });
  const toDispatch = independent.filter((id) => !skip.includes(id) && !kept.includes(id));
  const first = await Promise.all(toDispatch.map(runAt));
  const failed = first.filter((r) => !r.ok).map((r) => r.id);
  const someGreen = first.some((r) => r.ok) || kept.length > 0;
  if (!multi || !someGreen || failed.length === 0) return first;
  trace(`work-driver: re-dispatching failed workstreams once — ${failed.join(", ")}`);
  for (const id of failed) {
    for (let i = verdicts.length - 1; i >= 0; i--) {
      if (verdicts[i]?.id === id) verdicts.splice(i, 1);
    }
  }
  const retried = await Promise.all(failed.map(runAt));
  return first.map((r) => retried.find((x) => x.id === r.id) ?? r);
}
