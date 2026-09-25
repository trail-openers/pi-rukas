/**
 * work-driver-verify-pr17 — PR17 driver-side outcome verification gate.
 * Extracted from work-driver-verify.ts (AGENTS.md §12 file-size limit).
 *
 * Checks EXECUTED evidence (git status, rev-list, forge prView) rather
 * than trusting an agent's "done" claim. Used by runCommitPr as a
 * post-dispatch safety gate.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { DriverContext } from "./work-driver-context.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import { detectMainline } from "./work-driver-git.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import { verifyDevelopOutcome } from "./work-driver-verify-develop.ts";
import type { WorkState } from "./workflow-state.ts";

const execp = promisify(exec);

/** PR17 — escape hatch: PI_ENSEMBLE_VERIFY=0 disables the outcome gate. */
function verifyGateEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_VERIFY;
  return v !== "0" && v !== "false";
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
    return { ok: false, failure: "cannot be bound to this cycle: no branch was recorded" };
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
  ctx: DriverContext,
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
   * when a flake re-run fired, run1 otherwise), carried STRUCTURALLY so
   * the caller records it on the cap-hit event's `logPaths` field instead of
   * regexing the path out of the failure prose. Absent when no log was
   * written (write failure, no consolidated run).
   */
  logPath?: string;
}> {
  const failures: string[] = [];
  const notes: string[] = [];
  if (!verifyGateEnabled()) {
    return { ok: true, failures, notes: ["PI_ENSEMBLE_VERIFY=0 — outcome gate skipped"] };
  }
  const execFn = ctx.verifyExecFn ?? execp;

  if (step === "develop") {
    // #782 — the flake callback is wired at this layer: on recovery it
    // returns a success verdict carrying the flag the caller routes.
    let flakeEvidenceTail: string | undefined;
    let consolidatedLogPath: string | undefined;
    const fenceViolations: FenceViolationRecord[] = [];
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
    );
    const flakeRecovered = flakeEvidenceTail !== undefined;
    return {
      ok: failures.length === 0,
      failures,
      notes,
      ...(fenceViolations.length > 0 ? { fenceViolations } : {}),
      ...(flakeRecovered ? { flakeRecovered: true } : {}),
      ...(consolidatedLogPath !== undefined ? { logPath: consolidatedLogPath } : {}),
    };
  }

  // step === "commit-pr"
  let base = "main";
  const mainline = await detectMainline(ctx.repoRoot, execFn);
  if (mainline && "branch" in mainline) {
    base = mainline.branch;
  }
  try {
    // #451 — name the integration branch explicitly. `origin/<branchName>`
    // requires the branch to be pushed, which it is at commit-pr time (ops
    // pushes before opening the PR). Using the local ref name (not
    // `origin/<branch>`) because the commit-pr gate can run before push in
    // some edge cases; the local ref is what the cycle created.
    const branch = state.pipelineState.branchName ?? "HEAD";
    const { stdout } = await execFn(`git rev-list --count origin/${base}..${branch}`, {
      cwd: ctx.repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (Number.parseInt(stdout.trim(), 10) === 0) {
      failures.push(
        `ops claimed commit+PR done but the branch has zero commits ahead of origin/${base} — nothing was committed`,
      );
    }
  } catch (err) {
    notes.push(
      `git rev-list failed (${(err as Error).message?.slice(0, 100)}) — commit evidence unavailable`,
    );
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
