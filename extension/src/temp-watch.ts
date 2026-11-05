/**
 * temp-watch — the temp-dir byte leftover listing for a REVIEWER child (#2051).
 *
 * A reviewer that probes a claim makes its own scratch: the field incident this
 * module exists for was a PERFORMANCE lens that generated eight synthetic
 * transcript files of a hundred-odd megabytes each under the temp root to
 * measure its own claim about unbounded transcript reads, and never removed
 * them — across a day of reviews that filled the machine's temp quota and a
 * a later child died mid-run on it. `home-watch.ts` lists new NAMES under
 * `$HOME`; a name says nothing here, because the leak is bytes, and bytes are
 * what ends a cycle. So the same window that lists `$HOME` sums the ALLOCATED
 * bytes under the temp root before the child and after it, and reports the
 * delta on the same `operatorConfig` channel. Like the `$HOME` listing this is
 * disclosure, never deletion: the parent does not remove another process's
 * files, and a line naming a leftover costs the operator one read to act on.
 *
 * The measure is ALLOCATED BLOCKS (`st_blocks * 512`), not `st_size`. A
 * synthetic transcript made with `truncate`/`dd seek` reports a huge apparent
 * size for no disk used, and the quota that ran out was a disk quota: a sparse
 * file is not what fills a temp directory, so a line that reported `st_size`
 * would accuse a child of a leak that costs nothing.
 *
 * The root is resolved at CALL time from `process.env.TMPDIR ?? os.tmpdir()`,
 * never latched at module load and never taken from the child's cwd: a test (or
 * a driver) that points TMPDIR at a scratch dir points the measurement there
 * too, and macOS's TMPDIR is not `/tmp` — it sits under `/var`, whose sibling
 * `/tmp` is a symlink. The root is the temp dir rather than the child's cwd
 * because the quota that fills is the shared one.
 *
 * What the walk does not enter, and why:
 *
 *   - Harness-owned prefixes (`pi-rukas-review-`, the `pi-rukas-` prompt dir,
 *     `pi-rukas-perm-`, `pi-rukas-spawn-slots-`) are skipped by name at the top
 *     level. Every one of them is a tree the harness itself made and releases in
 *     its own `finally` — `runWithReviewerTree`'s reviewer worktree is released
 *     OUTSIDE this window, and the role prompt dir at `spawn-support.ts`'s.
 *     Counting them would blame the child for the harness's own scratch, which
 *     is a number no operator can act on.
 *   - Symlinks are never followed: `withFileTypes` + `isSymbolicLink()`, never
 *     `recursive: true`, which follows a link and would walk a child's one link
 *     out of the temp root into whatever it names.
 *   - The walk is bounded by ENTRY COUNT and by DURATION. The temp root is a
 *     shared directory holding every other process's files, so an unbounded walk
 *     is an unbounded cost paid on the child's critical path for a number that
 *     is disclosure. On either bound the partial sum is what is reported — an
 *     underestimate the line names as such — because a partial total that
 *     clears the threshold is still the fact the operator needs, and silence is
 *     never an answer here.
 *
 * Attribution is the same accepted weakness the `$HOME` listing and the config
 * restore state in their module headers: overlapping children share one window,
 * so the line reads `during the <role> run` — a concurrent writer's bytes are
 * counted, and the warn is the attribution rather than a claim about which
 * child wrote them. That is also why the delta, not the absolute total, is what
 * is reported: the baseline is everything the root held before this child.
 *
 * A walk that cannot complete is reported as its own line, and never as a zero:
 * `{ bytes }` is a listing and `{ code }` is "there is no listing", the same
 * split `home-watch.ts` keeps between an empty listing and no listing. A
 * baseline that failed means nothing can be attributed to the child — one line
 * names the errno, and no byte figure is printed.
 *
 * A child-chosen NAME never reaches the line — the walk reports a total, not a
 * path. The only child-influenced text is the errno, which a filesystem chose:
 * it still goes through the same two neutralisers `home-watch.ts` runs a name
 * through, because a value the environment returned is untrusted text on a
 * report line either way (`neutraliseFenceEntry` kills control characters,
 * `neutraliseEvidence` brackets anything a reader parses).
 */

import type { Dirent, Stats } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { neutraliseEvidence } from "./comment-evidence.ts";
import { neutraliseFenceEntry } from "./plan-fence-render.ts";

/**
 * The allocated-byte delta a reviewer child has to leave before a line is
 * pushed at all. Fixed, deliberately: an operator knob for a disclosure
 * threshold is a way to switch the disclosure off, and 64 MB is two orders
 * below the field incident and two above anything a review legitimately writes.
 */
export const TEMP_BYTES_REPORT_THRESHOLD = 64 * 1024 * 1024;
/** Entries the walk will open before it stops and reports what it has. */
export const TEMP_WALK_MAX_ENTRIES = 20_000;
/** Milliseconds the walk may spend before it stops and reports what it has. */
export const TEMP_WALK_MAX_MS = 2_000;
/** One block, the unit `st_blocks` counts. */
const BLOCK_BYTES = 512;

