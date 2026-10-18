/**
 * work-driver-worktree-sweep-owners — the sweep's owner index: read
 * `.pi/work-state/` ONCE and map every worktree path to the cycle whose state
 * file claims it.
 *
 * Split out of `work-driver-worktree-sweep.ts` for the 500-line gate
 * (AGENTS.md §12); that module owns the sweep loop and the decision ladder,
 * this one owns the disk read and the index. `findOwningCycleState` (in
 * `work-driver-worktree-sweep.ts`) and that module's sweep loop are the only
 * consumers. The git-worktree identity gate — the check that actually authorises
 * a purge or a removal — is `resolveSweepTarget`, also in
 * `work-driver-worktree-sweep.ts`; this module applies only the cheaper
 * containment gate (`claimUnderWorktrees`) to paths a state file NAMES, so the
 * two gates are not the same check and must not be described as one.
 *
 * #1454 — the pre-#1454 sweep guessed `.pi/work-state/<worktree-basename>.json`,
 * which never matches (directories are `issue-<N>-<workstream>`, state files
 * are `<N>.json`), so a crashed multi-workstream cycle was never reaped. The
 * authoritative id→path map is `pipelineState.worktrees`, and this index is
 * built from it.
 *
 * Every claimed path is routed through `claimUnderWorktrees` before it enters
 * the index. State files are operator-editable disk data; a `worktrees` map
 * naming the repo root or a path outside `.worktrees/` is a claim the sweep
 * must not honour, because the ladder it feeds ends in `git clean -fdX`. That
 * is the SAME gate the sweep loop applies to every directory it walks — a path
 * only a state file names gets no softer check.
 *
 * r2 — what the code below actually does, in order:
 *   1. read only `^\d+\.json$` files (never `path-claims.json`,
 *      `queue-summary.json`, or `writeSnapshot`'s `*.tmp` scratch);
 *   2. require the current `schemaVersion` and the WorkState shape before the
 *      value is handed to the ladder, recording anything else as `corrupt`;
 *   3. require `pipelineState.worktrees` to be a PLAIN OBJECT whose VALUES are
 *      strings — a nested object or a number would otherwise reach
 *      `resolveSweepTarget` as a claim;
 *   4. resolve each claim and the `.worktrees/` root through the filesystem
 *      (`claimUnderWorktrees`) and require containment on the RESOLVED paths,
 *      so a symlink or a `..` component cannot walk out from under a lexical
 *      prefix check.
 */

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { trace } from "./trace.ts";
import { WORK_STATE_SCHEMA_VERSION, type WorkState } from "./workflow-state.ts";

/** A state file's path claim, resolved against the sweep's own validation. */
interface OwnerEntry {
  state: WorkState;
}

/** worktree path → the cycle whose state file claims it. */
export interface OwnerIndex {
  byPath: Map<string, OwnerEntry>;
  /** State files that failed to parse or failed the shape check. */
  corrupt: string[];
}

/** Only numeric state files. Excludes path-claims.json, queue-summary.json, *.tmp. */
const STATE_FILE_NAME = /^\d+\.json$/;

/**
 * Read `.pi/work-state/` once and index every worktree path any cycle claims.
 *
 * Three filters the bare `*.json` read did not have:
 *
 *  - **Filename** is `^\d+\.json$`. The directory also holds `path-claims.json`
 *    (the claim registry), `queue-summary.json` (the multi-cycle index) and
 *    `*.tmp` write scratch from `writeSnapshot`. Reading them as candidate
 *    state files meant parsing other subsystems' data and shape-guessing at
 *    it; a hand-edited or half-written one of those could name a worktree.
 *  - **Shape** is checked (`schemaVersion` equal to the CURRENT version,
 *    `pipelineState` a plain object, `eventLog` an array) before the value is
 *    used. A file that parses but is not a current WorkState would otherwise
 *    reach `decideSweepAction`, which reads `state.eventLog.filter` and
 *    `state.pipelineState.mergeHold` and would throw on a shape it was never
 *    handed.
 *  - **Corruption is traced**, not swallowed. A silently-skipped state file
 *    is indistinguishable from a cycle that never existed, which is how this
 *    sweep previously lost a zombie: the operator had no signal that the reap
 *    was declined because a state file would not parse.
 */
