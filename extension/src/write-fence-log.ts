/**
 * write-fence-log — how a fenced child's refusals reach the driver (#1655).
 *
 * The companion runs INSIDE each developer child, and the driver owns the cycle
 * state. The channel between them is the cycle scratch dir: each refusal is one
 * JSON line appended to `<scratch>/write-fence-<pid>.jsonl`. The driver sums the
 * lines when a step settles and stores the total on the cycle state.
 *
 * A missing scratch dir costs the count, never the cycle: the child only traces
 * the refusal, and the driver reads nothing.
 */

import { promises as fs, appendFileSync } from "node:fs";
import path from "node:path";
import { trace } from "./trace.ts";

/** What a dispatch is fenced to: its worktree and the cycle scratch dir. Both absolute. */
export interface WriteFence {
  root: string;
  scratch: string;
}

/** The dispatch option that fences a child; the driver's dispatch seams accept it. */
export interface WriteFenceOpt {
  writeFence?: WriteFence;
}

/** One refused write, as the child records it. */
export interface WriteFenceRefusal {
  tool: string;
  path: string;
  reason: string;
  at: number;
}

const LOG_NAME = /^write-fence-\d+\.jsonl$/;

/** Append one refusal to this child's log. Never throws: the refusal stands either way. */
export function appendWriteFenceRefusal(
  scratch: string | undefined,
  entry: WriteFenceRefusal,
): void {
  if (!scratch || !path.isAbsolute(scratch)) return;
  try {
    appendFileSync(
      path.join(scratch, `write-fence-${process.pid}.jsonl`),
      `${JSON.stringify(entry)}\n`,
    );
  } catch (err) {
    trace(`write-fence: could not record refusal in ${scratch}: ${(err as Error).message}`);
  }
}

/** Total refusals across every fenced child that has written into this scratch dir. */
export async function countWriteFenceRefusals(scratch: string): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(scratch);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names.filter((n) => LOG_NAME.test(n))) {
    const text = await fs.readFile(path.join(scratch, name), "utf8").catch(() => "");
    total += text.split("\n").filter((line) => line.trim() !== "").length;
  }
  return total;
}

/**
 * Remove the logs a previous cycle left behind. Only the fence's own files are
 * touched; a `--restart` calls this so a new cycle starts its count at zero.
 */
export async function clearWriteFenceLogs(scratch: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(scratch);
  } catch {
    return;
  }
  await Promise.all(
    names.filter((n) => LOG_NAME.test(n)).map((n) => fs.rm(path.join(scratch, n), { force: true })),
  );
}

/** The env a fenced dispatch's child gets. An unfenced child gets none, so the fence stays off for it. */
export function writeFenceChildEnv(fence: WriteFence | undefined): Record<string, string> {
  return fence
    ? { PI_ENSEMBLE_WRITE_ROOT: fence.root, PI_ENSEMBLE_WRITE_SCRATCH: fence.scratch }
    : {};
}
