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
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import { detectMainline } from "./work-driver-git.ts";
import { verifyDevelopOutcome } from "./work-driver-verify-develop.ts";
import type { FlakeRetryOutcome } from "./work-driver-verify-develop.ts";
import type { ConsolidationVerdict } from "./workflow-state-consolidation.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state.ts";

// Re-export for existing consumers (smoke tests) so import paths stay valid.
export { verifyCmdFor } from "./work-driver-verify-cmd.ts";

const execp = promisify(exec);

/**
 * PR14 + #540 — Verify the integration branch's committed diff (vs
 * origin/main) covers every active workstream. Used as the post-dispatch
 * safety gate in runCommitPr.
 *
 * Coverage rule (#540): a workstream W is COVERED iff for EVERY declared
 * path p of W: p is in the committed diff, OR p is declared by a sibling S
 * whose ENTIRE declared path set is present in the committed diff
 * (full-set subsumption). A partial sibling cannot cover another
 * workstream's path — with A={a,b}, B={b} and commit={b} only, B is
 * covered (its own full set is present) but A is NOT: b is present, but a
 * is absent and B's full set {b} does not cover a. The pre-#540 rule
 * (`any path present`) fired in the mirror case (commit={a,b}) where B's
 * path "b" WAS in the diff but flagged B's overlap pessimism, and missed
 * the false-pass direction entirely.
 *
 * #778 rename awareness: the diff is read with `--name-status -M` so a
 * move (`git mv` / rename-during-develop, the #744 shape where a declared
 * name never appears in `--name-only`) is a rename code (R###), not a
 * silent absence. A path is covered when the normalised path is an exact
 * diff name, sits beneath a changed entry (directory declaration), OR a
 * rename's SOURCE equals it — a move of the declared file still ships its
 * content. R-code rename detection is the exact-path-evidence basis; no
 * basename/substring matching, so co-located-but-different files (#655's
 * measurement workstream) still read uncovered.
 *
 * Returns BOTH sides of the verdict: `missing` (workstreams not covered,
 * for backward compat with the PR14 cap-hit message) AND `filesPresent`
 * (the committed file list — what actually shipped, so the handoff can
 * render present + missing).
 *
 * Best-effort: any git-shell failure returns no-missing (don't false-
 * alarm on a transient git issue). The N=1 case short-circuits since
 * there's only one workstream and partial-commit doesn't apply.
 */
