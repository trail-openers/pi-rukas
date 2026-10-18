/**
 * work-driver-verify-pr17 — PR17 driver-side outcome verification gate.
 * Extracted from work-driver-verify.ts (AGENTS.md §12 file-size limit).
 *
 * Checks EXECUTED evidence (git status, rev-list, forge prView) rather
 * than trusting an agent's "done" claim. Used by runCommitPr as a
 * post-dispatch safety gate.
 */

import type { CommentEvidence } from "./comment-evidence.ts";
import { execTree } from "./exec-tree.ts";
import { execp as lensExecp } from "./exec.ts";
import { aheadOfBase } from "./git-range.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import type { GateHangPathSink } from "./work-driver-gate-hang.ts";
import { type VerifyExecFn, resolveMainline } from "./work-driver-git.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { verifyDevelopOutcome } from "./work-driver-verify-develop.ts";
import { beginVerifyRun, finishVerifyRun } from "./work-driver-verify-events.ts";
import type { DevelopGateRecord } from "./work-driver-verify-gate-reuse.ts";
import type { SelectedVerifyRecord } from "./work-driver-verify-select-exec.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";
import type { VerifyRunEventFragment } from "./workflow-state-events-verify.ts";
import type { WorkState } from "./workflow-state.ts";

// #1134 follow-up — the argv form must be honoured: the previous
// `promisify(exec)` dropped `argv`, so the commit count ran a bare `git` in
// production (no verifyExecFn is injected there) and every commit-pr read as
// unverifiable. The argv form keeps exec.ts's executor; the shell form —
// the project's verify and smoke commands — is tree-killing (exec-tree.ts).
const execp: VerifyExecFn = (cmd, opts) =>
  opts?.argv ? lensExecp(cmd, opts) : execTree(cmd, opts);

/**
 * PR17 — Driver-side outcome verification gate.
 *
 * Every quality gate before this PR was LLM judgment (adversarial + six
 * lenses reading diffs/transcripts); nothing driver-side ever EXECUTED
 * anything until post-PR CI. Agents claim "done" and the driver trusted
 * the claim — the documented silent-merge (#245/#253) and phantom-
 * handoff incidents are exactly this failure class (MAST: verification
 * failures = 21.3% of multi-agent failures). This gate checks executed
 * evidence, costs zero LLM tokens, and shortens the failure loop from
 * post-PR CI churn to pre-commit.
 *
 * Checks by step:
 *
 *   develop — delegated to verifyDevelopOutcome in work-driver-verify-develop.ts.
 *
 *   commit-pr —
 *     (a) commits exist on the branch: `git rev-list --count
 *         origin/<base>..<branchName>` > 0 at repoRoot (#451 — the branch
 *         is named explicitly so the gate works regardless of repo-root checkout).
 *         (#1134: the count is now `--right-only origin/<base>...origin/<branch>`,
 *         the mainline comes from detectMainline, and an unreadable count fails closed.)
 *     (b) the parsed PR number resolves via the forge adapter. When ops
 *         forgot the `pr: <N>` marker, fall back to a head-branch PR
 *         list and ADOPT the number into pipelineState
 *         (bonus repair — pre-PR17 a missing marker degraded handoff
 *         targeting). No PR found at all = the "opened a PR" claim was
 *         hollow.
 *
 * Failure semantics: returns `{ok: false, failures}` — the caller emits
 * cap-hit `verify-failed:<step>` → handoff with evidence in
 * pipelineState.verifyEvidence. Infra errors on OUR side (git itself
 * erroring at repoRoot) are notes, not failures — same no-false-alarm
 * stance as verifyConsolidation. The commit count is the exception (#1134):
 * if git cannot give it, the commit evidence is unverifiable, which is a failure.
 */
/** PR17 — escape hatch: PI_ENSEMBLE_VERIFY=0 disables the outcome gate. */
function verifyGateEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_VERIFY;
  return v !== "0" && v !== "false";
}

