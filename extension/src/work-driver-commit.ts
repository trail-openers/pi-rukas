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
import { trace } from "./trace.ts";
import { raiseConsolidationIncompleteCap } from "./work-driver-commit-completeness.ts";
import {
  causeFromIntegrateFailure,
  conflictArtifactFromPlumb,
  withPatchNote,
} from "./work-driver-commit-helpers.ts";

import { ensureIntegrateWorktreeOrHalt } from "./work-driver-commit-fallback.ts";
import {
  type CommitPrRootState,
  commitPrRootFieldsOf,
  inspectCommitPrRoot,
} from "./work-driver-commit-inspect.ts";
import { runCommitPr } from "./work-driver-commit-lock.ts";
import { auditCommitPrFallback } from "./work-driver-commit-pr-audit.ts";
import {
  finalizeCommitPrState,
  runCommitPrPostDispatchGates,
} from "./work-driver-commit-pr-events.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import { deriveConsolidationSubject } from "./work-driver-handoff-subject.ts";
import {
  type IntegrateResult,
  cachedIssueTitle,
  integrate,
  withIntegrationLock,
} from "./work-driver-integrate.ts";
import { renderAssumptions } from "./work-driver-intent.ts";
import { parsePrNumber } from "./work-driver-merged.ts";

// #861 — the lock-wrapped step handler lives in work-driver-commit-lock.ts
// (the AGENTS.md §12 500-line cap pushed it out); re-exported here so the
// existing import path in work-driver.ts is unchanged.
export { runCommitPr };
import {
  assumptionsBlockOf,
  carriedFindingsSectionOf,
  clipTitle,
  companionLinesOf,
  fixesLinesOf,
  operatorActionsSectionOf,
} from "./work-driver-pr-body-definition.ts";
import { findOpenPrForBranch } from "./work-driver-pr-preflight.ts";
import { renderLensFindingsSection } from "./work-driver-pr-sections.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { verifyConsolidation, verifyStepOutcome } from "./work-driver-verify.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import { appendEvent } from "./workflow-state.ts";
import type {
  CommitPrFallbackCause,
  ConsolidationVerdict,
  IncompleteConsolidation,
  WorkState,
} from "./workflow-state.ts";
const execp = promisify(exec);

// clipTitle (#507) lives with the PR text builders in
// work-driver-pr-body-definition.ts; re-exported for existing consumers.
export { clipTitle } from "./work-driver-pr-body-definition.ts";

// #539 — the fallback-cause vocabulary lives ONCE in workflow-state-events.ts
// (the event type that persists it) and is imported above; re-exported for
// the mechanizedCommitPr return type below.
export type { CommitPrFallbackCause } from "./workflow-state-events.ts";
// #861 — the shared helpers (the structured cause + the conflict-artifact
// seam) live in work-driver-commit-helpers.ts, shared with the fallback
// dispatch module (work-driver-commit-fallback.ts) — a circular import
// between the two modules would break jiti's load order.
export { conflictArtifactFromPlumb, withPatchNote } from "./work-driver-commit-helpers.ts";
import { deriveCommitPrTitle, integrationVerifyTimeoutMs } from "./work-driver-commit-title.ts";
export { deriveCommitPrTitle, integrationVerifyTimeoutMs };

/**
 * PR19 — Mechanized commit-pr: consolidation + commit + push + PR-creation
 * executed directly. Falls back to LLM ops dispatch on `{ok: false}` unless
 * `terminal` (verify failure — #328).
 */
