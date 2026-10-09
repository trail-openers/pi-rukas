/**
 * work-develop-retry — #1016: the selective, one-shot re-dispatch of a
 * develop fan-out's failed workstreams, and the per-completion persistence
 * of each workstream's `branch-completed` event.
 *
 * Only the workstreams without a green result are re-run. Greens keep their
 * worktree, commits and verdicts. Before a retry a failed workstream is reset
 * to its base, but ONLY when it has no commits ahead of that base: a worktree
 * with commits is never reset, so committed work cannot be discarded. The
 * retry is in-process and bounded to one attempt per workstream; a second
 * failure falls through to the branches-converged verdict and the handoff.
 * Called from runDevelopTopological (work-develop-topological.ts).
 */
import { trace } from "./trace.ts";
import type { RawVerdict } from "./work-develop-verdict-source.ts";
import type { DriverContext } from "./work-driver-context.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";
import { appendEvent, writeState } from "./workflow-state.ts";

type ExecFn = NonNullable<DriverContext["verifyExecFn"]>;

/** One workstream's verdict in the develop fan-out. */
export type FanoutVerdict = RawVerdict;

/** #1016 — the crash-resume greens and the notes the check left behind. */
export interface PreservedGreens {
  kept: Set<string>;
  notes: string[];
}

/** #1016 — the only ref a git command in these paths may receive: a full
 *  40-hex SHA. A branch name, `--hard`, `-x` or anything else is refused
 *  before git sees it. */
const SHA_RE = /^[0-9a-f]{40}$/;
export const isBaseSha = (s: unknown): s is string => typeof s === "string" && SHA_RE.test(s);

/** #1016 — tri-state commit count: git answered, or the check could not be read. */
export type CommitCheck = { commits: number } | { unreadable: string };

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
    ...notes.map((body) => ({
      step: "develop" as const,
      role: "driver",
      body,
      at,
    })),
  ];
  return { ...state, pipelineState: { ...state.pipelineState, plumbReports } };
}

/** #1016 — `git rev-list --count <base>..HEAD` in the workstream worktree.
 *  Only a real answer from git is a count; an invalid base, a git error or
 *  unparseable output is `unreadable` and says why. */
export async function commitsAheadOfBase(
  execFn: ExecFn,
  cwd: string,
  base: string | undefined,
): Promise<CommitCheck> {
  if (!isBaseSha(base)) return { unreadable: "base is not a 40-hex sha" };
  try {
    const { stdout } = await execFn(`git rev-list --count ${base}..HEAD`, {
      cwd,
      maxBuffer: 64 * 1024,
    });
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(n)
      ? {
          unreadable: `unparseable rev-list output: ${stdout.trim().slice(0, 80)}`,
        }
      : { commits: n };
  } catch (err) {
    return { unreadable: errText(err) };
  }
}

/** #1016 — the ONE owner of the rule "a green counts only with commits ahead
 *  of base". An unreadable check never untrusts a green: it keeps it, and the
 *  `note` names the workstream and the git error for the handoff. */
export async function greenCountsAsWork(
  execFn: ExecFn,
  cwd: string,
  base: string | undefined,
  workstreamId: string,
): Promise<{ counts: boolean; note?: string }> {
  const ahead = await commitsAheadOfBase(execFn, cwd, base);
  if ("unreadable" in ahead) {
    return {
      counts: true,
      note: `${workstreamId}: commit check unreadable, green kept — ${ahead.unreadable}`,
    };
  }
  return { counts: ahead.commits > 0 };
}

/** #1016 — reset a workstream worktree to its base and drop untracked files
 *  (`git clean -fd`, no `-x`: gitignored dependency links survive). Refuses,
 *  by throwing, unless the base is a 40-hex SHA AND the commit check returned
 *  zero commits ahead: a worktree with committed work is never reset, and an
 *  unreadable check is never a licence to reset. Uncommitted edits are
 *  discarded — by definition scratch, since nothing was committed. */
export async function resetWorktreeToBase(
  execFn: ExecFn,
  cwd: string,
  base: string | undefined,
): Promise<void> {
  if (!isBaseSha(base)) {
    throw new Error(`refusing to reset ${cwd}: base is not a 40-hex sha`);
  }
  const ahead = await commitsAheadOfBase(execFn, cwd, base);
  if (!("commits" in ahead)) {
    throw new Error(`refusing to reset ${cwd}: commit check unreadable — ${ahead.unreadable}`);
  }
  if (ahead.commits > 0) {
    throw new Error(`refusing to reset ${cwd}: HEAD has ${ahead.commits} commit(s) ahead of base`);
  }
  await execFn(`git reset --hard ${base}`, { cwd, maxBuffer: 64 * 1024 });
  await execFn("git clean -fd", { cwd, maxBuffer: 64 * 1024 });
}

/** #1016 — the crash-resume greens that still count as work. Each unreadable
 *  check keeps its green and records a note naming the workstream. */
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
    if (typeof cwd !== "string") continue;
    const r = await greenCountsAsWork(ctx.execFn, cwd, ctx.baseFor(id), id);
    if (r.note !== undefined) out.notes.push(r.note);
    if (r.counts) out.kept.add(id);
  }
  return out;
}

/** #1016 — the independent fan-out with crash-resume greens kept (verdict
 *  only, never re-dispatched) and failed workstreams re-run ONCE after a
 *  worktree reset. Workstreams in `skip` (no worktree) were already failed by
 *  the caller. `verdicts` is the pre-fan-out snapshot and is NOT mutated; the
 *  return value is the complete final verdict list, which the caller adopts
 *  as-is. */
export async function runIndependentFanout(args: {
  independent: string[];
  preserved: ReadonlySet<string>;
  skip: string[];
  runAt: (id: string) => Promise<FanoutVerdict>;
  resetFor: (id: string) => Promise<void>;
  verdicts: readonly FanoutVerdict[];
  multi: boolean;
}): Promise<FanoutVerdict[]> {
  const { independent, preserved, skip, runAt, resetFor, verdicts, multi } = args;
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
    // base) fails that workstream with its named reason and is not re-run.
    const resetErr = new Map<string, string>();
    for (const id of failed) {
      try {
        await resetFor(id);
      } catch (err) {
        resetErr.set(id, errText(err));
      }
    }
    const retried = await Promise.allSettled(
      failed.map(async (id): Promise<FanoutVerdict> => {
        const err = resetErr.get(id);
        if (err !== undefined) return { id, ok: false, reason: err };
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
  for (const id of toDispatch) out.push(finals.get(id) ?? { id, ok: false });
  return out;
}
