/**
 * work-driver-lens — Step 7 (lens review). The Step 7f lens-fix handler lives
 * in work-driver-lens-fix.ts (500-line limit); its commit helpers live in
 * work-driver-lens-fix-commit.ts and are re-exported from this module.
 */

import { carriedAdversarialFindings } from "./adversarial-findings.ts";
import { lensCommentBlock } from "./comment-evidence.ts";
import { detectRepeatSeam } from "./detect-repeat-seam.ts";
import { execp } from "./exec.ts";
import { lensFixDelta } from "./fix-delta.ts";
import { type WideningFinding, scanTypeWidening, wideningContext } from "./invariant-scan.ts";
import { buildEvidence, runClaimScan } from "./lens-evidence.ts";
import { runLensReview } from "./lens-review.ts";
import { appendGuardWriteEvents, runGuardMemoryWrites } from "./lens-vipune-write.ts";
import { writeFindings } from "./memory-write.ts";
import { resolveReviewThreshold } from "./review-threshold.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { readAllMergedDiffs } from "./work-driver-diff.ts";
import { readDoctrineAtBase } from "./work-driver-doctrine.ts";
import { lensCapKillEvent, lensTimingsOf } from "./work-driver-lens-capkill.ts";
import { applyLensVerdict } from "./work-driver-lens-verdicts.ts";
import { DOCTRINE_FILES, type DoctrineDoc, judgePolicy } from "./work-driver-policy.ts";
import { recordResidualsPost } from "./work-driver-pr-gone.ts";
import { verifyTimeoutMs } from "./work-driver-verify-develop-helpers.ts";
import { withUsage } from "./workflow-state-events-usage.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";
// Re-export: moved into work-driver-lens-fix-commit.ts for the 500-line gate
// (AGENTS.md §12) — importers (work-driver-adversarial.ts) keep their path.
export { commitLensFixChanges, countLensFixEmptyResends } from "./work-driver-lens-fix-commit.ts";
import { lensWorktree } from "./work-driver-lens-fix.ts";

