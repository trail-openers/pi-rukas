/**
 * lean/ci — the step that OBSERVES the pipeline: required checks plus the full tier.
 *
 * A child's prose ("CI looks fine") is not an outcome here. `green` is granted
 * only when two executed things agree about one named commit:
 *
 *   1. the forge's own required-check verdict — `gh pr view`'s
 *      `mergeStateStatus` (which already encodes the repo's required-check
 *      rules) plus `gh pr checks`' rows, both read at the PR head. Both are
 *      re-read every minute while a row is still running: a check that has not
 *      finished is not a check that failed, and grading one as red spends a
 *      build round on code that is not broken;
 *   2. the project's FULL-tier verify command, run locally in the run's own
 *      worktree at the head the run's gate certified.
 *
 * The second half is the reason `land` may trust `ci` at all: a run must not
 * reach the merge on the fast tier plus the frozen tests alone. With no full
 * tier configured this step returns `red` naming that gap — it fails closed
 * rather than reporting a green it did not observe.
 *
 * A red is a verdict and the machine routes it (one fix round, then handback).
 * A throw is infrastructure — an unreadable `gh`, a killed or un-startable tier,
 * checks that never finished inside the wait's bound, a worktree that is no
 * longer the tree the gate certified — which the engine turns into handed-back
 * rather than a build round, because a result nobody observed is not evidence
 * that the code is wrong.
 *
 * **The architectural bound.** Between `build`/`verify` and this handler nothing is
 * pushed, so the code the run produced exists ONLY in this worktree, and `ci`
 * necessarily executes its full tier FROM DISK. "The full tier ran at the frozen
 * head" is therefore NOT achievable by this shape — no frozen checkout happens here
 * (it never calls `checkout`, `switch`, `reset`, `clean` or `stash`). What the green
 * actually claims is that **the disk still matches the head the record says was
 * built**: before the tier runs, the worktree's HEAD is re-read against the newest
 * decided `verify`'s `verifiedHead`, HEAD must still sit on the run's branch, and the
 * tree must pass lean's single clean-tree gate (`assertTreeClean` in
 * `verify-recheck.ts`). Anything else throws. Proving the disk matches the head it
 * claims is the deliverable.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { testsFromLog } from "./build.ts";
import type { CiDeps } from "./ci-deps.ts";
import { CI_FULL_TIER, fullTierExcuse } from "./ci-excuse.ts";
import type { GlForge } from "./ci-forge-gl.ts";
import { CI_POLL_MS } from "./ci-poll.ts";
import { ciTierBudgetMs } from "./ci-tier-budget.ts";
import { checksRedReason, ciConfig, tierFailure } from "./ci-tier.ts";
import { DEFAULT_BUDGETS, type WorkConfig } from "./config.ts";
import { MINUTE_MS } from "./deadline.ts";
import type { HandlerCtx } from "./engine.ts";
import { prNumberFromLog } from "./review-log.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import {
  RED_CRITERIA_MAX,
  RED_CRITERIA_MAX_CHARS,
  RED_TIERS_MAX,
  RED_TIER_MAX_CHARS,
  clipNames,
} from "./state-outcome-gates.ts";
import type { RedRecord } from "./state-outcome-gates.ts";
import type { PreexistingTierRecord } from "./state-outcome-maps.ts";
import type { Outcome, Step } from "./state.ts";
import { budgetFor } from "./step-budget.ts";
import { preexistingReason } from "./verify-baseline-excuse.ts";
import { assertTreeClean } from "./verify-recheck.ts";
import { VerifyInfraError } from "./verify-types.ts";

export { CI_POLL_MS };

/**
 * The `ci` budget's minutes for one loaded config. One number feeds BOTH bounds of
 * the step — the forge wait and the full tier — so neither can drift from the other
 * or from what `.pi/work.json` says; `DEFAULT_BUDGETS` is the fallback only where
 * the config carries no `ci` row at all.
 *
 * A `0` here is the shipped default, not a bound of zero: elsewhere in a budget `0`
 * means "no bound", but here the same number is a timeout handed to the forge wait
 * and to the tier, so `0` would read as "expire immediately" and every run would
 * hand back at once. So `<= 0` takes the shipped number.
 */
function ciMinutes(cfg: WorkConfig): number {
  const configured = budgetFor(cfg, "ci")?.minutes ?? 0;
  return configured > 0 ? configured : (DEFAULT_BUDGETS.ci?.minutes ?? 30);
}

/** The newest decided `verify`'s full head, which is what CI must run against. */
function verifiedHead(ctx: HandlerCtx): string | undefined {
  for (let i = ctx.steps.length - 1; i >= 0; i--) {
    const step = ctx.steps[i];
    if (step?.state !== "verify" || step.outcome === undefined) continue;
    const head = step.outcome.verifiedHead;
    return typeof head === "string" && isFullCommitSha(head) ? head : undefined;
  }
  return undefined;
}

