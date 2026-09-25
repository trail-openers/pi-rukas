/** work-driver-lens — Step 7 (lens review) + Step 7f (lens-fix) handlers. */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { carriedAdversarialFindings } from "./adversarial-findings.ts";
import { detectRepeatSeam } from "./detect-repeat-seam.ts";
import { type WideningFinding, scanTypeWidening } from "./invariant-scan.ts";
import { buildEvidence, runClaimScan } from "./lens-evidence.ts";
import { runLensReview } from "./lens-review.ts";
import { appendGuardWriteEvents, runGuardMemoryWrites } from "./lens-vipune-write.ts";
import { writeFindings } from "./memory-write.ts";
import { resolveReviewThreshold } from "./review-threshold.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { readAllMergedDiffs } from "./work-driver-diff.ts";
import { readDoctrineAtBase } from "./work-driver-doctrine.ts";
import { lensCapKillEvent, lensTimingsOf } from "./work-driver-lens-capkill.ts";
import { countCommittedAhead, noDiffEvidence } from "./work-driver-lens-fix-commit.ts";
import { applyLensVerdict } from "./work-driver-lens-verdicts.ts";
import { parsePrNumber, runSingleDispatch } from "./work-driver-merged.ts";
import { DOCTRINE_FILES, type DoctrineDoc, judgePolicy } from "./work-driver-policy.ts";
import { inlineLensFixPrompt, scratchHygieneSection } from "./work-driver-prompts-late.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { withUsage } from "./workflow-state-events-usage.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

const execp = promisify(exec);

export async function runLens(
  ctx: DriverContext,
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
  if (wideningScanEnabled && widenings.length > 0) {
    const findingsSummary = widenings
      .map(
        (f) =>
          `  ${f.file}:${f.line ?? "?"} [${f.kind}]${f.before ? ` before: ${f.before}` : ""}${
            f.after ? ` after: ${f.after}` : ""
          }`,
      )
      .join("\n");
    context += `\n\nTYPE-WIDENING DETECTED (route-only to ARCHITECTURE lens):\n${findingsSummary}\n\nMANDATE: the ARCHITECTURE lens must answer: what invariant did this widening remove, and what now guarantees it?`;
  }

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
  const thresholdDecision = await resolveReviewThreshold(judgePolicy(ctx.repoRoot), docs);
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
      pi: ctx.pi,
    });
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
        memoryType: "guard",
        detail: w.detail,
      });
    }
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

/** #305 — commit lens-fix changes in the worktree (no empty commit). */
export async function commitLensFixChanges(
  cwd: string,
  round: number,
  execFn: (
    cmd: string,
    opts?: { cwd?: string; maxBuffer?: number; shell?: string },
  ) => Promise<{ stdout: string; stderr?: string }>,
): Promise<{ committed: boolean; error?: string; pushed?: boolean }> {
  // Check if there are any changes (staged + unstaged + untracked), and
  // capture the porcelain output for path parsing. One git status fork.
  let status: string;
  try {
    const raw = await execFn("git status --porcelain", {
      cwd,
      maxBuffer: 64 * 1024,
    });
    status = raw.stdout;
  } catch (err) {
    const errMsg = `git status failed: ${(err as Error).message?.slice(0, 200)}`;
    trace(`work-driver: lens-fix round ${round} — ${errMsg}`);
    return { committed: false, error: errMsg };
  }
  if (!status.trim()) {
    // Clean tree — the committed-work check is done by the CALLER
    // (runAdversarial) via `detectCommittedFix`. Reaching here with a
    // clean tree means the caller found no committed fix either.
    trace(`work-driver: lens-fix round ${round} — working tree clean, skipping commit`);
    return { committed: false };
  }

  // Stage + commit.
  try {
    // Stage all porcelain paths explicitly (tracked + untracked) rather
    // than `git add -u`, so new files created by the developer as part
    // of the fix are committed. Filter out `.pi/` and `tmp/` to avoid
    // staging driver artefacts like .pi/work-state/<issue>.json and
    // subagent scratch (#305). Mirrors the stagePorcelainPaths pattern
    // used by mechanizedCommitPr.
    const porcelain = status;
    const paths: string[] = [];
    for (const line of porcelain.split("\n")) {
      if (line.trim().length === 0) continue;
      const entry = line.slice(3);
      const arrow = entry.indexOf(" -> ");
      if (arrow >= 0) {
        paths.push(entry.slice(0, arrow), entry.slice(arrow + 4));
      } else {
        paths.push(entry);
      }
    }
    for (const p of paths) {
      const clean = p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
      // Skip driver artefacts under .pi/ and tmp/
      if (clean.startsWith(".pi/") || clean.startsWith("tmp/")) {
        continue;
      }
      await execFn(`git add -- ${JSON.stringify(clean)}`, { cwd, maxBuffer: 256 * 1024 });
    }
    await execFn(`git commit -q -m 'fix(lens): round ${round} — address lens-review findings'`, {
      cwd,
      maxBuffer: 64 * 1024,
    });
    trace(`work-driver: lens-fix round ${round} — committed fix`);
    return { committed: true };
  } catch (err) {
    const errMsg = `commit failed: ${(err as Error).message?.slice(0, 200)}`;
    trace(`work-driver: lens-fix round ${round} — ${errMsg}`);
    return { committed: false, error: errMsg };
  }
}

/** #654 — count lens-fix-empty-resend events after this round's anchor. */
export function countLensFixEmptyResends(events: readonly unknown[], reviewRound: number): number {
  const lensIdx = events
    .map((e, i) => ({ e, i }))
    .filter(
      ({ e }) =>
        (e as { kind?: string }).kind === "lens-issues-found" &&
        (e as { round?: number }).round === reviewRound,
    )
    .at(-1)?.i;
  if (lensIdx === undefined) return 0;
  let n = 0;
  for (let i = lensIdx + 1; i < events.length; i++) {
    if ((events[i] as { kind?: string }).kind === "lens-fix-empty-resend") n++;
  }
  return n;
}

