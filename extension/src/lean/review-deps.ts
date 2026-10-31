/**
 * lean/review-deps — the production wiring of the `review` step.
 *
 * `review.ts` is the decision procedure and takes every outside world through
 * `ReviewDeps`; this file is what the command hands it. Split out for the same
 * reason `publish-deps.ts` exists: the judgement and the process-spawning glue
 * change for different reasons, and a test drives the first with stubs while
 * never loading the second.
 *
 * Two choices here are load-bearing rather than mechanical, and both are the
 * review layer's own rules restated rather than lean's invention:
 *
 * - **The adversarial loop runs report-only.** It reviews and fixes nothing; the
 *   fix round is this step's, in its own disposable tree. `reportVerdict:
 *   "routed"` is what says so — with `"terminal"` the loop would judge its own
 *   round against its own round cap, and the step would inherit a verdict it had
 *   no part in producing. `reportRound` is threaded so the reviewer's prompt and
 *   ledger row carry the round of THIS step's loop, whose bound is the run's
 *   budget, not the loop's constant.
 * - **Both gates get refs, not a pasted diff.** `runLensReview` computes
 *   `git diff <base>...<head>` itself, so the diff is one the lenses can re-read
 *   and the ledger can bind to a commit rather than to a string this step handed
 *   over (the caller-supplied arm is recorded as never counting as a passing
 *   review).
 */

import { MAX_ROUNDS, runAdversarialLoop } from "../adversarial.ts";
import { execp } from "../exec.ts";
import type { LensReviewSummary } from "../lens-review-format.ts";
import { runLensReview } from "../lens-review.ts";
import { lensChildBoundMs } from "../spawn-child-bound.ts";
import { makeRunId, spawnSpecialist } from "../spawn.ts";
import { verifyTimeoutMs } from "../work-driver-verify-develop-helpers.ts";
import { leanChildOpts } from "./child-opts.ts";
import { loadWorkConfig } from "./config.ts";
import { fetchIssueBody } from "./io.ts";
import { adversarialContext } from "./review-prompt.ts";
import type { ReviewDeps } from "./review.ts";

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
        // The operator's own lever, read here rather than a number copied into
        // this file: `lensChildBoundMs()` is the single source for a lens child's
        // wall clock (`PI_ENSEMBLE_LENS_BOUND_MS`), and a literal here would make
        // that knob silently inert for every lean run.
        childBoundMs: lensChildBoundMs(),
        ...leanChildOpts(a.headless),
      });
      return {
        verdict: summary.verdict,
        findings: renderFindings(summary),
        usage: summary.usage,
        // The one field that distinguishes "no lens ran" from "lenses ran and
        // found nothing", and the only place it is stated — `verdict` says
        // APPROVED for both. Dropping it here is what would let the empty-delta
        // outcome read as a clean review.
        ...(summary.noReview === true ? { noReview: true } : {}),
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

/**
 * The round's findings as one line each, severity and source first.
 *
 * The shape is the fixer's brief's: a fixer handed a wall of prose re-derives a
 * solution from scratch, so one line per finding, with the lens and location the
 * fix has to land at.
 */
function renderFindings(summary: LensReviewSummary): string {
  return summary.findings
    .map(
      (f) =>
        `- [${f.severity}] ${f.lens} ${f.path}${f.line === undefined ? "" : `:${String(f.line)}`}: ${f.title}${f.description === undefined || f.description === "" ? "" : ` — ${f.description}`}`,
    )
    .join("\n");
}