export async function mechanizedCommitPr(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<
  | { ok: true; state: WorkState }
  | {
      ok: false;
      reason: string;
      terminal?: boolean;
      fallbackCause?: CommitPrFallbackCause;
      /**
       * #861 — the structured conflict-patch path preserved by integrate()
       * (the "where possible" of the ops-fallback conflict seam). Set when
       * integrate() preserved a patch on a non-terminal failure; the caller
       * (runCommitPrLocked) threads it as the STRUCTURAL argument of
       * `conflictArtifactFromPlumb`, so the ops prompt reads the field
       * rather than re-parsing the plumb's body.
       */
      conflictPatch?: string;
      /**
       * #861 — set when a TERMINAL mechanized failure already appended the
       * plumb + cap events (the creation-failure halt): the caller returns
       * this state instead of appending a second cap of its own.
       */
      haltedAfter?: WorkState;
    }
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
    // RE-ENTRY GUARD (census 2026-09-09): a resume that re-enters commit-pr
    // after a crash-past-prCreate used to run integrate() again — whose
    // `checkout -B` resets the branch to base — and prCreate a second PR
    // (gated only by the push rejection). An open PR whose head is this
    // exact branch means the previous attempt completed: short-circuit with
    // the found number; the verify gate after commit-pr still checks
    // commits-ahead + PR resolution. Fails open on an unreadable gh.
    const existingPr = await findOpenPrForBranch(execFn, ctx.repoRoot, branchName);
    if (existingPr !== undefined) {
      trace(
        `work-driver: commit-pr re-entry — open PR #${existingPr} already heads ${branchName}; integrate/prCreate skipped`,
      );
      const rootState = await inspectCommitPrRoot(execFn, ctx.repoRoot);
      let next = appendEvent(
        { ...state, pipelineState: { ...state.pipelineState, currentStep: "commit-pr" } },
        { kind: "step-started", step: "commit-pr", at: now },
      );
      next = appendEvent(
        next,
        synthesizeDriverCompletion({
          step: "commit-pr",
          label: "driver:commit-pr",
          summary: `Mechanized commit-pr RE-ENTRY: open PR #${existingPr} already heads ${branchName} — consolidation previously completed; integrate/prCreate skipped.\npr: ${existingPr}`,
          startedAt,
          now: Date.now(),
        }),
      );
      next = {
        ...next,
        pipelineState: { ...next.pipelineState, ...commitPrRootFieldsOf(rootState) },
      };
      return { ok: true, state: next };
    }
    // #818 — the PR title and the commit title are the SAME conventional
    // subject, derived from the issue (never `implement issue #N`).
    const title = await deriveCommitPrTitle(state, ctx, execFn);
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
    // baseSha rather than at whatever repoRoot's HEAD is, and refuses a dirty
    // repoRoot (#283's gate, relocated here) so operator residue can never
    // be swept into the PR — incident #602's shape.
    let commitPrFlakeEvidence: string | undefined;
    const res = await integrate(execFn, {
      repoRoot: ctx.repoRoot,
      branchName,
      baseSha: ps.baseSha,
      worktrees,
      // #794 — own-range selection (stacked workstreams: see workstreamBaseShas).
      workstreamBaseShas: ps.workstreamBaseShas,
      scratchDir: scratchDir(ctx.repoRoot, ctx.issue),
      commitTitle: title,
      commitBody,
      mode: "create",
      requireAllNonEmpty: true,
      // #453 — skip already-applied.
      commitShas: ps.commitShas,
      verifyCmd: await verifyCmdFor(ctx.repoRoot),
      verifyExecFn: ctx.verifyExecFn,
      verifyTimeoutMs: integrationVerifyTimeoutMs(),
      verifyRetry: {
        ciRetryCount: ps.ciRetryCount,
        onRecover: (evidenceTail?: string) => {
          commitPrFlakeEvidence = evidenceTail;
        },
      },
    });
    // #539 — the structured cause travels with the result: integrate()
    // KNOWS why it failed; a reader re-parsing `reason` would be guessing.
    const fallbackCause = causeFromIntegrateFailure(res);
    if (!res.ok) {
      if (res.failure === "verify") {
        // The consolidated tree does not build: a terminal verdict, not
        // environment variance — the ops fallback would commit and push the
        // same broken tree, making the verify gate one that cannot fail.
        return {
          ok: false,
          reason: res.reason,
          terminal: true,
          fallbackCause,
        };
      }
      // #861 — on a non-terminal failure the ops fallback takes over, so
      // the driver creates the worktree the fallback is pinned to, HERE:
      // (a) it sits INSIDE withIntegrationLock (runCommitPr wraps
      // mechanizedCommitPr) — the tree will hold the integration branch and
      // a sibling's sweep/integration must not race it; (b) `res.conflictPatch`
      // is in scope — the patch path is passed STRUCTURALLY to the prompt
      // (the "where possible" in the decision), never re-parsed from reason;
      // (c) a tree-creation failure does NOT dispatch: the fallback's ONLY
      // permitted working tree would not exist (a cwd-less / repoRoot-cwd
      // dispatch is exactly the #841 defect class — the prompt forbids both
      // repoRoot and the workstream worktrees, and the strict audit would
      // halt a child that worked there anyway). A failure to create the
      // integrate worktree is a driver environment failure → a cap, not an
      // LLM judgment call.
      const worktreeRes = await ensureIntegrateWorktreeOrHalt(ctx, state, branchName, execFn);
      if ("halted" in worktreeRes) {
        return {
          ok: false,
          reason: withPatchNote(res.reason, res.conflictPatch),
          terminal: true,
          haltedAfter: worktreeRes.halted,
        };
      }
      // #861 — the structured conflict-patch value threads to the caller
      // (runCommitPrLocked) instead of being re-parsed from this reason's
      // marker text.
      return {
        ok: false,
        reason: withPatchNote(res.reason, res.conflictPatch),
        fallbackCause,
        conflictPatch: res.conflictPatch,
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
    // those assumptions belong where review happens; buried in a state file
    // they may as well not exist.
    const assumptionsBlock = assumptionsBlockOf(ps.normalisedSpec);
    const carriedFindings = carriedFindingsSectionOf(state.eventLog);
    // #792 — no-diff deliverables (settings toggles, operator actions) must
    // surface as a DISTINCT PR-body section, not vanish from the record and
    // not be misrendered under the assumptions heading.
    const operatorActions = operatorActionsSectionOf(ps.normalisedSpec);
    const prBody = [
      "Automated by pi-rukas /work driver (mechanized commit-pr).",
      "",
      ...fixesLines,
      ...companionLines,
      ...workstreamLines,
      assumptionsBlock,
      carriedFindings,
      operatorActions,
      renderLensFindingsSection(state.eventLog),
    ]
      .filter((l) => l !== "")
      .join("\n");
    const prBodyFile = path.join(scratchDir(ctx.repoRoot, ctx.issue), "mech-pr-body.md");
    await fs.mkdir(path.dirname(prBodyFile), { recursive: true });
    await fs.writeFile(prBodyFile, prBody, "utf8");
    // `--head` is not optional under concurrency: without it gh infers the
    // head from repoRoot's CURRENT checkout, so a sibling group that moved
    // HEAD between our push and this call would have its branch opened as our
    // PR. The flag makes that impossible even if the lock is ever wrong.
    const forge = await forgeForCycle(ctx, execFn);
    if (!forge) {
      return {
        ok: false,
        reason: "forge not determined for this repo — cannot open the PR",
      };
    }
    // #776 — the 4th arg is the base branch: prCreateCmd builds
    // `--head <baseBranch>...<headBranch>` from it, so a path or empty value
    // there is what produced #753's "...mech-pr-body.md...feature/…" GraphQL
    // failure. We pass the body STRING (the scratch file above is for the
    // ops-fallback prompt) and no base — gh/glab defaults to the repo
    // default branch, which is the base the driver recorded in Step 3.
    const created = await forge.prCreate(title, branchName, prBody);
    const prNumber = created.number;
    if (prNumber === undefined || !Number.isFinite(prNumber)) {
      return {
        ok: false,
        reason: `forge pr create succeeded but returned no PR number (url=${(created.url ?? "").slice(0, 120)})`,
      };
    }
    // 5. Emit the same event shapes the dispatch path produces so the shared
    // downstream (parsePrNumber + both gates) runs unchanged. #782 — the
    // flake-recovery event (verify-flake-recovered, step: "commit-pr") is
    // included when the consolidated verify recovered on the single re-run.
    const rootState = await inspectCommitPrRoot(execFn, ctx.repoRoot);
    const next = finalizeCommitPrState(
      state,
      now,
      startedAt,
      ids,
      branchName,
      prNumber,
      res,
      rootState,
      commitPrFlakeEvidence,
    );
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
