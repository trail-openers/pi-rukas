/**
 * work-driver-commit — Step 6 (commit-pr) handler + the mechanized
 * commit-pr recipe.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). The
 * driver executes the consolidation + commit + push + PR-creation
 * recipe directly (PR19) instead of narrating it to an LLM ops dispatch;
 * `runCommitPr` falls back to an LLM ops dispatch on any mechanized
 * `{ok: false}` return.
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { cachedIssueTitle, integrate, withIntegrationLock } from "./work-driver-integrate.ts";
import { renderAssumptions } from "./work-driver-intent.ts";
import { parsePrNumber } from "./work-driver-lens.ts";
import { runSingleDispatch } from "./work-driver-merged.ts";
import { inlineCommitPrPrompt } from "./work-driver-prompts-late.ts";
import { verifyConsolidation, verifyStepOutcome } from "./work-driver-verify.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import { appendEvent } from "./workflow-state.ts";
import type { WorkState } from "./workflow-state.ts";

const execp = promisify(exec);

/**
 * PR19 — Mechanized commit-pr: the driver executes the consolidation +
 * commit + push + PR-creation recipe that `inlineCommitPrPrompt`
 * previously NARRATED to an LLM ops dispatch.
 *
 * Why: every worst-class incident in the harness's history (#245/#253
 * silent merges, v0.12.13 shipping 1-of-3 workstreams) was LLM ops
 * improvising these fully-enumerable operations, and the cd-chain /
 * permission-cache friction class (~22 fixes, vipune memory-row) exists
 * only because an LLM emits the shell. Direct execution deletes the
 * failure source instead of detecting its failures — verifyConsolidation
 * and verifyStepOutcome remain in place downstream as the unchanged
 * correctness oracle.
 *
 * Recipe (mirrors the PR14 prompt, plus one improvement: worktree
 * slices are staged with `git add` before capture, so untracked new
 * files are included — `git diff HEAD` alone silently missed them):
 *
 *   1. Ensure repoRoot is checked out on the integration branch.
 *   2. Per worktree: verify uncommitted work exists (empty → bail to
 *      LLM fallback); for sibling worktrees stage + capture
 *      `git diff --cached` → `git apply --index` at repoRoot; for the
 *      repoRoot-as-worktree case stage porcelain paths directly.
 *   3. Commit with a templated message (issue title from the cached
 *      body artifact; `Fixes #N` per active issue; `Companion to`
 *      lines for dropped issues).
 *   4. Push; `gh pr create --body-file`; parse the PR number from the
 *      URL gh prints.
 *
 * ANY failure returns `{ok: false, reason}` — the caller emits a
 * plumb-report and falls back to the LLM ops dispatch (judgmental
 * recovery), whose behaviour is unchanged from PR14. Success appends
 * the same `step-started` + `dispatch-completed` event shapes the
 * dispatch path produces (role "driver", summary carrying `pr: <N>`),
 * so parsePrNumber + both downstream gates run identically for both
 * paths.
 */
