/**
 * write-fence-log — how a fenced child's refusals reach the driver (#1655).
 *
 * The companion runs INSIDE each developer child, and the driver owns the cycle
 * state. The channel between them is the cycle scratch dir: each refusal is one
 * JSON line appended to `<scratch>/write-fence-<pid>.jsonl`. The driver sums the
 * lines when a step settles and stores the total on the cycle state.
 *
 * A missing scratch dir costs the count, never the cycle: the child only traces
 * the refusal, and the driver reads nothing. A log the driver cannot read is
 * counted as unreadable, never as zero, so the handoff can say the count is unknown.
 */

import { promises as fs, appendFileSync } from "node:fs";
import path from "node:path";
import { trace } from "./trace.ts";

/** What a dispatch is fenced to: its worktree, the main checkout, and the cycle scratch dir. All absolute. */
export interface WriteFence {
  root: string;
  repo: string;
  scratch: string;
}

/** One refused write, as the child records it. */
export interface WriteFenceRefusal {
  tool: string;
  path: string;
  reason: string;
  at: number;
}

/** What the driver reads back: refusals counted, and logs that could not be read (so their count is unknown). */
export interface WriteFenceCount {
  count: number;
  unreadable: number;
}

/** The env the fence reads. A child inherits none of these unless the driver sets them for its dispatch. */
const WRITE_FENCE_ENV = [
  "PI_ENSEMBLE_WRITE_ROOT",
  "PI_ENSEMBLE_WRITE_REPO",
  "PI_ENSEMBLE_WRITE_SCRATCH",
] as const;

const LOG_NAME = /^write-fence-\d+\.jsonl$/;

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
  }
}

/**
 * Total refusals across every fenced child that has written into this scratch dir.
 * A scratch dir that does not exist holds no logs (zero refusals); one that cannot
 * be read is unknown, reported as one unreadable log.
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
  let unreadable = 0;
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
    names
      .filter((n) => LOG_NAME.test(n))
      .map((n) =>
        fs.rm(path.join(scratch, n), { force: true }).catch((err: unknown) => {
          trace(`write-fence: could not clear ${n} from ${scratch}: ${(err as Error).message}`);
        }),
      ),
  );
}

/**
 * The env a child starts from: the parent's, with any inherited fence setting
 * removed (a child the driver did not fence must not inherit the ambient root of
 * the process that spawned it), and the child's role set.
 */
export function childEnvFor(env: NodeJS.ProcessEnv, role: string): Record<string, string> {
  const out: NodeJS.ProcessEnv = { ...env, PI_ENSEMBLE_ROLE: role };
  for (const key of WRITE_FENCE_ENV) delete out[key];
  return out as Record<string, string>;
}

/** The env a fenced dispatch's child gets. An unfenced child gets none, so the fence stays off for it. */
export function writeFenceChildEnv(fence: WriteFence | undefined): Record<string, string> {
  return fence
    ? {
        PI_ENSEMBLE_WRITE_ROOT: fence.root,
        PI_ENSEMBLE_WRITE_REPO: fence.repo,
        PI_ENSEMBLE_WRITE_SCRATCH: fence.scratch,
      }
    : {};
}
