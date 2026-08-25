/**
 * work-driver-commit — Step 6 (commit-pr) handler + the mechanized
 * commit-pr recipe.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). The
 * driver executes the consolidation + commit + push + PR-creation
 * recipe directly (PR19) instead of narrating it to an LLM ops dispatch;
 * `runCommitPr` falls back to an LLM ops dispatch on a mechanized
 * `{ok: false}` return -- EXCEPT a `terminal` one, which is a verdict the
 * fallback has no standing to overturn (see `mechanizedCommitPr`).
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { carriedAdversarialFindings, renderCarriedFindings } from "./adversarial-findings.ts";
import { trace } from "./trace.ts";
import {
  type CommitPrRootInspect,
  type CommitPrRootState,
  inspectCommitPrRoot,
} from "./work-driver-commit-inspect.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  type IntegrateResult,
  cachedIssueTitle,
  integrate,
  withIntegrationLock,
} from "./work-driver-integrate.ts";
import { renderAssumptions } from "./work-driver-intent.ts";
import { parsePrNumber } from "./work-driver-lens.ts";
import { runSingleDispatch } from "./work-driver-merged.ts";
import { inlineCommitPrPrompt } from "./work-driver-prompts-late.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { verifyConsolidation, verifyStepOutcome } from "./work-driver-verify.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import { appendEvent } from "./workflow-state.ts";
import type {
  CommitPrFallbackCause,
  ConsolidationVerdict,
  IncompleteConsolidation,
  WorkState,
} from "./workflow-state.ts";

const execp = promisify(exec);

// #507 — clip a PR title to a code-unit budget at a word boundary.
// Budget 64 (not 72): GitHub squash-merge appends ` (#<N>)`.
export function clipTitle(raw: string, budget: number): string {
  if (raw.length <= budget) return raw;
  let cut = budget - 1; // reserve one code unit for the ellipsis
  // Rule 4 — never leave a dangling high surrogate: if the cut falls between
  // the two halves of a surrogate pair (high half at cut-1 in the prefix, low
  // half at cut in the dropped tail), step the cut back so the pair is cut
  // whole. The high half can only sit at cut-1 when the low half sits at
  // cut, so checking the cut position for a low surrogate is sufficient.
  if (cut < raw.length) {
    const at = raw.charCodeAt(cut);
    const before = raw.charCodeAt(cut - 1);
    if (
      (at >= 0xdc00 && at <= 0xdfff && before >= 0xd800 && before <= 0xdbff) ||
      (at >= 0xd800 && at <= 0xdbff)
    ) {
      cut -= 1;
    }
  }
  // Rule 5 — last whitespace at or before cut; prefix after trimEnd must be
  // non-empty (a boundary at index 0 would otherwise yield a bare ellipsis).
  for (let i = cut; i >= 0; i--) {
    const ch = raw.charAt(i);
    if (/\s/.test(ch) && raw.slice(0, i).trimEnd().length > 0) {
      return `${raw.slice(0, i).trimEnd()}\u2026`;
    }
  }
  // Rule 6 — no breakable boundary (a single unbreakable token over budget).
  // The one case where a word is cut mid-way: the alternative is an empty
  // title, which is worse. `cut` was already backed off the pair in rule 4.
  return `${raw.slice(0, cut)}\u2026`;
}

/**
 * #500 — the `commitPrRoot` / `commitPrRootError` record fields for both
 * commit-pr paths (mechanized + ops fallback). One builder so the two
 * write sites cannot drift when the record gains a field.
 */
function commitPrRootFieldsOf(r: CommitPrRootInspect): {
  commitPrRoot: CommitPrRootState | undefined;
  commitPrRootError: string | undefined;
} {
  return r.ok
    ? { commitPrRoot: r.state, commitPrRootError: undefined }
    : { commitPrRoot: undefined, commitPrRootError: r.error };
}

