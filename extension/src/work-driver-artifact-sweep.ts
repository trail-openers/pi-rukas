/**
 * work-driver-artifact-sweep — #657 bounded best-effort sweep of orphan
 * artifact directories under `.pi/work-state/`.
 *
 * A cycle stores its per-issue artifacts in `.pi/work-state/<N>/` and the
 * driver's state in the sibling `.pi/work-state/<N>.json`. When a state file
 * is removed by hand (the documented "rm to start fresh" recovery) but the
 * artifact directory is not, the directory is orphaned and accumulates
 * forever. This sweep removes only directories that are provably orphaned:
 *
 *   - name is a POSITIVE INTEGER (numeric names are the artifact-dir shape;
 *     anything else — queue-summary, non-numeric dirs — is never touched),
 *   - NO sibling `<N>.json` state file (a live or terminal state file
 *     keeps its artifacts),
 *   - directory mtime older than 14 days (recent orphans are left alone —
 *     a mid-recovery operator may be about to re-create the state file).
 *
 * Best-effort by design: every failure mode (missing directory, permission
 * error, in-use directory) is traced and swallowed. This sweep runs at cycle
 * start and must never cost a cycle.
 *
 * Style follows the sibling `work-driver-worktree-sweep.ts`: `execFn`-
 * based removal, trace lines, never throws.
 */

import { exec } from "node:child_process";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

const defaultExecFn: ExecFn = promisify(exec) as unknown as ExecFn;

/** Hardcoded age floor for an orphan to be swept (14 days, ms). */
export const ORPHAN_ARTIFACT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Options for the artifact sweep.
 */
export interface ArtifactSweepOpts {
  /** Absolute repo root; `.pi/work-state/` is resolved under it. */
  repoRoot: string;
  /** Executor for `rm -rf` (injected so tests can assert the command). */
  execFn?: ExecFn;
  /** Set to false to disable the sweep (testing). */
  enabled?: boolean;
  /** Clock seam for tests (defaults to Date.now). */
  now?: () => number;
}

/**
 * Result of the artifact sweep.
 */
export interface ArtifactSweepResult {
  ran: boolean;
  checked: number;
  swept: string[];
  skipped: { name: string; reason: string }[];
}

/**
 * Run the sweep. Scans `.pi/work-state/` and removes directories matching
 * the orphan rules above. Never throws.
 */
export async function runArtifactSweep(opts: ArtifactSweepOpts): Promise<ArtifactSweepResult> {
  const { repoRoot, enabled = true, now = Date.now } = opts;
  const execFn = opts.execFn ?? defaultExecFn;

  if (!enabled) {
    return { ran: false, checked: 0, swept: [], skipped: [] };
  }

  const dir = join(repoRoot, ".pi", "work-state");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // No .pi/work-state directory — nothing to sweep.
    trace("artifact-sweep: no .pi/work-state directory — nothing to sweep");
    return { ran: true, checked: 0, swept: [], skipped: [] };
  }

  const checked: string[] = [];
  const swept: string[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const name of names) {
    const full = join(dir, name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch {
      // Entry vanished between readdir and lstat — skip silently.
      continue;
    }
    // Only directories are sweep candidates; files (queue-summary.json,
    // any <N>.json state file) are never touched.
    if (!st.isDirectory()) continue;
    checked.push(name);

    // Rule 1: positive-integer name only.
    if (!/^\d+$/.test(name) || Number(name) <= 0) {
      skipped.push({ name, reason: "non-numeric-name" });
      continue;
    }
    // Rule 2: no sibling <N>.json state file.
    if (existsStateFile(dir, name)) {
      skipped.push({ name, reason: "live-state-file" });
      continue;
    }
    // Rule 3: mtime older than the 14-day floor.
    if (now() - st.mtimeMs < ORPHAN_ARTIFACT_MAX_AGE_MS) {
      skipped.push({ name, reason: "recent" });
      continue;
    }

    // Orphan — remove recursively. Best-effort: never fatal.
    try {
      await execFn(`rm -rf ${JSON.stringify(full)}`);
      swept.push(name);
      trace(`artifact-sweep: removed orphan ${full}`);
    } catch (err) {
      const reason = (err as Error).message?.slice(0, 100) ?? "unknown";
      skipped.push({ name, reason: `remove-failed: ${reason}` });
      trace(`artifact-sweep: failed to remove ${full}: ${reason}`);
    }
  }

  if (swept.length === 0) {
    trace(`artifact-sweep: nothing to sweep (${checked.length} dir(s) checked)`);
  }

  return { ran: true, checked: checked.length, swept, skipped };
}

/** True when the sibling `<name>.json` state file exists. */
function existsStateFile(dir: string, name: string): boolean {
  const stateFile = join(dir, `${name}.json`);
  try {
    statSync(stateFile);
    return true;
  } catch {
    return false;
  }
}
