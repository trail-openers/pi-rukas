/**
 * work-driver-lens — Step 6 PR-number parsing + Step 7 (six-pass lens
 * review) + Step 7f (lens-fix) handlers.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene).
 * `commitLensFixChanges` is called by both `runLensFix` (indirectly, via
 * the next adversarial round) and work-driver-adversarial.ts's
 * `runAdversarial` (directly, after approval) — it lives here since it's
 * lens-fix's commit step, not adversarial's.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { carriedAdversarialFindings } from "./adversarial-findings.ts";
import { type WideningFinding, scanTypeWidening } from "./invariant-scan.ts";
import { buildEvidence, runClaimScan } from "./lens-evidence.ts";
import { runLensReview } from "./lens-review.ts";
import { writeFindings } from "./memory-write.ts";
import { resolveReviewThreshold } from "./review-threshold.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { readAllMergedDiffs } from "./work-driver-diff.ts";
import { readDoctrineAtBase } from "./work-driver-doctrine.ts";
import { lensCapKillEvent } from "./work-driver-lens-capkill.ts";
import { applyLensVerdict } from "./work-driver-lens-verdicts.ts";
import { runSingleDispatch } from "./work-driver-merged.ts";
import { DOCTRINE_FILES, type DoctrineDoc, judgePolicy } from "./work-driver-policy.ts";
import { inlineLensFixPrompt } from "./work-driver-prompts-late.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { withUsage } from "./workflow-state-events-usage.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * Parse `pr: <N>` from an ops commit-pr reply. Lenient — accepts
 * surrounding markdown emphasis (`**pr**: 556`), backticks (`pr: #556`,
 * `pr: \`#556\``), and the bare-or-`#`-prefixed number. Returns
 * `undefined` when no marker line is present (the dispatch may have
 * succeeded but ops forgot the marker — that's fine, runHandoff will
 * fall back to `gh issue comment`).
 */
const execp = promisify(exec);

export function parsePrNumber(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/^[ \t]*\*{0,2}pr\*{0,2}\s*:\s*`?#?(\d+)`?\s*$/im);
  if (!m) return undefined;
  const n = Number.parseInt(m[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * #456 — project a lens pass down to the per-lens timings persisted on the
 * `dispatch-completed` event. Pure so the shape is a tested contract:
 * sequential startMs across a pass (spawn cap 1) are the fingerprint of
 * semaphore queueing, distinct from a pass slowed by a contaminated diff.
 */
export function lensTimingsOf(
  lenses: Array<{ lens: unknown; startMs?: number; ms: number }>,
): Array<{ lens: string; startMs: number; ms: number }> {
  return lenses.map((l) => ({
    lens: String(l.lens),
    startMs: l.startMs ?? 0,
    ms: l.ms,
  }));
}

/**
 * Step 7 — Six-pass lens review.
 *
 * Calls `runLensReview` (exported from lens-review.ts) directly. The
 * function returns a structured LensReviewSummary with `verdict` we route
 * on. Bumps `reviewRound` and seeds `reviewCapStartedAt` on first entry.
 */
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

  // PR11 — lens-review runs POST-commit: `git diff HEAD` is empty at this
  // point (the changes are IN HEAD), so fetchAllMergedDiffs uses
  // `git diff origin/<base>..HEAD` (runAdversarial still uses
  // fetchAllDiffs — adversarial runs PRE-commit, uncommitted diff).
  // #384 — the read can say "I could not tell": a plain read returned ""
  // on every git failure and the guard below treated an empty diff as
  // APPROVED (stale ref / transient error / maxBuffer → unreviewed merge).
  const diffResult = await readAllMergedDiffs(ps.worktrees ?? {}, ctx.repoRoot, ps.branchName);
  if (!diffResult.ok) {
    trace(`work-driver: lens-review — diff unreadable: ${diffResult.reason}`);
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        lensDiffError: diffResult.reason,
      },
    };
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
  }

  // PR6 — empty-diff guard. Lens children hallucinate findings against
  // unrelated files when given empty context: on #533 (a devDep bump
  // already merged 5 days earlier) develop committed nothing, then
  // lens-review found PERFORMANCE issues in `src/web/sweep_stats.rs`.
  // PR11 narrows the failure mode the guard fires for: the integration
  // branch has no commits ahead of mainline (genuinely nothing to
  // review), not "git diff HEAD is empty after commit" (post-PR11 the
  // diff is base..HEAD, not HEAD).
  // Reaching here with an empty diff now means the branch was CONFIRMED to
  // have no commits ahead of base (`git rev-list --count` returned 0), not
  // merely that the read produced no output.
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
    summary = await reviewFn({ diff, context, cwd, evidence, extraFindings, threshold });
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
      { src: "pi-ensemble", issue: ctx.issue, kind: "lens-finding", cycle: String(round) },
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

  return next;
}

/**
 * Issue #305 — Mechanically commit lens-fix changes in the worktree.
 *
 * Called by runAdversarial after adversarial approves lens-fix changes.
 * Stages and commits any working-tree changes at ctx.repoRoot so the next
 * runLens (which reads committed state via `git diff origin/<base>..HEAD`) can
 * see the fix. If no changes exist (developer made no modifications), does
 * nothing — no empty commit.
 *
 * Returns { committed: true } if a commit was made, { committed: false }
 * if the working tree was clean, or { committed: false, error: <msg> } if
 * git failed.
 */
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
    if (!status.trim()) {
      trace(`work-driver: lens-fix round ${round} — working tree clean, skipping commit`);
      return { committed: false };
    }
  } catch (err) {
    const errMsg = `git status failed: ${(err as Error).message?.slice(0, 200)}`;
    trace(`work-driver: lens-fix round ${round} — ${errMsg}`);
    return { committed: false, error: errMsg };
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

/**
 * Step 7f — Lens fix loop iteration. Dispatches @developer with the
 * findings from the last lens-issues-found event. The driver's transition
 * table routes lens-fix → adversarial → lens-review (or to handoff on cap-
 * hit per nextStep()).
 *
 * Issue #305 — after adversarial approves lens-fix changes, runAdversarial
 * mechanically commits the fix at ctx.repoRoot. This bridges the gap between
 * runLensFix (which edits the working tree) and runLens (which reads
 * committed state via `git diff origin/<base>..HEAD`). Without this commit,
 * the next lens round sees the same baseline and re-flags the same findings
 * at escalating severity.
 */
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
  return runSingleDispatch(
    ctx,
    state,
    "lens-fix",
    "developer",
    `developer:lens-fix-${state.pipelineState.reviewRound}`,
    now,
    () => inlineLensFixPrompt(findings, scratchDir(ctx.repoRoot, ctx.issue)),
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
 * The tree the lens gate works in.
 *
 * The review and the fix have to agree on this. They did not: `runLens`
 * resolved a worktree while the fix dispatch passed no `cwd` at all and landed
 * in the Pi process's directory, so the fix was written somewhere the driver
 * never looked. Having one resolver is what keeps them from drifting apart
 * again.
 *
 * #492 — exported so the adversarial gate's lens-fix integration path names
 * the SAME tree it inspects and reports: the cap's handoff text and the
 * smoke tests must point at the worktree the driver actually checked.
 *
 * Falls back to repoRoot when no worktree is recorded — a cycle whose
 * mechanized branch setup fell back develops there, and the fix belongs
 * wherever the work is.
 */
export function lensWorktree(ctx: DriverContext, state: WorkState): string {
  const wt = state.pipelineState.worktrees ?? {};
  return wt.default ?? wt[Object.keys(wt)[0] ?? ""] ?? ctx.repoRoot;
}
