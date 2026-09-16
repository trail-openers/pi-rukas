/**
 * work-driver-converge-gate — the end-of-develop converge gate handler
 * (issue #741, P2). The DRIVER-side glue that wires the converge verdict
 * into the state machine.
 *
 * Classification (work-driver-converge.ts) is deterministic path presence
 * over the end-of-develop diff; this handler owns the ROUTING the issue
 * specifies:
 *
 *   - first absent set  → exactly one corrective developer re-dispatch
 *     naming the missing deliverables (the plan-quality one-shot pattern:
 *     a bounded corrective dispatch, never a loop); the safety net +
 *     verify gate + converge pass all re-run once on the new diff.
 *   - second absent set → cap-hit `develop-incomplete-deliverables` (a
 *     DISTINCT cap, not a reuse of verify-failed) → handoff.
 *   - corrective dispatch fails (provider error, kill, or an
 *     `ok === false` result) → cap-hit with evidence that says the
 *     corrective NEVER RAN. Same cap literal (the cap-registration
 *     sites are fixed), but the recovery recipe must not tell the
 *     operator to implement work that was never attempted.
 *   - partial only      → recorded on `pipelineState.convergeEvidence` and
 *     surfaced in the handoff/PR body as a WARNING; it never blocks (the
 *     58.9% figure counts partials as the upper bound — blocking on
 *     partials is a policy decision the issue defers to review).
 *
 * Escape hatch: PI_ENSEMBLE_CONVERGE=0 (checked in runConvergeGate).
 */

import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  type ConvergeVerdict,
  buildConvergeCorrectivePrompt,
  runConvergeGate,
  workstreamOwnsMissingPaths,
} from "./work-driver-converge.ts";
import { applySafetyNet } from "./work-driver-safety-net.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

const execp = promisify(exec);

/**
 * Run the converge gate at end-of-develop, after the existing verify gate
 * has passed. Returns the (possibly mutated) state.
 */
export async function runConvergeGateHandler(
  ctx: DriverContext,
  state: WorkState,
  dispatchFn: NonNullable<DriverContext["dispatchFn"]>,
): Promise<WorkState> {
  let next = state;

  const recordConverge = (verdict: ConvergeVerdict) => {
    next = {
      ...next,
      pipelineState: {
        ...next.pipelineState,
        convergeEvidence: {
          at: Date.now(),
          deliverables: verdict.deliverables.map((d) => ({
            id: d.id,
            status: d.status,
            reason: d.reason,
          })),
        },
      },
    };
  };

  const converge = await runConvergeGate(ctx, next);
  if (!converge) return next;
  recordConverge(converge);

  if (converge.absent.length === 0) return next;

  // The corrective child edits the worktree that OWNS the missing paths
  // (workstreamsOwningPath attribution — the same resolution the prompt
  // uses, so prompt and cwd cannot disagree). Only when ownership cannot
  // be determined does it fall back to the first worktree.
  const ownerWorkstreamId = workstreamOwnsMissingPaths(next, converge.absent);
  const owner = ownerWorkstreamId ? next.pipelineState.worktrees?.[ownerWorkstreamId] : undefined;
  const correctiveCwd = owner && owner !== "repoRoot" ? owner : firstWorktreeDir(next);

  const prompt = buildConvergeCorrectivePrompt(next, converge);
  let correctiveRan = false;
  let correctiveNote: string | undefined;
  try {
    const retry = await dispatchFn(ctx.pi, {
      role: "developer",
      prompt,
      cwd: correctiveCwd,
    });
    if (retry?.ok) {
      correctiveRan = true;
    } else if (retry) {
      // A killed child returns a DispatchResult (ok: false) rather than
      // throwing — that is a FAILED corrective, not a completed one.
      correctiveNote = "corrective re-dispatch FAILED (child reported failure)";
    }
  } catch (err) {
    correctiveNote = `corrective re-dispatch FAILED (${String(err).slice(0, 200)})`;
  }

  if (correctiveNote !== undefined) {
    // The one-shot budget is consumed but the corrective NEVER RAN: a
    // provider 429 or inactivity kill must not present as a completeness
    // verdict. Same cap literal (the eight registration sites are fixed),
    // but the evidence tells the operator the missing work was never
    // attempted — re-running /work spends a fresh corrective budget.
    trace(`work-driver: ${correctiveNote} — the absent set stands`);
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "develop-incomplete-deliverables",
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
      evidence: `${convergeEvidence(converge)}; ${correctiveNote} — the absent set stands untested`,
    });
    return next;
  }

  next = appendEvent(next, {
    kind: "converge-redispatch",
    step: "develop",
    at: Date.now(),
  });

  // Did the corrective child actually change the tree? If not, the safety
  // net + full verify re-run prove nothing new — skip them and go straight
  // to the second converge pass (or the cap).
  if (!(await treeChangedByCorrective(ctx, correctiveCwd))) {
    trace("work-driver: corrective re-dispatch left no tree changes — skipping the verify re-run");
  } else {
    // The corrective child left new work in the worktree and the diff
    // changed, so the evidence gates must judge the NEW state: safety net
    // first (commit the uncommitted work), then the verify gate.
    next = await applySafetyNet(ctx, next);
    const gate2 = await verifyStepOutcome(ctx, next, "develop");
    if (!gate2.ok) {
      const cap2 = gate2.failures.find((f) =>
        /cherry-pick \/ apply conflict|could not combine the workstreams/.test(f),
      )
        ? ("consolidated-verify-conflict" as const)
        : ("verify-failed:develop" as const);
      next = {
        ...next,
        pipelineState: {
          ...next.pipelineState,
          verifyEvidence: { step: "develop", failures: gate2.failures, at: Date.now() },
        },
      };
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap: cap2,
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
      });
      return next;
    }
  }

  // Second converge pass. One retry, never a loop — the second absent set
  // raises the distinct cap.
  const converge2 = await runConvergeGate(ctx, next);
  if (converge2) {
    recordConverge(converge2);
    if (converge2.absent.length > 0) {
      trace(`work-driver: develop-incomplete-deliverables — ${convergeEvidence(converge2)}`);
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "develop-incomplete-deliverables",
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
        evidence: convergeEvidence(converge2),
      });
    }
  }
  return next;
}

/**
 * Cheap dirty-tree probe for the corrective's worktree: non-empty
 * `git status --porcelain` means the child left (uncommitted) work behind.
 * The worktrees map is operator/persisted data — a path that does not lie
 * under repoRoot is skipped rather than shelled into (same stance as
 * readEndOfDevelopDiff's stale-path skip). An unreadable worktree is
 * treated as "unchanged" (the conservative, skip-the-rerun direction).
 */
async function treeChangedByCorrective(
  ctx: DriverContext,
  cwd: string | undefined,
): Promise<boolean> {
  if (!cwd) return false;
  const root = ctx.repoRoot;
  if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) return false;
  try {
    const { stdout } = await (ctx.verifyExecFn ?? execp)("git status --porcelain", {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** The operator-facing evidence line for the cap-hit event. */
function convergeEvidence(verdict: ConvergeVerdict): string {
  return `missing deliverable(s): ${verdict.absent
    .map((a) => `${a.id} (${a.missing.join(", ")})`)
    .join("; ")}`;
}

/**
 * The corrective child's cwd fallback: the first worktree (N=1). Used only
 * when the missing paths' owning workstream cannot be resolved.
 */
function firstWorktreeDir(state: WorkState): string | undefined {
  const worktrees = state.pipelineState.worktrees ?? {};
  const first = Object.values(worktrees)[0];
  if (first && first !== "repoRoot") return first;
  return undefined;
}
