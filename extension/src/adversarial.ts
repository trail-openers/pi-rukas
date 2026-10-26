import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyDispatchOutcome } from "./adversarial-classify.ts";
import {
  type FenceRecord,
  type FencedRound,
  createFixFence,
  withFixViolations,
} from "./adversarial-fix-guard.ts";
import {
  type BindingState,
  captureRound,
  makeLedgerWrite,
  roundHeadRef,
} from "./adversarial-ledger-capture.ts";
import { buildLedgerNote } from "./adversarial-ledger-note.ts";
import type { AdversarialLoopParams } from "./adversarial-loop-params.ts";
import { isToolPathProvenance } from "./adversarial-loop-params.ts";
import { makeRunPhase } from "./adversarial-phase.ts";
import { policyInfraFailureText, reportPolicyError } from "./adversarial-policy.ts";
import { buildAdversarialPrompt, buildFixPrompt } from "./adversarial-prompts.ts";
import { onRereadFailure, rereadStalenessNote } from "./adversarial-reread.ts";
import { type InfraCtx, infraFailureResult, runPhaseWithInfraRetry } from "./adversarial-retry.ts";
import { type RoundReview, roundAfterReread } from "./adversarial-round-state.ts";
import { createUsageTally } from "./adversarial-usage.ts";
import {
  decideLoopAction,
  fixRefusedResult,
  fixThrewResult,
  parseVerdict,
  passedRoundText,
  rejectedLoopText,
  summariseFindings,
  synthesizeResult,
  toRoundRecords,
  workCwdRequiredResult,
} from "./adversarial-verdict.ts";
import { markOrchestrator } from "./async-jobs.ts";
import { formatReportLine, renderCommentEvidence, roundComments } from "./comment-evidence.ts";
import type { LostCommentResult } from "./comment-retention.ts";
import { type RangeDiff, computeRangeDiff } from "./review-diff.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { AdversarialVerdict, DispatchResult } from "./types.ts";
import type { ExecFn } from "./worktree.ts";
export const MAX_ROUNDS = 3;

/** One round's outcome, as the loop records it for the ledger and the report. */
interface RoundRecord {
  round: number;
  verdict: AdversarialVerdict;
  ms: number;
}

/**
 * Run the 3-round adversarial loop directly. Exported so the work-driver can
 * call it without the tool-registration layer (PR1 workflow-graph compilation).
 * The `adversarial_loop` tool wraps this with `startJob` + steer-back; the
 * driver wraps it with `startJob({ ownerKind: "driver", skipDeck: true })` so
 * the result resolves via promise instead of as an [ensemble:async] steer.
 *
 * `orchestratorJobId` is the wrapping job's id, used to publish active-child
 * state for dispatch_peek / dispatch_steer to resolve into the running child.
 */
