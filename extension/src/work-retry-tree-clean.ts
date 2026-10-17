/**
 * work-retry-tree-clean — #1391: make a worktree clean for the retry of a step
 * whose child was LOST, and say what the lost attempt left behind.
 *
 * When a step child dies mid-flight the driver re-runs the step by dispatching
 * a brand-new child into the SAME worktree. Nothing had committed, stashed or
 * discarded what the severed child left there, so the retry's own precondition
 * was defeated by the failure it was retrying after. Observed on tehas cycle
 * 109: the round-2 lens-fix developer died at 01:56:00, the driver classified
 * it `provider-severed` and re-ran the step, and the new attempt met the dead
 * attempt's tree — `lens-fix-reposition: worktree has uncommitted changes: M
 * DESIGN.md, …` — so the cycle parked with `cap: lens-fix-reposition`,
 * `capReason: dirty: worktree has uncommitted changes: …`, and a third review
 * round that lasted one second. The half-written work survived only as a
 * handoff diff someone had exported by hand.
 *
 * Three rules, in this order, and the first one that fires ends the call:
 *
 *  1. **A step the cycle itself owns resets to its own base.** `develop` and
 *     `lens-fix` each have one tree and a 40-hex base that was recorded when
 *     the worktree was made. That tree's uncommitted work is saved as a patch
 *     first (the same save the #1016 retry reset performs) and only then
 *     discarded, so the retry starts clean and the work still exists on disk.
 *     Refusing beats discarding: a save that fails, a base that is not a SHA,
 *     or commits ahead of the base leaves the tree exactly as it was and says
 *     so.
 *  2. **Any other tree is preserved, never reset.** A worktree with unknown
 *     provenance gets a salvage copy and an in-scope read — the driver does not
 *     decide the fate of work whose base it cannot name. That is the
 *     preserve-then-clean seam's job, not this one's.
 *  3. **A clean tree is a no-op.** This runs on the retry path of every
 *     retryable step; the overwhelmingly common case is nothing to do.
 *
 * The whole seam is **best-effort in one direction only**: it never fails a
 * retry. A tree it could not read is reported, not fatal — the step re-runs
 * anyway, and the retry's own gate (the lens-fix reposition guard, the develop
 * commit rule) remains the thing that decides whether the base is trustworthy.
 * What is NOT best-effort is the account: `cleanAttemptLine` names every file
 * that was there, which is the half of the incident the operator could not
 * reconstruct afterwards.
 */

import { execp } from "./exec.ts";
import {
  type ExecFn,
  assertInsideWorktrees,
  commitsAheadOfBase,
  errText,
  isValidBaseSha,
  nextRetryAttempt,
  resetWorktreeToBase,
  retryPatchPath,
  runGit,
  workEntriesOf,
  worktreeStatus,
} from "./work-develop-git.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { WorkStep } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state-schema.ts";
import { salvageUncommittedWork } from "./worktree-salvage.ts";

/** The steps whose worktree the cycle created at a recorded base, owns outright,
 *  and may therefore reset. Every other step's tree is preserved only. */
const STEPS_WITH_OWNED_TREE: ReadonlySet<WorkStep> = new Set<WorkStep>(["develop", "lens-fix"]);

/** How the clean went. `files` is what was on disk BEFORE anything was touched,
 *  on every kind — a refusal that left a dirty tree intact still has to say
 *  what is sitting there. */
export interface RetryTreeClean {
  /** Nothing was there to clean, or nothing was touched (a refusal). */
  changed: boolean;
  /** True when the worktree could not be read at all. Non-fatal by design. */
  unreadable: boolean;
  /** Work paths found before the clean. Driver artefacts (`.pi/`, `tmp/`) excluded,
   *  which is exactly the set the reset spares — so the line and the action agree. */
  files: string[];
  /** The saved patch when work was saved; undefined when nothing was saved. */
  patch?: string;
  /** Why nothing was reset (an unreadable tree, a refused save, unknown provenance). */
  why?: string;
}

const NOTHING: RetryTreeClean = { changed: false, unreadable: false, files: [] };

/** Rule 2 of the module header: a tree whose base the driver cannot name is
 *  copied, never reset. The decision stays with the retry's own gate. */
async function preserveUnownedTree(
  execFn: ExecFn,
  args: { repoRoot: string; issue: number },
  tree: string,
  work: string[],
): Promise<RetryTreeClean> {
  const salvageDir = await salvageUncommittedWork(
    execFn,
    tree,
    scratchDir(args.repoRoot, args.issue),
  ).catch(() => undefined);
  return {
    changed: false,
    unreadable: false,
    files: work,
    why:
      salvageDir === undefined
        ? "no 40-hex base recorded, so nothing was discarded; the salvage copy failed too"
        : `no 40-hex base recorded, so nothing was discarded; ${work.length} file(s) copied to ${salvageDir}`,
  };
}

