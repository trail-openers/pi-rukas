import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyDispatchOutcome } from "./adversarial-classify.ts";
import { buildLedgerNote } from "./adversarial-ledger-note.ts";
import { writeAdversarialLedgerEntry } from "./adversarial-ledger.ts";
import { buildAdversarialPrompt, buildFixPrompt } from "./adversarial-prompts.ts";
import { type InfraCtx, infraFailureResult, runPhaseWithInfraRetry } from "./adversarial-retry.ts";
import {
  decideLoopAction,
  parseVerdict,
  summariseFindings,
  synthesizeResult,
  toRoundRecords,
} from "./adversarial-verdict.ts";
import { childHandles, registerChildHandle } from "./async-jobs-registry.ts";
import { markOrchestrator, setOrchestratorActiveChild } from "./async-jobs.ts";
import { formatReportLine, renderCommentEvidence, roundComments } from "./comment-evidence.ts";
import type { LostCommentResult } from "./comment-retention.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { readEnumMarker } from "./reply-markers.ts";
import { type RangeDiff, computeRangeDiff } from "./review-diff.ts";
import { type OnSlowCallback, feedSlowProgress, watchSlowDispatch } from "./slow-notice.ts";
import { makeRunId, spawnSpecialist } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { AdversarialVerdict, DispatchFailureCause, DispatchResult } from "./types.ts";
import { ADVERSARIAL_TRANSIENT_MAX_RETRIES, isRateLimit429Msg } from "./types.ts";
import type { ExecFn } from "./worktree.ts";
export const MAX_ROUNDS = 3;

/**
 * Wall-clock budget for all retry attempts in a single adversarial phase. When
 * elapsed time reaches this limit no further retries start, preventing a
 * repeated watchdog kill from consuming its full attempt budget. Set 0 to
 * disable. Override: PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS. Default: 30 min.
 */
export function adversarialPhaseBudgetMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return 30 * 60_000;
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
  params: {
    /** Optional when `base` + `head` are present (computed from the ref
     * range). When both `diff` and base/head are given, the string wins. */
    diff?: string;
    /** #1040 — git timeout for the comment-loss check (the driver passes verifyTimeoutMs()). */
    commentTimeoutMs?: number;
    /** #1040 — injected git seam for the comment-loss check (the driver passes its verify exec). */
    commentExecFn?: ExecFn;
    /** #859 — the base ref the tool computes the diff from (with head). */
    base?: string;
    /** #859 — the head ref the tool computes the diff from (with base). */
    head?: string;
    context: string;
    workCwd?: string;
    /** Recompute the diff before each review. Without it rounds 2+ see pre-fix material. */
    getDiff?: () => Promise<string>;
    /** The issue this diff is meant to satisfy (#278). Optional: older state files have none. */
    issueBody?: string;
    /** #799 — the slow-run recorder for this loop's inner children (each
     * threshold crossing of a review / fix round appends dispatch-slow), and
     * the parent pi for their slow-run watch (the PM notice half). */
    onSlow?: OnSlowCallback;
    pi?: ExtensionAPI;
    /** #912 — caller-supplied branch for the review-ledger write (the driver
     * worktrees are detached, so `git rev-parse --abbrev-ref HEAD` cannot
     * recover it). When absent the writer recovers the branch from `HEAD`
     * and skips (traces) on a detached head. */
    branch?: string;
    /**
     * #1114 — exactly ONE reviewer dispatch: no developer dispatch, no fix
     * round. The result carries the parsed verdict in `adversarialRounds` and
     * its findings in `text`; the driver routes from the round record. The
     * review-ledger entry is still written (#912) with `loopOutcome` set to
     * `approved` on a pass and `rejected` otherwise. An unparsed verdict is an
     * infrastructure outcome, never a verdict.
     */
    reportOnly?: boolean;
    /** #1114 — the round number a reportOnly review carries (prompt + record). Default 1. */
    reportRound?: number;
  },
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

  const ledgerWrite = (result: DispatchResult): DispatchResult => {
    writeAdversarialLedgerEntry(result, {
      workCwd: params.workCwd,
      // #988 — thread the branch the note resolved (same shared resolution,
      // same args + cwd) so the write does not re-resolve.
      resolvedBranch: branchResolved,
      branch: params.branch,
      head: params.head,
    });
    return withLedgerNote(result);
  };

  // #859 — resolve the ref range (used by both the diff and the comment check).
  const range = params.base && params.head ? { base: params.base, head: params.head } : null;

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
    const initial = await rangeDiffFn(cwd, range.base, range.head);
    if (!initial.ok) {
      return noDiffResult(
        `Adversarial loop could not compute the diff for ${range.base}...${range.head}: ${initial.reason}`,
      );
    }
    diff = initial.diff;
    // Rounds 2+ re-compute the SAME range, so a fix round's changes are
    // reviewed (same rule as the driver's per-round getDiff re-read).
    getDiff = async () => {
      const r = await rangeDiffFn(cwd, range.base, range.head);
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

  /**
   * Run one phase, threading dispatch-deck lifecycle and onProgress so the deck
   * shows whichever phase is running now. Also registers the inner spawn as the
   * orchestrator's `activeChild` so PM can `dispatch_peek` / `dispatch_steer`
   * against the loop's jobId and reach the currently-running inner child.
   */
  const runPhase = async (
    role: "adversarial-developer" | "developer",
    tag: string,
    prompt: string,
    cwd?: string,
  ): Promise<DispatchResult> => {
    const deckKey = `${runId}/${tag}`;
    const label = `${role}[${tag}]`;
    dispatchDeck.startEntry(deckKey, { label, role, tag });
    // #799 — the slow-run watch for this inner child: the deck key is the id
    // dispatch_peek shows, and it is what the PM notice names. The parent pi
    // is threaded so the notice reaches the PM (the watch site has no pi).
    // #907 — the CI-wait span feed for this inner child: the watch chains
    // its span tracker in front of the raw-event hook the spawn receives.
    const slowRaw: (event: PiJsonEvent) => void = () => {};
    const stopSlow = watchSlowDispatch({
      id: deckKey,
      role,
      label,
      ...(params.onSlow ? { onSlow: params.onSlow } : {}),
      ...(params.pi ? { pi: params.pi } : {}),
      onRawEvent: slowRaw,
    });
    try {
      return await spawnSpecialist(
        { role, prompt, cwd },
        {
          signal,
          runId,
          tag,
          onProgress: (state) => {
            dispatchDeck.updateEntry(deckKey, state);
            feedSlowProgress(deckKey, state);
          },
          onRawEvent: stopSlow.onRawEvent ?? slowRaw,
          onStdin: (stdin) => {
            // Publish this inner spawn as the orchestrator's active child so
            // PM's peek/steer calls against the orchestrator jobId resolve
            // to this stdin. Updated on each round; cleared in the finally.
            setOrchestratorActiveChild(orchestratorJobId, {
              role,
              label,
              deckKey,
              stdin,
            });
            // #799 — also registered under the deck key (steer from the peek id).
            registerChildHandle(deckKey, stdin, label, role);
          },
        },
      );
    } finally {
      stopSlow.stop();
      dispatchDeck.clearEntry(deckKey);
      childHandles.delete(deckKey);
      setOrchestratorActiveChild(orchestratorJobId, null);
    }
  };

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
      params.head,
      params.workCwd,
      params.commentTimeoutMs,
      params.commentExecFn,
    );
    const adv = await runPhaseWithInfraRetry(
      "adversarial-developer",
      `round${round}-review`,
      buildAdversarialPrompt({
        diff,
        context: params.context,
        round,
        maxRounds: MAX_ROUNDS,
        issueBody: params.issueBody,
        // #1040 — comments this round's diff removed, for the reviewer to judge.
        commentEvidence: renderCommentEvidence(lastComments),
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
      if (!verdict.verdictParsed) {
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
      const passed = decideLoopAction(verdict.status, round, MAX_ROUNDS, true) === "pass";
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
      const clean = verdict.status === "APPROVED";
      const notePrefix = diffRereadNotes.length ? `${diffRereadNotes.join("\n")}\n\n` : "";
      const commentsLine = await commentsLineNow();
      const r = synthesizeResult({
        ok: true,
        loopOutcome: "approved",
        text:
          notePrefix +
          (clean
            ? `Adversarial APPROVED after round ${round}.\n\n${verdict.findings}\n\n${commentsLine}`
            : `Adversarial PASSED WITH FINDINGS after round ${round} (verdict: ${verdict.status} — non-blocking per agents-base/adversarial-developer.md). These findings are unresolved and travel to the PR body and the lens review; they did not block the commit.\n\n${verdict.findings}\n\n${commentsLine}`),
        ms: Date.now() - start,
        usage,
        transcriptPath: lastTranscript,
        model: lastModel,
        adversarialRounds: toRoundRecords(rounds),
      });
      return ledgerWrite(r);
    }
    if (action === "reject") break;

    const fix = await runPhaseWithInfraRetry(
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
    );
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
    text: [
      ...diffRereadNotes,
      `❌ Adversarial REJECTED after ${MAX_ROUNDS} rounds. Last verdict: ${last?.verdict.status}`,
      "",
      last?.verdict.findings ?? "",
      "",
      "Surface the following options to the user verbatim and wait for their choice — do not pick on their behalf:",
      "",
      "  (a) Authorise another adversarial_loop pass (3 more rounds against the current diff).",
      "  (b) Accept the current state and proceed to @ops commit. Record the override in vipune.",
      "  (c) Abandon and rework the approach — return to issue scoping or developer redesign.",
      "  (d) Take over manually — user steps in to address findings directly.",
      "",
      commentsLine,
    ].join("\n"),
    ms: Date.now() - start,
    usage,
    transcriptPath: lastTranscript,
    model: lastModel,
    adversarialRounds: toRoundRecords(rounds),
  });
  return ledgerWrite(r);
}
