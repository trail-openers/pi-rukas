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
import { runSingleDispatch } from "./work-driver-merged.ts";
import { DOCTRINE_FILES, type DoctrineDoc, judgePolicy } from "./work-driver-policy.ts";
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
const execp = promisify(exec);

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
  // #384 — read the diff in a form that can say "I could not tell". The
  // plain read returned "" on every git failure, and the guard below treats
  // an empty diff as APPROVED — so a stale ref, a transient git error or a
  // maxBuffer overrun on a large diff all merged code unreviewed. Same defect
  // class as the `ci-status:` substring #380 removed from the merge step.
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

  const cwd =
    ps.worktrees?.default ??
    ps.worktrees?.[Object.keys(ps.worktrees ?? {})[0] ?? ""] ??
    ctx.repoRoot;
  const startedAt = Date.now();
  const jobId = makeRunId();
  const reviewFn = ctx.lensReviewFn ?? runLensReview;

  // Build lens context: base context + widening findings (if any).
  let context = `/work issue #${ctx.issue}, lens-review round ${round}`;
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

  let summary: Awaited<ReturnType<typeof reviewFn>>;
  try {
    summary = await reviewFn({ diff, context, cwd, evidence, extraFindings, threshold });
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
    // against a partial review. Standing doctrine: never silently downgrade
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
  );
}