/**
 * The command the driver's own gates run — after develop, after every
 * adversarial fix pass, and on the consolidated tree at commit-pr — or
 * undefined when the gate is disabled or the project has no command. The
 * adversarial reviewer is told the driver owns this command so it does not
 * spend a whole gate's wall-clock re-proving a result the driver already has.
 */
export async function driverGateCmd(repoRoot: string): Promise<string | undefined> {
  return verifyGateEnabled() ? verifyCmdFor(repoRoot) : undefined;
}

/** The fields of the forge `prView` result this gate reads. */
export interface PrView {
  state?: string;
  headRefName?: string;
}

/**
 * Is this the PR this cycle opened?
 *
 * Fails CLOSED on anything unreadable. Unlike the review threshold — where
 * silent doctrine is the normal case and the default applies — this guards the
 * one irreversible act in the cycle, so an answer it cannot understand is a
 * refusal rather than a shrug.
 */
export function judgePrIdentity(
  branchName: string | undefined,
  view: PrView | undefined,
): { ok: true } | { ok: false; failure: string } {
  if (!branchName) {
    return {
      ok: false,
      failure: "cannot be bound to this cycle: no branch was recorded",
    };
  }
  if (!view?.headRefName) {
    return {
      ok: false,
      failure: "returned no headRefName, so it cannot be bound to this cycle's branch",
    };
  }
  if (view.headRefName !== branchName) {
    return {
      ok: false,
      failure: `is opened against \`${view.headRefName}\`, not this cycle's branch \`${branchName}\` — the number does not belong to this cycle`,
    };
  }
  if (view.state !== "OPEN") {
    return {
      ok: false,
      failure: `is ${view.state ?? "in an unreported state"}, not OPEN — there is nothing here left to merge`,
    };
  }
  return { ok: true };
}

