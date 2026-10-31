/**
 * lean/review — the run's gate: the adversarial loop, the six-lens pass, and a
 * bounded number of fix rounds between them.
 *
 * Both gates are the frozen driver's own code, called rather than copied:
 * `runAdversarialLoop` in report-only mode (it reviews and fixes nothing; this
 * step routes its verdict) and `runLensReview` for the six lenses. What is
 * lean's own is which tree they read, who fixes what they find, and when the
 * loop stops. Where the bytes are and how they move is `review-git.ts`; this
 * file is the decision procedure.
 *
 * **Both gates read a resolved commit, never a working copy.** A gate approves
 * the bytes at a commit, and the only value that cannot be dirtied underneath
 * the step between two rounds is a commit sha resolved from a ref. This step
 * resolves origin's branch once per round and hands the same value to both
 * gates, to the fixer, and to the integration — five uses of one commit cannot
 * disagree, and a working copy would give each of them a different tree. Both
 * gates therefore get a ref range they compute their own diff from rather than
 * a string this step pasted: a pasted diff is a value the reviewer cannot
 * re-read, and a range is one it can.
 *
 * **The fix runs in a disposable tree of its own** (see `fixRound` in
 * `review-git.ts`), detached at the reviewed commit and destroyed at the end of
 * the round — because the fixer must not touch the tree `verify` and `publish`
 * read. A child loose in the run's worktree between two gates would leave the
 * green verdict describing one commit and the PR holding another. Detached on
 * purpose: a fixer that commits there moves no branch, so a child that committed
 * twice, amended, or reset could not corrupt what the run merges. Only the
 * integration moves anything, and only after its claims hold.
 *
 * **The bound is the run's, not this file's.** What the step may spend is one
 * number already in the state: `budgets.review.turns` in `.pi/work.json`, the
 * same ceiling the engine bills this step's children against. Each round of the
 * loop — a reviewer, the six lenses, and a fixer — is charged that many turns,
 * and the loop stops when the budget has no whole round left in it. No new knob:
 * a step that invented its own round cap would be a second answer to "when does
 * this stop", and the two would drift.
 *
 * **What ends the step.** Both gates clean is `done`, and the run goes to `ci`.
 * Anything else THROWS: findings still open at the bound, a gate that produced
 * no verdict, a head that moved or vanished mid-round, a fixer that rewrote the
 * frozen contract, an integration that could not be proven. A throw is the
 * engine's infrastructure path — the run hands back at exit 10 with the cause
 * named, rather than carrying an unreviewed head forward on a `done` it did not
 * earn. A gate that did not run is never a gate that passed.
 */

import { MAX_ROUNDS, runAdversarialLoop } from "../adversarial.ts";
import { execp } from "../exec.ts";
import { lensFixDelta } from "../fix-delta.ts";
import { buildEvidence, runClaimScan } from "../lens-evidence.ts";
import type { LensReviewSummary } from "../lens-review-format.ts";
import { runLensReview } from "../lens-review.ts";
import { makeRunId, spawnSpecialist } from "../spawn.ts";
import type { DispatchResult, DispatchSpec, DispatchUsage } from "../types.ts";
import { verifyTimeoutMs } from "../work-driver-verify-develop-helpers.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import type { ExecFn } from "../worktree.ts";
import { frozenFromLog } from "./build.ts";
import { leanChildOpts } from "./child-opts.ts";
import type { WorkConfig } from "./config.ts";
import { loadWorkConfig } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { fetchIssueBody } from "./io.ts";
import { fixRound, lensRow, rangeDiff, reviewedHead } from "./review-git.ts";
import { adversarialContext, lensContext } from "./review-prompt.ts";
import { specifyBranch } from "./specify-tree.ts";
import type { Outcome } from "./state.ts";
import type { DispatchUsageRow } from "./step-budget.ts";
import { budgetFor, dispatchUsageRow } from "./step-budget.ts";

/** The step's own throw: the run hands back, with this sentence as its cause. */
export class ReviewInfraError extends Error {
  override readonly name = "ReviewInfraError";
  constructor(
    message: string,
    readonly dispatches: DispatchUsageRow[] = [],
  ) {
    super(message);
  }
}

/**
 * What this step may never "fix" its way past.
 *
 * A lens round that did not complete reviewed nothing, so its verdict is not
 * evidence to fix against: an empty round whose fixer then changed nothing would
 * read as a resolution and let the run merge unreviewed. The round-cap verdicts
 * are another component's budget refusing this run, which a fix round cannot
 * answer — the operator named that budget, and only they can lift it.
 */
