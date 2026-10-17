/**
 * #1427 round 4 — a `ps` stand-in for the tree-walk budget test.
 *
 * Lives in `smoke-tests/lib/` beside the other hang helpers for the same reason
 * they do: `test-file-size-limit.ts` scans every `.ts` under `smoke-tests/`, and
 * the budget test is already at the cap with the cases it has to drive.
 *
 * The fake answers from a caller-supplied row set and RECORDS the `timeout` of
 * every call, which is what makes the aggregate walk budget assertable: the test
 * reads the timeouts `walkProcessTree` derived from its remaining budget, rather
 * than asserting on wall clock alone. `childrenOf` replicates the real
 * `psChildren` parse path (header dropped, `parsePsLine` shape) so the rows the
 * walk commits are the rows a real `ps` would have produced for this tree.
 */

import { spawnSync } from "node:child_process";
import type { HangProcess } from "../../src/work-driver-gate-hang.ts";
import { psWalkArgv } from "../../src/work-driver-gate-hang-tree.ts";

export interface HangProcessLike {
  pid: number;
  ppid: number;
  etime: string;
  args: string;
}

/** Render rows the way `ps -eo pid,ppid,etime,args` does: a header, then rows. */
export function psStdout(rows: HangProcessLike[]): string {
  return [
    "PID PPID ELAPSED COMMAND",
    ...rows.map((r) => `${r.pid} ${r.ppid} ${r.etime} ${r.args}`),
  ].join("\n");
}

export function fakeSpawnSync(
  rowsFor: (pid: number) => HangProcessLike[],
  opts: { delayMs?: number } = {},
): {
  run: typeof spawnSync;
  calls: { pid: number; timeoutMs: number }[];
  childrenOf: (pid: number, timeoutMs: number) => { rows: HangProcess[]; error?: string };
} {
  const calls: { pid: number; timeoutMs: number }[] = [];
  const run = ((bin: string, argv: string[], o: { timeout?: number }) => {
    const parentPid = Number(argv[argv.length - 1]);
    calls.push({ pid: parentPid, timeoutMs: Number(o?.timeout ?? -1) });
    const until = Date.now() + (opts.delayMs ?? 0);
    while (Date.now() < until) {
      /* spin: stand in for a ps that takes time to answer */
    }
    return { stdout: psStdout(rowsFor(parentPid)), status: 0, error: undefined };
  }) as unknown as typeof spawnSync;
  const childrenOf = (pid: number, timeoutMs: number) => {
    const res = run("ps", psWalkArgv(pid), { timeout: timeoutMs }) as unknown as {
      stdout: string;
    };
    const rows: HangProcess[] = [];
    for (const line of res.stdout.split("\n").slice(1)) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const args = (m[4] ?? "").trim();
      if (!args) continue;
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), etime: m[3] ?? "?", args });
    }
    return { rows };
  };
  return { run, calls, childrenOf };
}