// #539 — the fallback-cause vocabulary lives ONCE in workflow-state-events.ts
// (the event type that persists it) and is imported above; re-declaring it
// here is the duplication M1's review flagged. Re-exported for the
// mechanizedCommitPr return type below.
export type { CommitPrFallbackCause } from "./workflow-state-events.ts";

/** #539 — the structured cause, or `undefined` when integrate() did not
 * fail. Reads `res.failure` (the discriminator), never re-parses `reason` —
 * the catch-all turns any Error into `e.stderr ?? e.message`. */
function causeFromIntegrateFailure(res: IntegrateResult): CommitPrFallbackCause | undefined {
  if (res.ok) return undefined;
  return res.failure === "dirty-repoRoot" ? "dirty-repoRoot" : "other";
}

/**
 * Wall-clock for the verify run against the consolidated tree. This is the
 * project's FAST suite, not the full one — it exists to catch "the
 * combination does not build", which is quick to discover. Default 15 min.
 */
function integrationVerifyTimeoutMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_INTEGRATION_VERIFY_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 15 * 60_000;
}

/**
 * PR19 — Mechanized commit-pr: the driver executes the consolidation +
 * commit + push + PR-creation recipe that `inlineCommitPrPrompt`
 * previously NARRATED to an LLM ops dispatch. Every worst-class incident in
 * the harness's history (#245/#253 silent merges, v0.12.13 shipping 1-of-3
 * workstreams) was LLM ops improvising these fully-enumerable operations;
 * direct execution deletes the failure source instead of detecting its
 * failures. Recipe: ensure repoRoot is on the integration branch; per
 * worktree verify uncommitted work, stage + capture `git diff --cached`
 * (staging first is what includes untracked new files), `git apply --index`
 * at repoRoot; commit with a templated message; push; `gh pr create`
 * `--head <branch>`; parse the PR number. Most failures return
 * `{ok: false, reason}` — the caller emits a plumb-report and falls back to
 * the LLM ops dispatch (judgmental recovery). The exception is
 * `terminal: true`, set when the CONSOLIDATED tree fails the project's
 * verify command: the fallback exists to absorb environment variance, and
 * "this does not build" is a fact rather than variance — #328's shape.
 * Success appends the same `step-started` + `dispatch-completed` event
 * shapes the dispatch path produces (role "driver", summary carrying
 * `pr: <N>`), so parsePrNumber + both downstream gates run identically.
 */
