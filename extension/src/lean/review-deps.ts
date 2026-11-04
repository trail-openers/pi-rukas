/**
 * lean/review-deps — the production wiring of the `review` step, and the briefs
 * its children are dispatched with.
 *
 * `review.ts` is the decision procedure and takes every outside world through
 * `ReviewDeps`; this file is what the command hands it. Split out for the same
 * reason `publish-deps.ts` exists: the judgement and the process-spawning glue
 * change for different reasons, and a test drives the first with stubs while
 * never loading the second. The two prompt builders sit here rather than in a
 * module of their own because the facts they state — which tree, which commit,
 * which files are frozen, which budget — are the facts this seam already holds.
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

import {
  ADVERSARIAL_FINDING_RULE,
  fencedIssueBody,
  fencedIssuePromptBlock,
} from "../adversarial-prompts.ts";
import { runAdversarialLoop } from "../adversarial.ts";
import { execp } from "../exec.ts";
import type { LensReviewSummary, Severity } from "../lens-review-format.ts";
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
import { fetchIssueBody } from "./io.ts";
import type { ReviewWave } from "./review-args.ts";
import type { ReviewDeps } from "./review.ts";
import type { BudgetArms, BudgetFired } from "./step-budget.ts";
import { fenceText, promptText } from "./text-fence.ts";

/** Production dependencies: the real executor, both gates, the spawner, the push. */
export function reviewDeps(headless: boolean): ReviewDeps {
  // Declared as a `let` read at CALL time (not at literal-build time) so a test can
  // install an observer on the object it gets back: the lens engine is the one
  // outside-world call a test of THE CLAMP has to observe, and a clamp asserted on
  // its input cannot fail — the input was correct in the bug, and only what reached
  // `runLensReview` was wrong. Production never sets the field and gets
  // `runLensReview`.
  const deps: ReviewDeps = {
    headless,
    // The push inside `fixRound` is the one git call in this step that leaves the
    // clone, so it is the one the executor gives the driver's non-interactive env
    // to — the same `netGitEnv` `publish-deps.ts` applies (#1095: `GIT_TERMINAL_PROMPT=0`
    // plus `-o BatchMode=yes`, so ssh fails instead of reading a passphrase from
    // /dev/tty). Without it a lean review round could hang the step on a
    // credential prompt no other step in lean can hang on. `o?.cwd` is passed
    // through so `netGitEnv` still reads the repo's own `core.sshCommand`.
    exec: (cmd, o) =>
      execp(cmd, {
        ...(o ?? {}),
        ...(cmd === "git" && o?.env === undefined ? { env: netGitEnv(process.env, o?.cwd) } : {}),
      }),
    adversarial: (a) => {
      // The budget arms are DESTRUCTURED rather than spread, exactly as the lens
      // seam below does: `arms` is what the reviewer may inherit (the abort signal
      // the turns / tokens levers fire and the progress hook that measures them),
      // with `childBoundMs` taken out of the object AND out of the type so the
      // clamp below cannot be re-supplied by a spread and win — the lens leg lost
      // its operator knob that way. `loopChildBoundMs()` is the reviewer's own
      // knob (`PI_ENSEMBLE_ADVERSARIAL_BOUND_MS`, read there) and the step's armed
      // bound can only TIGHTEN it: the smaller of the two is the bound, which is
      // what a budget must mean. Asserted on the value the reviewer dispatch
      // actually received in `test-adversarial-reviewer-bound.ts`, never here.
      const { childBoundMs: budgetBoundMs, ...arms } = a.budget.opts;
      return runAdversarialLoop(
        {
          base: a.base,
          head: a.head,
          workCwd: a.cwd,
          context: adversarialContext(a.issue, a.wave, a.blockingFindings),
          issueBody: a.issueBody,
          // The reviewer's lane is one verdict; the fix round is this step's, so
          // the loop must not dispatch a fixer of its own.
          reportOnly: true,
          reportVerdict: "routed",
          // One reviewed round per gate call, so the loop's own `for` never gets
          // past its first iteration and never re-dispatches a reviewer here.
          reportRound: 1,
          // Lean's worktrees are detached, so the ledger writer cannot recover
          // the branch from HEAD and this is the only place it can come from.
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
      // The budget arms are DESTRUCTURED rather than spread, so the clamp below
      // cannot be re-supplied: spreading `a.budget.opts` after
      // `childBoundMs: Math.min(...)` handed back the budget's own `childBoundMs`
      // and it WON, which made `PI_ENSEMBLE_LENS_BOUND_MS` silently inert — a hung
      // lens child ran to the generic bound and the operator's tuning knob was
      // decoration. `arms` is what the lens is allowed to inherit (the abort signal
      // and the progress hook) with the one key it must not own taken out of the
      // object AND out of the type, so a future spread that could carry a
      // `childBoundMs` is a compile error rather than a bug waiting for someone to
      // reorder the lines. Asserted on the delivered value in
      // `test-lean-review-deps-bound.ts`, never on the input.
      const { childBoundMs: budgetBoundMs, ...arms } = a.budget.opts;
      const summary = await (deps.lensEngine ?? runLensReview)({
        base: a.base,
        head: a.head,
        cwd: a.cwd,
        context: a.context,
        evidence: a.evidence,
        extraFindings: a.extraFindings,
        // The re-review's range is the step's, not the ledger's: the head the fix
        // wave started from, so the round reads the fix and nothing else (see
        // `LensArgs.since`). Absent on the full round, which stays the layer's
        // ordinary whole-branch review.
        ...(a.since === undefined ? {} : { since: a.since }),
        // The worktree is detached, so the ledger write and the residual
        // disclosure can only be keyed on a branch this step names.
        branch: a.branch,
        // The run's own PR, when it has one (see `LensArgs.pr`): the number the
        // residual disclosure posts to, so the review layer does not spend a
        // `gh pr list` per ISSUES_FOUND round rediscovering it.
        ...(a.pr === undefined ? {} : { pr: a.pr }),
        processGroup: true,
        // The operator's own lever, read here rather than a number copied into
        // this file: `lensChildBoundMs()` is the single source for a lens child's
        // wall clock (`PI_ENSEMBLE_LENS_BOUND_MS`), and a literal here would make
        // that knob silently inert for every lean run. The step's armed `childBoundMs`
        // can only ever tighten it, never lengthen it — the smaller of the two is
        // the bound, which is what a budget must mean.
        childBoundMs: Math.min(budgetBoundMs ?? Number.POSITIVE_INFINITY, lensChildBoundMs()),
        // The project's blocking bar, threaded from the step (see
        // `LensArgs.threshold`). Without it the review layer falls to
        // `DEFAULT_REVIEW_THRESHOLD` — HIGH — and a round whose only findings
        // sit at that bar reads as ISSUES_FOUND, so this step buys a fixer for
        // findings the project said are disclosable rather than blocking.
        ...(a.threshold === undefined ? {} : { threshold: a.threshold }),
        // The test-only lens-child seam (see `ReviewDeps.lensChildFn`): set it and
        // the real engine fans out over the test's children instead of Pi ones.
        ...(deps.lensChildFn === undefined ? {} : { lensChildFn: deps.lensChildFn }),
        ...arms,
        ...leanChildOpts(a.headless),
      });
      return {
        verdict: summary.verdict,
        findings: renderFindings(summary),
        // The blocking rows, structured, for the step's re-review decision (see
        // `LensRound.reported`). The layer's own `reported` set is what the
        // summary carries, so the step reads the same list the verdict, the
        // severity counts and the ledger's `hasCritical` were computed from — a
        // second reading here would be a second definition of "blocking". The
        // layer's per-row `resolved` notices are NOT threaded: the step no longer
        // states a fate for any row, so nothing reads them (a field carried for a
        // reader that does not exist is a liability, not a saving).
        reported: summary.findings,
        // The rows the advisory split moved out of `reported`, carried so the
        // NOT ADDRESSED check cannot be discounted into a pass (see
        // `LensRound.advisory`). The layer's own list, restated as an empty array
        // when it set none — `[]` means "the split discounted nothing", which is
        // the same answer the field's absence means in the layer, and a step that
        // read `undefined` as "skip the check" would be the hole this closes.
        advisory: summary.advisory ?? [],
        usage: summary.usage,
        // The per-lens records, so the step bills one row per child that ran
        // rather than one row per round (see `lensRows` in `step-budget.ts`).
        lenses: summary.lenses,
        // The one field that distinguishes "no lens ran" from "lenses ran and
        // found nothing", and the only place it is stated — `verdict` says
        // APPROVED for both. Dropping it here is what would let the empty-delta
        // outcome read as a clean review.
        ...(summary.noReview === true ? { noReview: true } : {}),
        // The range the round RANGED OVER. The step's own claim is not evidence of
        // it: `assertRangedOverTheFix` compares the step's `since`/`head` against
        // THIS field, so dropping it here is what makes a scoped re-review
        // indistinguishable from a whole-branch one — the guard refuses the round
        // and the run hands back. Carried only when the layer set it: a full review
        // has no delta to name, and an invented stamp would be a lie about a range.
        ...(summary.deltaReview === undefined ? {} : { deltaReview: summary.deltaReview }),
        // The disclosure the round owed and may not have made. `runLensReview`
        // posts it itself for an ISSUES_FOUND round and reports a failed post
        // here, so this step adds nothing and only carries the reason to the
        // operator as part of the handback cause.
        ...(summary.note === undefined ? {} : { note: summary.note }),
      };
    },
    dispatch: (spec, o) =>
      // The arms are forwarded KEY BY KEY, not spread, because this is the one
      // lean dispatch that also adds its own options: an object spread here would
      // let a future arm collide silently with `processGroup`/`leanChildOpts`
      // rather than being named. `budgetTurns` is the #1991 steer's denominator
      // (#1988 follow-up 4) — drop this line and a lean fixer is killed at its
      // turns ceiling with nothing committed and nothing said to it.
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
    loadConfig: (repoRoot, baseSha) => loadWorkConfig(execp, repoRoot, baseSha),
    // One doctrine read and one judge child for the whole review step: the step
    // calls this once, before its first round (see `ReviewDeps.reviewThreshold`).
    // The base is the run's own base commit, never the working tree, so the fixer
    // cannot rewrite the doctrine its own findings are judged against.
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

// ─────────────────────────────────────────────────────────────────────────────
// The briefs. Both exist because lean has no caller to hand the step a context
// string: the adversarial loop and the six-lens pass each take one free-text
// `context`, and in the frozen driver the driver composed it — here the step is
// the caller, so the framing is this module's. Short on purpose: the diff, the
// issue body and the finding lists are the substance, and the loop and the lens
// roster already say what to do with them.
//
// The fix brief is the more important one. A fixer handed findings without a
// diff, an issue or a tree re-derives a solution from scratch — the frozen
// driver's fix-developer got the reviewer's entire reply as "findings" and no
// diff at all (#664), which is how a fix round undid a fix. So the finding text
// arrives fenced and bounded (the `text-fence.ts` rule, one implementation), the
// diff arrives as the command the step actually ran, and the frozen acceptance
// tests are named as untouchable — the same claim `build-prompt` makes, because
// the fixer is the second model that gets a worktree with the contract's tests
// in it.
// ─────────────────────────────────────────────────────────────────────────────

/** The framing the adversarial reviewer is dispatched with.
 *
 * States the one-wave policy rather than a round count: the reviewer is told
 * which pass it is on and that its findings are the last thing this step will
 * pay a fixer for, so it does not pace itself across a loop that does not exist.
 * The fix pass also gets the findings the fix range was allowed to contain, so a
 * CRITICAL it raises on untouched bytes can be told from one the fix introduced.
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

/** The framing every lens is dispatched with.
 *
 * `issueBody` is the run's issue, printed as the block every lens judges the
 * diff against. It arrives through the step rather than being fetched here
 * because the step reads it once (`lean/review.ts`) and both of its passes —
 * and the fixer — must see the same text. */
export function lensContext(
  issue: number,
  wave: ReviewWave,
  extra: { carried?: string; fixDelta?: string; issueBody?: string } = {},
): string {
  const parts = [
    `/work-lean issue #${String(issue)}, lens-review ${
      wave === "full" ? "full review of the branch" : "re-review of the fix wave's commits"
    }`,
  ];
  // The issue block rides the same channel as the carried findings, so it obeys
  // the same rule: disarmed at the print site. An issue body is author text —
  // one `### heading` or a ``` fence inside it would otherwise open a section
  // of six lens prompts the step never wrote.
  const issueBlock = fencedIssuePromptBlock(
    extra.issueBody,
    ADVERSARIAL_FINDING_RULE,
    fencedIssueBody,
  );
  if (issueBlock !== "") parts.push(issueBlock.trim());
  const carried = extra.carried?.trim();
  if (carried !== undefined && carried !== "")
    parts.push(
      // The findings the adversarial gate passed on are reviewer-authored prose
      // read back off a dispatch result, and they cross into six children's briefs
      // through this line. The branch's rule is that a value crossing into a
      // child's brief is DISARMED AT THE PRINT SITE — `promptText` for the
      // fixer's `head`/`base`, `fenceText` for the fixer's findings — because one
      // `### heading` inside a carried finding becomes a section of the lens
      // prompt the step never wrote, and the lenses are told to weigh this block
      // as evidence. Same seam, same rule, same bound as the fixer's findings.
      `OUTSTANDING FROM THE ADVERSARIAL GATE (non-blocking there — judge them yourself):\n${fenceText(carried, 20_000)}`,
    );
  const delta = extra.fixDelta?.trim();
  if (delta !== undefined && delta !== "") parts.push(delta);
  return parts.join("\n\n");
}

/**
 * What the fixer is told about the tree it works in.
 *
 * The child's cwd is the worktree, but a model that has to infer which directory
 * is its own will write somewhere else, so the three git facts it needs are
 * stated: where, on what branch, against what base. `head` is the commit the
 * review read — the tree the findings describe. A fixer given only the branch
 * cannot tell whether it sits at the reviewed commit or one behind it.
 */
export interface ReviewFixArgs {
  issue: number;
  /** Which pass of the one wave raised the findings this fixer answers. */
  wave: ReviewWave;
  /** Which gate produced the findings; names the list in the brief. */
  gate: string;
  findings: string;
  /**
   * The run's issue body, printed into the brief so the fixer cannot "fix" a
   * finding by violating a stated requirement of the ticket. Threaded from the
   * one `issueBody` the step read (`lean/review.ts`), never re-fetched.
   */
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
  // Every value below that did not originate in this file goes through
  // `promptText`: `frozenPaths` are keys read back from the durable state file
  // and `gate` is reviewer-influenced prose. A newline in either opened a section
  // of this brief the step never wrote — the same spoofing `text-fence` exists
  // for in a PR body, one line rather than one block. (`frozenKeyProblem` in
  // `state-outcome.ts` refuses a control character in a frozen key at load, so
  // this is defence at the print site rather than the only check.)
  const frozenList =
    opts.frozenPaths.length === 0
      ? "(none — this run froze no tests)"
      : opts.frozenPaths.map((p) => `- \`${promptText(p, NAME_MAX_CHARS)}\``).join("\n");
  const gate = promptText(opts.gate, 120);
  // `head` and `base` are git reads whose bytes an earlier stage or a hostile
  // branch can influence — a ref name, a commit subject, or a value an earlier step
  // recorded. Every sibling value in this brief already goes through `promptText`
  // at the print site (`worktree`, `branch`, `gate`, `frozenPaths`), and the
  // inconsistency WAS the vulnerability: one raw `\n` in a head opened a section of
  // the fixer's brief the step never wrote, and one `\r` rewrote the line the
  // instructions sit on. Same call, same rule, for the two that were left out.
  const head = promptText(opts.head, NAME_MAX_CHARS);
  const base = promptText(opts.base, NAME_MAX_CHARS);
  // The issue, fenced and bounded like every other block in this brief. The
  // fixer is the one model in this step that EDITS the tree: a finding that
  // contradicts what the ticket asked for must be named in its reply, not
  // implemented. Lean prints the BODY only — it has no cached title to print,
  // and inventing one from the first line of a body would be a claim the step
  // did not read off the forge.
  //
  // The lead-in names the block's purpose; the FULL decline rule is printed
  // once, in the section below, because the rule is a procedure (marker, what
  // may be cited, what a declined row costs) and not one sentence. The same
  // text twice in one brief is one rule the reader has to reconcile twice.
  const issueBlock = fencedIssuePromptBlock(
    opts.issueBody,
    "A finding you cannot apply without contradicting it is declined, not implemented — how is stated below.",
    fencedIssueBody,
  );
  // The rule that tells the fixer HOW to refuse. Printed as its own section
  // rather than folded into the prose below, because a brief with no issue block
  // has no requirement to cite and the rule must then not appear at all.
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