/** The retry's tree for a step, or undefined when the step has no worktree of
 *  its own (every pre-worktree state falls back to `repoRoot`, which the driver
 *  never resets). `lens-fix` consolidates every workstream into ONE tree, so it
 *  resolves through the same rule the review and the fix dispatch both use —
 *  a retry that cleaned a different tree than the one it dispatched into would
 *  be a no-op with a confident message. */
export function retryTargetTree(
  ctx: { repoRoot: string },
  state: WorkState,
  step: WorkStep,
): string | undefined {
  if (step !== "develop" && step !== "lens-fix") return undefined;
  const wts = state.pipelineState.worktrees ?? {};
  const id = step === "develop" ? "default" : undefined;
  const tree = id !== undefined ? wts[id] : (wts.default ?? wts[Object.keys(wts)[0] ?? ""]);
  if (!tree || tree === ctx.repoRoot) return undefined;
  return tree;
}

/** The base the tree was created from. `lens-fix` holds consolidated work, so
 *  its base is the branch tip, not the cycle base — resetting it would discard
 *  the work the review just read. It therefore has no base this seam may use,
 *  which puts it on rule 2 (preserve, never reset). */
function baseForTree(state: WorkState, step: WorkStep): string | undefined {
  if (step !== "develop") return undefined;
  const perWorkstream = state.pipelineState.workstreamBaseShas;
  const entry = perWorkstream?.default;
  const candidate = (typeof entry === "string" ? entry : undefined) ?? state.pipelineState.baseSha;
  return isValidBaseSha(candidate) ? candidate : undefined;
}

/**
 * Make the retry's worktree clean, best-effort. Never throws and never fails
 * the retry — every failure is a `why` on the result.
 */
export async function cleanWorktreeForRetry(args: {
  execFn?: ExecFn;
  repoRoot: string;
  issue: number;
  step: WorkStep;
  /** 1-based attempt that FAILED — names the saved patch so attempt N's save is
   *  never overwritten by attempt N+1's. */
  attempt: number;
  state: WorkState;
}): Promise<RetryTreeClean> {
  const tree = retryTargetTree(args, args.state, args.step);
  if (!tree) return NOTHING;
  const execFn = args.execFn ?? execp;
  const git = runGit(execFn);

  const status = await worktreeStatus(git, tree);
  if (!Array.isArray(status)) {
    return { ...NOTHING, unreadable: true, why: `git status unreadable — ${status.unreadable}` };
  }
  const work = workEntriesOf(status).map((e) => e.path);
  if (work.length === 0) return NOTHING;

  const base = baseForTree(args.state, args.step);
  if (!isValidBaseSha(base)) {
    return await preserveUnownedTree(execFn, args, tree, work);
  }

  try {
    assertInsideWorktrees(args.repoRoot, tree);
  } catch (err) {
    return { changed: false, unreadable: false, files: work, why: errText(err) };
  }
  const ahead = await commitsAheadOfBase(git, tree, base);
  if (!("commits" in ahead)) {
    return { changed: false, unreadable: false, files: work, why: errText(ahead.unreadable) };
  }
  if (ahead.commits > 0) {
    return {
      changed: false,
      unreadable: false,
      files: work,
      why: `HEAD has ${ahead.commits} commit(s) ahead of base — committed work is never discarded`,
    };
  }
  try {
    const patch = await resetWorktreeToBase(git, tree, base, {
      repoRoot: args.repoRoot,
      patchPath: retryPatchPath(scratchDir(args.repoRoot, args.issue), args.step, args.attempt),
    });
    return { changed: true, unreadable: false, files: work, patch };
  } catch (err) {
    // Fail closed: the reset refuses when the save failed, so the work is still
    // on disk exactly as the dead child left it.
    return { changed: false, unreadable: false, files: work, why: errText(err) };
  }
}

/** Cap on the files named in the scrollback/trace line: the account is bounded,
 *  the count never is (an unreadable list is not a reason to understate 200
 *  files as "a few"). */
const NAMED_FILES = 8;

/**
 * What the lost attempt left in the worktree — the operator-facing account the
 * retry line carries. Returns undefined when there is nothing to say: the step
 * has no worktree, the tree was already clean, or it could not be read.
 *
 * `files` are the paths the clean found BEFORE it touched anything, so the line
 * accounts for the work the driver may just have discarded and names where the
 * copy of it lives.
 */
export function cleanAttemptLine(
  step: WorkStep,
  tree: string,
  clean: RetryTreeClean,
): string | undefined {
  if (clean.files.length === 0 || clean.unreadable) return undefined;
  const named = clean.files
    .slice(0, NAMED_FILES)
    .map((f) => JSON.stringify(f))
    .join(", ");
  const more = clean.files.length > NAMED_FILES ? `, … (${clean.files.length} total)` : "";
  const where = `left ${clean.files.length} uncommitted file(s) in ${tree}: ${named}${more}`;
  if (clean.patch !== undefined) return `${where} — saved to ${clean.patch} before the retry`;
  if (clean.changed) return `${where} — discarded before the retry`;
  return clean.why === undefined
    ? `${where} — left in place`
    : `${where} — left in place (${clean.why})`;
}
