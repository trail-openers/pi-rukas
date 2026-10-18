/**
 * work-driver-gate-hang-tree — #1427: walking the killed gate's process tree.
 *
 * The hang report's most actionable section is the list of processes still
 * holding on when the wall clock fired (the nessie #1054 case: a test's own
 * already-killed `git pull` leaving a `git remote-http` behind, holding the
 * worktree). This module owns reading that tree — the `ps` invocation, the
 * breadth-first walk from the group leader, and the three bounds that keep the
 * diagnosis from becoming the second problem:
 *
 *   - {@link MAX_PROCESSES} rows, so a fork bomb cannot make the reporter the
 *     subject of its own report;
 *   - {@link MAX_SNAPSHOT_CHARS} of command text, enforced (not merely
 *     documented — round 3's finding was a bound nothing read);
 *   - {@link WALK_BUDGET_MS} of wall clock ACROSS ALL the `ps` calls. The row
 *     cap bounds what the walk returns; it never bounded how long it takes, and
 *     each level is a separate synchronous `ps`. Round 4 made the aggregate hold
 *     rather than merely be checked: each call's OWN timeout is the budget that
 *     is left, so a slow level cannot overshoot the aggregate by its own 3 s
 *     internal ceiling, and a level that would start past the deadline is
 *     skipped rather than spawned (#1427).
 *
 * Split from `work-driver-gate-hang.ts` for AGENTS.md §12's 500-line gate. The
 * renderer stays where it is; this is the collection half, with no dependency
 * on the report's shape.
 */

import { spawnSync } from "node:child_process";
import type { HangProcess } from "./work-driver-gate-hang.ts";

/** Bound on the walking ps calls, so a stuck tree cannot make us a second problem. */
const MAX_PROCESSES = 60;

/** Bound on a single `ps` walk's output, characters. Exported so the offline
 *  test can assert the bound actually bites — a cap nothing reads is not a cap. */
export const MAX_SNAPSHOT_CHARS = 4_000;

/** Bound on one process line's command text. Exported for the same reason. */
export const MAX_ARGS_CHARS = 160;

/**
 * #1427 round 3 — the wall-clock budget for one whole tree walk, across all its
 * `ps` calls. The row cap bounds what the walk RETURNS; nothing bounded how
 * long it TAKES, and each level was a separate synchronous `ps` with its own
 * 3 s internal timeout — so on a host whose `ps` is slow (loaded machine,
 * fork-exhausted container: the very conditions that made the gate hang) the
 * diagnosis was on track to cost up to three minutes of the cycle it is
 * reporting on. Two seconds is enough for dozens of levels of a real tree and
 * is not a number the reporter gets to argue with: when it runs out, the walk
 * returns what it has and says `walk budget exhausted`.
 *
 * #1427 round 4 — the per-call `ps` timeout is now DERIVED from what is left of
 * this budget (see {@link walkProcessTree}), so the aggregate is a real bound on
 * wall clock rather than a check performed between two calls that can each run
 * for three seconds.
 */
export const WALK_BUDGET_MS = 2_000;

/**
 * #1427 round 4 — the ceiling on one `ps` call's own timeout. It only ever
 * applies to the FIRST level, where the whole budget is still unspent; every
 * later level gets `deadline - now`, which is smaller. Keeping the ceiling
 * finite is what stops a hung `ps` from being the thing that never returns.
 */
const PS_CALL_CEILING_MS = 3_000;

/**
 * A `ps`-shaped process row. `etime` is `ps`' own elapsed-time column
 * (`[[HH:]MM:]SS`), which is what tells an operator a child has been sitting
 * there for 75 minutes rather than being a fresh spawn.
 */
export type { HangProcess };

/** Parse one `ps -eo pid,ppid,etime,args` row. Returns null for headers/junk. */
function parsePsLine(line: string): HangProcess | null {
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
  if (!m) return null;
  const pid = Number(m[1]);
  const ppid = Number(m[2]);
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null;
  const args = (m[4] ?? "").trim();
  if (!args) return null;
  return { pid, ppid, etime: m[3] ?? "?", args: args.slice(0, MAX_ARGS_CHARS) };
}

/** The command a `ps` walk runs. Exported so the offline test can drive it. */
export function psWalkArgv(parentPid: number): string[] {
  return ["-eo", "pid,ppid,etime,args", "--ppid", String(parentPid)];
}

/**
 * One level of the tree, via `ps --ppid`. `spawnSync` is used rather than
 * `execFile`: the caller is the failure path of a gate whose executor may be
 * the thing that is misbehaving, and a synchronous spawn of a stdlib binary
 * cannot deadlock on a promise the dying gate is holding.
 *
 * #1427 round 4 — `timeoutMs` is the budget the caller has LEFT, not a constant:
 * a level that starts with 200 ms remaining is given 200 ms, so the aggregate
 * {@link WALK_BUDGET_MS} is a bound on the walk rather than an aspiration.
 */