const NO_FIX_VERDICTS = ["REVIEW_INCOMPLETE", "ROUND_CAP_REACHED", "REVIEW_INCOMPLETE_STREAK"];

/** One lens child's wall clock; a lens ended at it leaves its lane not-reviewed. */
const LENS_CHILD_BOUND_MS = 15 * 60_000;

/** The fixer's wall clock, the same shape the other steps pass as `childBoundMs`. */
export const FIX_BOUND_MS = 20 * 60_000;

/**
 * One round's cost, in the unit the step's budget is counted in.
 *
 * A round is a reviewer, the six lenses, and a fixer, so a round is not one
 * child's 150 turns — that figure is what `runAdversarialLoop` bills PER CHILD,
 * and a child capped there makes every later claim a lower bound. Reading the
 * committed budget through that number gave 150 / 150 = **one** round, which is
 * not a review loop at all: a round that finds something can only fix, and the
 * fix is never re-reviewed, so the step certifies a head no gate looked at. Two
 * children's worth is the smallest number under which a budget of one round can
 * still fix and re-review, which is the whole point of the step.
 */
const TURNS_PER_ROUND = 300;

/** What one six-lens round answered, as the step reads it. */
export interface LensRound {
  verdict: string;
  /** The round's findings as the text a fixer is handed — one line each. */
  findings: string;
  /** What the six children reported, or `undefined` when none of them ran. */
  usage: DispatchUsage | undefined;
  /** Why the round owed the PR a residual-findings disclosure and did not make it. */
  note?: string;
}

/** What the step hands one round of the adversarial gate. */
export interface AdversarialArgs {
  base: string;
  head: string;
  branch: string;
  cwd: string;
  issue: number;
  issueBody: string;
  round: number;
  headless: boolean;
}

/** What the step hands one round of the six-lens pass. */
export interface LensArgs {
  base: string;
  head: string;
  branch: string;
  cwd: string;
  round: number;
  /** The context lines this step composes (see `review-prompt.ts`). */
  context: string;
  /** Post-change prose and the deterministic claim scan, read from the head ref. */
  evidence: string | undefined;
  extraFindings: Parameters<typeof runLensReview>[0]["extraFindings"];
  /** The headless trust stamp this run's children carry. */
  headless: boolean;
}

/** The step's dependencies: the outside world, injected. */
export interface ReviewDeps {
  /** The headless mode this run was started in; its children's permission stamp. */
  headless: boolean;
  exec: ExecFn;
  /** One round of the adversarial gate. Injected so a test drives verdicts with no child. */
  adversarial: (args: AdversarialArgs) => Promise<DispatchResult>;
  /** One round of the six-lens pass. */
  lens: (args: LensArgs) => Promise<LensRound>;
  /** The fixer, in the tree its `cwd` names. */
  dispatch: (spec: DispatchSpec, opts: { childBoundMs?: number }) => Promise<DispatchResult>;
  fetchIssueBody: (repoRoot: string, issue: number) => Promise<string>;
  loadConfig: (repoRoot: string, baseSha: string) => Promise<WorkConfig>;
}

/**
 * The adversarial gate: one report-only pass, and the finding text it left open.
 * `""` is the gate's pass. Anything else THROWS — a gate that produced no verdict
 * is not a gate that approved, and this one has no fixer of its own to blame.
 * The row this pass cost is APPENDED to the caller's running total, not returned:
 * a copy handed back and re-assigned per round is how a handback ends up
 * reporting the cost of one round as the cost of the step.
 */
async function adversarialGate(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  opts: {
    base: string;
    head: string;
    branch: string;
    issueBody: string;
    round: number;
    rows: DispatchUsageRow[];
  },
): Promise<{ findings: string }> {
  let result: DispatchResult;
  try {
    result = await deps.adversarial({
      base: opts.base,
      head: opts.head,
      branch: opts.branch,
      cwd: ctx.repoRoot,
      issue: ctx.issue,
      issueBody: opts.issueBody,
      round: opts.round,
      headless: deps.headless,
    });
  } catch (err) {
    throw new ReviewInfraError(
      `the adversarial loop threw: ${(err as Error)?.message ?? String(err)}`,
      opts.rows,
    );
  }
  opts.rows.push(dispatchUsageRow(result));
  if (result.loopOutcome === "approved") return { findings: "" };
  if (result.loopOutcome === "rejected") return { findings: result.text };
  throw new ReviewInfraError(
    `the adversarial gate produced no verdict (${String(result.loopOutcome)}${
      result.killCause === undefined ? "" : `, killed: ${String(result.killCause)}`
    }) — that is not a pass: ${result.text.slice(0, 300)}`,
    opts.rows,
  );
}

