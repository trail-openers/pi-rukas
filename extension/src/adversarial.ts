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
import { type InfraCtx, infraFailureResult, runPhaseWithInfraRetry } from "./adversarial-retry.ts";
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
  const rounds: Array<{
    round: number;
    verdict: AdversarialVerdict;
    ms: number;
  }> = [];
  // #859 — failed re-reads on rounds 2+: the loop keeps the previous diff (never
  // abandons a round); the loop itself never reviews the STALE diff on a
  // failed re-read, and the final result must say so.
  const diffRereadNotes: string[] = [];
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
  let lastTranscript: string | undefined;
  let lastModel: string | undefined;

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
  const ledgerBinding: BindingState = { capturedHeadRef: params.head };
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
    // #1104 — fence findings are prefixed BEFORE the write: the durable ledger
    // row must carry the same text the caller sees.
    decorate: (raw) => withFixViolations(raw, fenceRecords),
    note: withLedgerNote,
  });

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
        transcriptPath: lastTranscript,
        model: lastModel,
      }),
    );
  }
  const reportTerminal = params.reportVerdict === "terminal";

  // #859 — resolve the ref range (used by both the diff and the comment check).
  const range = params.base && params.head ? { base: params.base, head: params.head } : null;
  // #1360 — the head the CURRENT round reviews. It starts as the caller's ref
  // and a fix round that committed changes re-points it at `HEAD`, which is
  // what `getDiff` then diffs against (the range's head half), so the loop and
  // the writer never disagree about which commit a round judged.
  let headRef: string | undefined = params.head;

  // #948 / #1040 — the comment check runs ONCE per round, on the diff that round
  // reviews; that single result feeds both the reviewer's prompt and the
  // `comments:` report line (the last round's). A lost count > 0 does NOT change
  // the verdict. A check that never ran reads as not-run, never as clean.
  let lastComments: LostCommentResult = {
    ok: false,
    reason: "no review round ran",
  };
  const commentsLineNow = () => formatReportLine(lastComments);
  // #980 fix — the infra-failure result must carry the values ACCUMULATED up
  // to this point (the transcript/model of the round that just failed), so
  // they are read at CALL time through this snapshot rather than captured
  // once at loop entry (a pre-loop snapshot would be stale on rounds 2+).
  const infraCtxNow = (): InfraCtx => ({
    start,
    usage,
    lastTranscript,
    lastModel,
    toRoundRecords,
  });

  // #859 — resolve the diff: a pasted string wins over a ref range (traced);
  // with no string, base+head compute the range in workCwd (else the process
  // cwd). An error (invalid ref naming the ref, confirmed-empty range, cap
  // overflow) is returned AS the result — never a fallback to an empty
  // string, which the loop would review as "nothing to change" and approve.
  let diff: string;
  let getDiff = params.getDiff;
  /** #1360 — capture what THIS round is about to review, before its reviewer
   * dispatch, so the identity is the tree the reviewer's prompt carried and not
   * the tree a later fix round left behind.
   *
   * TOOL PATH ONLY. The bindings are consulted only for a `toolPath` row, so on
   * the driver path this call would be a round of git subprocesses whose answer
   * nothing reads — `captureRound` is not called there at all, and the writer
   * receives the row it recorded before #1360. */
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
        transcriptPath: lastTranscript,
        model: lastModel,
      }),
    );
  if (params.diff && range) {
    trace(
      `adversarial: diff string supplied alongside base=${range.base} head=${range.head} — the diff string wins`,
    );
    diff = params.diff;
  } else if (params.diff) {
    diff = params.diff;
  } else if (range) {
    const cwd = params.workCwd ?? process.cwd();
    // Round 1 uses the diff computed once here at tool entry.
    const initial = await rangeDiffFn(cwd, range.base, headRef ?? range.head);
    if (!initial.ok) {
      return noDiffResult(
        `Adversarial loop could not compute the diff for ${range.base}...${range.head}: ${initial.reason}`,
      );
    }
    diff = initial.diff;
    // Rounds 2+ re-compute the SAME range, so a fix round's changes are
    // reviewed (same rule as the driver's per-round getDiff re-read).
    getDiff = async () => {
      const r = await rangeDiffFn(cwd, range.base, headRef ?? range.head);
      if (!r.ok) {
        // #859 — a re-read failure is no longer a silent "" (which the loop
        // would ignore and review the STALE diff on). Name it in the trace;
        // the caller surfaces it in the final result.
        trace(
          `adversarial: diff re-read failed for range ${range.base}...${range.head}: ${r.reason} — reviewing the previous diff`,
        );
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
  const accumulate = (r: DispatchResult) => {
    if (r.usage) {
      usage.input += r.usage.input;
      usage.output += r.usage.output;
      usage.cacheRead += r.usage.cacheRead;
      usage.cacheWrite += r.usage.cacheWrite;
      usage.cost += r.usage.cost;
      usage.turns += r.usage.turns;
    }
    if (r.transcriptPath) lastTranscript = r.transcriptPath;
    if (r.model && !lastModel) lastModel = r.model;
  };

  const runPhase = makeRunPhase({
    runId,
    signal,
    orchestratorJobId,
    ...(params.onSlow ? { onSlow: params.onSlow } : {}),
    ...(params.pi ? { pi: params.pi } : {}),
    processGroup: params.processGroup,
  });
  // Re-read before every review. `fetchDiff` used to run once, before the loop,
  // so rounds 2 and 3 were prompted with pre-fix material and the reviewer had to
  // notice the staleness itself.
  const priorFindings: string[] = [];

  const firstRound = params.reportRound ?? 1;
  for (let round = firstRound; round <= MAX_ROUNDS; round++) {
    if (signal.aborted) break;
    if (round > firstRound && getDiff) {
      try {
        const fresh = await getDiff();
        // #1360 — a round after a fix pass reviews what the fixer left in the
        // worktree, so its head is the branch tip, not the ref the caller
        // named at entry (that ref is where the round-1 diff came from). The
        // head re-read sits with the diff re-read — #859's rule, now covering
        // both halves of the range. A failed re-read keeps the previous diff,
        // so it keeps the previous round's head too.
        headRef = roundHeadRef(headRef, { isRefRangeRound: range !== null, freshDiff: fresh });
        if (fresh.trim()) diff = fresh;
      } catch (err) {
        // A failed re-read is not a reason to abandon the round; the previous
        // diff plus the live worktree is what the reviewer had before this.
        // #859 — record it, so the final result names the staleness instead
        // of the operator having to notice it.
        const reason = (err as Error).message;
        trace(`adversarial: diff re-read failed for round ${round}: ${reason}`);
        diffRereadNotes.push(
          `note: round ${round} diff re-read failed (${reason}) — reviewed the previous diff`,
        );
      }
    }
    lastComments = await roundComments(
      diff,
      headRef,
      params.workCwd,
      params.commentTimeoutMs,
      params.commentExecFn,
    );
    // #1360 — capture what THIS round is about to review, immediately before
    // the reviewer dispatch. Gated on the provenance marker: the driver path
    // never consults a binding, so it pays for none (no capture, no extra git
    // subprocess, and its row is byte-identical to the pre-#1360 one).
    if (toolPath) await captureForRound();
    const adv = await runPhaseWithInfraRetry(
      "adversarial-developer",
      `round${round}-review`,
      buildAdversarialPrompt({
        diff,
        context: params.context,
        round,
        maxRounds: MAX_ROUNDS,
        issueBody: params.issueBody,
        fixDelta: round === firstRound ? params.fixDelta : undefined,
        gateCmd: params.gateCmd,
        // #1040 — comments this round's diff removed, for the reviewer to judge.
        commentEvidence: renderCommentEvidence(lastComments),
        // #1137 — scope the review to this workstream (N>1 only; absent on N=1).
        ...(params.scope !== undefined ? { scope: params.scope } : {}),
      }),
      params.workCwd,
      { runPhase, accumulate, signal },
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
          transcriptPath: lastTranscript,
          model: lastModel,
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
        transcriptPath: lastTranscript,
        model: lastModel,
        adversarialRounds: toRoundRecords(rounds),
      });
      return ledgerWrite(r);
    }
    if (action === "reject") break;
    if (!params.workCwd) {
      const state = { start, usage, lastTranscript, lastModel, rounds };
      return ledgerWrite(workCwdRequiredResult(round, verdict, state));
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
            diff,
            round,
            issueBody: params.issueBody,
            priorFindings: [...priorFindings],
          }),
          params.workCwd,
          { runPhase, accumulate, signal },
        ),
      );
    } catch (err) {
      // A throwing dispatch must not lose the fence's records: the ledger write
      // carries them (the check ran in the fence's finally before this throw).
      const state = { start, usage, lastTranscript, lastModel, rounds };
      return ledgerWrite(fixThrewResult(round, err, state));
    }
    if (!fixRun.ran) {
      const state = { start, usage, lastTranscript, lastModel, rounds };
      return ledgerWrite(fixRefusedResult(fixRun.outcome, fixRun.reason, state));
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
    transcriptPath: lastTranscript,
    model: lastModel,
    adversarialRounds: toRoundRecords(rounds),
  });
  return ledgerWrite(r);
}
