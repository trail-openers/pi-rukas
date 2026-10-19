/**
 * work-driver-verify-develop-protected — the develop step's protected-path
 * gate (#406), extracted from `work-driver-verify-develop.ts`.
 *
 * Why this seam: `verifyDevelopOutcome` had grown to 510 lines, past the
 * 500-line cap AGENTS.md §12 enforces. This file already follows a per-gate
 * extraction pattern — the falsily-green check lives in
 * `work-driver-falsily-green.ts` (#679), the scope/fanout gate in
 * `work-driver-scope-fanout.ts` (#285), the skip-ratchet and smoke gates in
 * `work-driver-verify-develop-gates.ts` (#451) — and the protected-path gate
 * is the same shape: one self-contained check over the diff's path set,
 * reading six values and writing only into the caller's `failures` and `notes`
 * arrays. No control flow crosses the boundary, so the extraction is a move,
 * not a rewrite: the jsdoc and every inline comment travel with the code.
 *
 * What the gate is: a cycle must not edit the files that decide whether its
 * own work passes. Policy prose (AGENTS.md, CLAUDE.md) is deliberately NOT
 * halted here — it is neutralised instead, by reading doctrine at baseSha in
 * the merge gate — so that this repo's own "docs ship with the PR" rule keeps
 * working.
 *
 * Import chain: work-driver-verify-develop.ts → this file →
 * work-driver-doctrine.ts + work-driver-protected-grant.ts (acyclic; the same
 * two modules the caller already imports, so extraction moves no dependency
 * edge). This file does NOT import work-driver-verify-develop.ts.
 */

import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type ExecFn, errText, isValidBaseSha, runGit } from "./work-develop-git.ts";
import type { CycleContext } from "./work-driver-context.ts";
import {
  doctrineProsePathsIn,
  explainProtectedPaths,
  protectedPathsIn,
} from "./work-driver-doctrine.ts";
import { ungrantedProtectedPaths } from "./work-driver-protected-grant.ts";
import type { PipelineState, WorkState } from "./workflow-state-schema.ts";

/**
 * #1676 backstop — discard an edit a developer made to a DEFERRED protected path.
 *
 * The plan fences a deferred path out of every workstream (`withDeferredProtectedFence`),
 * so an edit is a developer ignoring the fence. Rather than halting the cycle
 * after the whole develop spend, each worktree's edit to such a path is reverted
 * to base content (or removed when absent at base), and a revert commit is made
 * when the edit had been committed. Runs BEFORE the develop loop reads status and
 * diff, so the reverted path never reaches the uncommitted-only, scope or
 * protected-path checks. Any other ungranted protected path still halts in
 * `runProtectedPathGate`. A failed revert is a failure, never a silent pass.
 *
 * Only ungranted deferred paths are touched; the operator grant is honoured as
 * everywhere else. A worktree with no usable base is skipped, and the gate then
 * halts on any edit it still contains.
 */
export async function discardDeferred(
  protectedGateOn: boolean,
  execFn: ExecFn,
  worktrees: Record<string, string>,
  state: WorkState,
  ctx: CycleContext,
  failures: string[],
  notes: string[],
): Promise<void> {
  if (!protectedGateOn) return;
  const ps = state.pipelineState;
  const ungranted = ungrantedProtectedPaths(ps.deferredProtected ?? [], ctx.protectedGrant);
  if (ungranted.length === 0) return;
  const git = runGit(execFn);
  for (const [id, cwd] of Object.entries(worktrees)) {
    const base = baseForWorkstream(ps, id);
    if (!isValidBaseSha(base)) continue;
    for (const p of ungranted) {
      try {
        if (await discardOne(git, cwd, base, p)) {
          notes.push(
            `discarded an edit to deferred protected path "${p}" in workstream "${id}" — the plan fenced it out and it needs an operator grant (--allow-protected) to ship`,
          );
        }
      } catch (err) {
        failures.push(
          `could not discard the edit to deferred protected path "${p}" in worktree "${id}" (${cwd}): ${errText(err)}`,
        );
      }
    }
  }
}

/** The workstream's effective base, as the develop loop resolves it (#679). */
function baseForWorkstream(ps: PipelineState, id: string): string | undefined {
  const per = ps.workstreamBaseShas?.[id];
  if (isValidBaseSha(per)) return per;
  return isValidBaseSha(ps.baseSha) ? ps.baseSha : undefined;
}

