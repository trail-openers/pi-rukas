/**
 * work-driver-adversarial-fanout-run — the per-workstream adversarial pass of
 * the fan-out (#486), split from work-driver-adversarial-fanout.ts for the
 * AGENTS.md §12 file-size limit. Leaf module: one workstream in, one
 * `AdversarialOutcome` out; the aggregate/retry loop stays with the caller.
 *
 * #1634 — the diff read here is the discriminated one, so an unreadable tree is
 * a NO-VERDICT infra failure and never an approval.
 */

import { runAdversarialLoop } from "./adversarial.ts";
import { adversarialFixDelta } from "./fix-delta.ts";
import { slowRecorder } from "./slow-events.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { cycleChildOpts } from "./work-cycle-trust.ts";
import {
  capKillOutcomeFields,
  retryLadderKillCause,
} from "./work-driver-adversarial-fanout-capkill.ts";
import {
  DiffRereadError,
  diffUnreadableOutcome,
  isDiffRereadError,
  readDiffOrFailureOutcome,
} from "./work-driver-adversarial-fanout-diff.ts";
import { interpretReview, reviewRoundFor, reviewTrack } from "./work-driver-adversarial-fix.ts";
import { roundsRecords } from "./work-driver-adversarial-reentry.ts";
import { scopeFor } from "./work-driver-adversarial-scope.ts";
import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { readWorktreeDiff } from "./work-driver-diff-read.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { verifyTimeoutMs } from "./work-driver-verify-develop-helpers.ts";
import { driverGateCmd } from "./work-driver-verify-pr17.ts";
import type { PipelineState } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";

/** What one workstream's pass needs from the fan-out's shared context. */
export interface RunOneArgs {
  ctx: CycleContext;
  state: WorkState;
  /** N>1: one `branch-completed` event per workstream. */
  multi: boolean;
  /** The workstream map, for the sibling-scope framing (#1137). */
  wsMap: PipelineState["workstreams"];
  /** The outcome a prior pass recorded for this workstream, if any. */
  priorOutcomes: Map<string, string>;
}

/**
 * One workstream's adversarial pass: read its diff, then run (or skip) the
 * reviewer loop and fold the reply into an outcome. Never approves on an
 * unreadable diff (#1634), and never throws — a loop that throws becomes a
 * `threw` outcome with a `dispatch-failed` event.
 */
