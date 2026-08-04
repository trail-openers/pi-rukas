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

import { runLensReview } from "./lens-review.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { fetchAllMergedDiffs } from "./work-driver-diff.ts";
import { runSingleDispatch } from "./work-driver-merged.ts";
import { inlineLensFixPrompt } from "./work-driver-prompts-late.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * Parse `pr: <N>` from an ops commit-pr reply. Lenient — accepts
 * surrounding markdown emphasis (`**pr**: 556`), backticks (`pr: #556`,
 * `pr: \`#556\``), and the bare-or-`#`-prefixed number. Returns
 * `undefined` when no marker line is present (the dispatch may have
 * succeeded but ops forgot the marker — that's fine, runHandoff will
 * fall back to `gh issue comment`).
 */
export function parsePrNumber(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/^[ \t]*\*{0,2}pr\*{0,2}\s*:\s*`?#?(\d+)`?\s*$/im);
  if (!m) return undefined;
  const n = Number.parseInt(m[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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

  // PR11 — lens-review runs POST-commit, when the developer's work is
  // already committed on the feature branch. `git diff HEAD` (what
  // fetchAllDiffs uses) is empty at this point — the changes are IN
  // HEAD, not against it. Pre-PR11 the empty-diff guard fired on every
  // successful cycle (34 ms lens-review skip → code merged without six-
  // pass review). fetchAllMergedDiffs uses `git diff origin/<base>..HEAD`
  // which correctly returns the integrated diff. runAdversarial still
  // uses fetchAllDiffs because adversarial runs PRE-commit (uncommitted
  // diff in the worktree is the right input there).
  const diff = await fetchAllMergedDiffs(ps.worktrees ?? {}, ctx.repoRoot);

  // PR6 — empty-diff guard. Lens children hallucinate findings against
  // unrelated files when given empty context: on #533 (a devDep bump
  // already merged 5 days earlier) develop committed nothing, then
  // lens-review found PERFORMANCE issues in `src/web/sweep_stats.rs`.
  // PR11 narrows the failure mode the guard fires for: the integration
  // branch has no commits ahead of mainline (genuinely nothing to
  // review), not "git diff HEAD is empty after commit" (post-PR11 the
  // diff is base..HEAD, not HEAD).
  if (!diff.trim()) {
    next = appendEvent(
      next,
      { kind: "lens-skipped-empty-diff", at: Date.now(), round },
      { kind: "lens-approved", at: Date.now(), jobId: makeRunId(), round },
    );
    return next;
  }

  const cwd =
    ps.worktrees?.default ??
    ps.worktrees?.[Object.keys(ps.worktrees ?? {})[0] ?? ""] ??
    ctx.repoRoot;
  const startedAt = Date.now();
  const jobId = makeRunId();
  const reviewFn = ctx.lensReviewFn ?? runLensReview;
  let summary: Awaited<ReturnType<typeof reviewFn>>;
  try {
    summary = await reviewFn({
      diff,
      context: `/work issue #${ctx.issue}, lens-review round ${round}`,
      cwd,
    });
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

  next = appendEvent(next, {
    kind: "dispatch-completed",
    step: "lens-review",
    role: "code-review-specialist",
    jobId,
    label: `lens-review×6 (round ${round})`,
    ok: true,
    ms: Date.now() - startedAt,
    at: Date.now(),
    summary: `verdict=${summary.verdict}; findings=${summary.totalFindings}`,
  });

  if (summary.verdict === "APPROVED") {
    next = appendEvent(next, { kind: "lens-approved", at: Date.now(), jobId, round });
  } else if (summary.verdict === "ISSUES_FOUND" || summary.verdict === "CRITICAL_ISSUES_FOUND") {
    next = appendEvent(next, {
      kind: "lens-issues-found",
      at: Date.now(),
      jobId,
      round,
      findings: JSON.stringify(summary.findings.slice(0, 50)),
      verdict: summary.verdict,
    });
  } else {
    // REVIEW_INCOMPLETE — at least one lens failed all retries. Treat as a
    // halt that needs human attention rather than continuing the fix loop
    // against a partial review. /work.md doctrine: never silently downgrade
    // a six-pass to a five-pass.
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "adversarial-loop",
      reviewRound: round,
      nextStep: "handoff",
    });
  }

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
): Promise<{ committed: boolean; error?: string }> {
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
  );
}