/** Revert one deferred path in one worktree. Returns true when it was edited. */
async function discardOne(
  git: ReturnType<typeof runGit>,
  cwd: string,
  base: string,
  p: string,
): Promise<boolean> {
  if (isAbsolute(p) || p.split("/").includes("..")) {
    throw new Error(`refusing to restore an unsafe path "${p}"`);
  }
  const committed =
    (
      await git(["--literal-pathspecs", "diff", "--name-only", base, "HEAD", "--", p], {
        cwd,
      })
    ).stdout.trim().length > 0;
  const dirty =
    (
      await git(
        ["--literal-pathspecs", "status", "--porcelain", "--untracked-files=all", "--", p],
        { cwd },
      )
    ).stdout.trim().length > 0;
  if (!committed && !dirty) return false;
  const atBase =
    (await git(["ls-tree", "--name-only", base, "--", p], { cwd })).stdout.trim().length > 0;
  if (atBase) {
    await git(["--literal-pathspecs", "checkout", base, "--", p], { cwd });
  } else {
    await git(["--literal-pathspecs", "rm", "-r", "-f", "--ignore-unmatch", "-q", "--", p], {
      cwd,
    });
    await rm(join(cwd, p), { force: true, recursive: true });
  }
  if (committed) {
    await git(
      [
        "--literal-pathspecs",
        "commit",
        "-m",
        `fix(work): discard edit to deferred protected path ${p}`,
        "--",
        p,
      ],
      { cwd },
    );
  }
  return true;
}

/**
 * Run the protected-path gate over the develop step's changed paths.
 *
 * @param protectedGateOn `PI_ENSEMBLE_PROTECTED_PATHS` is not `0`; the caller
 *   reads the knob (it also decides whether the path sets are computed at all).
 * @param touchedPaths Paths the workstreams changed.
 * @param protectedOnlyPaths Rename SOURCES — paths that vanished rather than
 *   changed, which the plain touched-set does not carry (#1378).
 * @param protectedGrant The operator's per-cycle `--allow-protected` grant.
 *   Read from the invocation context only, NEVER the state file (#1090): a
 *   cycle that could write its own grant would grant itself.
 * @param issues Every issue in the group, so the explanation names all of them.
 * @returns The ungranted protected paths the gate failed on: the scope gate
 *   must not repeat a failure for any of them (#1676). Empty when none, or off.
 */
export function runProtectedPathGate(args: {
  protectedGateOn: boolean;
  touchedPaths: string[];
  protectedOnlyPaths: string[];
  protectedGrant: readonly string[] | undefined;
  issues: number[];
  failures: string[];
  notes: string[];
}): string[] {
  const {
    protectedGateOn,
    touchedPaths,
    protectedOnlyPaths,
    protectedGrant,
    issues,
    failures,
    notes,
  } = args;
  if (!protectedGateOn) {
    notes.push("PI_ENSEMBLE_PROTECTED_PATHS=0 — protected-path gate disabled");
    return [];
  }
  // #1378 — the union carries the rename sources; the #285/#1012/#679 gates in
  // the caller consumed `touchedPaths` alone and are byte-identical to before
  // this extraction.
  const protectedHits = protectedPathsIn([...touchedPaths, ...protectedOnlyPaths]);
  // #1090 — only the operator's invocation grant, never the state file.
  const ungranted = ungrantedProtectedPaths(protectedHits, protectedGrant);
  if (ungranted.length > 0) {
    failures.push(explainProtectedPaths(ungranted, protectedHits, issues));
  }
  const granted = protectedHits.filter((p) => !ungranted.includes(p));
  if (granted.length > 0) {
    notes.push(`operator grant (--allow-protected) admitted ${granted.join(", ")}`);
  }
  const prose = doctrineProsePathsIn([...touchedPaths, ...protectedOnlyPaths]);
  if (prose.length > 0) {
    notes.push(
      `develop changed policy prose (${prose.join(", ")}) — allowed, and inert for this cycle: merge authority is read at the base commit, so a grant added here cannot take effect until an operator merges it`,
    );
  }
  return ungranted;
}
