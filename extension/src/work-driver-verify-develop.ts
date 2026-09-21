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

import path from "node:path";
import {
  restoreConsolidatedVerifyRoot,
  retryConsolidatedVerify,
  runConsolidatedVerify,
} from "./work-driver-consolidated-verify.ts";
import {
  buildPerWorktreeFailuresByWs,
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
} from "./work-driver-consolidation-classify.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { provisionDepsHint } from "./work-driver-deps-hint.ts";
import {
  doctrineProsePathsIn,
  explainProtectedPaths,
  porcelainPaths,
  protectedPathsEnabled,
  protectedPathsIn,
} from "./work-driver-doctrine.ts";
import { extractAttributedTail } from "./work-driver-exec-error.ts";
import { runFalsilyGreenCheck } from "./work-driver-falsily-green.ts";
import { runScopeFanoutGate } from "./work-driver-scope-fanout.ts";
import { declaredPathsHaveSource, verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { runSkipRatchetGate, runSmokeGate } from "./work-driver-verify-develop-gates.ts";
import {
  formatExecError,
  normaliseScopePath,
  verifyTimeoutMs,
} from "./work-driver-verify-develop-helpers.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state.ts";
import { looksLikeMissingDeps } from "./worktree-provision.ts";

/**
 * #782 — the flake-retry outcome of the consolidated-verify gate. `undefined`
 * when no retry ran (the normal path); `{retries, recovered}` when the
 * bounded re-run was performed. The caller (work-develop-topological.ts) uses
 * this to set verifyEvidence.retries/recovered and to emit the
 * `verify-flake-recovered` event (recovered: true only).
 */
export type FlakeRetryOutcome = { retries: 1; recovered: boolean } | undefined;

/** PR338 — validate a git SHA before shell interpolation. */
const VALID_SHA_RE = /^[0-9a-f]{40}$/;
function isValidSha(s: string | undefined) {
  return typeof s === "string" && VALID_SHA_RE.test(s);
}

/**
 * Verify the develop step's outcome by checking executed evidence
 * in each worktree. Mutates `failures` and `notes` in place. When
 * `eventsOut` is provided, #782 flake-retry events are appended to it
 * (the driver's event log — the function is otherwise pure).
 *
 * Returns the flake-retry outcome (the #782 single bounded re-run result),
 * or `undefined` when no retry ran. The caller uses this to populate
 * verifyEvidence.retries / recovered on the state file.
 */
export async function verifyDevelopOutcome(
  ctx: DriverContext,
  state: WorkState,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  failures: string[],
  notes: string[],
  eventsOut?: WorkEvent[],
): Promise<FlakeRetryOutcome> {
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
    const perWorktreeVerifyFailures: string[] = [];
    for (const cwd of changedWorktrees) {
      try {
        await execFn(cmd, { cwd, timeout: verifyTimeoutMs(), maxBuffer: 4 * 1024 * 1024 });
      } catch (err) {
        const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
        // A verify command that fails for want of `node_modules` reports the
        // same shape as one that fails on a real defect; development happens
        // in a fresh worktree, so this is the likelier of the two when it
        // matches — say so rather than implying the diff is at fault. The
        // consolidated run below decides whether this is a genuine per-
        // worktree defect (kept as a failure) or a cross-worktree artifact
        // (downgraded to evidence).
        const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
        const depsHint = looksLikeMissingDeps(output) ? provisionDepsHint(state, cwd) : "";
        perWorktreeVerifyFailures.push(
          formatExecError(
            e,
            `verify command \`${cmd}\` exceeded its ${Math.round(verifyTimeoutMs() / 60000)}-min timeout in ${cwd}`,
            `verify command \`${cmd}\` failed in ${cwd}${depsHint}`,
          ),
        );
      }
    }
    // #750 — the develop gate reads the CONSOLIDATED tree, not the isolated
    // worktrees: a per-worktree verify cannot see a file a sibling's commit
    // supplies (or deletes), and the #750 regression proves the combined
    // state is the only state worth testing. The combined tree is built from
    // every worktree that has commits ahead of baseSha, so the gate runs
    // when any committed worktree is non-trivial to consolidate — i.e. any
    // worktree with committed work exists and the root itself is not the
    // only worktree (N=1 with the root as the worktree is the combined tree).
    const consolidationNeeded = changedWorktrees.length > 0;
    // #750 — the consolidated run (which owns the dirty-root refusal at its
    // preflight) must run whenever there is ANY committed worktree: the
    // refusal fires even for the N=1 case where the only worktree is the
    // root itself, because operator residue on the root must not be swept
    // into the PR just because the combined tree is trivially the root.
    if (!consolidationNeeded || !isValidSha(baseSha)) {
      // No consolidation possible: the per-worktree results are the verdict.
      // The only reachable skip is "changed work exists but no valid baseSha"
      // (without it the combined tree cannot be built); with no changed
      // worktrees there is nothing to combine, so no note is recorded.
      failures.push(...perWorktreeVerifyFailures);
      if (consolidationNeeded && !isValidSha(baseSha)) {
        notes.push(
          "consolidated verify skipped — no valid baseSha to build the combined tree against, so the per-worktree evidence is the verdict",
        );
      }
    } else {
      const scratchDir = path.join(ctx.repoRoot, "tmp", `issue-${ctx.issue}`);
      // #782 — the flake retry fires ONLY when (a) every per-worktree verify
      // passed, (b) the consolidated run failed, (c) workstreamCount > 1.
      // N=1 is a no-op consolidation: its failure is a per-workstream defect.
      const shouldRetry =
        perWorktreeVerifyFailures.length === 0 && Object.keys(worktrees).length > 1;
      const cons = await runConsolidatedVerify(execFn, {
        repoRoot: ctx.repoRoot,
        baseSha: baseSha as string,
        worktrees: state.pipelineState.worktrees ?? {},
        scratchDir,
        verifyCmd: cmd,
        timeoutMs: verifyTimeoutMs(),
        deferRestore: shouldRetry,
      });
      if (cons.status === "conflict") {
        // #725 — "conflict" has TWO causes: a genuine cherry-pick / patch-apply
        // conflict (a decomposition error) and the repoRoot-dirty preflight
        // refusal (operator residue — #668/#714). Routed on the structured
        // `kind`, not the detail prose; a dirty root is cleared with git status.
        if (cons.kind === "dirty-root") {
          failures.push(
            `consolidated verify was refused — repoRoot is dirty (${cons.detail}). Leftover residue from an earlier cycle, NOT a workstream conflict or verify failure: run \`git status\` at the repo root, clear the residue, and re-run the cycle`,
          );
        } else {
          failures.push(
            `consolidated verify could not combine the workstreams' commits — cherry-pick / apply conflict (${cons.detail}). Two workstreams edited the same lines; the decomposition is incoherent, which is distinct from a verify failure`,
          );
        }
      } else if (cons.status === "failed" && shouldRetry && cons.deferredOriginalRef) {
        // #782 — first run failed; the precondition holds, so re-run the SAME
        // verify command ONCE on the SAME still-checked-out scratch tree, BEFORE
        // the restore (which is deferred here). Exactly one retry, never a loop.
        const retry = await retryConsolidatedVerify(execFn, {
          repoRoot: ctx.repoRoot,
          verifyCmd: cmd,
          timeoutMs: verifyTimeoutMs(),
          firstRunOutput: cons.firstRunOutput,
        });
        // The restore is the caller's responsibility here (deferredRestore).
        // The scratch tree is only safe to unwind AFTER the retry has run —
        // a re-run after restore would test the wrong tree (the mainline).
        await restoreConsolidatedVerifyRoot(execFn, {
          repoRoot: ctx.repoRoot,
          originalRef: cons.deferredOriginalRef,
          scratchDir,
        });
        if (retry.recovered) {
          // Re-run passed: this was a flake, not a consolidation-created
          // defect. Emit the audit event; the caller records
          // verifyEvidence.retries/recovered from the returned outcome.
          notes.push(
            `consolidated verify FLAKE RECOVERED — the first run failed but the single bounded re-run on the same scratch tree passed \`${cmd}\`; the driver proceeds`,
          );
          eventsOut?.push({
            kind: "verify-flake-recovered",
            at: Date.now(),
            step: "develop",
            evidenceTail: cons.firstRunOutput.slice(0, 800),
          });
          return { retries: 1, recovered: true };
        }
        // Re-run also failed — a test that fails twice is not a flake.
        // Classify the FIRST run's output (the original failure; the second
        // run's failure is the same shape, and the classifier needs the
        // asserted assertion, not the duplicate) and park as today.
        const wsIds = Object.keys(worktrees);
        const { tail, attributed } = extractAttributedTail(cons.firstRunOutput, 800);
        const classifiedDetail = tail
          ? attributed
            ? tail
            : `${tail} (unattributed — best-effort tail)`
          : "verify command exited non-zero";
        const verdict = classifyConsolidatedVerifyFailure(
          wsIds.length,
          wsIds,
          classifiedDetail,
          buildPerWorktreeFailuresByWs(worktrees, changedWorktrees, perWorktreeVerifyFailures),
        );
        failures.push(consolidatedFailureMessage(verdict, cmd));
        return { retries: 1, recovered: false };
      } else if (cons.status === "failed") {
        // #777 — classify the consolidated-tree failure (see the classifier
        // module docstring for the three-way distinction).
        const wsIds = Object.keys(worktrees);
        const verdict = classifyConsolidatedVerifyFailure(
          wsIds.length,
          wsIds,
          cons.detail,
          buildPerWorktreeFailuresByWs(worktrees, changedWorktrees, perWorktreeVerifyFailures),
        );
        failures.push(consolidatedFailureMessage(verdict, cmd));
        // The non-retry failure path (N=1, or per-worktree failures present)
        // also records retries: 0 / recovered: false on verifyEvidence so the
        // handoff can distinguish "no retry was needed" from "retry ran and
        // did not help".
      } else {
        notes.push(
          `consolidated verify passed — workstreams ${cons.applied.join(", ")} combined in one tree passed \`${cmd}\`; per-worktree verify failures are recorded as evidence, not failures, because the combined tree is the verdict for cross-worktree artifacts`,
        );
      }
      // Aggregation: a consolidated PASS downgrades per-worktree failures
      // to evidence; a consolidated FAILURE keeps them as failures.
      if (cons.status === "passed") {
        for (const f of perWorktreeVerifyFailures)
          notes.push(`per-worktree verify (evidence) — ${f}`);
      } else {
        failures.push(...perWorktreeVerifyFailures);
      }
    }
  }

  // --- Skip-ratchet gate (PR277) + product smoke gate (PR277) ---
  // #451 — extracted to work-driver-verify-develop-gates.ts (AGENTS.md §12
  // file-size cap). The #782 flake-retry logic above pushed this file past
  // the 500-line limit; the two independent post-verify gates move there.
  await runSkipRatchetGate(execFn, ctx.repoRoot, baseSha, changedWorktrees, failures, notes);
  await runSmokeGate(execFn, ctx.repoRoot, changedWorktrees, failures, notes);
  return undefined;
}