export function buildOwnerIndex(repoRoot: string): OwnerIndex {
  const byPath = new Map<string, OwnerEntry>();
  const corrupt: string[] = [];
  const dir = join(repoRoot, ".pi", "work-state");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (err) {
    trace(`worktree-sweep: could not read ${dir}: ${err}`);
    return { byPath, corrupt };
  }
  for (const f of files) {
    if (!STATE_FILE_NAME.test(f)) continue;
    const file = join(dir, f);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      trace(`worktree-sweep: ${file} is not readable JSON — skipped: ${err}`);
      corrupt.push(f);
      continue;
    }
    if (!looksLikeWorkState(parsed)) {
      trace(`worktree-sweep: ${file} is not a current WorkState shape — skipped`);
      corrupt.push(f);
      continue;
    }
    const state = parsed as WorkState;
    if (state.issue !== Number(f.slice(0, -".json".length))) {
      trace(
        `worktree-sweep: ${file} names issue ${state.issue}, expected ${f.slice(0, -".json".length)} — skipped`,
      );
      corrupt.push(f);
      continue;
    }
    const claims: string[] = claimedWorktreePaths(state);
    // #861 — `integrateWorktree` is the one worktree path the driver records
    // OUTSIDE the `worktrees` map (`work-driver-commit-fallback.ts` writes it,
    // `work-driver-commit-pr-audit.ts` clears it). It lives under `.worktrees/`
    // like any other tree, so it is exactly as sweepable, and until now it was
    // the only state-file path the owner index never saw: a tree left behind by
    // a crashed commit-pr step was invisible to the reap by construction, and
    // the teardown loop — which does read it — applied the containment gate
    // while the sweep did not. Indexing it here puts both loops behind one gate.
    const integrate = (state.pipelineState as { integrateWorktree?: unknown }).integrateWorktree;
    if (typeof integrate === "string" && integrate.length > 0) claims.push(integrate);
    for (const claimed of claims) {
      // Containment gate: a claim must resolve under `.worktrees/`. This is the
      // security-relevant check (a state file cannot name the repo root or an
      // arbitrary path and have the sweep `git clean` it). It resolves through
      // the filesystem so a symlink cannot smuggle an outside path past a
      // textual prefix test; a claim whose path does not exist yet is compared
      // lexically so a since-removed tree still indexes and can be reaped.
      // The full git-worktree validation stays at the action site, where
      // resolveSweepTarget runs before every purge/remove.
      const target = claimUnderWorktrees(repoRoot, claimed);
      if (target === null) {
        trace(
          `worktree-sweep: #${state.issue} claims a worktree path outside .worktrees/: ${claimed}`,
        );
        continue;
      }
      if (!byPath.has(target)) byPath.set(target, { state });
    }
  }
  return { byPath, corrupt };
}

/**
 * The paths a state file claims, or `[]` when `pipelineState.worktrees` is not
 * a plain object of strings.
 *
 * r2 — `worktrees` is typed `Record<string, string>` but a state file is
 * operator-editable JSON, and the previous code did `Object.values(... ?? {})`
 * and then re-checked `typeof === "string"`, which meant a state file carrying
 * `worktrees: "all"` or `worktrees: ["/etc"]` threw inside the index build —
 * on the launch path, before any sweep decision was made.
 */
function claimedWorktreePaths(state: WorkState): string[] {
  const worktrees: unknown = (state.pipelineState as { worktrees?: unknown }).worktrees;
  if (!isPlainObject(worktrees)) return [];
  const paths: string[] = [];
  for (const claimed of Object.values(worktrees)) {
    if (typeof claimed === "string" && claimed.length > 0) paths.push(claimed);
  }
  return paths;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve a state-file claim to an absolute path iff it sits under
 * `<repoRoot>/.worktrees/`. Returns null for anything else (repo root, a plain
 * file, a `..` escape, or anything that reaches `.worktrees/` only through a
 * symlink).
 *
 * r2 — the check is on RESOLVED paths, not lexical ones. `resolve()` only
 * collapses `.`/`..` textually, so `foo/../../.worktrees/x` and a symlink at
 * `.worktrees/x -> /elsewhere` both passed a prefix test while pointing
 * somewhere the sweep has no business cleaning. `realpath()` follows links,
 * and a path that does not exist is resolved through its deepest existing
 * ancestor so a since-removed (but still claimed) tree is compared honestly
 * rather than dropped.
 */
export function claimUnderWorktrees(repoRoot: string, claimed: string): string | null {
  const worktreesDir = realpathOrAncestor(resolve(repoRoot, ".worktrees"));
  const resolved = realpathOrAncestor(resolve(claimed));
  if (resolved === null || worktreesDir === null) return null;
  if (resolved === worktreesDir || !resolved.startsWith(`${worktreesDir}/`)) return null;
  return resolved;
}

/**
 * realpath, falling back to the deepest existing ancestor when the final
 * components do not exist (ENOENT). A missing leaf is normal for the sweep —
 * it is often asked about a tree a crash already removed — so it is resolved
 * as far as the filesystem can answer rather than treated as an error.
 */
function realpathOrAncestor(candidate: string): string | null {
  let current = candidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...suffix.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = current.substring(0, current.lastIndexOf("/"));
      const leaf = current.substring(current.lastIndexOf("/") + 1);
      // Root itself is gone, or nothing left to walk up to.
      if (parent === current || leaf === "") return null;
      suffix.push(leaf);
      current = parent;
    }
  }
}

/**
 * The minimum a parsed object must look like before `decideSweepAction` is
 * handed it. Deliberately shallow — deep validation is `workflow-state.ts`'s
 * job at the driver boundary; here the question is only "can the ladder read
 * this without throwing".
 *
 * r2 — `schemaVersion` must EQUAL the current constant, not merely be a
 * number. A v2 file written by a newer install would previously index and then
 * feed whatever `pipelineState`/`eventLog` happen to look right to the ladder,
 * which ends in `git clean -fdX`. An unknown version is `corrupt`, never a
 * crash and never an action.
 */
function looksLikeWorkState(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object") return false;
  const rec = parsed as Record<string, unknown>;
  return (
    rec.schemaVersion === WORK_STATE_SCHEMA_VERSION &&
    isPlainObject(rec.pipelineState) &&
    Array.isArray(rec.eventLog)
  );
}