export async function runAdversarialLoop(
  params: AdversarialLoopParams,
  signal: AbortSignal,
  orchestratorJobId: string,
  /** #859 — the ref-range diff computation (injectable for tests). Used when
   * `diff` is absent and base/head are present. */
  rangeDiffFn: (cwd: string, base: string, head: string) => Promise<RangeDiff> = computeRangeDiff,
): Promise<DispatchResult> {
  const start = Date.now();
  const runId = makeRunId();
  const rounds: RoundRecord[] = [];
  // Failed re-reads on rounds 2+ accumulate here and print in the final result,
  // so the operator can see the round reviewed a stale diff instead of having to
  // notice it. Who owns the read decides whether a failure lands HERE or leaves
  // the loop by rethrow — the two cases and why they differ are documented once
  // in `adversarial-reread.ts` (#859, #1634).
  const diffRereadNotes: string[] = [];
  // The loop's cost tally and the transcript/model of its LAST dispatch
  // (adversarial-usage.ts): every result this loop synthesises reads through it,
  // so a partial loop reports what it actually spent.
  const tally = createUsageTally();
  const { usage } = tally;

  // #980 — resolve the branch ONCE before the loop (shared helper: explicit
  // `branch` → branch-named `head` ref → rev-parse). The VISIBLE not-recorded
  // note is threaded into every tool-path result; `ledgerWrite` keys on the SAME branch.
  const { branch: branchResolved, withLedgerNote } = await buildLedgerNote({
    branch: params.branch,
    head: params.head,
    workCwd: params.workCwd,
  });

  const fenceRecords: FenceRecord[] = [];
  const fence = createFixFence(params.fixFence, fenceRecords);
  // #1360 — the binding captured by the LAST round that read its diff and
  // dispatched a reviewer: the range SHAs plus the working-tree identity at
  // that moment. `ledgerWrite` threads it into the writer, which refuses the
  // row when the tool-path bindings do not hold.
  const ledgerBinding: BindingState = { captured: { binding: {}, headRef: params.head } };
  // #1360 — provenance is the branded marker the tool mints; an untyped caller
  // cannot produce the string, so this narrow IS the provenance check (see
  // `ToolPathProvenance`). The driver path carries none and runs no capture.
  const toolPath = isToolPathProvenance(params.toolPath);
  const ledgerWrite = makeLedgerWrite({
    state: ledgerBinding,
    workCwd: params.workCwd,
    branch: params.branch,
    // #988 — the branch the note resolved (same shared resolution, same args +
    // cwd), so the write does not re-resolve.
    resolvedBranch: branchResolved,
    callerSuppliedDiff: params.callerSuppliedDiff,
    // #1360 — provenance is set only at the tool boundary, never inferred.
    toolPath,
    baseRef: params.base,
    // #1360 — one executor for the whole binding: the per-round capture and the
    // write consult it, so a caller with its own git seam has ONE to give
    // (same shape as `commentExecFn` for the comment check).
    execFn: params.commentExecFn,
    // #1557 — see `LedgerEntry.rowNonce` for why identity, not a timestamp
    // floor; the guard never reads it.
    rowNonce: orchestratorJobId,
    // #1104 — fence findings are prefixed BEFORE the write: the durable ledger
    // row must carry the same text the caller sees.
    decorate: (raw) => withFixViolations(raw, fenceRecords),
    note: withLedgerNote,
  });

  const reportTerminal = params.reportVerdict === "terminal";

  // #1161 — the reportOnly verdict policy is checked and resolved ONCE, at
  // loop entry. An untyped caller with no recognised policy gets an infra
  // failure, never a verdict judged as a routed round.
  const policyError = reportPolicyError(params);
  if (policyError) {
    return ledgerWrite(
      synthesizeResult({
        ok: false,
        loopOutcome: "infra-failure",
        text: policyInfraFailureText(policyError),
        ms: Date.now() - start,
        usage,
        transcriptPath: tally.lastTranscript,
        model: tally.lastModel,
      }),
    );
  }

  // #859 — resolve the ref range (used by both the diff and the comment check).
  const range = params.base && params.head ? { base: params.base, head: params.head } : null;
  // #1360 — the head the CURRENT round reviews: the caller's ref at first, then
  // `HEAD` once a fix round commits, which is what `getDiff` diffs against (the
  // range's head half), so loop and writer never disagree about the judged commit.
  let headRef: string | undefined = params.head;
  /**
   * The diff the CURRENT round reviews, and the range its truncation notice may
   * name — ONE value, updated in ONE place (#1816). The builders mint the reread
   * command from `range` only when the diff exceeds the inline cap
   * (adversarial-diff-cap.ts), and `range` is set only where THIS loop ran
   * `rangeDiffFn`, so the /work fan-out's pasted diff keeps the "not available"
   * wording. A round whose re-read FAILED has none: the diff under review is a
   * previous round's, so the notice must not name a range it never read.
   */
  let review: RoundReview = { diff: "" };

  // #948 / #1040 — the comment check runs ONCE per round, on the diff that round
  // reviews; that single result feeds both the reviewer's prompt and the
  // `comments:` report line (the last round's). A lost count > 0 does NOT change
  // the verdict. A check that never ran reads as not-run, never as clean.
  let lastComments: LostCommentResult = { ok: false, reason: "no review round ran" };
  const commentsLineNow = () => formatReportLine(lastComments);
  // #980 fix — the infra-failure result must carry the values ACCUMULATED up
  // to this point (the transcript/model of the round that just failed), so
  // they are read at CALL time through this snapshot rather than captured
  // once at loop entry (a pre-loop snapshot would be stale on rounds 2+).
  const infraCtxNow = (): InfraCtx => ({
    start,
    usage,
    lastTranscript: tally.lastTranscript,
    lastModel: tally.lastModel,
    toRoundRecords,
  });
  /** The result-state shape the fix-phase failures carry: the same tally, read
   * at call time (adversarial-usage.ts), plus the rounds completed so far. */
  const roundStateNow = (completed: RoundRecord[]) => ({
    start,
    usage,
    lastTranscript: tally.lastTranscript,
    lastModel: tally.lastModel,
    rounds: completed,
  });

  // The diff source for rounds 2+: the caller's `getDiff`, replaced below by a
  // range reader when this loop computes the range itself (#859). Precedence at
  // entry — a pasted `diff` string wins over a ref range (traced); with no
  // string, base+head compute the range in workCwd (else the process cwd). A
  // failed entry read is returned AS the result, never fallen back to an empty
  // string, which the loop would review as "nothing to change" and approve.
  let getDiff = params.getDiff;

  /** #1360 — capture what THIS round is about to review, immediately before its
   * reviewer dispatch, so the identity is the tree the reviewer's prompt carried
   * and not one a later fix round left behind. TOOL PATH ONLY: the bindings are
   * consulted only for a `toolPath` row, so the driver path skips this entirely
   * (no git subprocesses whose answer nothing reads; its row is byte-identical
   * to the pre-#1360 one). */
  const captureForRound = async () =>
    captureRound(
      ledgerBinding,
      params.workCwd ?? process.cwd(),
      params.base,
      headRef,
      params.commentExecFn,
    );
  const noDiffResult = (text: string): DispatchResult =>
    ledgerWrite(
      synthesizeResult({
        ok: false,
        loopOutcome: "rejected",
        text,
        ms: Date.now() - start,
        usage,
        transcriptPath: tally.lastTranscript,
        model: tally.lastModel,
      }),
    );
  if (params.diff) {
    // A pasted diff wins outright, so a caller that sent both gets no range read
    // and no range in the reviewer's notice (the loop never diffed a range).
    if (range) trace(`adversarial: diff string wins over ${range.base}...${range.head}`);
    review = { diff: params.diff };
  } else if (range) {
    const cwd = params.workCwd ?? process.cwd();
    // Round 1 uses the diff computed once here at tool entry.
    const initial = await rangeDiffFn(cwd, range.base, headRef ?? range.head);
    if (!initial.ok) {
      return noDiffResult(
        `Adversarial loop could not compute the diff for ${range.base}...${range.head}: ${initial.reason}`,
      );
    }
    review = roundAfterReread(review, range, headRef, true, initial.diff);
    // Rounds 2+ re-compute the SAME range, so a fix round's changes are
    // reviewed (same rule as the driver's per-round getDiff re-read).
    getDiff = async () => {
      const r = await rangeDiffFn(cwd, range.base, headRef ?? range.head);
      if (!r.ok) {
        // #859 — a failed range re-read throws rather than answering "" (which
        // the loop would ignore and review the STALE diff on); the catch in the
        // round loop traces it and decides what it means.
        throw new Error(r.reason);
      }
      return r.diff;
    };
  } else {
    return noDiffResult(
      "Adversarial loop: provide `diff`, or both `base` and `head` (with `workCwd`) — nothing to review was supplied.",
    );
  }

  // Mark this job as orchestrator-shaped so dispatch_peek / dispatch_steer
  // can resolve the orchestrator jobId to its active inner child instead of
  // returning "no such job". Active child is updated below in runPhase.
  markOrchestrator(orchestratorJobId);
  // Findings the earlier rounds raised, carried into each later round's fix
  // prompt so the fixer sees the whole picture and not only the last verdict.
  const priorFindings: string[] = [];
  // Whether THIS loop may swallow a failed re-read — decided where the
  // substitution above decides, from the one fact that settles it (#1634).
  const rereadIsLoopOwn = getDiff !== params.getDiff;

  const runPhase = makeRunPhase({
    runId,
    signal,
    orchestratorJobId,
    // An absent optional stays absent rather than becoming `undefined`, so the
    // phase options are exactly what the caller supplied.
    ...(params.onSlow ? { onSlow: params.onSlow } : {}),
    ...(params.pi ? { pi: params.pi } : {}),
    processGroup: params.processGroup,
    workCycleTrust: params.workCycleTrust,
  });

  const firstRound = params.reportRound ?? 1;
  for (let round = firstRound; round <= MAX_ROUNDS; round++) {
    if (signal.aborted) break;
    if (round > firstRound && getDiff) {
      // One attempt per round, deliberately: a diff read is deterministic, so a
      // second try says the same thing (#1634's park skips the retry ladders for
      // the same reason). The `try` below decides what a failure means.
      try {
        const fresh = await getDiff();
        // #1360 — a round after a fix pass reviews what the fixer left in the
        // worktree, so its head is the branch tip, not the ref the caller
        // named at entry (that ref is where the round-1 diff came from). The
        // head re-read sits with the diff re-read — #859's rule, now covering
        // both halves of the range. A failed re-read keeps the previous diff,
        // so it keeps the previous round's head too.
        headRef = roundHeadRef(headRef, { isRefRangeRound: range !== null, freshDiff: fresh });
        // #1816 — the range is minted HERE, beside the head it describes, and
        // TOGETHER with the diff it produced: the notice must print the command
        // for the range this round actually reviewed.
        review = roundAfterReread(review, range, headRef, true, fresh);
      } catch (err) {
        // Who owned the read decides what a failed re-read is: a transient the
        // loop rides out on the previous diff, or the gate's own read failing —
        // in which case the loop must not produce a verdict for a round whose
        // diff it could not read, and never dispatches a reviewer against one.
        // Both branches, and why, are in `adversarial-reread.ts`.
        const failure = onRereadFailure(round, err, rereadIsLoopOwn);
        if (failure.action === "rethrow") throw err;
        // #859 + #1816: the previous diff plus the live worktree is what the
        // reviewer had before this round, so it reviews that again — and with no
        // range for this round, since the notice may not name one it never read.
        review = roundAfterReread(review, range, headRef, false, undefined);
        diffRereadNotes.push(rereadStalenessNote(round, failure.reason));
      }
    }
    lastComments = await roundComments(
      review.diff,
      headRef,
      params.workCwd,
      params.commentTimeoutMs,
      params.commentExecFn,
    );
    // #1360 — capture what THIS round is about to review, immediately before
    // the reviewer dispatch — gated on the provenance marker, because the driver
    // path never consults a binding and so pays for none.
    if (toolPath) await captureForRound();
    const adv = await runPhaseWithInfraRetry(
      "adversarial-developer",
      `round${round}-review`,
      buildAdversarialPrompt({
        diff: review.diff,
        context: params.context,
        round,
        maxRounds: MAX_ROUNDS,
        issueBody: params.issueBody,
        fixDelta: round === firstRound ? params.fixDelta : undefined,
        gateCmd: params.gateCmd,
        // #1040 — comments this round's diff removed, for the reviewer to judge.
        commentEvidence: renderCommentEvidence(lastComments),
        // #1137 — scope the review to this workstream (N>1 only; absent on N=1).
        // A plain pass-through now that the value is optional: an absent scope
        // leaves the key undefined, exactly as the conditional spread did, and
        // the builder already branches on `opts.scope`.
        scope: params.scope,
        // Only non-undefined on the ref-range path; a pasted diff keeps today's prompt.
        diffRange: review.range,
      }),
      params.workCwd,
      { runPhase, accumulate: tally.accumulate, signal },
    );
    const advCls = classifyDispatchOutcome(adv);
    if (advCls.cause !== "success") {
      return ledgerWrite(infraFailureResult(round, "review", adv, advCls, infraCtxNow()));
    }

    const verdict = parseVerdict(adv.text);
    rounds.push({ round, verdict, ms: adv.ms });
    if (params.reportOnly) {
      if (verdict.verdictParsed !== true) {
        return ledgerWrite(
          infraFailureResult(
            round,
            "review",
            adv,
            { ...advCls, headline: "produced no readable VERDICT marker" },
            infraCtxNow(),
          ),
        );
      }
      // #912 — the review ledger keys on the latest entry per branch, so every
      // reviewed round records its verdict: a pass is `approved`, anything the
      // driver will route back or reject is `rejected` (replaced by a later pass).
      const terminalRound = reportTerminal ? MAX_ROUNDS : round;
      const passed = decideLoopAction(verdict.status, terminalRound, MAX_ROUNDS, true) === "pass";
      return ledgerWrite(
        synthesizeResult({
          ok: true,
          loopOutcome: passed ? "approved" : "rejected",
          text: verdict.findings,
          ms: Date.now() - start,
          usage,
          transcriptPath: tally.lastTranscript,
          model: tally.lastModel,
          adversarialRounds: toRoundRecords(rounds),
        }),
      );
    }
    const action = decideLoopAction(verdict.status, round, MAX_ROUNDS, verdict.verdictParsed);
    if (action === "incomplete") {
      // Out of rounds with no readable verdict on the last one. Nothing was
      // reviewed, so this is not an approval and not a rejection — it is the
      // same "no verdict exists" case the infra path already reports, and the
      // step router already knows to retry it once.
      return ledgerWrite(
        infraFailureResult(
          round,
          "review",
          adv,
          {
            ...advCls,
            headline: "produced no readable VERDICT marker on the final round",
          },
          infraCtxNow(),
        ),
      );
    }
    if (action === "pass") {
      // `PASSED WITH FINDINGS` rather than `APPROVED` when something is still
      // outstanding — the operator (and the lens gate) must tell the two apart;
      // `commit-pr` carries the findings into the PR body.
      const commentsLine = await commentsLineNow();
      const r = synthesizeResult({
        ok: true,
        loopOutcome: "approved",
        text: passedRoundText({
          clean: verdict.status === "APPROVED",
          round,
          status: verdict.status,
          findings: verdict.findings,
          commentsLine,
          notes: diffRereadNotes,
        }),
        ms: Date.now() - start,
        usage,
        transcriptPath: tally.lastTranscript,
        model: tally.lastModel,
        adversarialRounds: toRoundRecords(rounds),
      });
      return ledgerWrite(r);
    }
    if (action === "reject") break;
    if (!params.workCwd) {
      return ledgerWrite(workCwdRequiredResult(round, verdict, roundStateNow(rounds)));
    }
    // #1104 — the fence checks workCwd (a worktree of the caller's repo) before
    // the first fix round, and runs the caller-repo check after every round,
    // even one whose dispatch throws. A refused round dispatches nothing.
    let fixRun: FencedRound<DispatchResult>;
    try {
      fixRun = await fence.round(round, params.workCwd, () =>
        runPhaseWithInfraRetry(
          "developer",
          `round${round}-fix`,
          buildFixPrompt({
            findings: verdict.findings,
            context: params.context,
            diff: review.diff,
            round,
            issueBody: params.issueBody,
            priorFindings: [...priorFindings],
            diffRange: review.range,
          }),
          params.workCwd,
          { runPhase, accumulate: tally.accumulate, signal },
        ),
      );
    } catch (err) {
      // A throwing dispatch must not lose the fence's records: the ledger write
      // carries them (the check ran in the fence's finally before this throw).
      return ledgerWrite(fixThrewResult(round, err, roundStateNow(rounds)));
    }
    if (!fixRun.ran) {
      return ledgerWrite(fixRefusedResult(fixRun.outcome, fixRun.reason, roundStateNow(rounds)));
    }
    const fix = fixRun.value;
    // Record what this round asked for, so the next fixer does not undo it.
    priorFindings.push(
      `Round ${round} (${verdict.status}): ${summariseFindings(verdict.findings)}`,
    );
    const fixCls = classifyDispatchOutcome(fix);
    if (fixCls.cause !== "success") {
      return ledgerWrite(infraFailureResult(round, "fix", fix, fixCls, infraCtxNow()));
    }
  }

  const last = rounds[rounds.length - 1];
  const commentsLine = await commentsLineNow();
  const r = synthesizeResult({
    ok: false,
    loopOutcome: "rejected",
    text: rejectedLoopText({
      maxRounds: MAX_ROUNDS,
      lastStatus: last?.verdict.status,
      findings: last?.verdict.findings ?? "",
      commentsLine,
      notes: diffRereadNotes,
    }),
    ms: Date.now() - start,
    usage,
    transcriptPath: tally.lastTranscript,
    model: tally.lastModel,
    adversarialRounds: toRoundRecords(rounds),
  });
  return ledgerWrite(r);
}
