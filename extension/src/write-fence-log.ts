/**
 * write-fence-log — how a fenced child's refusals reach the driver (#1655).
 *
 * The companion runs INSIDE each developer child, and the driver owns the cycle
 * state. The channel between them is the cycle scratch dir: each refusal is one
 * JSON line appended to `<scratch>/write-fence-<pid>.jsonl`. The driver sums the
 * lines when a step settles and stores the total on the cycle state.
 *
 * A missing scratch dir costs the count, never the cycle: the child only traces
 * the refusal, and the driver reads nothing. Anything the count cannot account
 * for is kept apart as unaccounted: a log the driver cannot read, a refusal the
 * child could not log (it leaves an `unaccounted` marker), a log a restart could
 * not remove. The handoff then says the count is unknown, never a silent zero.
 *
 * The scratch dir is child-writable, so the count is advisory: a child can
 * delete its own log. It is evidence about the developer's instructions, not a
 * gate.
 */

import { promises as fs, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { trace } from "./trace.ts";

/** One refused write, as the child records it. */
export interface WriteFenceRefusal {
  tool: string;
  path: string;
  reason: string;
  at: number;
}

/** What the driver reads back: refusals counted, and what the count cannot account for (so the total is a lower bound). */
export interface WriteFenceCount {
  count: number;
  unreadable: number;
}

const LOG_NAME = /^write-fence-\d+\.jsonl$/;
const UNACCOUNTED_NAME = /^write-fence-unaccounted-[\w-]+$/;

/** Mark the scratch dir as holding a refusal the count cannot see. Never throws. */
function markUnaccounted(scratch: string, tag: string | number): void {
  try {
    writeFileSync(
      path.join(scratch, `write-fence-unaccounted-${tag}`),
      `${new Date().toISOString()}\n`,
    );
  } catch (err) {
    trace(`write-fence: could not mark ${scratch} as unaccounted: ${(err as Error).message}`);
  }
}

/** Append one refusal to this child's log. Never throws: the refusal stands either way. */
export function appendWriteFenceRefusal(
  scratch: string | undefined,
  entry: WriteFenceRefusal,
): void {
  if (!scratch || !path.isAbsolute(scratch)) {
    trace(
      `write-fence: no absolute scratch dir (${scratch ?? "unset"}); refusal traced, not logged`,
    );
    return;
  }
  try {
    appendFileSync(
      path.join(scratch, `write-fence-${process.pid}.jsonl`),
      `${JSON.stringify(entry)}\n`,
    );
  } catch (err) {
    trace(`write-fence: could not record refusal in ${scratch}: ${(err as Error).message}`);
    markUnaccounted(scratch, process.pid);
  }
}

/**
 * Total refusals across every fenced child that has written into this scratch dir.
 * A scratch dir that does not exist holds no logs (zero refusals); one that cannot
 * be read is unknown, reported as one unaccounted source.
 */
export async function countWriteFenceRefusals(scratch: string): Promise<WriteFenceCount> {
  let names: string[];
  try {
    names = await fs.readdir(scratch);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { count: 0, unreadable: 0 };
    trace(
      `write-fence: could not read scratch ${scratch} (${code ?? "unknown errno"}): ${(err as Error).message}`,
    );
    return { count: 0, unreadable: 1 };
  }
  let count = 0;
  const markers = names.filter((n) => UNACCOUNTED_NAME.test(n)).length;
  let unreadable = markers;
  for (const name of names.filter((n) => LOG_NAME.test(n))) {
    const file = path.join(scratch, name);
    try {
      const text = await fs.readFile(file, "utf8");
      count += text.split("\n").filter((line) => line.trim() !== "").length;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      trace(
        `write-fence: could not read refusal log ${file} (${code ?? "unknown errno"}): ${(err as Error).message}`,
      );
      unreadable++;
    }
  }
  return { count, unreadable };
}

/**
 * Remove the logs and markers a previous cycle left behind. Only the fence's own
 * files are touched. Returns how many could not be removed, so the caller can
 * mark the new cycle's count unknown rather than start it at a false zero.
 */
export async function clearWriteFenceLogs(scratch: string): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(scratch);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    trace(`write-fence: could not list ${scratch} to clear the count: ${(err as Error).message}`);
    return 1;
  }
  const stale = names.filter((n) => LOG_NAME.test(n) || UNACCOUNTED_NAME.test(n));
  const failures = await Promise.all(
    stale.map((n) =>
      fs.rm(path.join(scratch, n), { force: true }).then(
        () => 0,
        (err: unknown) => {
          trace(`write-fence: could not clear ${n} from ${scratch}: ${(err as Error).message}`);
          return 1;
        },
      ),
    ),
  );
  return failures.reduce<number>((a, b) => a + b, 0);
}

/** Record that the count cannot account for `n` logs a restart could not remove. Never throws. */
export function markCountUnknown(scratch: string, n: number): void {
  for (let k = 0; k < n; k++) markUnaccounted(scratch, `restart-${k}`);
}
