/**
 * work-driver-verify-develop — develop-branch outcome verification.
 *
 * Extracted from work-driver-verify.ts (issue #338, file-size cap).
 * Checks diff evidence, verify command, skip-ratchet, and product smoke gates.
 * Import chain: work-driver-verify.ts → this file → work-driver-verify-cmd.ts
 * (acyclic). The #679 falsily-green check lives in work-driver-falsily-green.ts.
 * Exec-error formatting and verify-cmd gate helpers (timeout, path
 * normaliser, tolerance) live in work-driver-verify-develop-helpers.ts.
 */

import { runConsolidatedVerify } from "./work-driver-consolidated-verify.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  doctrineProsePathsIn,
  explainProtectedPaths,
  porcelainPaths,
  protectedPathsEnabled,
  protectedPathsIn,
} from "./work-driver-doctrine.ts";
import { runFalsilyGreenCheck } from "./work-driver-falsily-green.ts";
import { runScopeFanoutGate } from "./work-driver-scope-fanout.ts";
import { declaredPathsHaveSource, verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { runSkipRatchetGate, runSmokeGate } from "./work-driver-verify-develop-gates.ts";
import { normaliseScopePath } from "./work-driver-verify-develop-helpers.ts";
import { runVerifyCommandGate } from "./work-driver-verify-verify-cmd.ts";

import type { WorkState } from "./workflow-state.ts";

/** PR338 — validate a git SHA before shell interpolation. */
const VALID_SHA_RE = /^[0-9a-f]{40}$/;
function isValidSha(s: string | undefined) {
  return typeof s === "string" && VALID_SHA_RE.test(s);
}

/**
 * Verify the develop step's outcome by checking executed evidence
 * in each worktree. Mutates `failures` and `notes` in place.
 */
export async function verifyDevelopOutcome(
  ctx: DriverContext,
  state: WorkState,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  failures: string[],
  notes: string[],
  // #782 — fires when the consolidated-verify flake re-run passed.
  onVerifyFlakeRecovered?: (evidenceTail?: string) => void,
): Promise<void> {
  const worktrees =
    Object.keys(state.pipelineState.worktrees ?? {}).length > 0
      ? (state.pipelineState.worktrees ?? {})
      : { default: ctx.repoRoot };
  const baseSha = state.pipelineState.baseSha;
  const changedWorktrees: string[] = [];
  // #406 — every path the developers touched, across all worktrees, so the
  // protected-path gate below sees the whole change set rather than one
  // worktree's slice of it.
  const touchedPaths: string[] = [];
  // #285 scope/fanout map + #453 uncommitted-only count (suppresses the
  // hollow-diff message when per-worktree failures already explain it).
  let assessedCount = 0;
  // #672 (sub-defect 1) — per-worktree changed-path attribution. Each id's
  // Set is initialized BEFORE the accumulation loop so `.add()` writes into
  // a live Set (the pre-fix code called `.get(id)?.add()` before any `.set()`
  // — a silent no-op), and it is never overwritten with the cross-worktree
  // cumulative `touchedPaths` union (the pre-fix post-loop `.set(id, new Set(touchedPaths))`
  // made every id's Set an identical copy of the union of ALL worktrees' paths).
  // `touchedPaths` stays cumulative — the #406 gate and diagnostics rely on it.
  const changedPathsByWorkstream = new Map<string, Set<string>>(
    Object.keys(worktrees).map((id) => [id, new Set<string>()]),
  );
  // #453 — count worktrees with uncommitted-only changes (no commits ahead
  // of baseSha); when > 0 and changedWorktrees is empty, the per-worktree
  // failures already explain the issue — skip the empty-diff message.
  let uncommittedOnlyCount = 0;
  // #679 (task-evidence) — workstream ids whose declared paths are entirely
  // non-source (docs-only), EXEMPT from the "uncommitted but no commit"
  // failure (uncommitted work is a legitimate non-source deliverable) and
  // from the generic "every worktree empty" message (no commits expected).
  const legitimateNonSourceWorkstreams = new Set<string>();
  // #679 (task-evidence) — per-workstream base resolution. A dependent
  // workstream's EFFECTIVE base is its dependency's post-commit SHA (persisted
  // in `workstreamBaseShas`); every other workstream falls back to the global
  // `baseSha`. The falsily-green check compares each worktree against THIS ref,
  // so a dependent whose base ≠ the global base is judged against the right ref.
  const workstreamBaseShas = state.pipelineState.workstreamBaseShas;
  const effectiveBaseFor = (wsId: string): string | undefined => {
    const per = workstreamBaseShas?.[wsId];
    if (isValidSha(per)) return per;
    if (isValidSha(baseSha)) return baseSha;
    return undefined;
  };
  // #679 (task-evidence) — per-workstream declared-source flag, computed once
  // so BOTH the uncommitted-only suppression and the falsily-green check share
  // the same classification (no repeated classifier calls).
  const declaredSourceByWorkstream = new Map<string, boolean>();
  const workstreamsMap = state.pipelineState.workstreams ?? {};
  for (const [wsId, ws] of Object.entries(workstreamsMap)) {
    try {
      declaredSourceByWorkstream.set(
        wsId,
        await declaredPathsHaveSource(ws?.paths ?? [], ctx.repoRoot),
      );
    } catch {
      declaredSourceByWorkstream.set(wsId, true); // uncertain → treat as source
    }
  }
  for (const [id, cwd] of Object.entries(worktrees)) {
    let hasCommits = false;
    let hasUncommitted = false;
    let assessed = false;
    try {
      const { stdout } = await execFn("git status --porcelain", {
        cwd,
        maxBuffer: 1024 * 1024,
      });
      assessed = true;
      if (stdout.trim().length > 0) hasUncommitted = true;
      const statusPaths = porcelainPaths(stdout);
      touchedPaths.push(...statusPaths);
      const ownSet = changedPathsByWorkstream.get(id);
      if (ownSet) for (const file of statusPaths) ownSet.add(normaliseScopePath(file));
    } catch (err) {
      notes.push(`git status failed in ${id} (${(err as Error).message?.slice(0, 100)})`);
    }
    // #725 — diff against THIS workstream's effective base, not the cycle-
    // global baseSha: a dependent's worktree is created from its dependency's
    // post-commit SHA (#679), so a global-base diff spuriously includes the
    // dependency's files — the #607 false positive.
    const effBase = effectiveBaseFor(id);
    if (isValidSha(effBase)) {
      try {
        const { stdout } = await execFn(`git rev-list --count ${effBase}..HEAD`, {
          cwd,
          maxBuffer: 64 * 1024,
        });
        if (Number.parseInt(stdout.trim(), 10) > 0) hasCommits = true;
        assessed = true;
      } catch (err) {
        // #725 — an absent baseSha in this worktree's history is not evidence
        // either way; but a base the code itself resolved and git could not
        // read IS a degraded measurement — name the ref and error (#384).
        if (effBase !== baseSha) {
          notes.push(
            `rev-list failed against effective base ${effBase} in ${id} — commit count unavailable, the worktree may be undercounted as changed (${(err as Error).message?.slice(0, 100)})`,
          );
        }
      }
      try {
        const { stdout } = await execFn(`git diff --name-only ${effBase}..HEAD`, {
          cwd,
          maxBuffer: 4 * 1024 * 1024,
        });
        const diffPaths = stdout.split("\n").filter((l) => l.trim().length > 0);
        touchedPaths.push(...diffPaths);
        const ownSet = changedPathsByWorkstream.get(id);
        if (ownSet) for (const file of diffPaths) ownSet.add(normaliseScopePath(file));
      } catch {
        // Same as above — an absent baseSha in this worktree is not evidence.
      }
    }
    if (assessed) assessedCount++;
    // #453 + #725 — the `changed` decision derives from the SAME ref the
    // diff block tested (the effective base, not the global baseSha, which
    // may be absent for a dependent with a valid workstreamBaseShas entry);
    // the uncommitted fallback applies only when NO valid base exists (older
    // state files).
    const changed = isValidSha(effBase) ? hasCommits : hasCommits || hasUncommitted;
    if (changed) changedWorktrees.push(cwd);
    // Per-worktree diagnostic: uncommitted work exists but hasn't been committed.
    // #679 (task-evidence) — a workstream whose declared paths are entirely
    // non-source (docs-only) is NOT penalised for leaving its uncommitted work
    // uncommitted: that uncommitted work IS the deliverable (a docs change),
    // and the falsily-green check below handles the source case explicitly.
    const isLegitNonSource = declaredSourceByWorkstream.get(id) === false;
    if (isValidSha(effBase) && hasUncommitted && !hasCommits) {
      if (isLegitNonSource) {
        legitimateNonSourceWorkstreams.add(id);
        // Legitimate docs-only deliverable — no failure; the safety net will
        // still commit it driver-side so the transfer unit is a real commit.
      } else {
        uncommittedOnlyCount++;
        // #621 — the developer commits in their own worktree with their own
        // conventional-commit subject; what matters is that the work is
        // committed ahead of baseSha before the adversarial gate runs.
        // #725 — name the ref this check actually tested (the effective base).
        const ref = isValidSha(effBase) ? `base ${effBase}` : "baseSha";
        failures.push(
          `worktree "${id}": has uncommitted changes but no commit ahead of ${ref} — run \`git add -A && git commit -m \"<type>(scope): concise subject\"\` in the worktree before completing the develop step`,
        );
      }
    }
  }

  // --- #679 (task-evidence) — per-worktree falsily-green evidence check ---
  // Extracted to work-driver-falsily-green.ts (file-size cap). A workstream
  // whose declared paths are source yet produced no source changes is falsely
  // green; a genuine docs-only workstream is not penalised. Per-worktree, so
  // one empty workstream no longer suppresses the evidence for the rest of
  // the fanout. Populates `legitimateNonSourceWorkstreams` for the caller to
  // suppress the generic empty-diff message for docs-only streams.
  await runFalsilyGreenCheck(
    execFn,
    ctx.repoRoot,
    worktrees,
    workstreamBaseShas,
    baseSha,
    changedPathsByWorkstream,
    declaredSourceByWorkstream,
    legitimateNonSourceWorkstreams,
    failures,
  );

  // --- Protected-path gate (#406) ---
  // A cycle must not edit the files that decide whether its own work passes.
  // Policy prose (AGENTS.md, CLAUDE.md) is deliberately NOT halted here — it
  // is neutralised instead, by reading doctrine at baseSha in the merge gate —
  // so that this repo's own "docs ship with the PR" rule keeps working.
  if (protectedPathsEnabled()) {
    const protectedHits = protectedPathsIn(touchedPaths);
    if (protectedHits.length > 0) failures.push(explainProtectedPaths(protectedHits));
    const prose = doctrineProsePathsIn(touchedPaths);
    if (prose.length > 0) {
      notes.push(
        `develop changed policy prose (${prose.join(", ")}) — allowed, and inert for this cycle: merge authority is read at the base commit, so a grant added here cannot take effect until an operator merges it`,
      );
    }
  } else {
    notes.push("PI_ENSEMBLE_PROTECTED_PATHS=0 — protected-path gate disabled");
  }

  // --- Scope/fanout gate (#285) — extracted to work-driver-scope-fanout.ts ---
  // #725 — each workstream's fence is evaluated against its OWN effective-base
  // diff (above), with a dependsOn carve-out for paths a declared dependency
  // owns (work-driver-scope-fanout.ts): the cross-declaration contract (#572)
  // keeps findPathCollisions from firing. A fence HIT is a decomposition
  // problem, not an integration one: NOT routed to the consolidated-verify-
  // conflict cap (only the cherry-pick conflict below).
  runScopeFanoutGate(
    state.pipelineState.workstreams ?? {},
    changedPathsByWorkstream,
    failures,
    notes,
  );

  if (changedWorktrees.length === 0) {
    // #679 (task-evidence) — if every assessed worktree is a legitimate
    // docs-only stream (declared non-source), the absence of commits is not a
    // hollow-diff failure: the work is a docs deliverable, and the safety net
    // commits it. Suppress the generic message.
    const allAssessedAreDocsOnly =
      assessedCount > 0 &&
      [...legitimateNonSourceWorkstreams].length === Object.keys(worktrees).length;
    if (assessedCount > 0 && uncommittedOnlyCount === 0 && !allAssessedAreDocsOnly) {
      // Every worktree is genuinely empty (no uncommitted, no commits).
      failures.push(
        "developer claimed done but every assessed worktree has an empty diff (no uncommitted changes, no commits ahead of base) — the claim is not backed by any code change",
      );
    } else if (assessedCount === 0) {
      notes.push(
        "no worktree could be assessed (git status / rev-list failed everywhere) — diff evidence unavailable, gate degrading to pass-with-note",
      );
    }
    // else: uncommittedOnlyCount > 0 — per-worktree failures already explain
    // the issue (uncommitted work, no commits ahead of baseSha).
  }
  // --- Verify command (b) — per-worktree, then the CONSOLIDATED tree ---
  // #669 — every gate before the consolidated run sees ONE workstream in
  // isolation, so a test in workstream X that asserts on a file owned by
  // workstream Y cannot pass in X's tree. Per-worktree verify stays (out-of-
  // scope touches, skip-ratchet violations and missing deps are per-worktree
  // diagnostics the consolidated run cannot see), but it must never be the
  // SOLE basis for rejecting a fanout: N>1 workstreams get one additional
  // verify against a tree containing ALL of their commits, and per-worktree
  // verify failures are downgraded to notes whenever that consolidated run
  // passes — the consolidated result is what decides whether a per-worktree
  // failure was a cross-worktree artifact.
  const cmd = await verifyCmdFor(ctx.repoRoot);
  if (!cmd) {
    notes.push(
      "no verify command discoverable (.pi/verify-cmd, package.json scripts, Cargo.toml) — diff evidence only",
    );
  } else {
    // #794 — the per-worktree loop + consolidated run + classification is
    // extracted to work-driver-verify-verify-cmd.ts (500-line gate); the
    // failure messages, the flake-retry precondition and the aggregation
    // semantics all live there unchanged.
    await runVerifyCommandGate({
      execFn,
      cmd,
      ctx,
      state,
      worktrees,
      baseSha,
      changedWorktrees,
      workstreamBaseShas,
      failures,
      notes,
      onVerifyFlakeRecovered,
    });
  }

  // --- Skip-ratchet gate (PR277) + product smoke gate (PR277) ---
  // #451 — extracted to work-driver-verify-develop-gates.ts (AGENTS.md §12
  // file-size cap). The #782 flake-retry logic above pushed this file past
  // the 500-line limit; the two independent post-verify gates move there.
  await runSkipRatchetGate(execFn, ctx.repoRoot, baseSha, changedWorktrees, failures, notes);
  await runSmokeGate(execFn, ctx.repoRoot, changedWorktrees, failures, notes);
  return undefined;
}
