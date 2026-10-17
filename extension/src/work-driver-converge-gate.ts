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

import path from "node:path";
import { recordCommentEvidence } from "./comment-evidence.ts";
import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import {
  type ConvergeVerdict,
  buildConvergeCorrectivePrompt,
  runConvergeGate,
  workstreamOwnsMissingPaths,
} from "./work-driver-converge.ts";
import { driverDeckOpts } from "./work-driver-deck-header.ts";
import { applySafetyNet } from "./work-driver-safety-net.ts";
import { verifyCapFor } from "./work-driver-verify-develop-helpers.ts";
import { recordConsolidatedVerifySkip } from "./work-driver-verify-events.ts";
import { verifyStepOutcome } from "./work-driver-verify.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * Run the converge gate at end-of-develop, after the existing verify gate
 * has passed. Returns the (possibly mutated) state.
 */
export async function runConvergeGateHandler(
  ctx: CycleContext,
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
            ...(d.noDiffEvidence ? { noDiffEvidence: d.noDiffEvidence } : {}),
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

  // HEAD before the corrective runs: a child that COMMITS its work leaves a
  // clean tree, so the post-dispatch probe needs this to see the round.
  const correctiveDir = resolveProbeDir(ctx, correctiveCwd);
  const headBefore = correctiveDir ? await headOf(ctx, correctiveDir) : undefined;

  const prompt = buildConvergeCorrectivePrompt(next, converge);
  // Total partition over the dispatch outcome: { ok: true, ok: false,
  // no-result (undefined/null), threw }. A killed child returns a
  // DispatchResult (ok: false) rather than throwing; a falsy result is
  // the same class as ok:false — a FAILED corrective, not a completed one.
  // The success path is driven on the POSITIVE signal (ok === true), so a
  // missing result can never fall through and present as a completion.
  let correctiveNote: string | undefined;
  try {
    const retry = await dispatchFn(
      ctx.host,
      {
        role: "developer",
        prompt,
        cwd: correctiveCwd,
      },
      {
        // #838 — the converge corrective dispatch's deck row (row label
        // `#<issue> develop · corrective` — display only; the job label below
        // is what the cycle's events record). (This site is allowlisted in
        // test-dispatch-cwd-audit: an explicit cwd above — the `label:` token
        // below is the dispatch label, not a deck-option label.)
        label: "develop:corrective",
        deck: {
          ...driverDeckOpts(ctx.issue, "develop", "corrective"),
          label: "develop:corrective",
        },
      },
    );
    if (retry?.ok !== true) {
      correctiveNote = retry
        ? "corrective re-dispatch FAILED (child reported failure)"
        : "corrective re-dispatch FAILED (no result returned)";
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

  // Did the corrective child actually change the worktree? A CONFIRMED
  // no-op — clean tree AND HEAD where it was — skips the safety net + full
  // verify re-run (they would prove nothing new). "unknown" — the cwd was
  // outside repoRoot or a probe threw — falls through to the re-run: a
  // redundant-but-correct re-run is the right cost for uncertainty; a
  // skipped gate is not.
  const treeState = await correctiveChange(ctx, correctiveDir, headBefore);
  if (treeState === "unchanged") {
    trace(
      "work-driver: corrective re-dispatch left no commits and no tree changes — skipping the verify re-run",
    );
  } else {
    // The corrective child left new work in the worktree and the diff
    // changed, so the evidence gates must judge the NEW state: safety net
    // first (commit the uncommitted work), then the verify gate.
    next = await applySafetyNet(ctx, next);
    const gate2 = await verifyStepOutcome(ctx, next, "develop");
    // #1240 — the corrective re-run's skip is recorded like the first pass's:
    // without it a skip on this path is invisible, which is exactly the
    // "gate silently stopped running" reading #1240 exists to prevent.
    next = recordConsolidatedVerifySkip(next, gate2);
    // #1040 — lost-comment evidence persists from the re-run's develop note.
    next = recordCommentEvidence(next, gate2.commentEvidence);
    if (gate2.flakeRecovered) {
      next = appendEvent(next, {
        kind: "verify-flake-recovered",
        at: Date.now(),
        step: "develop",
      });
    }
    if (!gate2.ok) {
      // #794 — the failure message distinguishes the stacked case (own-range
      // pick; a conflict here is a genuine overlap or a diverged dependency
      // tip — NOT a decomposition defect) from an independent-fanout
      // overlap; the router's regex matches both shapes.
      const conflictText = gate2.failures.find((f) =>
        /cherry-pick \/ apply conflict|could not combine the workstreams/.test(f),
      );
      const cap2 = conflictText
        ? ("consolidated-verify-conflict" as const)
        : verifyCapFor(
            "develop",
            gate2.failures,
            gate2.baselineRedOnly,
            gate2.buildResidueOnly === true,
          );
      next = {
        ...next,
        pipelineState: {
          ...next.pipelineState,
          // #782 — thread the flake-recovered flag into verifyEvidence so the
          // handoff can show "retried once, recovered" when the converge gate
          // parks after a consolidated verify that recovered from a flake.
          verifyEvidence: {
            step: "develop",
            failures: gate2.failures,
            at: Date.now(),
            origin: "outcome-gate",
            ...(gate2.buildResidueOnly === true ? { buildResidueOnly: true } : {}),
            ...(gate2.flakeRecovered ? { retries: 1, recovered: true } : {}),
          },
        },
      };
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap: cap2,
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
        ...(conflictText ? { evidence: conflictText } : {}),
        // #1427 round 3 — the hang reports THIS re-run wrote, on the same
        // structural channel `appendDevelopVerifyFailure` uses for the first
        // pass. Without it this cap — reached when the corrective's commit
        // re-ran the gate and THAT hung — handed off with no pointer to the
        // report that says what hung, even though the file was on disk.
        ...(gate2.hangLogPaths !== undefined && gate2.hangLogPaths.length > 0
          ? { logPaths: [...gate2.hangLogPaths] }
          : {}),
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
 * The directory the corrective's probes run in, or undefined when there is
 * no cwd or the persisted worktree path lies outside repoRoot (operator
 * data — skipped rather than shelled into, same stance as
 * readEndOfDevelopDiff's stale-path skip).
 */
function resolveProbeDir(ctx: CycleContext, cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const root = ctx.repoRoot;
  // Resolve EXACTLY as readEndOfDevelopDiff does (work-driver-converge.ts):
  // the "repoRoot" sentinel means the repo root checkout, anything else
  // relative is rooted at the driver's repoRoot. The containment check and
  // the shell both use the RESOLVED dir — comparing the raw persisted string
  // would call a relative in-tree path (e.g. ".worktrees/issue-N-task-b")
  // "outside repoRoot" and emit a misleading trace.
  const dir = cwd === "repoRoot" ? root : path.isAbsolute(cwd) ? cwd : path.join(root, cwd);
  if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) {
    trace(`work-driver: converge gate — cannot probe worktree ${dir}: outside repoRoot`);
    return undefined;
  }
  return dir;
}

/** HEAD of the corrective's worktree, or undefined when it cannot be read. */
async function headOf(ctx: DriverContext, dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await (ctx.verifyExecFn ?? execp)("git rev-parse HEAD", {
      cwd: dir,
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Did the corrective child change its worktree? Three states:
 *
 *   - `changed`   — non-empty `git status --porcelain` (uncommitted work),
 *     OR HEAD moved since `headBefore` (the child COMMITTED its work, which
 *     is what the developer prompt asks for — a clean tree alone says
 *     nothing; #1203). The gates must judge the new state.
 *   - `unchanged` — both probes RAN, the tree is clean and HEAD is where it
 *     was; the caller may skip the safety net + verify re-run.
 *   - `unknown`   — a probe could not run: no resolvable dir, `git status`
 *     threw, or HEAD was unreadable before or after. The caller treats this
 *     like `changed`: a redundant-but-correct re-run beats a silently
 *     skipped gate.
 */
export async function correctiveChange(
  ctx: DriverContext,
  dir: string | undefined,
  headBefore: string | undefined,
): Promise<"unchanged" | "changed" | "unknown"> {
  if (!dir) return "unknown";
  try {
    // Same maxBuffer as readEndOfDevelopDiff's porcelain read (a large dirty
    // tree must not overflow ENOBUFS and silently flip the probe to
    // unknown), plus a timeout so a wedged worktree (locked index, network
    // fs) degrades to unknown → re-run rather than hanging the gate.
    const { stdout } = await (ctx.verifyExecFn ?? execp)("git status --porcelain", {
      cwd: dir,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    });
    if (stdout.trim().length > 0) return "changed";
  } catch (err) {
    trace(
      `work-driver: converge gate — worktree probe failed in ${dir}: ${String(err).slice(0, 200)}`,
    );
    return "unknown";
  }
  const headAfter = await headOf(ctx, dir);
  if (headBefore === undefined || headAfter === undefined) return "unknown";
  if (headAfter === headBefore) return "unchanged";
  trace(
    `work-driver: corrective re-dispatch committed its work (HEAD ${headBefore.slice(0, 8)} → ${headAfter.slice(0, 8)}) — re-running the gates`,
  );
  return "changed";
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