export async function verifyConsolidation(
  ctx: DriverContext,
  state: WorkState,
): Promise<{
  missing: Array<{ id: string; paths: string[] }>;
  filesPresent: string[];
  verdicts: ConsolidationVerdict[];
}> {
  const workstreams = state.pipelineState.workstreams ?? {};
  const ids = Object.keys(workstreams);
  if (ids.length <= 1) return { missing: [], filesPresent: [], verdicts: [] };
  // Resolve the mainline branch to diff against.
  let base = "main";
  const mainline = await detectMainline(ctx.repoRoot, execp);
  if (mainline && "branch" in mainline) {
    base = mainline.branch;
  }
  let statusOut = "";
  try {
    // #451 — name the integration branch explicitly. Under worktree isolation
    // the repo root sits on mainline; bare `..HEAD` would compare mainline
    // against itself and return empty (passing the gate unconditionally).
    // #778 — `--name-status -M` (not `--name-only`): renames emit R### with
    // the SOURCE path in the diff output, so a move is visible evidence
    // instead of a silent absence of the old name.
    const branch = state.pipelineState.branchName ?? "HEAD";
    const { stdout } = await execp(`git diff --name-status -M origin/${base}..${branch}`, {
      cwd: ctx.repoRoot,
      maxBuffer: 1024 * 1024,
    });
    statusOut = stdout;
  } catch (err) {
    trace(
      `work-driver: verifyConsolidation diff failed (treating as no-missing): ${(err as Error).message?.slice(0, 120)}`,
    );
    return { missing: [], filesPresent: [], verdicts: [] };
  }
  const changedFiles = new Set<string>();
  // #778 — rename SOURCES (the old side of R### codes): a declared path that
  // was renamed away still shipped; exact-string membership only.
  const renamedSources = new Set<string>();
  for (const line of statusOut.split("\n")) {
    const fields = line.split("\t");
    const code = fields[0]?.trim() ?? "";
    if (!code) continue;
    const codeBase = code[0];
    // A rename (R###) has two columns; the second is the rename's TARGET and
    // is what landed — it belongs in the present set, not the source set.
    if (codeBase === "R" && fields.length >= 3) {
      for (const col of [1, 2] as const) {
        const p = normaliseDeclaredPath(fields[col] ?? "");
        if (!p) continue;
        changedFiles.add(p);
        if (col === 1) renamedSources.add(p);
      }
      continue;
    }
    // #778 — only a RENAME source can cover a declared path. A plain delete
    // (D) still lists the name in `--name-status` — the pre-#778 behavior —
    // so treating D as coverage would let a deleted file keep a workstream
    // "covered"; a moved file is the only move that ships its content.
    const p = normaliseDeclaredPath(fields[1] ?? "");
    if (p && codeBase !== "D") changedFiles.add(p);
  }
  // #778 — filesPresent is the COMMITTED side of the record (what shipped);
  // the rename source may no longer exist, so it is not a "present" file —
  // it only covers a declared path via the source set above.
  const filesPresent = [...changedFiles].filter((p) => p === "" || !renamedSources.has(p));
  // A declared path counts as "in the diff" when a committed file equals it,
  // sits beneath it (a directory declaration covers its contents), or a
  // rename's source equals it (the #778/#744 move case). The exact-match Set
  // lookups are O(1) and are the common case; the prefix scan only fires for
  // directory declarations.
  const declaredPathInDiff = (p: string): boolean =>
    changedFiles.has(p) ||
    renamedSources.has(p) ||
    Array.from(changedFiles).some((f) => f.startsWith(`${p}/`));
  // Normalised declared paths per workstream, so a sibling's set and this
  // workstream's paths compare like-for-like.
  const declaredOf = (ws: { paths: string[] }): string[] =>
    ws.paths.map(normaliseDeclaredPath).filter((p) => p.length > 0);
  // Precomputed once per workstream so the per-path covered-check below is
  // an O(W) scan against precomputed data, not an O(W·F) recompute per path.
  const siblingSets = new Map<string, Set<string>>();
  const siblingFullyPresent = new Map<string, boolean>();
  for (const sid of ids) {
    const s = workstreams[sid];
    if (!s || s.paths.length === 0) continue;
    const set = new Set(declaredOf(s));
    siblingSets.set(sid, set);
    siblingFullyPresent.set(sid, Array.from(set).every(declaredPathInDiff));
  }
  const missing: Array<{ id: string; paths: string[] }> = [];
  const verdicts: ConsolidationVerdict[] = [];
  for (const id of ids) {
    const ws = workstreams[id];
    if (!ws || ws.paths.length === 0) {
      // No paths declared → can't verify; note, don't false-alarm.
      verdicts.push({ id, status: "unverifiable", reason: "no declared paths" });
      continue;
    }
    const own = declaredOf(ws);
    // #540 full-set subsumption: a declared path p of W is covered when p
    // is in the committed diff, OR p is also declared by a sibling whose
    // ENTIRE declared set is present — a partial sibling cannot cover.
    const uncovered = own.filter((p) => {
      if (declaredPathInDiff(p)) return false;
      return !ids.some((sid) => {
        if (sid === id) return false;
        const s = workstreams[sid];
        if (!s) return false;
        return siblingFullyPresent.get(sid) === true && (siblingSets.get(sid)?.has(p) ?? false);
      });
    });
    if (uncovered.length > 0) {
      missing.push({ id, paths: ws.paths });
      verdicts.push({ id, status: "uncovered", uncoveredPaths: uncovered });
    } else {
      verdicts.push({ id, status: "complete" });
    }
  }
  return { missing, filesPresent, verdicts };
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
 *         origin/<base>..<branchName>` > 0 at repoRoot (#451 — the branch
 *         is named explicitly so the gate works regardless of repo-root checkout).
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
 * stance as verifyConsolidation.
 */
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
  eventsOut?: WorkEvent[],
): Promise<{
  ok: boolean;
  failures: string[];
  notes: string[];
  adoptedPrNumber?: number;
  /** #782 — the flake-retry outcome of the develop consolidated-verify gate. */
  flakeRetry?: FlakeRetryOutcome;
}> {
  const failures: string[] = [];
  const notes: string[] = [];
  if (!verifyGateEnabled()) {
    return { ok: true, failures, notes: ["PI_ENSEMBLE_VERIFY=0 — outcome gate skipped"] };
  }
  const execFn = ctx.verifyExecFn ?? execp;

  if (step === "develop") {
    const flakeRetry = await verifyDevelopOutcome(ctx, state, execFn, failures, notes, eventsOut);
    return { ok: failures.length === 0, failures, notes, flakeRetry };
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
