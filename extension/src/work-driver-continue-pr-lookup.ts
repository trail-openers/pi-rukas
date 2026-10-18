/**
 * work-driver-continue-pr-lookup — #1468: decide whether `--continue-pr` has
 * exactly one PR it may continue, and whether that PR's head is safe to use.
 * Everything here is read-only: it caps before any branch, ref or worktree
 * is touched.
 */

import { type ForgeType, detectForge } from "./forge-detect.ts";
import { detectMainline } from "./work-driver-branch-mechanized.ts";
import type { DriverContext } from "./work-driver-context.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import { netRefProblem } from "./work-driver-net-git.ts";
import {
  type OpenPrLookup,
  type OpenPrMatch,
  listOpenPrsForIssue,
} from "./work-driver-pr-preflight.ts";
import { execp } from "./work-driver-verify.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

export type ContinueLookupOutcome =
  | { ok: true; pr: OpenPrMatch }
  | {
      cap: "continue-pr-not-found" | "continue-pr-ambiguous" | "continue-pr-fork";
      evidence: string;
    };

/** Map a lookup to the one PR to continue, or the cap that says why not. */
export function classifyContinueLookup(
  result: OpenPrLookup,
  issue: number,
  forge: ForgeType,
): ContinueLookupOutcome {
  if (forge !== "github") {
    return {
      cap: "continue-pr-not-found",
      evidence: `the forge is ${forge}; --continue-pr reads GitHub pull requests only`,
    };
  }
  if (result.kind === "unreadable")
    return { cap: "continue-pr-not-found", evidence: result.reason };
  const [pr, ...rest] = result.prs;
  if (!pr) return { cap: "continue-pr-not-found", evidence: `no open PR matches issue #${issue}` };
  if (rest.length > 0) {
    const list = result.prs.map((p) => `#${p.number} (${p.matchedBy})`).join(", ");
    return { cap: "continue-pr-ambiguous", evidence: `open PRs for issue #${issue}: ${list}` };
  }
  // gh omits isCrossRepository for an unknown fork state; only an explicit false is ours.
  if (pr.isCrossRepository !== false || !pr.headRepository) {
    return {
      cap: "continue-pr-fork",
      evidence: `PR #${pr.number} head ${pr.headRefName ?? "(unknown)"} is from another repository or a deleted fork`,
    };
  }
  return { ok: true, pr };
}

/**
 * Why the PR's head may not be used, or undefined. The head name comes from
 * the PR, so it is untrusted: the character check runs before git sees it,
 * and git runs in argv form.
 */
export async function continueHeadProblem(
  execFn: VerifyExecFn,
  repoRoot: string,
  pr: OpenPrMatch,
  mainline: string,
): Promise<string | undefined> {
  const head = pr.headRefName ?? "";
  const refProblem = netRefProblem(head);
  if (refProblem) return `PR #${pr.number} head: ${refProblem}`;
  try {
    await execFn("git", { argv: ["check-ref-format", "--branch", head], cwd: repoRoot });
  } catch {
    return `PR #${pr.number} head "${head}" is not a valid branch name`;
  }
  if (head === mainline) return `PR #${pr.number} head is the mainline ${mainline}`;
  if (pr.baseRefName !== mainline) {
    return `PR #${pr.number} targets ${pr.baseRefName ?? "(unknown)"}, not the mainline ${mainline}`;
  }
  return undefined;
}

export type ContinueCap =
  | Extract<ContinueLookupOutcome, { cap: string }>["cap"]
  | "continue-pr-unsafe-head";

async function forgeOf(ctx: DriverContext): Promise<ForgeType> {
  if (ctx.forge) return ctx.forge.forge;
  try {
    return (await detectForge(ctx.repoRoot)).forge;
  } catch {
    return "unknown";
  }
}

/** The one PR to continue with a safe head, or the cap that says why not. */
export async function continueLookup(
  ctx: DriverContext,
  execFn: VerifyExecFn,
  mainline: string,
): Promise<{ ok: true; pr: OpenPrMatch } | { cap: ContinueCap; evidence: string }> {
  const listed = await listOpenPrsForIssue(execFn, ctx.repoRoot, ctx.issue);
  const found = classifyContinueLookup(listed, ctx.issue, await forgeOf(ctx));
  if (!("ok" in found)) return found;
  const problem = await continueHeadProblem(execFn, ctx.repoRoot, found.pr, mainline);
  return problem ? { cap: "continue-pr-unsafe-head", evidence: problem } : found;
}

/** A continue-pr cap that sends the cycle to handoff. */
export function continueCapHit(
  state: WorkState,
  cap: ContinueCap | "continue-pr-head-moved" | "step-failed:branch",
  evidence: string,
  now: number,
): WorkState {
  return appendEvent(state, {
    kind: "cap-hit",
    at: now,
    cap,
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence,
  });
}

/**
 * Run at explore, so a run that cannot continue a PR stops before any
 * dispatch is paid for. Returns the capped state, or undefined to go on.
 * PI_ENSEMBLE_PR_PREFLIGHT does not apply: this lookup is the point of the flag.
 */
export async function continuePrPreflight(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState | undefined> {
  if (!ctx.continuePr || state.pipelineState.continuedPr) return undefined;
  const execFn = ctx.verifyExecFn ?? execp;
  const found = await continueLookup(ctx, execFn, await detectMainline(execFn, ctx.repoRoot));
  return "ok" in found ? undefined : continueCapHit(state, found.cap, found.evidence, now);
}