export async function mechanizedCommitPr(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<{ ok: true; state: WorkState } | { ok: false; reason: string }> {
  const execFn = ctx.verifyExecFn ?? execp;
  const ps = state.pipelineState;
  const branchName = ps.branchName;
  if (!branchName || branchName.startsWith("(")) {
    return { ok: false, reason: "integration branch name was not captured at Step 3" };
  }
  const issues = activeIssuesOf(state);
  // #287 — no `?? ctx.repoRoot` fallback: after always-worktree, a missing
  // worktree map means the branch step did not complete, and integrating from
  // repoRoot would consolidate whatever happens to be sitting there.
  const worktrees = ps.worktrees ?? {};
  const ids = Object.keys(worktrees);
  if (ids.length === 0) {
    return { ok: false, reason: "no worktrees recorded at Step 3 — nothing to consolidate" };
  }
  const startedAt = Date.now();
  try {
    const title = (await cachedIssueTitle(state))?.slice(0, 72) ?? `implement issue #${ctx.issue}`;
    const fixesLines = issues.map((n) => `Fixes #${n}`);
    const companionLines = (ps.droppedIssues ?? []).map(
      (d) =>
        `Companion to #${d.issue} (${d.verdict}: ${d.reason || "no reason given"}; left untouched).`,
    );
    const workstreamLines =
      ids.length > 1
        ? [
            "",
            `Consolidated ${ids.length} workstreams: ${ids
              .map((id) => `${id} (${ps.workstreams?.[id]?.scope ?? "no scope"})`)
              .join(", ")}`,
          ]
        : [];
    const commitBody = [...fixesLines, ...companionLines, ...workstreamLines].join("\n");
    // #287 — consolidation, commit and push all happen inside `integrate()`,
    // the single writer to repoRoot. It creates the branch at the recorded
    // baseSha rather than at whatever repoRoot's HEAD is, and refuses to run
    // against a dirty repoRoot (#283's gate, relocated here) so operator
    // residue can never be swept into the PR — incident #602's shape.
    const res = await integrate(execFn, {
      repoRoot: ctx.repoRoot,
      branchName,
      baseSha: ps.baseSha,
      worktrees,
      scratchDir: scratchDir(ctx.repoRoot, ctx.issue),
      commitTitle: title,
      commitBody,
      mode: "create",
      requireAllNonEmpty: true,
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: res.conflictPatch
          ? `${res.reason} (patch preserved at ${res.conflictPatch})`
          : res.reason,
      };
    }
    if (res.empty) {
      return {
        ok: false,
        reason:
          "every worktree was clean — no uncommitted work to consolidate (developer may not have written)",
      };
    }
    // #378 — when the intent resolver filled gaps with defensible defaults,
    // those assumptions belong where review happens. `proceed-with-assumptions`
    // is only honest if the assumptions are visible; buried in a state file
    // they may as well not exist.
    const assumptionsBlock = ps.normalisedSpec
      ? renderAssumptions(ps.normalisedSpec as Parameters<typeof renderAssumptions>[0])
      : "";
    const prBody = [
      "Automated by pi-ensemble /work driver (mechanized commit-pr).",
      "",
      ...fixesLines,
      ...companionLines,
      ...workstreamLines,
      assumptionsBlock,
    ]
      .filter((l) => l !== "")
      .join("\n");
    const prBodyFile = path.join(scratchDir(ctx.repoRoot, ctx.issue), "mech-pr-body.md");
    await fs.mkdir(path.dirname(prBodyFile), { recursive: true });
    await fs.writeFile(prBodyFile, prBody, "utf8");
    // `--head` is not optional under concurrency: without it gh infers the
    // head from repoRoot's CURRENT checkout, so a sibling group that moved
    // HEAD between our push and this call would have its branch opened as our
    // PR — with our title and body. The lock makes that impossible; the flag
    // makes it impossible even if the lock is ever wrong.
    const { stdout: prOut } = await execFn(
      `gh pr create --head ${JSON.stringify(branchName)} --title ${JSON.stringify(title)} --body-file ${JSON.stringify(prBodyFile)}`,
      { cwd: ctx.repoRoot, maxBuffer: 256 * 1024 },
    );
    const prMatch = prOut.match(/\/pull\/(\d+)/);
    const prNumber = prMatch?.[1] ? Number.parseInt(prMatch[1], 10) : undefined;
    if (prNumber === undefined || !Number.isFinite(prNumber)) {
      return {
        ok: false,
        reason: `gh pr create succeeded but no PR number was parseable from its output (${prOut.trim().slice(0, 120)})`,
      };
    }
    // 5. Emit the same event shapes the dispatch path produces so the
    // shared downstream (parsePrNumber + both gates) runs unchanged.
    let next = appendEvent(
      { ...state, pipelineState: { ...state.pipelineState, currentStep: "commit-pr" } },
      { kind: "step-started", step: "commit-pr", at: now },
    );
    next = appendEvent(next, {
      kind: "dispatch-completed",
      step: "commit-pr",
      role: "driver",
      jobId: "mechanized",
      label: "driver:commit-pr",
      ok: true,
      ms: Date.now() - startedAt,
      at: Date.now(),
      summary: `Mechanized commit-pr: consolidated ${ids.length} worktree(s), committed, pushed ${branchName}, opened PR.\npr: ${prNumber}`,
    });
    return { ok: true, state: next };
  } catch (err) {
    const e = err as Error & { stderr?: string };
    return {
      ok: false,
      reason: `${(e.stderr ?? e.message ?? "unknown error").toString().trim().slice(0, 300)}`,
    };
  }
}

/**
 * Step 6 — Commit + PR. ops commits the diff, pushes, opens a PR with
 * `Fixes #N` in the body. PR4 captures the `pr: <N>` line ops's prompt
 * asks for into pipelineState.prNumber so the handoff step (7g) can
 * target the right PR for `gh pr comment` instead of falling back to
 * `gh issue comment`.
 */
export async function runCommitPr(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  // #289 — one contiguous critical section per group. The span deliberately
  // includes the LLM ops fallback (it mutates repoRoot exactly as the
  // mechanized path does) and BOTH verify gates, which read repoRoot HEAD via
  // `git rev-list` / `git diff --name-only` and would otherwise validate a
  // sibling group's commits as this group's evidence.
  return withIntegrationLock(ctx.repoRoot, () => runCommitPrLocked(ctx, state, now));
}

async function runCommitPrLocked(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  let next: WorkState | undefined;
  let preDispatch = state;
  // PR19 — mechanized commit-pr. Consolidation + commit + push + PR
  // creation are fully enumerable operations; every worst-class incident
  // (#245/#253 silent merges, v0.12.13 partial consolidation) was an LLM
  // ops dispatch improvising them. The driver now executes the recipe
  // directly; the LLM ops dispatch remains as fallback when the
  // mechanized path hits something judgmental (apply conflict, push
  // rejection, unexpected repo state) — that env variance is exactly
  // what the LLM absorbs well. #393 removed the knob that forced the LLM path
  // outright: an opt-out restores the shape that caused #245/#253's silent
  // merges and v0.12.13's partial consolidation. The fallback below is
  // recovery from a failed attempt, which is a different thing.
  {
    const mech = await mechanizedCommitPr(ctx, state, now);
    if (mech.ok) {
      next = mech.state;
    } else {
      trace(`work-driver: mechanized commit-pr fell back to ops dispatch: ${mech.reason}`);
      preDispatch = appendEvent(state, {
        kind: "plumb-report",
        at: Date.now(),
        step: "commit-pr",
        role: "driver",
        body: `Mechanized commit-pr fell back to the ops dispatch: ${mech.reason}. Note: the repo root may contain partially staged consolidation from the mechanized attempt — verify with \`git status\` before re-applying patches.`,
      });
    }
  }
  if (next === undefined) {
    next = await runSingleDispatch(ctx, preDispatch, "commit-pr", "ops", "ops:commit-pr", now, () =>
      // PR14 — thread worktrees + workstreams + branchName into the prompt
      // so ops knows to consolidate every worktree's uncommitted changes
      // (not just whichever one its dispatch landed in). Pre-PR14 the
      // prompt was single-tree shaped; multi-workstream cycles silently
      // committed only one worktree's slice (v0.12.13 /work 577 incident).
      inlineCommitPrPrompt(
        activeIssuesOf(preDispatch),
        preDispatch.pipelineState.droppedIssues ?? [],
        preDispatch.pipelineState.worktrees ?? {},
        preDispatch.pipelineState.workstreams ?? {},
        preDispatch.pipelineState.branchName ?? "(branch not captured — set in Step 3)",
        scratchDir(ctx.repoRoot, ctx.issue),
      ),
    );
  }
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;
  const prNumber = parsePrNumber(last.summary);
  if (prNumber !== undefined) {
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, prNumber },
    };
  }
  // PR14 — post-dispatch consolidation gate. For N>1 cycles, verify the
  // committed diff includes files from EVERY workstream's `paths` list.
  // If any workstream's paths are entirely absent from the diff, ops
  // committed a partial slice — halt with cap-hit so the operator can
  // investigate before the merge step ships the partial work.
  //
  // Defense in depth: the new prompt instructions explicitly tell ops
  // to consolidate all worktrees and verify before committing, but
  // doctrine alone isn't enough — the v0.12.13 incident merged 1 of 3
  // workstreams as a "successful" cycle.
  const consolidationCheck = await verifyConsolidation(ctx, next);
  if (consolidationCheck.missing.length > 0) {
    trace(
      `work-driver: commit-pr partial-consolidation detected — missing workstreams: ${consolidationCheck.missing.map((m) => m.id).join(", ")}`,
    );
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        incompleteConsolidation: consolidationCheck.missing,
      },
    };
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "commit-pr-incomplete-consolidation",
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
    });
    return next;
  }
  // PR17 — outcome verification gate: prove the "committed + opened PR"
  // claim with executed evidence (commits ahead of origin/<base>, PR
  // number resolving via gh). Runs only when the consolidation gate
  // passed — one cap per failure, most-specific wins. Bonus repair: when
  // ops forgot the `pr: <N>` marker but the PR exists, the gate adopts
  // the number resolved via `gh pr list --head` so handoff/ci target
  // the right PR (pre-PR17 a missing marker silently degraded both).
  const gate = await verifyStepOutcome(ctx, next, "commit-pr");
  if (gate.adoptedPrNumber !== undefined) {
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, prNumber: gate.adoptedPrNumber },
    };
  }
  if (!gate.ok) {
    trace(`work-driver: verify-failed:commit-pr — ${gate.failures.join(" | ")}`);
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        verifyEvidence: { step: "commit-pr", failures: gate.failures, at: Date.now() },
      },
    };
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "verify-failed:commit-pr",
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
    });
  }
  return next;
}