/**
 * The six-lens gate: one round at the commit the adversarial gate just cleared.
 *
 * Its own read of origin, deliberately, rather than the value the caller still
 * holds: if the round before left origin somewhere else, that is the fact the
 * next verdict should be stated against. Two gates reviewing two different
 * commits have reviewed neither.
 */
async function lensGate(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  opts: {
    base: string;
    branch: string;
    round: number;
    since: string | undefined;
    carried: string | undefined;
    rows: DispatchUsageRow[];
  },
): Promise<LensRound & { head: string }> {
  const head = await reviewedHead(deps, ctx.repoRoot, opts.branch, opts.rows);
  const diff = await rangeDiff(deps, ctx.repoRoot, opts.base, head, opts.rows);
  // What the last fix pass moved, so a lens reads the delta first and weighs it
  // specifically for what the fix broke beside the line it repaired.
  const delta = await lensFixDelta(ctx.repoRoot, opts.branch, opts.since);
  // Both of these read the HEAD REF, never the filesystem: the trees lean works
  // in are detached at the base, so anything opened here is the pre-change text.
  const evidence = await buildEvidence(ctx.repoRoot, head, diff);
  const extraFindings = await runClaimScan(deps.exec, ctx.repoRoot, head, diff);
  let round: LensRound;
  try {
    round = await deps.lens({
      base: opts.base,
      head,
      branch: opts.branch,
      cwd: ctx.repoRoot,
      round: opts.round,
      context: lensContext(ctx.issue, opts.round, {
        carried: opts.carried,
        fixDelta: delta.section,
      }),
      evidence,
      extraFindings,
      headless: deps.headless,
    });
  } catch (err) {
    throw new ReviewInfraError(
      `the six-lens review threw: ${(err as Error)?.message ?? String(err)}`,
      opts.rows,
    );
  }
  opts.rows.push(lensRow(round.usage));
  return { ...round, head };
}

