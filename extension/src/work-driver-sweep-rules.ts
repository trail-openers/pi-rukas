/**
 * work-driver-sweep-rules — worktree-name and dependency-preservation guards.
 *
 * Split out of `work-driver-worktree-sweep.ts` for the §12 500-line cap, at the
 * seam that already matters: the sweep is a pure set of rules over a worktree's
 * name and its state file, and then an IO half that turns a rule's verdict into
 * a `git` command. Everything here inspects and never executes, so the two live
 * tree-loss guards #1265 added — group ownership and dependency preservation.
 * The decision ladder and executor live in `work-driver-sweep-policy.ts`.
 */

import { type Stats, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { WorkState } from "./workflow-state.ts";
import { DEPENDENCY_MARKERS } from "./worktree-provision-hook.ts";
import { SHAREABLE_DEPS } from "./worktree-provision.ts";

/**
 * The issue a worktree directory name encodes, or undefined when it does not
 * name a driver worktree at all.
 *
 * #1265 — this lookup was the whole bug. The sweep used to read
 * `.pi/work-state/<basename>.json`, but a basename is `issue-<N>-<id>`
 * (`work-driver-branch-mechanized.ts`; `issues-<N>-<M>-<id>` for a grouped
 * cycle, `issue-<N>-integrate` for the driver-owned tree) while a state file is
 * `<N>.json` (`workflow-state.ts` `workStateFile`). No worktree has ever been
 * named like a state file, so EVERY candidate fell through to
 * `state-unreadable` and the decision engine below Rules 1–2 never ran: a
 * killed cycle's leftovers accumulated forever, holding branches that the next
 * cycle then tripped over. The one test only exercised `enabled: false`, so the
 * sweep was dark in production and dark in the suite at the same time.
 *
 * The FIRST number is the primary issue — the key of the state file, which
 * `claimCycle` keys on every issue in the group anyway. A grouped cycle, though,
 * names a tree by its PRIMARY (`issues-<N>-<M>-<id>`), so a pure name comparison
 * protects only one workstream of a live group; `groupClaimedByState` covers the
 * rest. Leading zeros are rejected rather than folded: the driver formats
 * `issue-${n}-…` from a parsed decimal, so `issue-007-default` is a hand-made
 * tree, and a hand-made tree gets a skip, never a guess.
 */
export function parseWorktreeIssue(name: string): number | undefined {
  const m = /^(?:issue|issues)-(\d+)-/.exec(name);
  if (!m) return undefined;
  const digits = m[1];
  if (!digits || digits.length > 15 || (digits.length > 1 && digits.startsWith("0"))) {
    return undefined;
  }
  const issue = Number(digits);
  return Number.isSafeInteger(issue) && issue > 0 ? issue : undefined;
}

/**
 * Whether a worktree directory belongs to the cycle that launched this sweep.
 *
 * #1265 — the guard compared the basename against `${issue}-default`, a string
 * no directory is ever named (the prefix is missing, so it never matched and
 * the launching cycle's own tree was swept like anyone else's). A tree the
 * launching cycle is about to reuse is not a leftover; removing or purging it
 * out from under the cycle that just claimed the issue destroys in-progress
 * work. The rule is therefore the basename's issue, not a name pattern: the
 * same issue the state file is keyed on.
 */
export function isLaunchingCycleOwnWorktree(name: string, launchingCycleIssue: number): boolean {
  return parseWorktreeIssue(name) === launchingCycleIssue;
}

/** The subset of a state file the group-claim rule reads. */
export type StateClaim = Pick<WorkState, "issue" | "issues"> & {
  pipelineState: { status: string };
};

/**
 * Whether a RUNNING state file claims a worktree's issue — primary **or**
 * secondary — and therefore whether the tree belongs to a cycle that has not
 * reached a terminal status.
 *
 * Takes the worktree NAME and does its own parsing: a name that encodes no
 * issue encodes no claim either, so it answers `false` rather than comparing
 * against a sentinel a caller had to invent.
 *
 * #1265 round 1 — two loss paths the owner/liveCycles guards do not cover, both
 * reachable the moment the sweep stops being dark:
 *
 *  - A grouped cycle launched as #10 writes one state file, `10.json`, carrying
 *    `issues: [10, 11]`, and names EVERY workstream tree by the primary —
 *    `issues-10-11-task-b`. A pure-name self-guard cannot see 11, and the state
 *    file's own `issue` is 10, so `liveCycles.has(state.issue)` never fires for
 *    the sibling either. Before this rule the running group's second workstream
 *    was purged.
 *  - `owner` is OPTIONAL (`workflow-state-schema-workstate.ts`) and is written
 *    only by `markDispatchStarted`. A file persisted at a step boundary before
 *    the first dispatch has none, so Rule 3a has nothing to test. `liveCycles`
 *    is an in-process set that a sibling Pi process is structurally not in.
 *
 * Gated on `status === "running"`: a terminal file's `issues` is a historical
 * record, not a claim, so this never blocks the reclamation #1265 is for.
 * Measured on the 32 state files on this host, 29 carry `status: handoff` or
 * `merged`; 2 are `running`. So this guard skips the two live trees and the
 * sweep still removes the dead ones.
 */
export function groupClaimedByState(state: StateClaim, worktreeName: string): boolean {
  if (state.pipelineState.status !== "running") return false;
  const worktreeIssue = parseWorktreeIssue(worktreeName);
  if (worktreeIssue === undefined) return false;
  return state.issue === worktreeIssue || (state.issues?.includes(worktreeIssue) ?? false);
}

/**
 * The dependency locations `worktree-provision.ts` links into every worktree:
 * that module's `SHAREABLE_DEPS`, read rather than restated. A copy of the
 * names here would silently stop suppressing the purge the day the provisioner
 * links one more (or one fewer) directory, and the copy would keep passing.
 */
export const PROVISIONED_DEP_NAMES: readonly string[] = SHAREABLE_DEPS;

/**
 * The same list under the name the provisioner uses. The guard below reads this
 * one so "what counts as a dependency location" is spelled once in this module.
 */
const DEP_NAMES = PROVISIONED_DEP_NAMES;

/**
 * The marker files that make a depth-1 directory "a package", i.e. a place the
 * provisioner looks for a nested `node_modules`.
 *
 * THIS IS `worktree-provision-hook.ts`'s `DEPENDENCY_MARKERS`, imported rather
 * than restated: the sweep's dependency guard must look in exactly the places
 * provisioning links from, and a private copy would silently narrow what the
 * sweep protects the day the provisioner learns a new ecosystem. `hasReal
 * DependencyTree` cannot call the provisioner's own `packageDirsAt` — it is
 * async (`fs/promises.access`) while this guard runs sync inside
 * `executeSweepAction` — so it takes the list and does its own `existsSync`
 * pass. Pinned by a rules-test assertion.
 */
export const PACKAGE_DIR_MARKERS = DEPENDENCY_MARKERS;

/**
 * Whether one dependency location holds a REAL (non-symlink) directory.
 *
 * The symlink test is on the `lstat` result. The previous shape called
 * `isSymbolicLink()` on the stat a filesystem had already followed, which is
 * `false` for every input: a symlink was read as a real tree, and a DANGLING
 * one made `isDirectory()` false as well — so the broken link became the one
 * case the guard wrongly protected, and the real install became the case it
 * stopped protecting. Both are fixed by asking `lstat` and nothing else.
 */
function realDependencyDir(abs: string): boolean {
  let stat: Stats;
  try {
    stat = lstatSync(abs);
  } catch {
    // A location that cannot be looked at is not evidence of a tree; the
    // unreadable-WHOLE-TREE case is handled by the caller, which returns true.
    return false;
  }
  if (stat.isSymbolicLink()) return false;
  // An unresolvable link target is not a tree to protect either: `git clean`
  // costs nothing to drop it, and the next provision re-makes it.
  try {
    if (realpathSync(abs) !== abs) return false;
  } catch {
    return false;
  }
  return stat.isDirectory();
}

/**
 * Whether one worktree holds a dependency directory the provisioner would have
 * linked: any `SHAREABLE_DEPS` location at the root, or `node_modules` in a
 * depth-1 package directory (the same `candidatesForDir` rule the provisioner
 * applies — only Node keeps its tree in a package dir).
 *
 * Sync, and deliberately so: `executeSweepAction` calls this in a tight loop
 * over every candidate tree, and the provisioner's own discovery
 * (`packageDirsAt`) is async. The marker list above is pinned equal to the
 * provisioner's by a rules-test assertion, so the two cannot drift silently.
 *
 * An unreadable directory is never evidence of a tree; the caller has already
 * answered the unreadable-WHOLE-TREE case by returning true.
 */
function hasLinkableDependencyDir(worktreePath: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(worktreePath);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (DEP_NAMES.includes(entry) && realDependencyDir(join(worktreePath, entry))) {
      return true;
    }
    // Depth-1 package dirs: only `node_modules` counts there, and only in a
    // directory that carries a package marker.
    if (entry.startsWith(".") || entry === "node_modules" || entry === ".worktrees") continue;
    if (!hasPackageMarker(join(worktreePath, entry))) continue;
    if (realDependencyDir(join(worktreePath, entry, "node_modules"))) return true;
  }
  return false;
}