export async function verifyStepOutcome(
  ctx: CycleContext,
  state: WorkState,
  step: "develop" | "commit-pr",
): Promise<{
  ok: boolean;
  failures: string[];
  notes: string[];
  adoptedPrNumber?: number;
  /**
   * #782 — true when this run's consolidated verify recovered from a single
   * transient flake (the caller emits `verify-flake-recovered` and records
   * `retries: 1, recovered: true` on any verifyEvidence it writes). Absent
   * on every other outcome, including the retry-failed path (that path
   * records `retries: 1, recovered: false` without the flag).
   */
  flakeRecovered?: boolean;
  /**
   * #814 — structured develop-scope-fence violations recorded by the
   * develop gate (absent when the gate recorded none, including
   * pre-#814 state files and self-fence/dependsOn-exempt hits). The caller
   * persists them on `pipelineState.verifyEvidence.fenceViolations` so the
   * explain/handoff renderers can attribute a consolidation conflict to the
   * fence instead of asserting an incoherent decomposition.
   */
  fenceViolations?: FenceViolationRecord[];
  /**
   * #841 — the consolidated verify's persisted raw-output log path (run2
   * when a flake re-run fired, run1 otherwise), carried STRUCTURALLY so the
   * caller records it on the cap-hit event's `logPaths` field instead of
   * regexing the path out of the failure prose. Absent when no log was
   * written (write failure, no consolidated run).
   */
  logPath?: string;
  /** #1040 — the develop gate's comment-loss checks, structured (see `recordCommentEvidence`). */
  commentEvidence?: CommentEvidence[];
  /** #1349 — the verify command is red at base and its failures are the only ones. */
  baselineRedOnly?: boolean;
  /**
   * #1421 fix round — the consolidated gate DECLINED to consolidate because
   * the root held nothing but untracked, git-ignored build output. Carried
   * STRUCTURALLY from the result's `kind`/`buildResidueOnly`, so the cap
   * router never has to substring-match an operator-authored path out of the
   * failure prose to tell an environment refusal from a verdict.
   */
  buildResidueOnly?: boolean;
  /**
   * #1427 — the gate-hang reports this gate persisted, one per gate run it
   * killed at its bound (per-worktree, consolidated, or both). Carried
   * STRUCTURALLY so the cap emit site records them on the cap-hit event's
   * `logPaths` — the handoff then names the files, and no renderer has to find
   * a path in prose. Absent when no run was killed or nothing could be written.
   */
  hangLogPaths?: string[];
  /**
   * #1240 — the consolidated verify did not run because its probe tree is the
   * tree the per-worktree verify already judged. The caller turns this into a
   * `consolidated-verify-skipped` event (`makeConsolidatedVerifySkippedEvent`).
   */
  consolidatedVerifySkipped?: AlreadyVerifiedTree;
  /**
   * #1415 — `verify-started` (already persisted, so the stream showed it while
   * the gate ran) and `verify-completed`; the caller appends both through
   * `recordDevelopGateEvents`. Absent when no verify command was resolved.
   */
  verifyEvents?: VerifyRunEventFragment[];
  /**
   * #1415 — the gate's reuse bookkeeping (see `GateRecorded`); the caller folds
   * it into `pipelineState.gateReuse` through `recordDevelopGateEvents`, so the
   * next develop pass can reuse a verdict this one established.
   */
  gateRecord?: DevelopGateRecord;
  /** #1647 — the selected develop run's flaky and baseline-red tests, folded into `pipelineState.verifyAttribution`. */
  selectedVerify?: SelectedVerifyRecord;
}> {
  const failures: string[] = [];
  const notes: string[] = [];
  if (!verifyGateEnabled()) {
    return {
      ok: true,
      failures,
      notes: ["PI_ENSEMBLE_VERIFY=0 — outcome gate skipped"],
    };
  }
  const execFn = ctx.verifyExecFn ?? execp;

  if (step === "develop") {
    // #782 — the flake callback is wired at this layer: on recovery it
    // returns a success verdict carrying the flag the caller routes.
    let flakeEvidenceTail: string | undefined;
    let consolidatedLogPath: string | undefined;
    const fenceViolations: FenceViolationRecord[] = [];
    const commentEvidence: CommentEvidence[] = [];
    let baselineRedOnly = false;
    // #1240 — the identity that justified skipping the consolidated run.
    // Captured here and returned structurally: the caller appends the event,
    // which is where the event log lives.
    let consolidatedVerifySkipped: AlreadyVerifiedTree | undefined;
    // #1421 fix round — the consolidated gate's structured "declined on
    // nothing but build residue" signal, captured here and returned on the
    // result so the cap router reads a boolean rather than a substring.
    let buildResidueOnly = false;
    // #1427 round 3 — the hang reports of THIS gate call, in a sink created
    // here rather than on the cycle context. The context is the wrong scope:
    // it lives for the whole cycle and `verifyStepOutcome` is called up to
    // three times in one develop step (first pass, fence merge-and-retry,
    // sibling-symbol merge), so a cap emitted by the second or third call
    // carried the FIRST call's report paths in its `logPaths` — the handoff
    // pointed the operator at a file from a run that had nothing to do with the
    // cap, and the fence-retry fallback could name reports for a re-run that
    // killed nothing at all. One sink per call, returned as this call's
    // `hangLogPaths`, is the scope the cap actually has.
    const hangSink: GateHangPathSink = {};
    let gateRecord: DevelopGateRecord | undefined;
    // #1647 — a holder, not a `let` assigned in a callback: the callback fills
    // it and the return below reads it, and a closure-assigned `let` reads as
    // always undefined to the type checker.
    const selectedOut: { record?: SelectedVerifyRecord } = {};
    const verifyStarted = await beginVerifyRun(ctx, state);
    await verifyDevelopOutcome(ctx, state, execFn, failures, notes, {
      // #782 — the flake callback is wired at this layer: on recovery it
      // returns a success verdict carrying the flag the caller routes.
      onVerifyFlakeRecovered: (evidenceTail) => {
        flakeEvidenceTail = evidenceTail;
      },
      fenceViolations,
      onConsolidatedLogPath: (logPath) => {
        consolidatedLogPath = logPath;
      },
      commentEvidence,
      onBaselineRedOnly: () => {
        baselineRedOnly = true;
      },
      // #1240 review r2 — without this callback the identity the probe
      // recorded is DROPPED: `verifyDevelopOutcome` threads the out-parameter
      // to the report layer, which calls it, and `consolidatedVerifySkipped`
      // would stay undefined so no caller appended the event. The note still
      // appeared, which is exactly how the gap hid: the note is rendered from
      // `cons.skipped` independently of the callback.
      onConsolidatedVerifySkipped: (skipped) => {
        consolidatedVerifySkipped = skipped;
      },
      // #1421 fix round — the consolidated gate's structured "declined on
      // nothing but build residue" signal, captured here and returned on the
      // result so the cap router reads a boolean rather than a substring.
      onBuildResidueOnly: () => {
        buildResidueOnly = true;
      },
      // #1427 fix round — the walker is a test seam for the hang reports, and
      // it has to reach BOTH legs of the gate (per-worktree and consolidated).
      ...(ctx.walkProcessTree !== undefined ? { walkProcessTree: ctx.walkProcessTree } : {}),
      // #1427 round 3 — this call's sink, threaded to every writer below.
      hangSink,
      // #1415 — captured and returned: the caller owns the state it lands on.
      onGateRecorded: (pass, greens, refuted) => {
        gateRecord = { pass, greens: [...greens], refuted: [...refuted] };
      },
      onSelectedVerify: (record) => {
        selectedOut.record = record;
      },
    });
    const flakeRecovered = flakeEvidenceTail !== undefined;
    const verifyEvents = finishVerifyRun(verifyStarted, failures.length === 0);
    return {
      ok: failures.length === 0,
      failures,
      notes,
      ...(fenceViolations.length > 0 ? { fenceViolations } : {}),
      ...(flakeRecovered ? { flakeRecovered: true } : {}),
      ...(consolidatedLogPath !== undefined ? { logPath: consolidatedLogPath } : {}),
      ...(baselineRedOnly ? { baselineRedOnly: true } : {}),
      ...(consolidatedVerifySkipped !== undefined ? { consolidatedVerifySkipped } : {}),
      ...(verifyEvents.length > 0 ? { verifyEvents } : {}),
      ...(buildResidueOnly ? { buildResidueOnly: true } : {}),
      ...(gateRecord !== undefined ? { gateRecord } : {}),
      ...(selectedOut.record !== undefined ? { selectedVerify: selectedOut.record } : {}),
      // #1427 round 3 — read the sink THIS call created, not the cycle context:
      // the list is exactly the reports this gate run wrote, which is what the
      // cap emit site needs. (It used to read `ctx.gateHangLogPaths`, which
      // accumulated across every gate call of the cycle, so a late cap named
      // early runs' reports.)
      ...(hangSink.gateHangLogPaths !== undefined && hangSink.gateHangLogPaths.length > 0
        ? { hangLogPaths: [...hangSink.gateHangLogPaths] }
        : {}),
      commentEvidence,
    };
  }

  // step === "commit-pr"
  // #1134 — the same mainline resolution readIntegratedDiff uses (detectMainline).
  // Unresolved has no base to count against, so it fails closed below.
  const mainline = await resolveMainline(ctx.repoRoot, execFn);
  const base = mainline.ok ? mainline.branch : undefined;
  // #451 — name the integration branch explicitly. `origin/<branchName>`
  // requires the branch to be pushed, which it is at commit-pr time (ops
  // pushes before opening the PR). Using the local ref name (not
  // `origin/<branch>`) because the commit-pr gate can run before push in
  // some edge cases; the local ref is what the cycle created.
  // #1134 supersedes the local-ref choice above: the head is origin/<branch>.
  // #1134 — head is origin/<branch>, the ref readIntegratedDiff reads. This gate
  // runs after integrate() has pushed (work-driver-commit-pr-events.ts), so the
  // remote-tracking ref exists. Three-dot + --right-only: the branch's own
  // commits, measured from the merge base.
  const branch = state.pipelineState.branchName;
  if (base === undefined) {
    const reason = mainline.ok ? "unknown" : mainline.reason;
    failures.push(
      `could not count commits: the mainline is unresolved (${reason}) — commit evidence is unverifiable`,
    );
  } else if (!branch) {
    failures.push(
      `could not count commits ahead of origin/${base}: no branch name was recorded for this cycle`,
    );
  } else {
    const ahead = await aheadOfBase(execFn, ctx.repoRoot, `origin/${base}`, `origin/${branch}`);
    switch (ahead.kind) {
      case "ahead":
        break;
      case "empty":
        // #1332 — state what was measured; the ops reply may have said
        // nothing was committed, so the text never attributes a claim to it.
        failures.push(
          `the branch has zero commits ahead of origin/${base} after commit-pr — nothing was committed`,
        );
        break;
      case "unpushed":
        // The count reads origin/<branch>; a clone that never pushed it has nothing
        // to count, and that is a named fact, not an unverifiable reading.
        failures.push(
          `origin/${branch} not found in this clone — the branch was not pushed from here`,
        );
        break;
      case "unresolved":
      case "unknown": {
        // Unreadable or unresolvable is unknown, never zero and never a pass.
        const why = ahead.kind === "unknown" ? ahead.error : ahead.reason;
        failures.push(`${why} — commit evidence is unverifiable`);
        break;
      }
    }
  }
  let adoptedPrNumber: number | undefined;
  let prToCheck = state.pipelineState.prNumber;
  if (prToCheck === undefined) {
    // Ops forgot the `pr: <N>` marker. Try to resolve by branch name
    // before declaring failure (bonus repair for handoff targeting).
    const branch = state.pipelineState.branchName;
    if (branch) {
      const forge = await forgeForCycle(ctx, execFn);
      if (forge) {
        try {
          const prs = await forge.prList({ sourceBranch: branch });
          const n = prs[0]?.number;
          if (n !== undefined && Number.isFinite(n) && n > 0) {
            adoptedPrNumber = n;
            prToCheck = n;
            notes.push(
              `ops omitted the pr: marker; resolved PR #${n} via forge prList by head branch`,
            );
          }
        } catch {
          // forge unavailable or no PR — the check below reports it.
        }
      }
    }
    if (prToCheck === undefined) {
      failures.push(
        "no PR exists for the branch: the commit-pr reply carried no `pr: <N>` marker and the forge lists none for the head branch — the step is not backed by an actual PR",
      );
    }
  }
  if (prToCheck !== undefined) {
    // The number may have come from an ops child's reply. Asking whether it
    // resolves proves only that SOME PR has that number — in a busy repo the
    // numbers around a real PR are all live PRs, so a plausible mistake is a
    // valid one. Bind it to the branch instead: that is driver-computed, and
    // `gh pr create --head` opened the PR against exactly it.
    let view: PrView | undefined;
    const forge = await forgeForCycle(ctx, execFn);
    if (forge) {
      try {
        const pr = await forge.prView(prToCheck);
        view = { state: pr.state, headRefName: pr.headRefName };
      } catch (err) {
        const e = err as Error & { stderr?: string };
        failures.push(
          `PR #${prToCheck} does not resolve via the forge adapter: ${(e.stderr ?? e.message ?? "").slice(0, 200)}`,
        );
      }
    } else {
      failures.push(`PR #${prToCheck} cannot be verified: forge undetermined for this repo`);
    }
    if (view !== undefined) {
      const identity = judgePrIdentity(state.pipelineState.branchName, view);
      if (!identity.ok && identity.failure) {
        failures.push(`PR #${prToCheck} ${identity.failure}`);
      }
    }
  }
  return { ok: failures.length === 0, failures, notes, adoptedPrNumber };
}
