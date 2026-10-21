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
 *     a mid-recovery operator may be about to re-create the state file),
 *   - and, checked LAST (#1743), no LIVE park record inside: the record is the
 *     evidence behind a refusal the operator was given, so its directory
 *     survives the age floor — but only while the guard would still believe it.
 *
 * Best-effort by design: every failure mode (missing directory, permission
 * error, in-use directory) is traced and swallowed. This sweep runs at cycle
 * start and must never cost a cycle.
 *
 * Style follows the sibling `work-driver-worktree-sweep.ts`: `execFn`-
 * based removal, trace lines, never throws.
 */

import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import {
  COVERED_PARK_CAPS,
  PARK_RECORD_MAX_AGE_MS,
  parkRecordExpired,
  readParkRecord,
} from "./work-driver-park-record.ts";
import type { ExecFn } from "./worktree.ts";

const defaultExecFn: ExecFn = execp;

/**
 * The age floor an orphan must pass to be swept is `PARK_RECORD_MAX_AGE_MS`,
 * declared in `work-driver-park-record.ts` — the record's own expiry. It lives
 * there (not here) so the record module never imports the sweep that judges
 * its directory; see that module for why one clock serves both.
 */

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
    if (now() - st.mtimeMs < PARK_RECORD_MAX_AGE_MS) {
      skipped.push({ name, reason: "recent" });
      continue;
    }
    // Rule 1b (#1743), checked LAST: a dir holding a LIVE park record is not
    // removed. The record is the cross-cycle memory behind a refusal the
    // operator is told about ("this issue already parked twice, first reported
    // <date>"), and the refusal names its path — deleting it would hand the
    // operator a third identical park and destroy the evidence for the guard
    // that stopped them. It is an exemption only while the record still
    // describes the world: past the age floor below the guard ignores it
    // anyway, so keeping the directory alive forever would preserve dead state.
    //
    // Last rather than first, because a record does not make a directory
    // un-orphaned — it only delays the sweep, and an exemption checked before
    // every other rule cannot report what the other rules found.
    if (await holdsLiveParkRecord(repoRoot, name, now)) {
      skipped.push({ name, reason: "park-record-held" });
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

/**
 * #1743 — true when the artifact dir holds a park record the guard would still
 * act on (work-driver-park-record.ts).
 *
 * The cap names and the expiry clock are both IMPORTED from that module, not
 * restated here: it owns `park-<cap>.json`, and a record the sweep alone
 * believes in — while the guard ignores it as expired, or after a rename adds a
 * fourth cap — is an exemption from nothing.
 *
 * An unreadable dir counts as holding one: the sweep keeps on doubt, and an
 * orphan record costs a few bytes where deleting a live one costs a wrong
 * refusal (or a missing one).
 */
async function holdsLiveParkRecord(
  repoRoot: string,
  name: string,
  now: () => number,
): Promise<boolean> {
  try {
    readdirSync(join(repoRoot, ".pi", "work-state", name));
  } catch {
    return true;
  }
  for (const cap of COVERED_PARK_CAPS) {
    const rec = await readParkRecord(repoRoot, Number(name), cap);
    if (rec && !parkRecordExpired(rec, now())) return true;
  }
  return false;
}
