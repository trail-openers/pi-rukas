/**
 * lean/review-deps — the production wiring of the `review` step, and the briefs
 * its children are dispatched with.
 *
 * `review.ts` is the decision procedure and takes every outside world through
 * `ReviewDeps`; this file is what the command hands it. Split out for the same reason
 * `publish-deps.ts` exists: the judgement and the process-spawning glue change for
 * different reasons. The two prompt builders sit here because the facts they state —
 * which tree, which commit, which files are frozen, which budget — are the facts this
 * seam already holds.
 *
 * Two choices here are load-bearing rather than mechanical:
 *
 * - **The adversarial loop runs report-only.** It reviews and fixes nothing; the fix
 *   round is this step's, in its own disposable tree. `reportVerdict: "routed"` is what
 *   says so — with `"terminal"` the loop would judge its own round against its own round
 *   cap. `reportRound` is threaded so the reviewer's prompt and ledger row carry the
 *   round of THIS step's loop.
 * - **Both gates get refs, not a pasted diff.** `runLensReview` computes
 *   `git diff <base>...<head>` itself, so the diff is one the lenses can re-read and the
 *   ledger can bind to a commit rather than to a string this step handed over.
 */

import { ADVERSARIAL_FINDING_RULE } from "../adversarial-prompts.ts";
import { runAdversarialLoop } from "../adversarial.ts";
import { execp } from "../exec.ts";
import type { LensReviewSummary, Severity } from "../lens-review-format.ts";
import { cappedSuffix } from "../lens-review-render.ts";
import { runLensReview } from "../lens-review.ts";
import { adversarialChildBoundMs as loopChildBoundMs } from "../review-bounds.ts";
import { resolveLensReviewThreshold } from "../review-threshold-at-base.ts";
import { lensChildBoundMs } from "../spawn-child-bound.ts";
import { makeRunId, spawnSpecialist } from "../spawn.ts";
import { FIXER_DECLINE_RULE, ISSUE_DECLINE_MARKER } from "../work-driver-lens-issue.ts";
import { netGitEnv } from "../work-driver-net-git.ts";
import { judgePolicy } from "../work-driver-policy.ts";
import { verifyTimeoutMs } from "../work-driver-verify-develop-helpers.ts";
import { leanChildOpts } from "./child-opts.ts";
import { loadWorkConfig } from "./config.ts";
import { fetchIssueBody, forgeFor } from "./io.ts";
import type { ReviewWave } from "./review-args.ts";
import { reviewCriteriaSection, reviewIssueBlock, seatIssueBody } from "./review-spec-split.ts";
import type { ReviewDeps } from "./review.ts";
import type { BudgetArms, BudgetFired } from "./step-budget.ts";
import { fenceText, promptText } from "./text-fence.ts";

