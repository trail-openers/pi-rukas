/**
 * work-driver-commit-lock — the commit-pr step's critical-section wrapper.
 *
 * Split from work-driver-commit.ts for the AGENTS.md §12 500-line cap (the
 * #861 fallback plumbing pushed it over). Owns `runCommitPrLocked` — the
 * body that `runCommitPr` runs inside `withIntegrationLock`.
 *
 * The lock is the ONLY path that writes to repoRoot; this wrapper
 * serialises consolidation (cherry-pick / patch-apply) across workstreams
 * AND across concurrent driver processes in the same repo clone (the same
 * seam as `integrate()`, `runConsolidatedVerify`, handoff-consolidate, and
 * the merged teardown).
 */
import { execp } from "./exec.ts";
import { redactThenBound } from "./text-flatten.ts";
import { trace } from "./trace.ts";
import { dispatchCommitPrFallback } from "./work-driver-commit-fallback.ts";
import { conflictArtifactFromPlumb } from "./work-driver-commit-helpers.ts";
import { auditCommitPrFallback } from "./work-driver-commit-pr-audit.ts";
import { pushTerminalCap } from "./work-driver-commit-pr-events.ts";
import {
  type ConsolidatedVerifyEvidence,
  consolidatedVerifyCapFields,
  consolidatedVerifyEvidenceFields,
} from "./work-driver-commit-verify-evidence.ts";
import { mechanizedCommitPr } from "./work-driver-commit.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { continueCommitPrHalt } from "./work-driver-continue-pr-commit.ts";
import { withIntegrationLock } from "./work-driver-lock.ts";
import { appendEvent } from "./workflow-state.ts";
import type { WorkState } from "./workflow-state.ts";

export { runCommitPr };

/**
 * Bound for the plumb-report body that carries a mechanized failure's raw reason. The
 * reason is the gate's own text — for a `push-refused` halt it is the forge's `remote:`
 * lines verbatim, and those quote the content push protection flagged. The body persists
 * in the state file and the handoff prints it, so it is redacted before it is bounded
 * (redact-then-clip, never the reverse: a clip can cut a token into a fragment no pattern
 * recognises).
 */
const PLUMB_BODY_MAX = 2000;

/**
 * Step 6 — Commit + PR. ops commits the diff, pushes, opens a PR with
 * `Fixes #N` in the body. PR4 captures the `pr: <N>` line ops's prompt
 * asks for into pipelineState.prNumber so the handoff step (7g) targets
 * the right PR for `gh pr comment` instead of falling back to issue.
 *
 * PR19 — one contiguous critical section per group: includes the LLM ops
 * fallback (it mutates repoRoot exactly as the mechanized path does) and
 * BOTH verify gates, which read repoRoot HEAD via `git rev-list` /
 * `git diff --name-only` and would otherwise validate a sibling group's
 * commits as this group's evidence.
 */
async function runCommitPr(ctx: CycleContext, state: WorkState, now: number): Promise<WorkState> {
  return withIntegrationLock(ctx.repoRoot, () => runCommitPrLocked(ctx, state, now));
}