export async function mechanizedCommitPr(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<
  | { ok: true; state: WorkState }
  | { ok: false; reason: string; terminal?: boolean; fallbackCause?: CommitPrFallbackCause }
> {
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
    const rawTitle = await cachedIssueTitle(state);
    const title =
      rawTitle !== null && rawTitle !== undefined
        ? clipTitle(rawTitle, 64)
        : `implement issue #${ctx.issue}`;
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
      // The first time anything compiles the COMBINATION of the workstreams.
      // Absent `.pi/verify-cmd` leaves this undefined and the gate skips.
      verifyCmd: await verifyCmdFor(ctx.repoRoot),
      verifyExecFn: ctx.verifyExecFn,
      verifyTimeoutMs: integrationVerifyTimeoutMs(),
    });
    // #539 — the structured cause travels with the result: integrate()
    // KNOWS why it failed; a reader re-parsing `reason` would be guessing.
    const fallbackCause = causeFromIntegrateFailure(res);
    if (!res.ok) {
      return {
        ok: false,
        reason: res.conflictPatch
          ? `${res.reason} (patch preserved at ${res.conflictPatch})`
          : res.reason,
        // A tree that does not build is a verdict, not the environment
        // variance the LLM fallback exists to absorb. Handing it on would
        // make the gate one that cannot fail: it blocks the mechanized path
        // and the ops dispatch commits and pushes the same broken tree
        // anyway — #328's shape, in a new place.
        terminal: res.failure === "verify",
        fallbackCause,
      };
    }
    if (res.empty) {
      return {
        ok: false,
        reason:
          "every worktree was clean — no uncommitted work to consolidate (developer may not have written)",
        fallbackCause,
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
      renderCarriedFindings(carriedAdversarialFindings(state.eventLog)),
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
    const rootState = await inspectCommitPrRoot(execFn, ctx.repoRoot);
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
    const commitPrRootFields = commitPrRootFieldsOf(rootState);
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        ...commitPrRootFields,
      },
    };
    return { ok: true, state: next };
  } catch (err) {
    const e = err as Error & { stderr?: string };
    return {
      ok: false,
      // #539 — a thrown error (ENOENT, signal kill, an uncaught apply
      // stderr) is NOT an integrate() verdict: no structured cause, so
      // "other" is the honest label rather than a regex over the message.
      fallbackCause: "other",
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
    } else if (mech.terminal) {
      // The consolidated tree does not build. The fallback exists to absorb
      // environment variance, not to overrule a verdict — letting ops commit
      // and push the same tree would make this a gate that cannot fail, and
      // the six lenses would then review something that was never compiled.
      trace(`work-driver: commit-pr halted, consolidated tree failed verify: ${mech.reason}`);
      return appendEvent(
        state,
        {
          kind: "plumb-report",
          at: Date.now(),
          step: "commit-pr",
          role: "driver",
          body: mech.reason,
        },
        {
          kind: "cap-hit",
          at: Date.now(),
          cap: "integration-verify-failed",
          reviewRound: state.pipelineState.reviewRound,
          nextStep: "handoff",
        },
      );
    } else {
      trace(`work-driver: mechanized commit-pr fell back to ops dispatch: ${mech.reason}`);
      preDispatch = appendEvent(state, {
        kind: "plumb-report",
        at: Date.now(),
        step: "commit-pr",
        role: "driver",
        body: `Mechanized commit-pr fell back to the ops dispatch: ${mech.reason}. Note: the repo root may contain partially staged consolidation from the mechanized attempt — verify with \`git status\` before re-applying patches.`,
        // #539 — the writer's own structured observation; the renderer
        // prefers this over re-deriving the cause from the recorded state.
        fallbackCause: mech.fallbackCause,
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
  // #500 — the ops fallback consolidates repoRoot BY HAND; unlike the
  // mechanized path there is no guarantee what it leaves. Record the state
  // it actually left (unmerged paths, staged count, current branch) so the
  // handoff renders facts rather than the assumption of a clean tree. A
  // read failure records the failure, not a guess: a silent empty state
  // would make the handoff's "clean" claim exactly the defect this ticket
  // exists to close.
  const execFn = ctx.verifyExecFn ?? execp;
  const rootState = await inspectCommitPrRoot(execFn, ctx.repoRoot);
  next = {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      ...commitPrRootFieldsOf(rootState),
    },
  };
  const prNumber = parsePrNumber(last.summary);
  if (prNumber !== undefined) {
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, prNumber },
    };
  }
  // PR14 + #540 — post-dispatch consolidation gate (subsumption-aware,
  // both-sides report). Defense in depth: the v0.12.13 incident merged
  // 1 of 3 workstreams as a "successful" cycle.
  const consolidationCheck = await verifyConsolidation(ctx, next);
  if (consolidationCheck.missing.length > 0) {
    trace(
      `work-driver: commit-pr partial-consolidation detected — missing workstreams: ${consolidationCheck.missing.map((m) => m.id).join(", ")}`,
    );
    const verdicts: ConsolidationVerdict[] = consolidationCheck.verdicts
      .filter((v) => v.status !== "complete")
      .map((v) =>
        v.status === "uncovered"
          ? { id: v.id, status: "uncovered" as const, uncoveredPaths: v.uncoveredPaths }
          : { id: v.id, status: "unverifiable" as const, reason: v.reason },
      );
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        incompleteConsolidation: {
          verdicts,
          filesPresent: consolidationCheck.filesPresent,
        },
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
