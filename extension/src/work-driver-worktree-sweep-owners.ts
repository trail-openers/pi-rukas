/**
 * work-driver-worktree-sweep-owners — the sweep's owner index: read
 * `.pi/work-state/` ONCE and map every worktree path to the cycle whose state
 * file claims it.
 *
 * Split out of `work-driver-worktree-sweep.ts` for the 500-line gate
 * (AGENTS.md §12); that module owns the sweep loop and the decision ladder,
 * this one owns the disk read and the index. `findOwningCycleState` and the
 * sweep loop are the only consumers.
 *
 * #1454 — the pre-#1454 sweep guessed `.pi/work-state/<worktree-basename>.json`,
 * which never matches (directories are `issue-<N>-<workstream>`, state files
 * are `<N>.json`), so a crashed multi-workstream cycle was never reaped. The
 * authoritative id→path map is `pipelineState.worktrees`, and this index is
 * built from it.
 *
 * Every claimed path is routed through `resolveSweepTarget` before it enters
 * the index. State files are operator-editable disk data; a `worktrees` map
 * naming the repo root or a path outside `.worktrees/` is a claim the sweep
 * must not honour, because the ladder it feeds ends in `git clean -fdX`. That
 * is the SAME gate the sweep loop applies to every directory it walks — a path
 * only a state file names gets no softer check.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { trace } from "./trace.ts";
import type { WorkState } from "./workflow-state.ts";

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
 *  - **Shape** is checked (`schemaVersion` a number, `pipelineState` an
 *    object, `eventLog` an array) before the value is used. A file that
 *    parses but is not a WorkState would otherwise reach `decideSweepAction`,
 *    which reads `state.eventLog.filter` and `state.pipelineState.mergeHold`
 *    and would throw on a shape it was never handed.
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
      trace(`worktree-sweep: ${file} is not a WorkState shape — skipped`);
      corrupt.push(f);
      continue;
    }
    const state = parsed as WorkState;
    for (const claimed of Object.values(state.pipelineState.worktrees ?? {})) {
      if (typeof claimed !== "string" || claimed.length === 0) continue;
      // Containment gate: a claim must resolve under `.worktrees/`. This is the
      // security-relevant check (a state file cannot name the repo root or an
      // arbitrary path and have the sweep `git clean` it), and it is I/O-free —
      // so a tree that is temporarily absent still indexes and can be reaped.
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
 * Resolve a state-file claim to an absolute path iff it sits under
 * `<repoRoot>/.worktrees/`. Returns null for anything else (repo root, a plain
 * file, a `..` escape). Normalises without touching the filesystem so an
 * absent-but-claimed tree still indexes — the sweep's own resolveSweepTarget is
 * what refuses to *act* on a path that is not a real worktree.
 */
export function claimUnderWorktrees(repoRoot: string, claimed: string): string | null {
  const worktreesDir = resolve(repoRoot, ".worktrees");
  const resolved = resolve(claimed);
  if (resolved === worktreesDir || !resolved.startsWith(`${worktreesDir}/`)) return null;
  return resolved;
}

/**
 * The minimum a parsed object must look like before `decideSweepAction` is
 * handed it. Deliberately shallow — deep validation is `workflow-state.ts`'s
 * job at the driver boundary; here the question is only "can the ladder read
 * this without throwing".
 */
function looksLikeWorkState(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object") return false;
  const rec = parsed as Record<string, unknown>;
  return (
    typeof rec.schemaVersion === "number" &&
    rec.pipelineState !== null &&
    typeof rec.pipelineState === "object" &&
    Array.isArray(rec.eventLog)
  );
}