async function runCommitPrLocked(
  ctx: CycleContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  let next: WorkState | undefined;
  let preDispatch = state;
  let fallbackConflictPatch: string | undefined;
  const execFn = ctx.verifyExecFn ?? execp;
  // PR19 — mechanized commit-pr. The LLM ops dispatch remains as fallback
  // for judgmental recovery (apply conflict, push rejection).
  {
    const mech = await mechanizedCommitPr(ctx, state, now);
    if (mech.ok) {
      next = mech.state;
    } else if (mech.terminal) {
      // The consolidated tree does not build (the `integration-verify-failed`
      // cap) OR the driver-owned integrate worktree could not be created
      // (the `integration-worktree-violation` cap): in BOTH cases the
      // fallback exists to absorb environment variance, not to overrule a
      // verdict — dispatching ops would either commit the same broken tree
      // (a gate that cannot fail; the six lenses would review something
      // never compiled) or work in a tree the prompt forbids (an unpinned
      // dispatch — the #841 defect class, which the strict audit would halt
      // anyway). The prepared state carries the plumb + cap already appended.
      trace(`work-driver: commit-pr halted (terminal mechanized failure): ${mech.reason}`);
      // #1439 — a push the forge refused gets its OWN cap, its own evidence origin,
      // and its own cause verdict (`issue`, not `change`). Pre-fix it shared the
      // consolidated-verify cap and its `change` verdict, so the operator of cycle
      // 1439 was told "the verify command failed … fix the change" for a GitHub
      // push-protection refusal that no amount of fixing satisfies until someone
      // allows the flagged content or the fixtures stop carrying it.
      //
      // #1064 — EVERY terminal cap now carries evidence. The pre-fix spread attached
      // it only for a timed-out run, so a terminal `integration-verify-failed` parked
      // with nothing but the cap name: `causeEvidence` was the cap, the operator saw
      // no failing test, and the bounded failure lines the gate had already extracted
      // were thrown away. Both cases now ride through one helper (see
      // `work-driver-commit-verify-evidence.ts`) so the two caps cannot drift apart
      // the way the develop step's evidence did before #841.
      const evidence: ConsolidatedVerifyEvidence = {
        cap: pushTerminalCap(mech),
        reason: mech.reason,
        timedOut: mech.timedOut === true,
        pushRefused: mech.fallbackCause === "push-refused",
        // #1064 — the gate's own failure lines, threaded up from the consolidated
        // verify through integrate() and mechanizedCommitPr. The helpers below
        // tolerate their absence (an old state file, a failure that never reached the
        // gate) rather than inventing a line.
        ...(mech.failures !== undefined ? { failures: mech.failures } : {}),
        ...(mech.logPaths !== undefined ? { logPaths: mech.logPaths } : {}),
      };
      const verifyFields = consolidatedVerifyEvidenceFields(evidence);
      // The terminal path must LEAVE `next` set. `next === undefined` is what the
      // dispatcher below reads as "the mechanized path failed in a recoverable way — run
      // the ops fallback", and a `return` here used to skip both that assignment and the
      // guard's intent: a `terminal: true` failure still paid for the very dispatch it
      // was marked terminal to avoid (#1439's 40-minute ops child on a GH013 refusal).
      // Returning the cap'd state is what makes `terminal` mean something.
      next =
        mech.haltedAfter ??
        appendEvent(
          verifyFields === undefined
            ? state
            : { ...state, pipelineState: { ...state.pipelineState, ...verifyFields } },
          {
            kind: "plumb-report",
            at: Date.now(),
            step: "commit-pr",
            role: "driver",
            body: redactThenBound(mech.reason, PLUMB_BODY_MAX).text,
            ...(mech.fallbackCause === "push-refused" ? { fallbackCause: mech.fallbackCause } : {}),
          },
          {
            kind: "cap-hit",
            at: Date.now(),
            // #1324 — a run killed at its bound reached no verdict about the code.
            cap: evidence.cap,
            reviewRound: state.pipelineState.reviewRound,
            nextStep: "handoff",
            ...consolidatedVerifyCapFields(evidence),
          },
        );
    } else if (state.pipelineState.continuedPr) {
      // #1468 — the fallback's prompt opens a PR; a continued PR gets none.
      return continueCommitPrHalt(ctx, state, mech.reason, execFn);
    } else {
      trace(`work-driver: mechanized commit-pr fell back to ops dispatch: ${mech.reason}`);
      preDispatch = appendEvent(state, {
        kind: "plumb-report",
        at: Date.now(),
        step: "commit-pr",
        role: "driver",
        // #861 — the old "the repo root may contain partially staged
        // consolidation" sentence is GONE: on every fallback-reachable
        // failure integrate() runs verifiedRestoreRoot (it saves any partial
        // state to a scratch artifact first, then reset --hard + checkout and
        // VERIFIES repoRoot is clean). A restore failure already carries
        // "repoRoot was NOT restored …" in mech.reason — the driver never
        // claims a restoration it has not verified.
        body: `Mechanized commit-pr fell back to the ops dispatch: ${mech.reason}`,
        // #539 — the writer's own structured observation; the renderer
        // prefers this over re-deriving the cause from the recorded state.
        // #1439 — the ops fallback is pinned to the driver-owned integrate worktree
        // (created by mechanizedCommitPr under the integration lock); the prompt names
        // that path as the ONLY permitted working tree (worktree-commit-fallback.ts owns
        // the dispatch shape + the prompt threading).
        //
        // A push refusal is the exception: the fallback is NOT dispatched (the branch is
        // already consolidated and committed locally, and the remote's refusal is not
        // something a child can lift), so the plumb-report records a cause the fallback
        // can never itself carry. The handoff still renders it, and the cause classifier
        // reads the same `fallbackCause` to keep the terminal halt's plumb and its cap
        // describing one event.
        fallbackCause: mech.fallbackCause,
      });
      // #861 round 2 — the structured conflict-artifact value threads from
      // the mechanized failure directly into the ops prompt (the plumb's
      // body carries the same marker, so the helper can recover it if the
      // caller did not have a structured value — e.g. the no-diff reason).
      fallbackConflictPatch = conflictArtifactFromPlumb(
        preDispatch.eventLog[preDispatch.eventLog.length - 1],
        mech.conflictPatch,
      );
    }
  }
  let fallbackFired = false;
  if (next === undefined) {
    // #861 — the fallback is pinned to the driver-owned integrate worktree
    // (created by mechanizedCommitPr under the integration lock); the
    // prompt names that path as the ONLY permitted working tree (worktree-
    // commit-fallback.ts owns the dispatch shape + the prompt threading).
    next = await dispatchCommitPrFallback(ctx, preDispatch, now, execFn, fallbackConflictPatch);
    fallbackFired = true;
  }
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind !== "dispatch-completed") return next;
  // #861 — the post-dispatch sequence (the #841 defect's guard): the
  // PR-verification gates run first (a partial consolidation halts with
  // `commit-pr-incomplete-consolidation` before the cycle can advance),
  // then the STRICT branch-holder audit — the integration branch must be
  // held by the integrate worktree, or by NOTHING; any other holder
  // (including repoRoot and this cycle's own workstream worktrees) halts
  // with `integration-worktree-violation`. A fully clean tail removes the
  // integrate worktree (kept on any handoff halt for inspection).
  return auditCommitPrFallback(ctx, execFn, next, fallbackFired, true);
}