/** Does this directory carry one of the package markers? */
function hasPackageMarker(dir: string): boolean {
  for (const marker of PACKAGE_DIR_MARKERS) {
    if (existsSync(join(dir, marker))) return true;
  }
  return false;
}

/**
 * Whether a worktree holds a provisioned dependency tree worth keeping —
 * `node_modules` / `.venv` / `vendor` present as a REAL directory rather than a
 * symlink. `worktree-provision.ts` *links* these into every worktree, and the
 * driver's own `.pi/worktree-setup` hook may `bun install` / `uv sync` one in.
 *
 * #1265 round 1 — `git clean -fdX` removes exactly the *ignored* files, which is
 * precisely those provisioned trees. When they are symlinks (or absent) the
 * removal is free: it drops a link or nothing, and the next provision re-makes
 * it. When one is a real per-checkout install it destroys a dependency tree,
 * which on a Rust/Node repo is the 30-60 minute rebuild the reviewer measured.
 * So the expensive shape — a real dependency directory — is the ONLY one that
 * suppresses the artifact purge; a tree with no provisioned deps still cleans
 * normally, and a symlink still does. A tree that cannot be read is treated as
 * worth keeping, because the safe default is not to clean.
 *
 * The scan covers the depth-1 package directories as well as the root, because
 * that is where a nested-package monorepo keeps its trees — pi-rukas's own real
 * `node_modules` lives at `extension/node_modules`, and a root-only scan read
 * that tree's absence as "nothing worth keeping". Same marker set and the same
 * per-directory candidate rule the provisioner applies.
 */
export function hasRealDependencyTree(worktreePath: string): boolean {
  try {
    readdirSync(worktreePath);
  } catch {
    // A tree that cannot be read is treated as worth keeping: the safe default
    // is not to clean.
    return true;
  }
  return hasLinkableDependencyDir(worktreePath);
}
