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
import { countPrCommits, refResolves } from "./git-range.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import { type VerifyExecFn, resolveMainline } from "./work-driver-git.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { verifyDevelopOutcome } from "./work-driver-verify-develop.ts";
import type { WorkState } from "./workflow-state.ts";

// #1134 follow-up — the argv form must be honoured: the previous
// `promisify(exec)` dropped `argv`, so countPrCommits ran a bare `git` in
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
    await verifyDevelopOutcome(
      ctx,
      state,
      execFn,
      failures,
      notes,
      (evidenceTail) => {
        flakeEvidenceTail = evidenceTail;
      },
      fenceViolations,
      (logPath) => {
        consolidatedLogPath = logPath;
      },
      commentEvidence,
    );
    const flakeRecovered = flakeEvidenceTail !== undefined;
    return {
      ok: failures.length === 0,
      failures,
      notes,
      ...(fenceViolations.length > 0 ? { fenceViolations } : {}),
      ...(flakeRecovered ? { flakeRecovered: true } : {}),
      ...(consolidatedLogPath !== undefined ? { logPath: consolidatedLogPath } : {}),
      commentEvidence,
    };
  }

  // step === "commit-pr"
  // #1134 — the same mainline resolution readIntegratedDiff uses (detectMainline).
  // Unresolved has no base to count against, so it fails closed below.
  const mainline = await resolveMainline(ctx.repoRoot, execFn);
  const base = "branch" in mainline ? mainline.branch : undefined;
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
    const reason = "reason" in mainline ? mainline.reason : "unknown";
    failures.push(
      `could not count commits: the mainline is unresolved (${reason}) — commit evidence is unverifiable`,
    );
  } else if (!branch) {
    failures.push(
      `could not count commits ahead of origin/${base}: no branch name was recorded for this cycle`,
    );
  } else if (!(await refResolves(execFn, ctx.repoRoot, `origin/${branch}`))) {
    // The count reads origin/<branch>; a clone that never pushed it has nothing
    // to count, and that is a named fact, not an unverifiable reading.
    failures.push(`origin/${branch} not found in this clone — the branch was not pushed from here`);
  } else {
    try {
      const ahead = await countPrCommits(
        execFn,
        ctx.repoRoot,
        `origin/${base}`,
        `origin/${branch}`,
      );
      if (Number.isNaN(ahead)) {
        // Unparseable is not zero and not a pass: it is unknown, so it fails closed.
        failures.push(
          `could not count commits ahead of origin/${base} — commit evidence is unverifiable`,
        );
      } else if (ahead === 0) {
        failures.push(
          `ops claimed commit+PR done but the branch has zero commits ahead of origin/${base} — nothing was committed`,
        );
      }
    } catch (err) {
      // #1134 — a rejected count is unknown, the same as NaN: a failure, never a note.
      const msg = ((err as Error).message ?? String(err)).slice(0, 200);
      failures.push(
        `could not count commits ahead of origin/${base}: ${msg} — commit evidence is unverifiable`,
      );
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
        "ops claimed a PR was opened but no `pr: <N>` marker was parsed and no PR exists for the branch — the claim is not backed by an actual PR",
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
