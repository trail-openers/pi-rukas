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
 * A child whose scratch dir is unset or relative cannot name the cycle's dir, so
 * its marker goes to the repo's fallback dir (`unscratchedDir`), which the driver
 * counts alongside the cycle's own. That dir is shared by every cycle in the repo
 * and a restart does not clear it, so a marker there reads as unknown until it is
 * removed by hand. That is the honest direction: the count is unknown, not zero.
 *
 * The scratch dir is child-writable, so the count is advisory: a child can
 * delete its own log. It is evidence about the developer's instructions, not a
 * gate.
 */

import { promises as fs, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
/** The fallback dir's name under the repo's `tmp/`, beside the cycle scratch dirs. */
const UNSCRATCHED_DIR = "write-fence-unscratched";

/** The repo-level dir a refusal the cycle scratch dir cannot take is marked in (see the module doc). */
export function unscratchedDir(repoRoot: string): string {
  return path.join(repoRoot, "tmp", UNSCRATCHED_DIR);
}

/** Mark `dir` as holding a refusal the count cannot see. Returns false when the marker could not be written. Never throws. */
function markUnaccounted(dir: string, tag: string | number): boolean {
  try {
    writeFileSync(
      path.join(dir, `write-fence-unaccounted-${tag}`),
      `${new Date().toISOString()}\n`,
    );
    return true;
  } catch (err) {
    trace(`write-fence: could not mark ${dir} as unaccounted: ${(err as Error).message}`);
    return false;
  }
}

/** Mark a refusal the cycle scratch dir cannot take in the repo's fallback dir. Never throws. */
function markUnscratched(repo: string | undefined): void {
  if (!repo || !path.isAbsolute(repo)) {
    trace("write-fence: no absolute repo dir either; the refusal is traced and not counted");
    return;
  }
  const dir = unscratchedDir(repo);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    trace(`write-fence: could not create ${dir}: ${(err as Error).message}`);
    return;
  }
  markUnaccounted(dir, process.pid);
}

/**
 * Append one refusal to this child's log. Never throws: the refusal stands either way.
 * A refusal the scratch dir cannot take is marked unaccounted in the repo's fallback
 * dir, so the driver reports the count unknown rather than 0.
 */
export function appendWriteFenceRefusal(
  scratch: string | undefined,
  entry: WriteFenceRefusal,
  repo?: string,
): void {
  if (!scratch || !path.isAbsolute(scratch)) {
    trace(`write-fence: no absolute scratch dir (${scratch ?? "unset"}); refusal traced`);
    markUnscratched(repo);
    return;
  }
  try {
    appendFileSync(
      path.join(scratch, `write-fence-${process.pid}.jsonl`),
      `${JSON.stringify(entry)}\n`,
    );
  } catch (err) {
    trace(`write-fence: could not record refusal in ${scratch}: ${(err as Error).message}`);
    if (!markUnaccounted(scratch, process.pid)) markUnscratched(repo);
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