/** Production dependencies: the real executor, both gates, the spawner, the push. */
export function reviewDeps(headless: boolean): ReviewDeps {
  // Declared as a `let` read at CALL time so a test can install an observer on the object
  // it gets back: a clamp asserted on its input cannot fail — only what reached
  // `runLensReview` can be wrong. Production never sets the field and gets `runLensReview`.
  const deps: ReviewDeps = {
    headless,
    // The push inside `fixRound` is the one git call in this step that leaves the clone,
    // so it gets the driver's non-interactive `netGitEnv` (`GIT_TERMINAL_PROMPT=0` plus
    // `-o BatchMode=yes`) — without it a lean review round could hang on a credential
    // prompt. `o?.cwd` is passed through so `netGitEnv` still reads `core.sshCommand`.
    exec: (cmd, o) =>
      execp(cmd, {
        ...(o ?? {}),
        ...(cmd === "git" && o?.env === undefined ? { env: netGitEnv(process.env, o?.cwd) } : {}),
      }),
    adversarial: (a) => {
      // The budget arms are DESTRUCTURED rather than spread, as the lens seam below does:
      // `arms` is what the reviewer may inherit (the abort signal and the progress hook)
      // with `childBoundMs` taken out of the object AND out of the type so the clamp below
      // cannot be re-supplied by a spread. `loopChildBoundMs()` is the reviewer's own knob
      // and the step's armed bound can only TIGHTEN it. Asserted on the value the reviewer
      // dispatch received in `test-adversarial-reviewer-bound.ts`.
      const { childBoundMs: budgetBoundMs, ...arms } = a.budget.opts;
      return runAdversarialLoop(
        {
          base: a.base,
          head: a.head,
          workCwd: a.cwd,
          context: adversarialContext(a.issue, a.wave, a.blockingFindings),
          issueBody: seatIssueBody(a.issueBody),
          // The split's criteria section, rendered HERE — the only seam that sets
          // it. The /work driver and the `adversarial_loop` tool leave the loop's
          // `reviewCriteria` absent and their prompts stay byte-identical; with the
          // switch off this renders `""` and the loop prints no section.
          //
          // The pair is one decision: `seatIssueBody` strips for exactly the bodies
          // this renders a section for, because the loop prints its issue block from
          // `issueBody` ITSELF. Handing it the raw body while rendering the section
          // put the machine block in the reviewer's prompt twice — once as JSON, once
          // as criteria rows — and the block is what the split exists to keep out.
          ...reviewCriteriaSection(a.issueBody),
          // The reviewer's lane is one verdict; the fix round is this step's, so the loop
          // must not dispatch a fixer of its own.
          reportOnly: true,
          reportVerdict: "routed",
          // One reviewed round per gate call, so the loop never re-dispatches a reviewer.
          reportRound: 1,
          // Lean's worktrees are detached, so the ledger writer cannot recover the branch
          // from HEAD and this is the only place it can come from.
          branch: a.branch,
          commentTimeoutMs: verifyTimeoutMs(),
          processGroup: true,
          ...arms,
          childBoundMs: Math.min(budgetBoundMs ?? Number.POSITIVE_INFINITY, loopChildBoundMs()),
          ...leanChildOpts(a.headless),
        },
        new AbortController().signal,
        makeRunId(),
      );
    },
    lens: async (a) => {
      // The budget arms are DESTRUCTURED rather than spread, so the clamp below cannot be
      // re-supplied: spreading `a.budget.opts` after `childBoundMs: Math.min(...)` hands
      // back the budget's own value and it wins, making `PI_ENSEMBLE_LENS_BOUND_MS` inert.
      // Taking the key out of the type too makes a future spread that could carry it a
      // compile error. Asserted on the delivered value in `test-lean-review-deps-bound.ts`.
      const { childBoundMs: budgetBoundMs, ...arms } = a.budget.opts;
      const summary = await (deps.lensEngine ?? runLensReview)({
        base: a.base,
        head: a.head,
        cwd: a.cwd,
        context: a.context,
        evidence: a.evidence,
        extraFindings: a.extraFindings,
        // The re-review's range is the step's, not the ledger's (see `LensArgs.since`);
        // absent on the full round, which stays the ordinary whole-branch review.
        ...(a.since === undefined ? {} : { since: a.since }),
        // The whole-branch arm of the re-review (`LensArgs.full`).
        ...(a.full === true ? { full: true } : {}),
        // The worktree is detached, so the ledger write and the residual disclosure can
        // only be keyed on a branch this step names.
        branch: a.branch,
        // The run's own PR, when it has one (see `LensArgs.pr`): the number the residual
        // disclosure posts to, so the layer spends no `gh pr list` per round.
        ...(a.pr === undefined ? {} : { pr: a.pr }),
        processGroup: true,
        // The operator's own lever, read here: `lensChildBoundMs()` is the single source
        // for a lens child's wall clock, and a literal here would make that knob inert.
        childBoundMs: Math.min(budgetBoundMs ?? Number.POSITIVE_INFINITY, lensChildBoundMs()),
        // The project's blocking bar, threaded from the step (see `LensArgs.threshold`).
        // Without it the layer falls to `DEFAULT_REVIEW_THRESHOLD` — HIGH — and this step
        // buys a fixer for findings the project said are disclosable.
        ...(a.threshold === undefined ? {} : { threshold: a.threshold }),
        // The test-only lens-child seam (see `ReviewDeps.lensChildFn`).
        ...(deps.lensChildFn === undefined ? {} : { lensChildFn: deps.lensChildFn }),
        ...arms,
        ...leanChildOpts(a.headless),
      });
      return {
        verdict: summary.verdict,
        findings: renderFindings(summary),
        // The blocking rows, structured, for the step's re-review decision (see
        // `LensRound.reported`). The layer's own `reported` set, so the step reads the same
        // list the verdict and the ledger's `hasCritical` were computed from. The layer's
        // per-row `resolved` notices are NOT threaded: the step states no fate for any row.
        reported: summary.findings,
        // The rows the advisory split moved out of `reported`, carried so the NOT ADDRESSED
        // check cannot be discounted into a pass (see `LensRound.advisory`). `[]` means the
        // split discounted nothing — a step that read `undefined` as "skip the check" would
        // be the hole this closes.
        advisory: summary.advisory ?? [],
        usage: summary.usage,
        // The per-lens records, so the step bills one row per child that ran rather than
        // one per round (see `lensRows` in `step-budget.ts`).
        lenses: summary.lenses,
        // The one field that distinguishes "no lens ran" from "lenses ran and found
        // nothing", and the only place it is stated — `verdict` says APPROVED for both.
        ...(summary.noReview === true ? { noReview: true } : {}),
        // The range the round RANGED OVER. `assertRangedOverTheFix` compares the step's
        // `since`/`head` against THIS field, so dropping it makes a scoped re-review
        // indistinguishable from a whole-branch one. Carried only when the layer set it:
        // an invented stamp would be a lie about a range.
        ...(summary.deltaReview === undefined ? {} : { deltaReview: summary.deltaReview }),
        // The disclosure the round owed and may not have made: `runLensReview` posts it and
        // reports a failed post here, so this step only carries the reason onward.
        ...(summary.note === undefined ? {} : { note: summary.note }),
      };
    },
    dispatch: (spec, o) =>
      // The arms are forwarded KEY BY KEY, not spread, because this dispatch also adds its
      // own options: a spread would let a future arm collide silently with
      // `processGroup`/`leanChildOpts`. `budgetTurns` is the turn-budget denominator for a
      // fixer — drop this line and a lean fixer is killed at its turns ceiling with nothing
      // committed.
      spawnSpecialist(spec, {
        processGroup: true,
        writeFence: o.writeFence,
        extraArgs: o.extraArgs,
        ...(o.childBoundMs === undefined ? {} : { childBoundMs: o.childBoundMs }),
        budgetTurns: o.budgetTurns,
        ...(o.signal === undefined ? {} : { signal: o.signal }),
        ...(o.onProgress === undefined ? {} : { onProgress: o.onProgress }),
        ...leanChildOpts(headless),
      }),
    fetchIssueBody,
    // The bound stop's disclosure, through the same forge adapter every other lean
    // post uses, so the body meets the public-text check every other comment meets.
    prComment: async (repoRoot, prNumber, body) => {
      const forge = await forgeFor(repoRoot);
      if (forge === undefined)
        throw new Error("no forge adapter: cannot post the unreviewed-lanes comment");
      await forge.prComment(prNumber, body);
    },
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
    // One doctrine read and one judge child for the whole review step (see
    // `ReviewDeps.reviewThreshold`). The base is the run's own base commit, never the
    // working tree, so the fixer cannot rewrite the doctrine its findings are judged
    // against.
    reviewThreshold: (repoRoot, baseSha) =>
      resolveLensReviewThreshold({
        judge: judgePolicy(repoRoot, {
          processGroup: true,
        } satisfies NonNullable<Parameters<typeof judgePolicy>[1]>),
        execFn: (cmd, o) => execp(cmd, o ?? {}),
        repoRoot,
        baseRef: baseSha,
        where: { repoRoot },
      }),
  };
  return deps;
}