function psChildren(
  parentPid: number,
  run: typeof spawnSync,
  timeoutMs: number,
): { rows: HangProcess[]; error?: string } {
  let res: ReturnType<typeof spawnSync>;
  try {
    res = run("ps", psWalkArgv(parentPid), { encoding: "utf8", timeout: timeoutMs });
  } catch (e) {
    return { rows: [], error: `ps could not be started (${(e as Error).message?.slice(0, 80)})` };
  }
  if (res.error)
    return { rows: [], error: `ps could not be started (${res.error.message.slice(0, 80)})` };
  // exit 1 with no output is `ps`' answer to "no such parent", which is a
  // legitimate empty level, not a failure to snapshot.
  const stdout = typeof res.stdout === "string" ? res.stdout : "";
  if (res.status !== 0 && stdout.trim() === "") {
    return { rows: [], error: `ps exited ${res.status} without output` };
  }
  const rows: HangProcess[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const row = parsePsLine(line);
    if (row) rows.push(row);
  }
  return { rows };
}

/**
 * Walk the gate's process tree breadth-first from its leader, bounded three
 * ways: {@link MAX_PROCESSES} rows, {@link MAX_SNAPSHOT_CHARS} of command text,
 * and {@link WALK_BUDGET_MS} of wall clock across every `ps` it makes.
 *
 * `childrenOf` is injectable so the walk is testable without forking, and a
 * real `ps` on the host is what production gets. A failure on the FIRST level
 * (no `ps` binary, a host without `--ppid`) is reported as `treeUnavailable`;
 * a failure deeper in is not — the levels already walked are the evidence. The
 * two budget exhaustions ARE reported, because a tree that stopped at a bound
 * is a different claim from a tree that was fully walked.
 */
export function walkProcessTree(
  leaderPid: number,
  childrenOf: (pid: number, timeoutMs: number) => { rows: HangProcess[]; error?: string } = (
    pid,
    timeoutMs,
  ) => psChildren(pid, spawnSync, timeoutMs),
  opts: { budgetMs?: number } = {},
): { processes: HangProcess[]; treeUnavailable?: string } {
  const budgetMs = opts.budgetMs ?? WALK_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const visited = new Set<number>();
  const queue: number[] = [leaderPid];
  let firstLevelError: string | undefined;
  // #1427 round 3 — the character bound the docstring has always claimed. Rows
  // are committed to `collected` only while the running total fits, so the cap
  // truncates at a ROW boundary rather than mid-line (half a `git remote-https`
  // command line reads as a claim about a process that may not exist).
  const collected: HangProcess[] = [];
  let snapshotChars = 0;
  let snapshotTruncated = false;
  let budgetExhausted = false;
  const commit = (rows: HangProcess[]) => {
    for (const row of rows) {
      if (
        collected.length >= MAX_PROCESSES ||
        snapshotChars + row.args.length > MAX_SNAPSHOT_CHARS
      ) {
        snapshotTruncated = true;
        break;
      }
      snapshotChars += row.args.length;
      collected.push(row);
      queue.push(row.pid);
    }
  };
  while (queue.length > 0 && collected.length < MAX_PROCESSES) {
    // #1427 round 4 — the budget is not merely CHECKED before each `ps` (a
    // check between calls that each run for their own 3 s is a budget that
    // reads 2 s and takes 60), it is DERIVED: each level gets exactly the time
    // that remains, and a level that would start at or after the deadline is
    // never spawned at all.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      budgetExhausted = true;
      break;
    }
    const parent = queue.shift() as number;
    if (visited.has(parent)) continue;
    visited.add(parent);
    const level = childrenOf(parent, Math.min(PS_CALL_CEILING_MS, remaining));
    if (level.error) {
      if (collected.length === 0 && visited.size === 1) firstLevelError = level.error;
      continue;
    }
    commit(level.rows);
    if (snapshotTruncated) break;
  }
  if (collected.length === 0) {
    return {
      processes: [],
      treeUnavailable:
        firstLevelError ??
        (budgetExhausted
          ? "walk budget exhausted"
          : snapshotTruncated
            ? `process snapshot exceeded the ${MAX_SNAPSHOT_CHARS}-character bound before one row fit`
            : "no descendant process answered for the gate's pid"),
    };
  }
  // A walk that ran out of its budget still hands back the levels it saw — they
  // are evidence — but it says the walk was cut short rather than presenting a
  // truncated tree as the whole group.
  if (budgetExhausted) {
    return { processes: collected, treeUnavailable: "walk budget exhausted" };
  }
  if (snapshotTruncated) {
    return {
      processes: collected,
      treeUnavailable: `process snapshot bounded to ${MAX_SNAPSHOT_CHARS} characters`,
    };
  }
  return { processes: collected };
}

/** The default tree walker, kept behind a name so callers stay readable. */
export function captureProcessTree(leaderPid: number): {
  processes: HangProcess[];
  treeUnavailable?: string;
} {
  return walkProcessTree(leaderPid);
}
