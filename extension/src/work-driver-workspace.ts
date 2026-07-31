/**
 * work-driver-workspace — scratch-dir lifecycle helpers for /work cycles.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Pure
 * filesystem helpers with no DriverContext dependency — used by the
 * commit-pr step body (work-driver-commit.ts) and by runWorkDriver's main
 * loop (work-driver.ts) for setup/teardown around a cycle.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * Project-local scratch directory for ephemeral /work artefacts (diff
 * snapshots between adversarial rounds, captured screenshots, one-off
 * verification scripts, analysis outputs).
 *
 * Background: PR #239 live-tested on lantern issue #553 left 12+ dot-
 * prefixed diff files (`.pr1_r2.diff`, `.regate-1.diff`, etc.) in the
 * repo root, plus PNG screenshots, e2e scenario scripts, a 2.3 GB ELF
 * core dump, and a scratch test_string_error.rs at root. Causes:
 * agents improvised "save diff between rounds" with arbitrary names, and
 * the project's .gitignore didn't anticipate. The next /work's branch
 * step ABORTed correctly ("working tree is not clean") — but PR #239
 * lacked B3 (ABORT detection) so the abort was swallowed.
 *
 * PR2 fold-in: driver creates `<repoRoot>/tmp/issue-<N>/` on cycle
 * start, adds `tmp/` to `.git/info/exclude` (per-clone, NOT a committed
 * `.gitignore` entry — exclusion is local tooling concern, not project
 * shape), and tells every dispatched subagent via its prompt where to
 * write scratch. Convention: this path OR /tmp; never repo root, never
 * tracked dirs unless committing.
 *
 * Cleanup policy: on `merged` (success) the driver removes the dir.
 * On `handoff` or `aborted`, KEPT so the user can inspect what the
 * agents produced when something went wrong.
 */
export function scratchDir(repoRoot: string, issue: number): string {
  return path.join(repoRoot, "tmp", `issue-${issue}`);
}

/**
 * PR10 — Resolve the active-issue list for downstream steps.
 *
 * Precedence: `pipelineState.activeIssues` (the NEEDS_WORK subset
 * populated by runExplore for multi-issue cycles) → `WorkState.issues`
 * (all issues passed to /work, populated by commands.ts) →
 * `[WorkState.issue]` (legacy single-issue path; back-compat with
 * pre-PR10 state files where neither array existed).
 *
 * Every step body that needs to know "which issues are we working on
 * right now" should call this, NOT read `state.issue` directly.
 */
export function activeIssuesOf(state: WorkState): number[] {
  return state.pipelineState.activeIssues ?? state.issues ?? [state.issue];
}

/**
 * Idempotent setup: create `<repoRoot>/tmp/issue-<N>/`, ensure
 * `.git/info/exclude` contains a `/tmp/` line so the tmp tree is hidden
 * from `git status` without touching the committed `.gitignore`.
 *
 * Failure modes return silently with a trace log — the cycle can still
 * proceed; the worst case is agents continuing to write to repo root
 * (the legacy behaviour). This is best-effort hygiene, not a hard gate.
 */
export async function setupWorkspaceTmp(repoRoot: string, issue: number): Promise<string> {
  const dir = scratchDir(repoRoot, issue);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    trace(`work-driver: failed to mkdir scratch dir ${dir}: ${(err as Error).message}`);
  }
  // Add `/tmp/` to .git/info/exclude if absent. The leading slash anchors
  // to repo root (subdir `node_modules/tmp/` would NOT be ignored). The
  // file may not exist on fresh clones; create with the line.
  const excludeFile = path.join(repoRoot, ".git", "info", "exclude");
  try {
    let current = "";
    try {
      current = await fs.readFile(excludeFile, "utf8");
    } catch {
      /* fresh repo or no .git/info dir — handled below */
    }
    if (!/^\/tmp\/?\s*$/m.test(current)) {
      const banner = current.includes("# pi-ensemble")
        ? ""
        : "\n# pi-ensemble: scratch dir for /work cycles (see docs/troubleshooting.md)\n";
      const next = `${current.endsWith("\n") || current.length === 0 ? current : `${current}\n`}${banner}/tmp/\n`;
      // Ensure the parent directory exists; .git/info may be missing on
      // weird clones (e.g., shallow worktrees) but mkdir -p is harmless.
      await fs.mkdir(path.dirname(excludeFile), { recursive: true });
      await fs.writeFile(excludeFile, next, "utf8");
      trace(`work-driver: added /tmp/ to ${excludeFile}`);
    }
  } catch (err) {
    trace(`work-driver: failed to update ${excludeFile}: ${(err as Error).message}`);
  }
  return dir;
}

/**
 * Remove the scratch dir for a finished /work cycle. Called only on
 * `merged` (success) — handoff/aborted preserves it for inspection.
 * Silent on failure (best-effort).
 */
export async function teardownWorkspaceTmp(repoRoot: string, issue: number): Promise<void> {
  const dir = scratchDir(repoRoot, issue);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    trace(`work-driver: removed scratch dir ${dir}`);
  } catch (err) {
    trace(`work-driver: failed to rm scratch dir ${dir}: ${(err as Error).message}`);
  }
}
