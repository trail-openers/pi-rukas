/**
 * work-driver-merge-subject — the #810 single-commit merge-subject decision.
 *
 * When a /work cycle parks, the driver consolidates its workstreams onto the
 * feature branch with a housekeeping commit (`chore(handoff): consolidate
 * parked work onto <branch>`). If that branch later holds EXACTLY ONE commit
 * above the base, GitHub's squash merge uses that commit's message instead of
 * the PR title (measured: PR #801 landed on main as a `chore` despite its
 * `fix(work):` title, suppressing the release-please bump and changelog
 * entry). Multi-commit branches squash using the PR title and are unaffected
 * (PR #802, confirmed the same day).
 *
 * Option (b) of the #810 spec: the merge step passes an explicit
 * `--subject` so the PR title wins regardless of commit count, and the
 * handoff's printed recovery commands carry the SAME command so an operator
 * recovering a parked branch by hand runs the explicit-subject merge rather
 * than relying on remembering it.
 *
 * The decision is deliberately conservative — `undefined` (no subject
 * flag) is the honest default:
 *
 *   - NOT parked (no `handoff-consolidated` event): nothing to fix, and
 *     changing the subject of a normal merge would be a no-op at best
 *     (multi-commit branches already use the title) and scope creep at
 *     worst.
 *   - Parked but the ahead-count is unreadable or not exactly one: the
 *     observed single-commit behaviour is a repo setting
 *     (`squash_merge_commit_title`), not a universal rule — refusing to
 *     guess keeps the command byte-identical to the pre-#810 shape.
 *   - The PR title is unreadable: an empty subject is worse than none.
 *
 * The LLM-ops fallback merge path (`inlineMergePrompt`) does NOT pass the
 * subject: the LLM already sees the PR and its title in the prompt context
 * and runs the merge interactively; the mechanized path is the one whose
 * argv must be pinned.
 */

import type { VerifyExecFn } from "./work-driver-git.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * True when the cycle parked at handoff with its work consolidated onto the
 * branch (the `handoff-consolidated` event is the audit trail — a
 * `consolidated: true` on the `handoff-emitted` event alone is not enough,
 * because it is only set after the consolidation event is appended).
 */
export function isConsolidatedPark(state: WorkState): boolean {
  return state.eventLog?.some((e) => e.kind === "handoff-consolidated") ?? false;
}

/** Count the commits `branch` is ahead of `baseSha`. Returns undefined on any git failure. */
export async function countBranchAhead(
  execFn: VerifyExecFn,
  repoRoot: string,
  branch: string,
  baseSha: string,
): Promise<number | undefined> {
  try {
    const { stdout } = await execFn(`git rev-list --count ${baseSha}..${branch}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Read the PR title via the forge CLI. Returns undefined on any failure. */
export async function readPrTitle(
  execFn: VerifyExecFn,
  repoRoot: string,
  prNumber: number,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFn(`gh pr view ${prNumber} --json title --jq '.title'`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const title = stdout.trim();
    return title || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The #810 decision: the explicit squash `--subject` to pass at merge time,
 * or `undefined` (no flag, byte-identical pre-#810 command).
 *
 * `undefined` whenever the shape is NOT "a parked, consolidated cycle whose
 * branch holds exactly one commit above its base" — see the module header
 * for the conservative-default reasoning. The subject is the PR title,
 * clipped to a single line (a `--subject` argument must be a one-line shell
 * argument).
 */
export async function mergeSubjectForState(
  _ctx: { repoRoot: string; issue: number },
  state: WorkState,
  execFn: VerifyExecFn,
): Promise<string | undefined> {
  if (!isConsolidatedPark(state)) return undefined;
  const { branchName, baseSha, prNumber } = state.pipelineState;
  if (!branchName || !baseSha || !prNumber) return undefined;
  const ahead = await countBranchAhead(execFn, _ctx.repoRoot, branchName, baseSha);
  if (ahead !== 1) return undefined;
  const title = await readPrTitle(execFn, _ctx.repoRoot, prNumber);
  if (!title) return undefined;
  const firstLine = title.split("\n")[0];
  return (firstLine ?? "").trim() || undefined;
}
