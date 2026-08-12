/**
 * work-driver-verify — driver-side outcome-verification gate.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Checks
 * EXECUTED evidence (git status, verify command, skip-ratchet, product
 * smoke, PR existence) rather than trusting an agent's "done" claim.
 * Used by runDevelop and runCommitPr as a post-dispatch safety gate.
 *
 * After issue #338 extraction:
 *   - verifyCmdFor → work-driver-verify-cmd.ts
 *   - develop branch → work-driver-verify-develop.ts (verifyDevelopOutcome)
 *   - commit-pr branch + verifyConsolidation remain here.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { detectMainline } from "./work-driver-git.ts";
import { verifyDevelopOutcome } from "./work-driver-verify-develop.ts";
import type { WorkState } from "./workflow-state.ts";

// Re-export for existing consumers (smoke tests) so import paths stay valid.
export { verifyCmdFor } from "./work-driver-verify-cmd.ts";

const execp = promisify(exec);

/**
 * PR14 — Verify the integration branch's committed diff (vs origin/main)
 * includes files from EVERY active workstream's `paths` list. Used as
 * the post-dispatch safety gate in runCommitPr. Returns missing
 * workstreams (those whose paths are entirely absent from the diff)
 * so the cap-hit message can name them.
 *
 * Best-effort: any git-shell failure returns no-missing (don't false-
 * alarm on a transient git issue). The N=1 case short-circuits since
 * there's only one workstream and partial-commit doesn't apply.
 */
export async function verifyConsolidation(
  ctx: DriverContext,
  state: WorkState,
): Promise<{ missing: Array<{ id: string; paths: string[] }> }> {
  const workstreams = state.pipelineState.workstreams ?? {};
  const ids = Object.keys(workstreams);
  if (ids.length <= 1) return { missing: [] };
  // Resolve the mainline branch to diff against.
  let base = "main";
  const mainline = await detectMainline(ctx.repoRoot, execp);
  if (mainline && "branch" in mainline) {
    base = mainline.branch;
  }
  let diffNames = "";
  try {
    const { stdout } = await execp(`git diff --name-only origin/${base}..HEAD`, {
      cwd: ctx.repoRoot,
      maxBuffer: 1024 * 1024,
    });
    diffNames = stdout;
  } catch (err) {
    trace(
      `work-driver: verifyConsolidation diff failed (treating as no-missing): ${(err as Error).message?.slice(0, 120)}`,
    );
    return { missing: [] };
  }
  const changedFiles = new Set(diffNames.split("\n").filter((s) => s.trim().length > 0));
  const missing: Array<{ id: string; paths: string[] }> = [];
  for (const id of ids) {
    const ws = workstreams[id];
    if (!ws || ws.paths.length === 0) {
      // No paths declared → can't verify; skip (don't false-alarm).
      continue;
    }
    const anyPresent = ws.paths.some((raw) => {
      const p = normaliseDeclaredPath(raw);
      if (!p) return false;
      return Array.from(changedFiles).some((f) => f === p || f.startsWith(`${p}/`));
    });
    if (!anyPresent) {
      missing.push({ id, paths: ws.paths });
    }
  }
  return { missing };
}

/**
 * A declared path as `git` would spell it.
 *
 * `paths` is prose from the plan step, not `git` output, and — measured across
 * the real state files on this host — it carries annotations the planner added
 * for a human reader:
 *
 *     "extension/src/work-driver-verify-cmd.ts (new)"
 *     "extension/src/role-tools.ts (no changes)"
 *
 * Compared by exact equality against `git diff --name-only`, neither ever
 * matches, so the workstream reads as MISSING even when its files changed. The
 * failure is one-directional — a false alarm at commit-pr, never a false pass —
 * which is why it went unnoticed.
 *
 * A trailing parenthetical is stripped; one INSIDE a name ("notes (draft).md")
 * is not, because that is a real filename.
 */
export function normaliseDeclaredPath(raw: string): string {
  return raw
    .trim()
    .replace(/\s*\([^()]*\)\s*$/, "")
    .replace(/^[`*\s]+|[`*\s]+$/g, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
}

/** PR17 — escape hatch: PI_ENSEMBLE_VERIFY=0 disables the outcome gate. */
function verifyGateEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_VERIFY;
  return v !== "0" && v !== "false";
}

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
 *         origin/<base>..HEAD` > 0 at repoRoot.
 *     (b) the parsed PR number resolves via `gh pr view`. When ops
 *         forgot the `pr: <N>` marker, fall back to `gh pr list
 *         --head <branch>` and ADOPT the number into pipelineState
 *         (bonus repair — pre-PR17 a missing marker degraded handoff
 *         targeting). No PR found at all = the "opened a PR" claim was
 *         hollow.
 *
 * Failure semantics: returns `{ok: false, failures}` — the caller emits
 * cap-hit `verify-failed:<step>` → handoff with evidence in
 * pipelineState.verifyEvidence. Infra errors on OUR side (git itself
 * erroring at repoRoot) are notes, not failures — same no-false-alarm
 * stance as verifyConsolidation.
 */
/** The fields of `gh pr view --json state,headRefName` this gate reads. */
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
): Promise<{ ok: boolean; failures: string[]; notes: string[]; adoptedPrNumber?: number }> {
  const failures: string[] = [];
  const notes: string[] = [];
  if (!verifyGateEnabled()) {
    return { ok: true, failures, notes: ["PI_ENSEMBLE_VERIFY=0 — outcome gate skipped"] };
  }
  const execFn = ctx.verifyExecFn ?? execp;

  if (step === "develop") {
    await verifyDevelopOutcome(ctx, state, execFn, failures, notes);
    return { ok: failures.length === 0, failures, notes };
  }

  // step === "commit-pr"
  let base = "main";
  const mainline = await detectMainline(ctx.repoRoot, execFn);
  if (mainline && "branch" in mainline) {
    base = mainline.branch;
  }
  try {
    const { stdout } = await execFn(`git rev-list --count origin/${base}..HEAD`, {
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
      try {
        const { stdout } = await execFn(
          `gh pr list --head ${JSON.stringify(branch)} --json number --jq '.[0].number'`,
          { cwd: ctx.repoRoot, maxBuffer: 64 * 1024 },
        );
        const n = Number.parseInt(stdout.trim(), 10);
        if (Number.isFinite(n) && n > 0) {
          adoptedPrNumber = n;
          prToCheck = n;
          notes.push(`ops omitted the pr: marker; resolved PR #${n} via gh pr list --head`);
        }
      } catch {
        // gh unavailable or no PR — the check below reports it.
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
    try {
      const { stdout } = await execFn(`gh pr view ${prToCheck} --json state,headRefName`, {
        cwd: ctx.repoRoot,
        maxBuffer: 256 * 1024,
      });
      view = JSON.parse(stdout) as PrView;
    } catch (err) {
      const e = err as Error & { stderr?: string };
      failures.push(
        `PR #${prToCheck} does not resolve via \`gh pr view\`: ${(e.stderr ?? e.message ?? "").slice(0, 200)}`,
      );
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