export async function runLens(
  ctx: CycleContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  const ps = state.pipelineState;
  const round = ps.reviewRound + 1;
  let next: WorkState = {
    ...state,
    pipelineState: {
      ...ps,
      currentStep: "lens-review",
      reviewRound: round,
      reviewCapStartedAt: ps.reviewCapStartedAt ?? now,
    },
  };
  next = appendEvent(next, { kind: "step-started", step: "lens-review", at: now });
  const diffResult = await readAllMergedDiffs(ps.worktrees ?? {}, ctx.repoRoot, ps.branchName);
  if (!diffResult.ok) {
    trace(`work-driver: lens-review — diff unreadable: ${diffResult.reason}`);
    next = { ...next, pipelineState: { ...next.pipelineState, lensDiffError: diffResult.reason } };
    return appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "lens-diff-unreadable",
      reviewRound: round,
      nextStep: "handoff",
    });
  }
  const diff = diffResult.diff;

  // #279 — type-widening scan: route-only detector for invariant removal.
  // Findings are injected into the lens context with framing for the
  // ARCHITECTURE lens to evaluate. Escape hatch: PI_ENSEMBLE_WIDENING_SCAN=0.
  const wideningScanEnabled = process.env.PI_ENSEMBLE_WIDENING_SCAN !== "0";
  let widenings: WideningFinding[] = [];
  if (wideningScanEnabled) {
    widenings = scanTypeWidening(diff);
    next = appendEvent(next, {
      kind: "widening-scan",
      at: Date.now(),
      findings: widenings,
    });
    const guardWrites = await runGuardMemoryWrites(
      widenings,
      ctx.issue,
      ctx.repoRoot,
      ctx.gvwmWriteFn,
    );
    for (const ev of appendGuardWriteEvents(guardWrites)) {
      next = appendEvent(next, ev);
    }
  }

  // PR6 — empty-diff guard. Lens children hallucinate findings against
  // unrelated files when given empty context (see #533). PR11 narrows the
  // failure mode: the integration branch has no commits ahead of mainline.
  if (diffResult.empty) {
    next = appendEvent(
      next,
      { kind: "lens-skipped-empty-diff", at: Date.now(), round },
      { kind: "lens-approved", at: Date.now(), jobId: makeRunId(), round },
    );
    return next;
  }

  const cwd = lensWorktree(ctx, state);
  const startedAt = Date.now();
  const jobId = makeRunId();
  const reviewFn = ctx.lensReviewFn ?? runLensReview;

  // Build lens context: base context + widening findings (if any).
  let context = `/work issue #${ctx.issue}, lens-review round ${round}`;
  // Non-blocking findings the adversarial gate passed on. It saw only the diff;
  // this gate applies the project's configurable severity threshold and has the
  // issue, the lenses and the full branch — so it is the right place to decide
  // whether any of them actually matter.
  const carried = carriedAdversarialFindings(state.eventLog);
  if (carried) {
    context += `\n\nOUTSTANDING FROM THE ADVERSARIAL GATE (non-blocking there — judge them yourself):\n${carried}`;
  }
  // #1040 — comments the branch removed, for every lens to weigh (SIMPLICITY
  // owns documentation). Lost comments never failed the develop step; this is
  // their review.
  context += await lensCommentBlock(
    lensWorktree(ctx, state),
    ps.baseSha,
    ps.branchName,
    verifyTimeoutMs(),
    ctx.verifyExecFn,
  );
  if (wideningScanEnabled) context += wideningContext(widenings);
  // What the last fix pass changed, for every lens to read first: a fix can
  // break the line beside the one it repairs (fix-delta.ts).
  const fixDelta = await lensFixDelta(ctx.repoRoot, ps.branchName, ps.lensReviewedHead);
  context += fixDelta.section;

  // Post-change file content for the lenses, and the claim scan. Both need the
  // BRANCH, not `cwd`: under always-worktree the worktrees stay detached at
  // baseSha, so anything read from the filesystem here is the pre-change text.
  const execFn = ctx.verifyExecFn ?? execp;
  const evidence = ps.branchName
    ? await buildEvidence(ctx.repoRoot, ps.branchName, diff)
    : undefined;
  const extraFindings = ps.branchName
    ? await runClaimScan(execFn, ctx.repoRoot, ps.branchName, diff)
    : [];
  if (extraFindings.length > 0) {
    trace(
      `work-driver: lens-review — claim-scan flagged ${extraFindings.length} unsourced claim(s)`,
    );
  }

  // The blocking bar is the project's, not this code's. Doctrine is read at
  // baseSha so a cycle cannot lower its own bar mid-run (#406's shape).
  const docs: DoctrineDoc[] = [];
  for (const file of DOCTRINE_FILES) {
    const read = await readDoctrineAtBase(execFn, ctx.repoRoot, ps.baseSha, file);
    if (read.text !== undefined) docs.push({ file, text: read.text });
  }
  const thresholdDecision = await resolveReviewThreshold(
    judgePolicy(ctx.repoRoot, { processGroup: ctx.processGroup === true, signal: ctx.signal }),
    docs,
  );
  trace(`work-driver: lens-review — blocking severity ${thresholdDecision.severity}`);
  const threshold = thresholdDecision.severity;

  // #543 F4(g) — a cap-killed lens child is a dispatch-failure of that
  // child (see work-driver-lens-capkill.ts): the driver emits the event so
  // the step router + F5 checkpoint + handoff see the structured cause.
  let summary: Awaited<ReturnType<typeof reviewFn>>;
  try {
    summary = await reviewFn({
      diff,
      context,
      cwd,
      evidence,
      extraFindings,
      threshold,
      pi: ctx.host,
      // #912 — caller-supplied branch for the review-ledger write
      // (driver worktrees are detached; the ledger writer cannot
      // recover the branch name from a detached HEAD).
      branch: ps.branchName,
      // #1024 — the cycle's signal and group policy reach every lens child.
      signal: ctx.signal,
      processGroup: ctx.processGroup,
      pr: ps.prNumber, // the disclosure goes to this cycle's PR, merged or not
    });
    next = await recordResidualsPost(ctx, next, summary, round);
    const capKillEvent = lensCapKillEvent(
      summary,
      jobId,
      round,
      Date.now() - startedAt,
      Date.now(),
    );
    if (capKillEvent) next = appendEvent(next, capKillEvent);
  } catch (err) {
    return appendEvent(next, {
      kind: "dispatch-failed",
      step: "lens-review",
      role: "code-review-specialist",
      jobId,
      label: `lens-review×6 (round ${round})`,
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }

  // The head this round read, for the next round's delta (not on an incomplete review).
  if (fixDelta.head && summary.verdict !== "REVIEW_INCOMPLETE") {
    next = { ...next, pipelineState: { ...next.pipelineState, lensReviewedHead: fixDelta.head } };
  }

  // #543 F5 — persist what the review actually observed. The lens
  // children's per-lens verdicts (lens / status / findings count) are
  // the "sibling verdicts" a REVIEW_INCOMPLETE handoff must preserve:
  // one loop-killed lens is not a silent 1-of-6 loss, so the other
  // five's outcomes are recorded on pipelineState before the cap-hit
  // fires and the handoff renders them. Additive — the event log
  // (tail-invariance, #533) is untouched; this is a snapshot like
  // handoffSnapshot, and the handoff renderers read it when the
  // REVIEW_INCOMPLETE / review-incomplete cap fires.
  if (summary.lenses && summary.lenses.length > 0) {
    const lensVerdicts = summary.lenses.map((l) => ({
      lens: l.lens,
      ok: l.ok,
      blocked: l.blocked,
      findings: l.findings.length,
    }));
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        lensReviewSummary: { round, verdict: summary.verdict, lenses: lensVerdicts },
      },
    };
  }

  next = appendEvent(
    next,
    withUsage(
      {
        kind: "dispatch-completed",
        step: "lens-review",
        role: "code-review-specialist",
        jobId,
        label: `lens-review×6 (round ${round})`,
        ok: true,
        ms: Date.now() - startedAt,
        at: Date.now(),
        summary: `verdict=${summary.verdict}; findings=${summary.totalFindings}`,
        // #456 — per-lens timing persisted so a slow round is diagnosable.
        lensTimings: summary.lenses.length > 0 ? lensTimingsOf(summary.lenses) : undefined,
      },
      summary.usage,
    ),
  );

  // #422 — persist what the review found, deterministically. Candidates only,
  // capped, and never fatal: a memory problem must not affect a cycle whose
  // code work is already done.
  if (summary.findings.length > 0) {
    const written = await writeFindings(
      summary.findings.map((f) => ({ path: f.path, title: f.title, severity: f.severity })),
      { src: "pi-rukas", issue: ctx.issue, kind: "lens-finding", cycle: String(round) },
      { cwd: ctx.repoRoot, timeoutMs: 8000 },
    );
    for (const w of written) {
      next = appendEvent(next, {
        kind: "memory-write",
        at: Date.now(),
        outcome: w.outcome,
        id: w.id,
        memoryType: "observation",
        detail: w.detail,
      });
    }
  }

  // #973 review — the no-review outcome must never look like an approval.
  // runLens supplies its own diff (the merged worktree diff from
  // readAllMergedDiffs; the empty-diff case skips to lens-approved above),
  // so a `noReview` summary can only arrive through a `since`-shaped call
  // (e.g. an injected lensReviewFn). Handle it defensively: route to
  // handoff (a STOP — never a fake lens-approved event the nextStep router
  // would trust, and never the round-cap/step-back routing below).
  if (summary.noReview) {
    trace(
      `work-driver: lens-review — no-review outcome (nothing changed since ${summary.deltaReview?.since.slice(0, 8)}) — routing to handoff (a no-review is not an approval)`,
    );
    return appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "no-review-outcome",
      reviewRound: round,
      nextStep: "handoff",
      evidence: `lens review returned a no-review outcome (no changes since ${summary.deltaReview?.since ?? "the last recorded lens run"}) — a no-review is not an approval; re-run the review with an explicit diff after a new commit`,
    });
  }

  next = await applyLensVerdict(summary, jobId, round, ctx, next);

  // #280 §B — round-1 seam escalation: detectRepeatSeam fires, route to
  // step-back (SDD analysis). Round ≥2 unchanged.
  const seamEscalationEnabled = process.env.PI_ENSEMBLE_SEAM_ESCALATION !== "0";
  if (
    seamEscalationEnabled &&
    round === 1 &&
    (summary.verdict === "ISSUES_FOUND" || summary.verdict === "CRITICAL_ISSUES_FOUND") &&
    summary.findings.length > 0
  ) {
    const seam = detectRepeatSeam(summary.findings);
    if (seam) {
      // theme includes lens + pattern so downstream tests can verify it
      next = appendEvent(next, {
        kind: "step-back-triggered",
        at: Date.now(),
        theme: `${seam.lens}::${seam.normalisedTitle}`,
      });
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "repeat-finding-seam",
        reviewRound: round,
        nextStep: "step-back",
        evidence: `repeat-finding-seam detected: ${seam.fileCount} files share the same ${seam.normalisedTitle} pattern`,
      });
      return next;
    }
  }

  return next;
}
