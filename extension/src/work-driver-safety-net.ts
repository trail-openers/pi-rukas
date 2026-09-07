/**
 * work-driver-safety-net — #622 mechanical auto-commit safety net.
 *
 * The developer prompt (post-#621) explicitly instructs subagents to
 * `git add` + `git commit` in their worktree, and the verify gate
 * (`work-driver-verify-develop.ts`) requires commits ahead of baseSha.
 * But smaller models can still skip the commit step due to constraint
 * drift over long contexts.
 *
 * This module runs driver-side AFTER all developer dispatches complete
 * but BEFORE the verify gate. It checks each worktree for the specific
 * failure mode the verify gate would reject: uncommitted changes exist
 * but there are zero commits ahead of baseSha. When that condition
 * holds, it stages the porcelain paths (excluding driver artefacts under
 * `.pi/` and `tmp/`) and creates a driver-attributed commit.
 *
 * The safety net NEVER fires when:
 *   - the worktree already has commits ahead of baseSha (AC2), or
 *   - the worktree is clean (AC3), or
 *   - the dispatch failed (the dispatch-failed HALT machinery handles it), or
 *   - `PI_ENSEMBLE_SAFETY_NET_COMMIT=0` is set (AC5).
 *
 * It NEVER throws: any git failure degrades to the pre-safety-net behaviour
 * (the verify gate will produce the same "uncommitted changes but no commit"
 * failure as before). The cycle already has a full failure path for that case.
 *
 * Follows the same pattern as `work-driver-cap-checkpoint.ts` (auto-commit
 * for cap-killed dispatches): porcelain path parsing, scoped staging
 * (skip `.pi/`, `tmp/`), driver-attributed commit message, and `commitSha`
 * recorded on the event so handoff renderers can show what was committed.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

const safetyNetExecp = promisify(exec);

/** #622 — escape hatch: PI_ENSEMBLE_SAFETY_NET_COMMIT=0 disables the safety net. */
function safetyNetEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_SAFETY_NET_COMMIT;
  return v !== "0" && v !== "false";
}

/**
 * #622 — Apply the mechanical auto-commit safety net after all developer
 * dispatches complete.
 *
 * For each worktree, checks:
 *   1. `git status --porcelain` — if empty, skip (AC3: no changes = nothing to commit).
 *   2. `git rev-list --count baseSha..HEAD` — if > 0, skip (AC2: already committed).
 *   3. Otherwise: stage the porcelain paths (excluding `.pi/` and `tmp/`)
 *      and commit with a driver-attributed message.
 *
 * Returns the (possibly updated) WorkState with a `safety-net-commit` event
 * appended for each worktree the safety net fired on. Never throws: a git
 * failure degrades to the pre-safety-net behaviour.
 */
export async function applySafetyNet(ctx: DriverContext, state: WorkState): Promise<WorkState> {
  if (!safetyNetEnabled()) {
    trace("work-driver: safety net disabled (PI_ENSEMBLE_SAFETY_NET_COMMIT=0)");
    return state;
  }

  const worktrees = state.pipelineState.worktrees ?? {};
  const baseSha = state.pipelineState.baseSha;
  const validBaseSha = /^[0-9a-f]{40}$/.test(baseSha ?? "");
  if (!validBaseSha) {
    // No valid baseSha (older state files / ops-dispatch fallback):
    // the verify gate uses the uncommitted-counts behaviour and the
    // safety net has nothing to commit against — skip.
    trace("work-driver: safety net skipped — no valid baseSha");
    return state;
  }

  const events: WorkEvent[] = [];
  const now = Date.now();

  for (const [wsId, cwd] of Object.entries(worktrees)) {
    let dirty: string[] = [];
    let commitAhead = 0;

    // (1) Check if worktree has uncommitted changes.
    try {
      const { stdout } = await safetyNetExecp("git status --porcelain", {
        cwd,
        maxBuffer: 256 * 1024,
      });
      dirty = stdout
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0);
    } catch (err) {
      trace(
        `work-driver: safety net — git status failed in ${cwd}: ${(err as Error).message?.slice(0, 200)}`,
      );
      continue;
    }

    // (AC3) Clean tree → nothing to commit → skip.
    if (dirty.length === 0) {
      trace(`work-driver: safety net skipped ${wsId} — tree clean`);
      continue;
    }

    // (2) Check if worktree already has commits ahead of baseSha.
    try {
      const { stdout } = await safetyNetExecp(`git rev-list --count ${baseSha}..HEAD`, {
        cwd,
        maxBuffer: 64 * 1024,
      });
      commitAhead = Number.parseInt(stdout.trim(), 10) || 0;
    } catch {
      // baseSha may not exist in this worktree's history — not evidence either way.
      // Conservatively treat as 0 commits (fire the safety net if dirty).
    }

    // (AC2) Already has commits ahead of baseSha → developer committed correctly → skip.
    if (commitAhead > 0) {
      trace(
        `work-driver: safety net skipped ${wsId} — already has ${commitAhead} commit(s) ahead of baseSha`,
      );
      continue;
    }

    // Fire the safety net: stage porcelain paths and commit.
    trace(`work-driver: safety net firing for ${wsId} — ${dirty.length} uncommitted path(s)`);
    let commitSha: string | undefined;
    let filesCommitted = 0;

    try {
      for (const line of dirty) {
        const entry = line.slice(3);
        const arrow = entry.indexOf(" -> ");
        const targets = arrow >= 0 ? [entry.slice(0, arrow), entry.slice(arrow + 4)] : [entry];
        for (const t of targets) {
          const clean = t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
          // Skip driver artefacts: .pi/ and tmp/ (same exclusion as cap-checkpoint).
          if (clean.startsWith(".pi/") || clean.startsWith("tmp/")) continue;
          try {
            await safetyNetExecp(`git add -- ${JSON.stringify(clean)}`, {
              cwd,
              maxBuffer: 256 * 1024,
            });
            filesCommitted++;
          } catch (err) {
            trace(
              `work-driver: safety net add failed for ${clean}: ${(err as Error).message?.slice(0, 120)}`,
            );
          }
        }
      }
      // Commit with driver-attributed message so the operator can tell
      // this from a developer's seam commit.
      const commitMsg = `wip: driver safety-net commit for ${wsId}`;
      await safetyNetExecp(`git commit -q --no-verify -m ${JSON.stringify(commitMsg)}`, {
        cwd,
        maxBuffer: 64 * 1024,
      });
      const { stdout: shaOut } = await safetyNetExecp("git rev-parse HEAD", {
        cwd,
        maxBuffer: 64 * 1024,
      });
      commitSha = shaOut.trim();
    } catch (err) {
      trace(
        `work-driver: safety net commit failed for ${wsId}: ${(err as Error).message?.slice(0, 200)}`,
      );
      // The commit failed — the tree is still dirty, nothing was saved.
      // The verify gate will produce the same failure as before the safety net.
      continue;
    }

    if (commitSha) {
      events.push({
        kind: "safety-net-commit",
        at: now,
        workstreamId: wsId,
        worktreePath: cwd,
        commitSha,
        filesCommitted,
      });
      trace(
        `work-driver: safety net committed ${wsId} (${commitSha.slice(0, 8)}) — ${filesCommitted} file(s)`,
      );
    }
  }

  if (events.length === 0) return state;
  return appendEvent(state, ...events);
}