export async function runAdversarialWorkstream(
  id: string,
  args: RunOneArgs,
): Promise<AdversarialOutcome> {
  const { ctx, state, multi, wsMap, priorOutcomes } = args;
  const cwd = state.pipelineState.worktrees?.[id] ?? ctx.repoRoot;
  if (!state.pipelineState.worktrees?.[id])
    trace(`work-driver: adversarial[${id}] — no worktree, reviewing at repoRoot`);
  const label = multi ? `adversarial[${id}]` : "adversarial_loop";
  const scope = scopeFor(wsMap, id);
  const startedAt = Date.now();
  const orchestratorJobId = makeRunId();
  // Per-workstream diff: `git diff <baseSha>..HEAD` from this worktree
  // — exactly what ONE developer committed. After a developer commit
  // (post-#453) `git diff HEAD` is empty (HEAD IS the commit), so we
  // diff against the detach point. Without baseSha we fall back to
  // `git diff HEAD` (pre-commit semantics for uncommitted work).
  const baseSha = state.pipelineState.baseSha;
  // #1634 — the read that can say "I could not tell", plus its failure route.
  // `fetchDiff` returned "" for EVERY failure (no cwd, a non-repository
  // directory, a `git diff` that threw or exited non-zero), and the guard below
  // read that as a clean tree: skipped + APPROVED with zero rounds. A killed
  // develop round whose worktree nobody could read was approved and merged.
  // Mirror of #384 on the lens side.
  const read = await readDiffOrFailureOutcome({
    id,
    cwd,
    baseSha,
    multi,
    label,
    jobId: orchestratorJobId,
    startedAt,
    priorOutcomes,
    execFn: ctx.verifyExecFn,
  });
  if (!read.ok) return read.outcome;
  const diff = read.diff;

  // #286 — empty-diff short-circuit (a full reviewer spawn on an empty
  // diff is pure waste; lens review has had this guard since PR6). Reached
  // ONLY on an ok read, so empty here means git said so (#1634).
  const emptySkipDisabled = process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP === "0";
  if (!emptySkipDisabled && !diff.trim()) {
    trace(`work-driver: adversarial[${id}] skipped — empty diff`);
    return {
      id,
      ok: true,
      rounds: 0,
      records: [],
      infra: false,
      threw: false,
      skipped: true,
      priorInfra: priorOutcomes.get(id) === "infra-failure",
      completionEvent: {
        kind: "adversarial-skipped-empty-diff",
        at: Date.now(),
        workstreamId: id,
      },
      branchEvent: multi
        ? {
            kind: "branch-completed",
            step: "adversarial",
            workstreamId: id,
            ok: true,
            ms: Date.now() - startedAt,
            at: Date.now(),
          }
        : undefined,
    };
  }

  const loopFn = ctx.adversarialLoopFn ?? runAdversarialLoop;
  let result: DispatchResult;
  try {
    result = await loopFn(
      {
        diff,
        context: multi
          ? `/work issue #${ctx.issue}: gating diff for workstream "${id}" before commit (Step 5).`
          : `/work issue #${ctx.issue}: gating diff before commit (Step 5).`,
        workCwd: cwd,
        commentTimeoutMs: verifyTimeoutMs(),
        commentExecFn: ctx.verifyExecFn,
        // Re-read before each round. Without this, rounds 2+ are prompted
        // with the pre-fix diff and the reviewer has to notice for itself
        // that its earlier objections were already addressed.
        getDiff: async () => {
          const reread = await readWorktreeDiff(cwd, baseSha, ctx.verifyExecFn);
          // #1634 — a failed re-read throws the READ's own failure type, not a
          // plain Error: the caller below turns it into the same no-verdict
          // `diffUnreadable` outcome a failed round-1 read produces. It used to
          // throw a bare Error the reviewer loop caught, noted, and carried on
          // reviewing the previous round's diff with — to an APPROVED with no
          // diff behind it (#859's "keep the previous diff" is the wrong rule
          // for a gate).
          if (!reread.ok) throw new DiffRereadError(reread.reason);
          return reread.diff;
        },
        // What the fix pass before this re-review changed, to be read first.
        fixDelta: await adversarialFixDelta(state, id, cwd),
        // #278 — the reviewer judges the diff against what was ASKED FOR,
        // not just against generic code quality. Absent on cycles resumed
        // from older state files, which degrade to the previous behaviour.
        issueBody: state.pipelineState.issueBodyArtifact,
        // #1137 — judge this workstream against its OWN scope; sibling
        // criteria are listed as out of scope in the prompt.
        ...(scope !== undefined ? { scope } : {}),
        // The develop gate (or the fix pass's) passed this command on this
        // tree to get here; the reviewer must not spend a gate re-proving it.
        gateCmd: await driverGateCmd(ctx.repoRoot),
        // #799 — the slow-run recorder collects into the driver's pending
        // buffer (keyed by this cycle's primary issue); the step boundary
        // (routeStepOutcome) drains it — the fan-out folds nothing of its
        // own any more.
        onSlow: slowRecorder(ctx.issue, "adversarial"),
        // #912 — caller-supplied branch for the review-ledger write
        // (driver worktrees are detached; the ledger writer cannot
        // recover the branch name from a detached HEAD).
        branch: state.pipelineState.branchName,
        // #1114 — one reviewer dispatch; the driver routes the verdict.
        reportOnly: true,
        reportVerdict: "routed",
        reportRound: reviewRoundFor(state, id),
        // #1024 — headless: the cycle's signal reaches the inner children and
        // each one leads its own process group.
        processGroup: ctx.processGroup,
        // #1666 — a headless cycle's inner children run under trust, as interactive ones do.
        ...cycleChildOpts(ctx),
      } satisfies Parameters<typeof runAdversarialLoop>[0],
      // Interactive runs have no cycle signal; spawn-level timeouts in
      // spawn.ts (per-role) bound the work there.
      ctx.signal ?? new AbortController().signal,
      orchestratorJobId,
    );
  } catch (err) {
    // #1634 — a failed re-read is the driver's own read failing, not a child
    // that died: same no-verdict outcome, same cap, never an approval on the
    // stale diff the loop would otherwise have carried forward. `adversarial.ts`
    // RETHROWS a caller-supplied `getDiff` that throws for exactly this reason,
    // so the throw reaches here rather than being noted and ridden out; the
    // shape is recognised by its structural discriminant, never by prose.
    if (isDiffRereadError(err)) {
      return diffUnreadableOutcome({
        id,
        cwd,
        multi,
        label,
        jobId: orchestratorJobId,
        startedAt,
        priorOutcomes,
        reason: err.reason,
      });
    }
    const errMsg = (err as Error).message?.slice(-200);
    return {
      id,
      ok: false,
      rounds: 0,
      records: [],
      infra: false,
      threw: true,
      skipped: false,
      priorInfra: priorOutcomes.get(id) === "infra-failure",
      rejectionText: `adversarial loop threw: ${errMsg}`,
      errorTail: errMsg,
      failureEvent: {
        kind: "dispatch-failed",
        step: "adversarial",
        role: "adversarial-loop",
        jobId: orchestratorJobId,
        label,
        ms: Date.now() - startedAt,
        at: Date.now(),
        errorTail: errMsg,
      },
      branchEvent: multi
        ? {
            kind: "branch-completed",
            step: "adversarial",
            workstreamId: id,
            ok: false,
            ms: Date.now() - startedAt,
            error: errMsg,
            at: Date.now(),
          }
        : undefined,
    };
  }

  const completionEvent = await buildCompletionEvent(
    ctx,
    "adversarial",
    "adversarial-loop",
    label,
    // #298 — a REJECTED verdict is a COMPLETED review, not a dispatch
    // failure (pre-#298 exitCode=1 recorded it as dispatch-failed with
    // the escalation menu as errorTail).
    result.loopOutcome === "rejected" ? { ...result, ok: true, exitCode: 0 } : result,
  );
  const records = roundsRecords(result);
  // #1114 — the verdict decides routing (fix / pass / reject / infra).
  const reading = interpretReview(result, reviewRoundFor(state, id));
  const ok = reading.ok;
  // #485 — rounds are data: the loop's own count when it carried one,
  // else the count the per-round records describe.
  // #1114 — plus the rounds this workstream already ran on earlier invocations.
  const rounds = reviewTrack(state.eventLog, id).rounds + (result.roundsExecuted ?? records.length);
  return {
    id,
    ok,
    rounds,
    records,
    infra: reading.infra || (!ok && result.loopOutcome === "infra-failure"),
    threw: false,
    skipped: false,
    priorInfra: priorOutcomes.get(id) === "infra-failure",
    rejectionText: ok ? undefined : result.text,
    fixRequested: reading.fixRequested,
    fixFindings: reading.fixRequested ? result.text : undefined,
    // A pass that carried unresolved findings says so in its headline.
    passFindings: reading.passFindings,
    errorTail: result.errorStop?.message ?? undefined,
    providerRepeats: result.providerRepeats,
    // #543 — thread a loop / token-budget cap kill (+ its trigger
    // evidence) so the aggregate parks with the fixed-literal cap
    // INSTEAD of the generic infra cap (see work-driver-adversarial).
    ...capKillOutcomeFields(result),
    // #1243 — and the watchdog kill (timeout / inactivity / tool-inactivity /
    // abort / plan-timeout) for the retry ladder alone. Order matters:
    // `capKillOutcomeFields` wins for loop / token-budget, which it owns.
    ...(retryLadderKillCause(result) ? { killCause: retryLadderKillCause(result) } : {}),
    completionEvent,
    branchEvent: multi
      ? {
          kind: "branch-completed",
          step: "adversarial",
          workstreamId: id,
          ok,
          ms: Date.now() - startedAt,
          at: Date.now(),
        }
      : undefined,
  };
}