/** The `review` step. Returns `done`; THROWS on anything it cannot settle. */
export async function reviewOutcome(ctx: HandlerCtx, deps: ReviewDeps): Promise<Outcome> {
  const { repoRoot, issue } = ctx;
  const branch = specifyBranch(ctx.run.branch, issue);
  const base = ctx.run.baseSha;
  try {
    assertSafeRef(branch);
    if (base !== "") assertSafeRef(base);
  } catch (err) {
    throw new ReviewInfraError((err as Error).message);
  }
  if (!/^[0-9a-f]{40}$/.test(base))
    throw new ReviewInfraError(
      `the run has no base commit to review against: ${JSON.stringify(base.slice(0, 80))}`,
    );

  // The contract, the config and the issue, all read before any child is paid:
  // a step that discovered its spec was unreadable after two rounds of review
  // had spent those rounds for nothing.
  const frozen = frozenFromLog(ctx.steps);
  const config = await deps.loadConfig(repoRoot, base).catch((err: unknown) => {
    throw new ReviewInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  const issueBody = await deps.fetchIssueBody(repoRoot, issue).catch((err: unknown) => {
    throw new ReviewInfraError(`could not read the issue: ${(err as Error).message}`);
  });

  // The bound, from the number the run already carries. One round is charged
  // what a round costs (`TURNS_PER_ROUND`, which is a reviewer, the six lenses
  // and a fixer), so the loop stops when the step's budget cannot pay for
  // another whole one — rather than when this file guessed a round count.
  const budget = budgetFor(config, "review")?.turns ?? 0;
  const maxRounds = Math.max(1, Math.floor(budget / TURNS_PER_ROUND));

  // `rows` accumulates across the WHOLE step, not one round: the handback must
  // say what every round cost, including the one that failed. Nothing re-derives
  // it per round — a total rebuilt each round reports a two-round run to the
  // operator as a one-round one.
  const rows: DispatchUsageRow[] = [];
  let head = await reviewedHead(deps, repoRoot, branch, rows);
  /** The head the last six-lens round read: the base of this round's fix delta. */
  let lastReviewed: string | undefined;
  /** Findings the adversarial gate passed on without blocking, for the lenses to weigh. */
  let carried: string | undefined;

  for (let round = 1; ; round++) {
    const gate = await adversarialGate(deps, ctx, {
      base,
      head,
      branch,
      issueBody,
      round,
      rows,
    });
    if (gate.findings !== "") {
      carried = gate.findings;
      const { head: pushed } = await fixRound(deps, ctx, {
        head,
        frozen,
        findings: gate.findings,
        gate: "adversarial loop",
        round,
        rows,
      });
      head = pushed;
      continue;
    }

    const lens = await lensGate(deps, ctx, {
      base,
      branch,
      round,
      since: lastReviewed,
      carried,
      rows,
    });
    if (lens.verdict === "APPROVED")
      return {
        kind: "done",
        reason: `adversarial and six-lens review clean at ${lens.head.slice(0, 12)} (${String(round)} round(s))`,
        dispatches: rows,
      };
    if (NO_FIX_VERDICTS.includes(lens.verdict))
      throw new ReviewInfraError(
        `the six-lens review did not complete (${lens.verdict}${lens.note === undefined ? "" : `; disclosure: ${lens.note}`}) — an incomplete round is not a pass to fix against`,
        rows,
      );
    if (round >= maxRounds)
      throw new ReviewInfraError(
        `findings still open after ${String(round)} review round(s) at the step's budget of ${String(budget)} turns: ${lens.findings.slice(0, 500)}`,
        rows,
      );
    lastReviewed = lens.head;
    const { head: pushed } = await fixRound(deps, ctx, {
      head: lens.head,
      frozen,
      findings: lens.findings,
      gate: `six-lens review (${lens.verdict})`,
      round,
      rows,
    });
    head = pushed;
  }
}

/** Production dependencies: the real executor, both gates, and the spawner. */
export function reviewDeps(headless: boolean): ReviewDeps {
  return {
    headless,
    exec: (cmd, opts) => execp(cmd, opts ?? {}),
    adversarial: (a) =>
      runAdversarialLoop(
        {
          base: a.base,
          head: a.head,
          workCwd: a.cwd,
          context: adversarialContext(a.issue, a.round, MAX_ROUNDS),
          issueBody: a.issueBody,
          // The reviewer's lane is one verdict; the fix round is this step's, so
          // the loop must not dispatch a fixer of its own.
          reportOnly: true,
          reportVerdict: "routed",
          reportRound: a.round,
          // Lean's worktrees are detached, so the ledger writer cannot recover
          // the branch from HEAD and this is the only place it can come from.
          branch: a.branch,
          commentTimeoutMs: verifyTimeoutMs(),
          processGroup: true,
          ...leanChildOpts(a.headless),
        },
        new AbortController().signal,
        makeRunId(),
      ),
    lens: async (a) => {
      const summary = await runLensReview({
        // The refs, not a pasted diff: the review computes `git diff
        // <base>...<head>` itself, so its diff is one the lenses can re-read and
        // the ledger can bind to a commit rather than to a string this step
        // handed it (the caller-supplied arm is recorded as never counting as a
        // passing review).
        base: a.base,
        head: a.head,
        cwd: a.cwd,
        context: a.context,
        evidence: a.evidence,
        extraFindings: a.extraFindings,
        // The worktree is detached, so the ledger write and the residual
        // disclosure can only be keyed on a branch this step names.
        branch: a.branch,
        processGroup: true,
        childBoundMs: LENS_CHILD_BOUND_MS,
        ...leanChildOpts(a.headless),
      });
      return {
        verdict: summary.verdict,
        findings: renderFindings(summary),
        usage: summary.usage,
        // The disclosure the round owed and may not have made. `runLensReview`
        // posts it itself for an ISSUES_FOUND round and reports a failed post
        // here, so this step adds nothing and only carries the reason to the
        // operator as part of the handback cause.
        ...(summary.note === undefined ? {} : { note: summary.note }),
      };
    },
    dispatch: (spec, o) =>
      spawnSpecialist(spec, {
        processGroup: true,
        ...(o.childBoundMs === undefined ? {} : { childBoundMs: o.childBoundMs }),
        ...leanChildOpts(headless),
      }),
    fetchIssueBody,
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
  };
}

/** The round's findings as one line each, severity and source first. */
function renderFindings(summary: LensReviewSummary): string {
  return summary.findings
    .map(
      (f) =>
        `- [${f.severity}] ${f.lens} ${f.path}${f.line === undefined ? "" : `:${String(f.line)}`}: ${f.title}${f.description === undefined || f.description === "" ? "" : ` — ${f.description}`}`,
    )
    .join("\n");
}
