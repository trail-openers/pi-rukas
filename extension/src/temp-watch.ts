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
 * The channel is INERT for a repointed child (#2241). A child's `TMPDIR`, `TMP`
 * and `TEMP` now name its own per-spawn dir, so everything it writes lands there
 * and the spawn's `finally` removes it — it no longer lands in the root this walk
 * measures, and a leak this line reports can no longer come from such a child. It
 * still measures the shared root, which is where a leak from anything OUTSIDE a
 * repointed child (a helper a child execs with its own env, a nested process that
 * sets TMPDIR elsewhere, a pre-#2241 child) still shows up. The disclosure is kept
 * rather than deleted for that reason, and the residual is stated plainly: for a
 * child whose temp root the harness set, a large scratch tree it left in its OWN
 * dir is invisible here, and what removes it is the spawn's cleanup, not this walk.
 *
 * What the walk does not enter, and why:
 *
 *   - The harness's own trees are skipped by OWNERSHIP, never by name. A name is
 *     the one property of a temp entry a child chooses, so a prefix list is a
 *     blind spot a child can name itself into: `mkdtemp` a directory called
 *     `pi-rukas-whatever` and a whole leak stops being measured. The skip is
 *     therefore three properties that are NOT the child's to pick: the top-level
 *     entry starts with a harness prefix, it is owned by the uid running the
 *     parent (`st_uid` — which is every harness tree, since the parent and its
 *     children share one uid), and it is a directory in mode `0700` with no group
 *     or other bits. Each harness tree that can be live in this window is made
 *     exactly that way: `writeRolePromptFile`'s prompt dir, the permission
 *     socket's directory, `host-spawn-slots`' slot dir, `reviewer-tree`'s
 *     checkout and `work-driver-toolchain-canary`'s probe dir all `mkdtemp` and
 *     set `0700` explicitly — including `writeRolePromptFile`'s dir, which since
 *     #2241 is also the child's whole `TMPDIR` and so must keep that mode for the
 *     skip to still read it as the harness's own. A child's own `mkdir` gets `0777 & ~umask`, which at any
 *     umask up to `007` is wider than `0700` and reads as a leak. What a child CAN
 *     do is `chmod 700` its own harness-prefixed directory and match all three — the
 *     honest shapes and that one are indistinguishable from the parent's side, since
 *     nothing records which directories the harness made in this window. That is the
 *     accepted residual, stated rather than papered over: it takes deliberate
 *     mimicry to reach (two properties a child would have to choose on purpose), the
 *     hygiene rule in the reviewer prompts is what keeps a probe tree from growing
 *     large enough to matter, and it is the reason the skip requires all three rather
 *     than the name it could not trust alone. Counting the harness's own scratch would
 *     blame the child for a number no operator can act on; that is why the trees are
 *     skipped at all, and why the skip is the narrow thing it is.
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
 * split `home-watch.ts` keeps between an empty listing and no listing. BOTH
 * walks say so: a baseline that failed means nothing can be attributed to the
 * child (one line names the errno, no byte figure), and a baseline plus a failed
 * after-walk is "cannot prove the child left nothing" — the same one line, which
 * is what the `$HOME` channel already does for its second listing. The shape
 * this channel exists to catch is a child that trashed the temp root at the end
 * of its run, and a silent return there is the disclosure failing on exactly the
 * incident it was written for. Silences remain only where a line would be noise:
 * a below-threshold delta, and the non-reviewer roles that are not measured.
 *
 * A child-chosen NAME never reaches the line — the walk reports a total, not a
 * path. The only child-influenced text is the errno, which a filesystem chose:
 * it still goes through the same two neutralisers `home-watch.ts` runs a name
 * through, because a value the environment returned is untrusted text on a
 * report line either way (`neutraliseFenceEntry` kills control characters,
 * `neutraliseEvidence` brackets anything a reader parses).
 *
 * The walk also cannot be made expensive on purpose. The entry and duration
 * ceilings are PARAMETERS, so the test can trip them on a fixture instead of
 * waiting for a shared temp root to grow; the shipped call sites pass none, which
 * is what makes {@link TEMP_WALK_MAX_ENTRIES} and {@link TEMP_WALK_MAX_MS} the
 * only values a real measurement uses.
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
 * The `== threshold` case prints nothing on purpose (the arm is `<=`), so the test
 * measures AT the arm instead of trusting this arithmetic.
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
 * `writeRolePromptFile`), the permission socket (`spawn-permission.ts`), the
 * host-wide slot dir (`host-spawn-slots.ts`) and the type-checker probe dir
 * (`work-driver-toolchain-canary.ts`). Matched against the top-level name only,
 * and NOT sufficient on its own: `isHarnessEntry` requires the owner and the
 * mode too, because a prefix a child can type is a prefix a child can use.
 */
export const HARNESS_TEMP_PREFIXES: readonly string[] = [
  "pi-rukas-review-",
  "pi-rukas-",
  "pi-rukas-perm-",
  "pi-rukas-spawn-slots-",
  "pi-rukas-canary-",
];
/** Group or other permissions: a harness tree is `0700`, nothing wider. */
const NON_OWNER_MODE_BITS = 0o077;

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
 * asks for, and handed to {@link tempAllocatedBytes} as `stat` so a test can arrange
 * an entry's removal at the moment the walk asks for it (the fs module namespace is
 * read-only under bun and jiti, so it cannot be patched from outside). An entry it
 * cannot stat counts as nothing rather than failing the walk: a file another process
 * removed while the walk ran is a shared temp root behaving normally, not a
 * measurement that failed.
 */