/**
 * Is the disk still the head this run was certified at?
 *
 * `ci` runs its full tier as a shell command IN the worktree, so the tree it judges is
 * whatever is on disk when the handler starts. Nothing is pushed between the
 * build/verify gate and here, so the only way to make "the full tier ran at the
 * verified head" honest is to PROVE the disk still holds that head — with the same
 * reads `verify-recheck.ts` makes after every tier:
 *
 *   - HEAD is re-read and must equal `verified` — a `git checkout` of anything else
 *     (or a commit made since the gate) is refused here rather than graded;
 *   - HEAD must still sit on the run's own branch — `git checkout --detach` leaves
 *     the same sha on no branch, and everything after this step pushes the branch;
 *   - the tree must be clean, through lean's single clean-tree gate
 *     ({@link assertTreeClean}) — a rewritten or untracked file means the tier would
 *     run over bytes no commit holds.
 *
 * Every refusal throws: this is the machine having moved, not the code being wrong.
 */
async function assertDiskAtVerifiedHead(
  deps: CiDeps,
  wt: string,
  verified: string,
  branch: string,
): Promise<void> {
  const read = async (argv: string[], why: string): Promise<string> => {
    const ran = await deps
      .exec("git", {
        argv: [...NO_HOOKS, ...argv],
        cwd: wt,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      })
      .catch(() => undefined);
    if (ran === undefined)
      throw new VerifyInfraError(`could not re-read ${why} in ${wt} before the full tier`);
    return (ran.stdout ?? "").trim();
  };
  const head = await read(["rev-parse", "HEAD"], "HEAD");
  if (head !== verified)
    throw new VerifyInfraError(
      `the worktree ${wt} is at ${head === "" ? "no readable head" : head.slice(0, 12)}, not the verified head ${verified.slice(0, 12)} — the full tier would run over a tree this run never certified`,
    );
  // `symbolic-ref -q` exits 1 with no output when HEAD is detached; any other
  // failure is a git that would not answer, and is never blamed on the run.
  const symbolic = await deps
    .exec("git", {
      argv: [...NO_HOOKS, "symbolic-ref", "--short", "-q", "HEAD"],
      cwd: wt,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
    .catch((err: unknown) => {
      const e = err as { code?: unknown; stderr?: unknown };
      if (e?.code === 1 && String(e.stderr ?? "").trim() === "") return { stdout: "" };
      throw new VerifyInfraError(`could not re-read the branch in ${wt} before the full tier`);
    });
  if ((symbolic.stdout ?? "").trim() !== branch)
    throw new VerifyInfraError(
      `the worktree ${wt} is not on the run's branch ${branch} — the full tier would run on a tree taken off the ref everything after this step pushes`,
    );
  await assertTreeClean(deps.exec, wt, "ci");
}

/**
 * What a red `ci` records about the gate that failed, beside its reason.
 *
 * The step has three reds and they are three different failures with three different
 * owners — no full tier configured, the forge's checks, and the tier itself — so each
 * names what it ran. The tier's own name is `ci`'s own constant, and its criteria come
 * from the same criterion→files map `verify` attributes with: the full tier is the
 * project's whole suite, which is what those frozen tests are.
 */
function ciRed(opts: {
  reason: string;
  tiers: readonly string[];
  criteria: readonly string[];
}): Outcome & { red: RedRecord } {
  return {
    kind: "red",
    reason: opts.reason,
    red: {
      tiers: clipNames(opts.tiers, RED_TIERS_MAX, RED_TIER_MAX_CHARS),
      criteria: clipNames(opts.criteria, RED_CRITERIA_MAX, RED_CRITERIA_MAX_CHARS),
    },
  };
}

/** Every criterion the run's frozen contract maps to any test file at all. */
function contractCriteria(steps: Step[]): string[] {
  return Object.keys(testsFromLog(steps));
}

/**
 * The `ci` step. Returns `green` | `red`; THROWS on infrastructure.
 *
 * The head it observes is the run's own: the newest decided `verify`'s
 * `verifiedHead`, which is also what `land` later compares to the PR head. A ci
 * green recorded over a tree nobody ran the full tier at is the shape this step
 * exists to make unreachable, so an absent head throws rather than falling back
 * to whatever the worktree happens to hold — and so does a worktree that has
 * moved off it since (`assertDiskAtVerifiedHead`).
 */
export async function ciOutcome(ctx: HandlerCtx, deps: CiDeps): Promise<Outcome> {
  const verified = verifiedHead(ctx);
  if (verified === undefined)
    throw new VerifyInfraError("the step log records no verified head to run CI against");
  const prNumber = prNumberFromLog(ctx.steps);
  if (prNumber === undefined)
    throw new VerifyInfraError("the step log records no PR to read CI for");
  // The tier is the step's OWN half of the green, and it is refused before the
  // forge is resolved: a project that configured no full tier has no green on
  // offer, so the operator's diagnosis is the missing tier, not the forge —
  // and the run never pays a forge detection for a verdict it cannot earn.
  const wt = specifyWorktreePath(ctx.repoRoot, ctx.issue);
  // The project config is read ONCE here and passed to everything that wants
  // it: the configured full tier, the wait bound and the tier's bound all come
  // from this one read of the run's base commit.
  const cfg = await ciConfig(deps, ctx);
  const configured = deps.readVerifyCmd
    ? await deps.readVerifyCmd(wt, verified).catch((err: unknown) => {
        throw new VerifyInfraError(
          `could not read .pi/verify-cmd: ${(err as Error)?.message ?? String(err)}`,
        );
      })
    : undefined;
  const full = (cfg.verify.full ?? configured ?? "").trim();
  if (full === "")
    return ciRed({
      reason: `no full verify tier is configured (.pi/work.json verify.full, or .pi/verify-cmd at ${verified.slice(0, 12)}): a run must not land on the fast tier plus the frozen tests alone`,
      // The tier this step was owed and never got is the fact a host triages the run on.
      tiers: [CI_FULL_TIER],
      criteria: contractCriteria(ctx.steps),
    });

  // The forge is resolved by the SAME detection `publish` and `land` obey, so the
  // step cannot read a GitLab MR with GitHub commands. `undefined` is an answer
  // ("no forge this harness can drive") and it throws: falling through to the gh
  // argv would let a GitLab project whose detection failed be graded on reads of a
  // forge it is not on — the silent wrong-verdict this step exists to make
  // unreachable. It is resolved only once a full tier is on offer, because a
  // project that configured none has no green to lose and its diagnosis is the
  // missing tier, not the forge.
  const forge = await deps.forge(ctx.repoRoot);
  if (forge === undefined)
    throw new VerifyInfraError(
      "no forge adapter could be resolved for this repository: ci reads the PR/MR through the forge, so it refuses to fall back to gh commands",
    );
  const gitlab = forge.forge === "gitlab";
  // On the GitLab arm the step needs the seam that hands back the MR reply the
  // readiness was composed from — without it the commit the verdict is about
  // cannot be named, which is the adapter's fault and not the MR's, so it is
  // refused here rather than collapsing into "the forge gave no head".
  if (gitlab && typeof forge.lastMrRow !== "function")
    throw new VerifyInfraError(
      "this forge adapter offers no way to read back the MR reply its readiness was composed from, so ci cannot name the commit its verdict is about",
    );

  const checks = await checksRedReason(
    deps,
    ctx,
    ctx.repoRoot,
    prNumber,
    verified,
    ciMinutes(cfg),
    gitlab,
    // The gh arm never reaches the GitLab seam, and `readForge` branches on
    // `gitlab` before touching it; the cast says "this one has the seam" for the
    // arm where that is already established above.
    forge as GlForge,
  );
  if (checks !== undefined)
    return ciRed({
      reason: checks,
      // The checks the run's own contract exercises are the ones a red pipeline answers
      // for; which single row refused is the forge's sentence, not a criterion.
      tiers: [CI_FULL_TIER],
      criteria: contractCriteria(ctx.steps),
    });

  // The disk is read AGAIN, immediately before the tier, because the tier runs
  // from disk: see `assertDiskAtVerifiedHead` for the bound this proves (and the
  // bound it cannot). Placed after the forge reads so a PR that is not the
  // verified head stays a RED about the forge rather than becoming an
  // infrastructure fault about the worktree — the two have different owners.
  await assertDiskAtVerifiedHead(deps, wt, verified, specifyBranch(ctx.run.branch, ctx.issue));

  // The tier's bound is its OWN, sequential after the wait, and of the same
  // size: waiting out 18 minutes of CI must not leave the full tier a minute.
  // When the run carries a cycle deadline it is clamped to what that deadline
  // still leaves, and the tier never starts when it leaves nothing — see
  // {@link ciTierBudgetMs}.
  const timeoutMs = ciTierBudgetMs(ctx, deps.tierTimeoutMs, ciMinutes(cfg));
  const tier = await tierFailure(deps, full, wt, timeoutMs);
  if (tier === undefined)
    return {
      kind: "green",
      reason: `required checks CLEAN and the full verify tier passed at ${verified}`,
    };
  // The full tier is red. Before red-ding the run, ask whether every test it named
  // was already red at the run's base commit — the same verbatim rule `verify` applies
  // to its own tiers, which `ci` pays for with its own probe of that base.
  const excuse = await fullTierExcuse({
    deps,
    ctx,
    full,
    wt,
    stream: tier.stream,
    ran: tier.ran,
  });
  if (excuse === undefined)
    return ciRed({
      reason: tier.reason,
      tiers: [CI_FULL_TIER],
      criteria: contractCriteria(ctx.steps),
    });
  return {
    kind: "green",
    reason: `required checks CLEAN at ${verified} — ${preexistingReason([CI_FULL_TIER])}`,
    preexistingFailures: { full: excuse },
  };
}