/**
 * The prefixes under the temp root that belong to the harness rather than to a
 * child, each a tree some `finally` already owns: the reviewer worktree
 * (`reviewer-tree.ts`), the per-spawn role prompt dir (`spawn-support.ts`'s
 * `writeRolePromptFile`), the permission socket (`spawn-permission.ts`) and the
 * host-wide slot dir (`host-spawn-slots.ts`). Matched against the top-level
 * name only, so a child's own directory is walked whatever it is called.
 */
export const HARNESS_TEMP_PREFIXES: readonly string[] = [
  "pi-rukas-review-",
  "pi-rukas-",
  "pi-rukas-perm-",
  "pi-rukas-spawn-slots-",
];

/** What one walk of the root produced: a byte sum, or the errno that stopped it. */
export type TempMeasure =
  | { bytes: number; bound: string | undefined }
  | { code: string | undefined };

/** The temp root a child ran with — resolved now, never latched at module load. */
export function tempRoot(env: Record<string, string | undefined> = process.env): string {
  const tmp = env.TMPDIR;
  return tmp !== undefined && tmp !== "" ? tmp : os.tmpdir();
}

/**
 * The one `lstat` the walk makes, on its own so a test can watch what the walk
 * asks for. An entry it cannot stat counts as nothing rather than failing the
 * walk: a file another process removed while the walk ran is a shared temp root
 * behaving normally, not a measurement that failed.
 */
async function lstatForMeasure(target: string): Promise<Stats> {
  const { lstat } = await import("node:fs/promises");
  return lstat(target);
}
async function allocatedBytes(target: string): Promise<number> {
  let st: Stats;
  try {
    st = await lstatForMeasure(target);
  } catch {
    return 0;
  }
  return st.isFile() ? st.blocks * BLOCK_BYTES : 0;
}

/**
 * Sum the allocated bytes under `root`, skipping the harness's own trees and
 * never following a link. `bound` names the ceiling that stopped the walk, or
 * `undefined` when the walk finished: a truncated walk is an UNDERESTIMATE, and
 * a line that printed the number without saying so is how a disclosure starts
 * reporting a confident wrong answer.
 */
export async function tempAllocatedBytes(
  root: string,
  maxEntries = TEMP_WALK_MAX_ENTRIES,
  maxMs = TEMP_WALK_MAX_MS,
): Promise<TempMeasure> {
  const started = Date.now();
  const queue: string[] = [root];
  let entries = 0;
  let bytes = 0;
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let listed: Dirent[];
    try {
      listed = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // The root is the only unreadable directory that changes the verdict: with
      // nothing under it measured there is no total to report at all.
      if (dir === root) return { code: (err as NodeJS.ErrnoException).code };
      // A subdirectory that vanished or refuses us mid-walk is a shared temp
      // root behaving normally, and a per-entry failure is not a failed walk.
      continue;
    }
    let stopped: string | undefined;
    for (const entry of listed) {
      if (entry.isSymbolicLink()) continue;
      if (dir === root && isHarnessEntry(entry.name)) continue;
      // The bound is checked before the entry is opened, so the count is the
      // number of entries the walk touched, not one more than it touched.
      entries++;
      if (entries > maxEntries) {
        stopped = `entry bound ${maxEntries}`;
        break;
      }
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(target);
        continue;
      }
      if (entry.isFile()) bytes += await allocatedBytes(target);
    }
    if (stopped !== undefined) return { bytes, bound: stopped };
    if (Date.now() - started > maxMs) return { bytes, bound: `duration bound ${maxMs}ms` };
  }
  return { bytes, bound: undefined };
}

/** A top-level temp entry the harness made and removes itself. */
function isHarnessEntry(name: string): boolean {
  return HARNESS_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The report line for one baseline/after pair, or nothing when there is nothing
 * to say. The shapes are kept apart rather than collapsed to a zero: a failed
 * baseline is "cannot measure" (one line, no byte figure, because there is
 * nothing to attribute), a below-threshold delta is silence, and a walk the
 * clock or the entry ceiling stopped says so in the line.
 */
export function tempBytesLines(role: string, baseline: TempMeasure, after: TempMeasure): string[] {
  if (!("bytes" in baseline)) {
    return [
      `operator-config: could not measure the temp directory (${neutraliseEvidence(neutraliseFenceEntry(baseline.code ?? "unknown"))})`,
    ];
  }
  // A second listing that failed says nothing about the child: the first total
  // was taken before it ran, so there is no "unchanged" to claim and no new
  // bytes to name. Nothing is pushed, and the failure is not dressed as a zero.
  if (!("bytes" in after)) return [];
  const delta = after.bytes - baseline.bytes;
  if (delta <= TEMP_BYTES_REPORT_THRESHOLD) return [];
  const bound = after.bound ?? baseline.bound;
  const tail =
    bound === undefined
      ? ""
      : ` — partial walk (${neutraliseEvidence(neutraliseFenceEntry(bound))})`;
  return [
    `temp-bytes: ${delta} (allocated) during the ${neutraliseEvidence(neutraliseFenceEntry(role))} run${tail}`,
  ];
}
