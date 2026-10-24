/**
 * work-retry-tree-clean — #1391: the ONE save-then-clean a step retry runs on
 * the tree a lost child left behind.
 *
 * The router re-runs a step by dispatching a brand-new child into the SAME
 * worktree. Nothing used to commit, stash or discard what the severed child
 * left there, so the retry's own precondition was defeated by the failure it
 * was retrying after: a measured cycle lost its round-2 lens-fix developer, the
 * retry met `lens-fix-reposition: worktree has uncommitted changes: M
 * DESIGN.md, …`, and the cycle parked one second into its third round.
 *
 * Callers: both retry branches of `routeStepOutcome` (through
 * `work-driver-step-clean.ts`) and the lens-fix reposition gate, for dirt it
 * can attribute to a lost attempt. The git recipe is `work-develop-git.ts`'s —
 * `savePartialWork` (stage, verify every path landed in the index, commit-tree
 * + durable ref, binary patch written `wx`) then `resetAndClean` — so the
 * develop fan-out retry and the step retry share one implementation.
 *
 * Order is load-bearing and fails closed: the ref and the patch both exist
 * before `reset --hard`, and a save that fails returns `failed` with the tree
 * untouched — the caller parks rather than discarding the only copy.
 *
 * Which tree, and reset to what:
 *  - `develop` (N=1 `default` tree) → the workstream's 40-hex base;
 *  - `lens-fix` (the consolidated tree, via `lensWorktree`) → its own HEAD,
 *    never the cycle base: that tree sits at the branch tip and resetting it to
 *    `baseSha` would drag it off the work the review just read;
 *  - every other step → nothing. `adversarial`'s tree holds the uncommitted
 *    diff under review, so its dirt is the work, not residue.
 * A tree carrying commits is `kept`, never reset: committed work is the
 * develop retry's starting point and the #749 lens-fix integration's input.
 */

import { execp } from "./exec.ts";
import {
  type ExecFn,
  assertInsideWorktrees,
  commitsAheadOfBase,
  errText,
  isValidBaseSha,
  nextRetryAttempt,
  resetAndClean,
  retryPatchPath,
  runGit,
  savePartialWork,
  workEntriesOf,
  worktreeStatus,
} from "./work-develop-git.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { lensWorktree } from "./work-driver-lens-fix.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { WorkStep } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state-schema.ts";

/** How the clean went. `files` is what was there BEFORE anything was touched. */
export type RetryTreeClean =
  | { kind: "none" }
  | { kind: "cleaned"; tree: string; files: string[]; ref: string; patch: string }
  | { kind: "kept"; tree: string; files: string[]; why: string }
  | { kind: "failed"; tree: string; files: string[]; why: string };

/** The tree a retried step dispatches into, or undefined when it has none the
 *  driver may clean (see the module header). `repoRoot` is never a target. */
export function retryTargetTree(
  ctx: Pick<CycleContext, "repoRoot">,
  state: WorkState,
  step: WorkStep,
): string | undefined {
  const tree =
    step === "develop"
      ? state.pipelineState.worktrees?.default
      : step === "lens-fix"
        ? lensWorktree(ctx as CycleContext, state)
        : undefined;
  return tree === undefined || tree === ctx.repoRoot ? undefined : tree;
}

/** The ref a step's save is kept under — per issue, step and save number. */
export function preservedRefFor(issue: number, step: WorkStep, n: number): string {
  return `refs/pi-rukas/retry-preserved/issue-${issue}/${step}-${n}`;
}

/** The reset target for the step's tree, or why the tree is kept as it is. */
async function resetTarget(
  execFn: ExecFn,
  state: WorkState,
  step: WorkStep,
  tree: string,
): Promise<{ target: string } | { why: string }> {
  const git = runGit(execFn);
  if (step === "develop") {
    const entry = state.pipelineState.workstreamBaseShas?.default;
    const base = (typeof entry === "string" ? entry : undefined) ?? state.pipelineState.baseSha;
    if (!isValidBaseSha(base)) return { why: "no 40-hex base recorded for the tree" };
    const ahead = await commitsAheadOfBase(git, tree, base);
    if (!("commits" in ahead)) return { why: `commit count unreadable — ${ahead.unreadable}` };
    if (ahead.commits > 0) {
      return {
        why: `HEAD has ${ahead.commits} commit(s) ahead of base — the retry builds on them`,
      };
    }
    return { target: base };
  }
  const { stdout } = await git(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"], {
    cwd: tree,
    maxBuffer: 64 * 1024,
  });
  if (!/^\d+$/.test(stdout.trim()))
    return { why: `commit count unreadable: ${stdout.slice(0, 80)}` };
  const count = Number(stdout.trim());
  if (count > 0) return { why: `HEAD has ${count} commit(s) not on origin — left for integration` };
  return { target: "HEAD" };
}

/**
 * Save the lost attempt's work, then clean the tree. Never throws: every git
 * or filesystem failure is a `failed` result, and on `failed` the tree holds
 * exactly what the dead child left. `tree` overrides the step's own tree (the
 * reposition gate passes the one it inspected).
 */
export async function cleanWorktreeForRetry(args: {
  execFn?: ExecFn;
  repoRoot: string;
  issue: number;
  step: WorkStep;
  state: WorkState;
  tree?: string;
}): Promise<RetryTreeClean> {
  const tree = args.tree ?? retryTargetTree(args, args.state, args.step);
  if (tree === undefined) return { kind: "none" };
  const execFn = args.execFn ?? execp;
  const git = runGit(execFn);
  let files: string[] = [];
  try {
    assertInsideWorktrees(args.repoRoot, tree);
    const status = await worktreeStatus(git, tree);
    if (!Array.isArray(status)) throw new Error(`status unreadable — ${status.unreadable}`);
    files = workEntriesOf(status).map((e) => e.path);
    if (files.length === 0) return { kind: "none" };
    const decided = await resetTarget(execFn, args.state, args.step, tree);
    if ("why" in decided) return { kind: "kept", tree, files, why: decided.why };
    const scratch = scratchDir(args.repoRoot, args.issue);
    const n = await nextRetryAttempt(scratch, args.step);
    const ref = preservedRefFor(args.issue, args.step, n);
    const patch = retryPatchPath(scratch, args.step, n);
    await savePartialWork(git, tree, decided.target, files, patch, ref);
    await resetAndClean(git, tree, decided.target);
    return { kind: "cleaned", tree, files, ref, patch };
  } catch (err) {
    return { kind: "failed", tree, files, why: errText(err) };
  }
}

/** Paths named in the operator line; the count is never truncated. */
const NAMED_FILES = 8;

/** The retry-line clause for a clean result, or undefined when nothing was there. */
export function retryTreeLine(clean: RetryTreeClean): string | undefined {
  if (clean.kind === "none") return undefined;
  const named = clean.files
    .slice(0, NAMED_FILES)
    .map((f) => JSON.stringify(f))
    .join(", ");
  const more = clean.files.length > NAMED_FILES ? `, … (${clean.files.length} total)` : "";
  const where = `left ${clean.files.length} uncommitted file(s) in ${clean.tree}: ${named}${more}`;
  if (clean.kind === "cleaned") {
    return `${where} — saved to ref ${clean.ref} and ${clean.patch}, tree cleaned for the retry`;
  }
  if (clean.kind === "kept") return `${where} — left in place (${clean.why})`;
  return `${where} — NOT cleaned, the save failed (${clean.why})`;
}