async function lstatForMeasure(target: string): Promise<Stats> {
  const { lstat } = await import("node:fs/promises");
  return lstat(target);
}
async function allocatedBytes(target: string, stat: StatEntry): Promise<number> {
  let st: Stats;
  try {
    st = await stat(target);
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
/** The walk's stat seam: one entry's stats, or the error the filesystem returned. */
type StatEntry = (target: string) => Promise<Stats>;

export async function tempAllocatedBytes(
  root: string,
  maxEntries = TEMP_WALK_MAX_ENTRIES,
  maxMs = TEMP_WALK_MAX_MS,
  stat: StatEntry = lstatForMeasure,
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
      if (dir === root && (await isHarnessEntry(root, entry.name, stat))) continue;
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
      if (entry.isFile()) bytes += await allocatedBytes(target, stat);
    }
    if (stopped !== undefined) return { bytes, bound: stopped };
    if (Date.now() - started > maxMs) return { bytes, bound: `duration bound ${maxMs}ms` };
  }
  return { bytes, bound: undefined };
}

/**
 * A top-level temp entry the harness made and removes itself: our name, our uid,
 * and a directory no one but the owner can read — three properties, ALL of them
 * required, because a name alone is a skip a child grants itself. The three are
 * deliberately separate clauses rather than one mask: each is a distinct property
 * the walk refuses to take on trust (what we own, and how wide the door is), and
 * collapsing them into a single bitwise test would let one clause stand in for
 * another. See the header for why mode `0700` is safe to require of every harness
 * tree and why a child cannot use that requirement to hide anything.
 */
async function isHarnessEntry(root: string, name: string, stat: StatEntry): Promise<boolean> {
  if (!HARNESS_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  let st: Stats;
  try {
    st = await stat(path.join(root, name));
  } catch {
    // An entry we cannot stat is not provably a harness tree, so it is not skipped.
    // A shared temp root is another process's to empty, and an entry removed between
    // the readdir and this lstat is that. Measuring it instead costs nothing: it is
    // gone, so `allocatedBytes` yields 0 — whereas throwing here escapes the walk,
    // the guard's `finally`, and the dispatch it was measuring.
    return false;
  }
  if (!st.isDirectory()) return false;
  // Ours: every harness tree is made by this process or one of its children, all
  // of which share its uid, so an entry owned by anyone else cannot be one.
  if (st.uid !== currentUid()) return false;
  // Private: exactly the owner's rwx, with no group or other bit anywhere. Both
  // clauses are needed — the first would accept `0777`-shaped modes read as
  // "executable by the owner", the second alone would accept `0000`.
  if ((st.mode & 0o777) !== 0o700) return false;
  return (st.mode & NON_OWNER_MODE_BITS) === 0;
}

/** The uid the parent runs as — the uid every harness tree is owned by. */
function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
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
  // A failed after-walk with a good baseline says "cannot prove the child left
  // nothing", which is a fact the operator needs — the child's own last act can
  // be to remove or lock the root, and that is the leak-shaped failure this
  // channel exists to catch. One line, no byte figure, and never a zero: the
  // shape mirrors `could not re-read $HOME` in the sibling channel.
  if (!("bytes" in after)) {
    return [
      `operator-config: could not measure the temp directory (${neutraliseEvidence(neutraliseFenceEntry(after.code ?? "unknown"))})`,
    ];
  }
  const delta = after.bytes - baseline.bytes;
  // Negative and below-bar are both silence. The two walks are not an atomic pair,
  // so a third process freeing bytes inside the window can make the delta negative,
  // and a truncated baseline can hand that number the partial-walk tail it would
  // otherwise have to earn. `<= threshold` already refuses every negative; the
  // explicit `delta < 0` is the same answer stated twice, so a later change to the
  // threshold's arithmetic cannot turn a negative into a disclosed figure.
  if (delta < 0 || delta <= TEMP_BYTES_REPORT_THRESHOLD) return [];
  // EITHER walk being bounded makes the delta an underestimate, so either one gets
  // named — and named as itself: a partial baseline under-counts what the child
  // started from and so inflates the delta, a partial after-walk under-counts what
  // it left and so deflates it. One shared word for both told an operator nothing
  // about which direction to distrust the figure in.
  const bound =
    after.bound !== undefined
      ? `partial after-walk: ${after.bound}`
      : baseline.bound !== undefined
        ? `partial baseline: ${baseline.bound}`
        : undefined;
  const tail = bound === undefined ? "" : ` — ${neutraliseEvidence(neutraliseFenceEntry(bound))}`;
  return [
    `temp-bytes: ${delta} (allocated) during the ${neutraliseEvidence(neutraliseFenceEntry(role))} run${tail}`,
  ];
}