/**
 * The round's findings as one line each, severity and source first. The shape is the
 * fixer's brief's: a fixer handed a wall of prose re-derives a solution from scratch, so
 * it needs the lens and the location the fix has to land at.
 */
export function renderFindings(summary: LensReviewSummary): string {
  return summary.findings
    .map(
      (f) =>
        `- [${f.severity}${cappedSuffix(f)}] ${f.lens} ${f.path}${f.line === undefined ? "" : `:${String(f.line)}`}: ${f.title}${f.description === undefined || f.description === "" ? "" : ` — ${f.description}`}`,
    )
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// The briefs. Both exist because lean has no caller to hand the step a context string:
// the adversarial loop and the six-lens pass each take one free-text `context`, and here
// the step is the caller. Short on purpose: the diff, the issue body and the finding
// lists are the substance. The fix brief is the more important one — a fixer handed
// findings without a diff, an issue or a tree re-derives a solution from scratch, which
// is how a fix round undoes the previous fix.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The framing the adversarial reviewer is dispatched with. States the one-wave policy
 * rather than a round count, so the reviewer does not pace itself across a loop that does
 * not exist. The fix pass also gets the findings the fix range was allowed to contain, so
 * a CRITICAL on untouched bytes can be told from one the fix introduced.
 */
function adversarialContext(
  issue: number,
  wave: ReviewWave,
  blockingFindings: string | undefined,
): string {
  const scope =
    wave === "full"
      ? "the full review of the branch, before any fix"
      : "the re-review of the fix wave's own commits — read the fix, not the whole branch";
  const known =
    blockingFindings === undefined || blockingFindings.trim() === ""
      ? ""
      : `\n\nKnown findings the fix was asked to answer (a finding here is not new; a CRITICAL you find in code the fix did not touch is):\n${fenceText(blockingFindings, 20_000)}`;
  return `/work-lean issue #${String(issue)}: gating the run's committed head before it merges (review step, one fix wave — this pass is ${scope}). What you report here is the last the step will pay a fixer for.${known}`;
}

/**
 * The framing every lens is dispatched with. `issueBody` is the run's issue, printed as
 * the block every lens judges the diff against, threaded from the step so both passes and
 * the fixer see the same text. `full` is the layer's whole-branch opt-out, threaded so the
 * range wording names the arm the step bought.
 */
export function lensContext(
  issue: number,
  wave: ReviewWave,
  extra: { carried?: string; fixDelta?: string; issueBody?: string; full?: boolean } = {},
): string {
  // The range wording FOLLOWS THE ARM the step bought, not the delta section printed
  // beside it: `fixDelta` returns a section on BOTH arms, so it cannot say which this is —
  // and a whole-branch re-review told it reads the fix's commits wants a delta verdict from
  // the one round that must judge the branch to retire a carried CRITICAL.
  const scope =
    wave === "full" || extra.full === true
      ? "full review of the branch"
      : "re-review of the fix wave's commits";
  const parts = [`/work-lean issue #${String(issue)}, lens-review ${scope}`];
  const issueBlock = reviewIssueBlock(extra.issueBody, ADVERSARIAL_FINDING_RULE);
  if (issueBlock !== "") parts.push(issueBlock.trim());
  const carried = extra.carried?.trim();
  if (carried !== undefined && carried !== "")
    parts.push(
      // The carried findings are reviewer-authored prose crossing into six children's
      // briefs, and the branch's rule is that such a value is DISARMED AT THE PRINT SITE:
      // one `### heading` inside a finding becomes a section of the lens prompt the step
      // never wrote, and the lenses are told to weigh this block as evidence.
      `OUTSTANDING FROM THE ADVERSARIAL GATE (non-blocking there — judge them yourself):\n${fenceText(carried, 20_000)}`,
    );
  const delta = extra.fixDelta?.trim();
  if (delta !== undefined && delta !== "") parts.push(delta);
  return parts.join("\n\n");
}

/**
 * What the fixer is told about the tree it works in.
 *
 * The child's cwd is the worktree, but a model that has to infer which directory is its
 * own will write somewhere else, so the three git facts are stated: where, on what
 * branch, against what base. `head` is the commit the review read — the tree the findings
 * describe.
 */
export interface ReviewFixArgs {
  issue: number;
  /** Which pass of the one wave raised the findings this fixer answers. */
  wave: ReviewWave;
  /** Which gate produced the findings; names the list in the brief. */
  gate: string;
  findings: string;
  /** The run's issue body, printed into the brief so the fixer cannot "fix" a finding by
   * violating a stated requirement. Threaded from the one `issueBody` the step read. */
  issueBody?: string;
  /** Absolute path of the disposable tree the child works in. */
  worktree: string;
  /** The repo the tree belongs to, for the write fence's `repo` field. */
  repoRoot: string;
  branch: string;
  base: string;
  head: string;
  /** The frozen acceptance test paths — the child may not edit these. */
  frozenPaths: string[];
  /** The step's armed budget, threaded to the child's bound/abort/progress. */
  budget: BudgetArms;
  /** Where `runFixer` reports a budget breach back to `fixRound`. */
  stop: { fired?: BudgetFired };
}

/** The largest tree or branch name this step will print into a brief. */
const NAME_MAX_CHARS = 200;

export function fixPrompt(opts: ReviewFixArgs): string {
  // Every value below that did not originate in this file goes through `promptText`:
  // `frozenPaths` are keys read back from the durable state file and `gate` is
  // reviewer-influenced prose. A newline in either opened a section of this brief the step
  // never wrote. (`frozenKeyProblem` in `state-outcome.ts` refuses a control character in
  // a frozen key at load, so this is defence at the print site.)
  const frozenList =
    opts.frozenPaths.length === 0
      ? "(none — this run froze no tests)"
      : opts.frozenPaths.map((p) => `- \`${promptText(p, NAME_MAX_CHARS)}\``).join("\n");
  const gate = promptText(opts.gate, 120);
  // `head` and `base` are git reads whose bytes an earlier stage or a hostile branch can
  // influence. Every sibling value here already goes through `promptText` at the print
  // site; one raw `\n` in a head opened a section of the fixer's brief the step never
  // wrote. Same call, same rule, for the two that were left out.
  const head = promptText(opts.head, NAME_MAX_CHARS);
  const base = promptText(opts.base, NAME_MAX_CHARS);
  // The issue, fenced and bounded like every other block here. The fixer is the one model
  // in this step that EDITS the tree: a finding that contradicts the ticket must be named
  // in its reply, not implemented. Lean prints the BODY only — no cached title exists.
  //
  // The FULL decline rule is printed once, in its own section below, because it is a
  // procedure and not one sentence; printing it twice is one rule to reconcile twice.
  const issueBlock = reviewIssueBlock(
    opts.issueBody,
    "A finding you cannot apply without contradicting it is declined, not implemented — how is stated below.",
  );
  // Printed as its own section because a brief with no issue block has no requirement to
  // cite, and the rule must then not appear at all.
  const declineRule =
    issueBlock === ""
      ? ""
      : `\n## Declining a finding that contradicts the issue\n\n${FIXER_DECLINE_RULE}\n`;
  return `You are fixing the findings one review gate raised against this run's work (issue #${String(
    opts.issue,
  )}, review step, one fix wave, gate: ${gate}).
${issueBlock}${declineRule}
## The findings

${fenceText(opts.findings, 20_000)}

## The tree

- Worktree: \`${promptText(opts.worktree, NAME_MAX_CHARS)}\` — work ONLY here.
- Branch: \`${promptText(opts.branch, NAME_MAX_CHARS)}\`
- Reviewed commit: \`${head}\` (base \`${base}\`)

Read the diff you are changing with \`git diff ${base}...${head}\` before you edit anything: these findings describe that tree, not the whole repository.

## Untouchable

These files are the run's acceptance contract — frozen, and proved red before the implementation existed. Do NOT edit, rename or delete any of them, and do not add a new test file:

${frozenList}

A fix that turns a frozen test green by changing it has destroyed the only evidence this run has. If a finding can only be resolved by changing one of these, leave it and say so in your reply.

## What to do

Fix every finding you can without widening the change: no guards for inputs that cannot occur, no refactors beside the fix, no comments narrating this round. Check your own work by running the frozen tests and the project's fast typecheck and lint — **do not run the project's full test suite**, the verify step runs it.

Work the findings highest severity first, and commit each fix as you finish it rather than saving the commits for the end: if this wave has a turn budget, one that runs out keeps only what it committed, so an uncommitted fix is a fix that did not happen. A finding whose closure needs an edit to a file in the Untouchable list, or a change outside this diff, is out of scope — name it in your reply and move on to the next rather than spending the wave on it.

Commit what you changed before you reply (do not push, do not amend, do not rebase). If a finding is wrong or out of scope, leave it and say why in your reply rather than arguing with it in code.`;
}