export async function runLensFix(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  // Find the most recent lens-issues-found in the log to extract findings.
  const lastFinding = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<(typeof state.eventLog)[number], { kind: "lens-issues-found" }> =>
        e.kind === "lens-issues-found",
    );
  const findings = lastFinding?.findings ?? "(no prior findings recorded)";
  // #654 — empty-diff shape: re-dispatch the fix ONCE with no-diff evidence
  // before re-flagging identical findings at escalating severity.
  const resends = countLensFixEmptyResends(state.eventLog, state.pipelineState.reviewRound);
  const fixTree = lensWorktree(ctx, state);
  let next = state;
  if (resends > 0) {
    // The worktree was already established clean by the #492 inspection in
    // runAdversarial (that is what parked the cycle). Re-inspect for the
    // re-dispatch's own evidence: if it is now dirty, the previous attempt
    // left uncommitted work — commit it (that is what the prompt says), do
    // not re-dispatch blindly.
    // #749 — committed-work-aware: a clean porcelain is NOT evidence of
    // "no fix" when the fixer committed its work. Check the committed
    // count against the branch head before classifying.
    let porcelain: string | undefined;
    try {
      const execFn = ctx.verifyExecFn ?? execp;
      const { stdout } = await execFn("git status --porcelain", {
        cwd: fixTree,
        maxBuffer: 64 * 1024,
      });
      porcelain = stdout.trim();
    } catch {
      porcelain = undefined;
    }
    if (porcelain === undefined || porcelain.length > 0) {
      // Dirty tree (or unreadable — fail open to the normal dispatch, which
      // will integrate the uncommitted work through the existing gate). No
      // re-dispatch needed.
      trace(
        `work-driver: lens-fix re-dispatch skipped — worktree ${fixTree} not clean (or unreadable)`,
      );
    } else {
      // Clean tree. Check committed work before declaring "no fix".
      const branchName = state.pipelineState.branchName;
      let committedCount: number | undefined;
      if (branchName) {
        const execFn = ctx.verifyExecFn ?? execp;
        committedCount = await countCommittedAhead(execFn, fixTree, branchName);
      }
      if (committedCount !== undefined && committedCount > 0) {
        // The fixer committed its work — NOT a no-diff shape. The
        // re-dispatch must not claim "no changes" when a committed fix
        // exists.
        trace(
          `work-driver: lens-fix re-dispatch skipped — worktree ${fixTree} has ${committedCount} committed fix(es) ahead of ${branchName}`,
        );
      } else {
        const evidence = branchName
          ? noDiffEvidence(fixTree, branchName, committedCount ?? null)
          : `no committed fix: no branch name recorded; worktree ${fixTree} has a clean working tree`;
        trace(`work-driver: lens-fix re-dispatch — no committed fix in ${fixTree}`);
        next = appendEvent(next, {
          kind: "lens-fix-empty-resend",
          at: Date.now(),
          jobId: makeRunId(),
          round: state.pipelineState.reviewRound,
          worktree: fixTree,
          evidence,
        });
      }
    }
  }
  const isResend = next !== state;
  const prompt = isResend
    ? [
        `RE-DISPATCH — the previous lens-fix dispatch produced no committed fix: no commits ahead of the feature branch in the lens-fix worktree ${JSON.stringify(fixTree)}.`,
        `Either the findings are already resolved in the committed diff (in which case say so with \`nothing-to-fix: <one-line reason>\` and make no changes), or the previous attempt left uncommitted work in that tree that it never committed. Inspect the tree — \`git -C ${fixTree} status\` — and commit any uncommitted fix work there: \`git add -A\` followed by \`git commit -m "<type>(scope): concise subject"\`. Do NOT push.`,
        "",
        "Findings (JSON-encoded array of {path, line, severity, title, suggestion}):",
        "```json",
        findings,
        "```",
        scratchHygieneSection(scratchDir(ctx.repoRoot, ctx.issue)),
      ].join("\n")
    : inlineLensFixPrompt(findings, scratchDir(ctx.repoRoot, ctx.issue));
  return runSingleDispatch(
    ctx,
    next,
    "lens-fix",
    "developer",
    `developer:lens-fix-${state.pipelineState.reviewRound}`,
    now,
    () => prompt,
    // Fix the code where the code IS. This dispatch carried no cwd, so the
    // child edited repoRoot while `integrateLensFix` staged from the worktree
    // nobody had touched — `stagePorcelainPaths` returned 0 and the loop
    // `continue`d, so the fix was silently dropped and the next lens round
    // re-flagged the same findings at escalating severity until the cap.
    //
    // Observed on nessie #663: the pushed commit had deleted 1007 lines of
    // src/config/mod.rs, breaking the build. The lens-fix developer restored it
    // correctly — 1174 lines, staged — and none of it was ever committed.
    //
    // The same worktree the review itself read, so the fix lands against the
    // tree the findings describe. One worktree holds every workstream's
    // consolidated work, so there is no N>1 partition to make here.
    { cwd: lensWorktree(ctx, state) },
  );
}

/**
 * The tree the lens gate works in. #492 — exported so the adversarial gate's
 * lens-fix integration path names the SAME tree. Falls back to repoRoot.
 */
export function lensWorktree(ctx: DriverContext, state: WorkState): string {
  const wt = state.pipelineState.worktrees ?? {};
  return wt.default ?? wt[Object.keys(wt)[0] ?? ""] ?? ctx.repoRoot;
}
