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

import type { CommentEvidence } from "./comment-evidence.ts";
import { COMMENT_RETENTION_PATHS } from "./comment-retention.ts";
import { DEFAULT_GIT_TIMEOUT_MS } from "./git-range.ts";
import { runConsolidatedVerify } from "./work-driver-consolidated-verify.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import {
  doctrineProsePathsIn,
  explainProtectedPaths,
  protectedPathsEnabled,
  protectedPathsIn,
} from "./work-driver-doctrine.ts";
import { runFalsilyGreenCheck } from "./work-driver-falsily-green.ts";
import { ungrantedProtectedPaths } from "./work-driver-protected-grant.ts";
import {
  changedPaths,
  readCommittedProtectedPaths,
  readProtectedStatusPaths,
  renameSourcePaths,
} from "./work-driver-protected-paths-read.ts";
import { runScopeFanoutGate } from "./work-driver-scope-fanout.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import { BASELINE_RED_MARKER } from "./work-driver-verify-baseline.ts";
import {
  declaredPathsHaveSource,
  shouldSkipVerifyForFrontendOnly,
  verifyCmdFor,
} from "./work-driver-verify-cmd.ts";
import {
  collectCommentEvidence,
  runSkipRatchetGate,
  runSmokeGate,
} from "./work-driver-verify-develop-gates.ts";
import { normaliseScopePath } from "./work-driver-verify-develop-helpers.ts";
import type { VerifyDevelopOutcomeOptions } from "./work-driver-verify-develop-options.ts";
import { fastVerifyCmdFor, withFastTier } from "./work-driver-verify-fast.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";
import { runVerifyCommandGate } from "./work-driver-verify-verify-cmd.ts";

import type { WorkState } from "./workflow-state.ts";

/** PR338 — validate a git SHA before shell interpolation. A type guard, so a
 *  caller that has checked one does not re-cast it to satisfy the diff reader. */
const VALID_SHA_RE = /^[0-9a-f]{40}$/;
function isValidSha(s: string | undefined): s is string {
  return typeof s === "string" && VALID_SHA_RE.test(s);
}

/**
 * Verify the develop step's outcome by checking executed evidence
 * in each worktree. Mutates `failures` and `notes` in place.
 */
export async function verifyDevelopOutcome(
  ctx: CycleContext,
  state: WorkState,
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  failures: string[],
  notes: string[],
  // The out-parameters that used to be trailing positional callbacks now come
  // as one options object (each field documented in
  // work-driver-verify-develop-options.ts). Behaviour is unchanged: every
  // field stays optional, `commentEvidence` still defaults to a fresh array,
  // and each is still forwarded to exactly the gate it was forwarded to.
  options: VerifyDevelopOutcomeOptions = {},
): Promise<void> {
  const {
    onVerifyFlakeRecovered,
    fenceViolations,
    onConsolidatedLogPath,
    commentEvidence = [],
    onBaselineRedOnly,
    onConsolidatedVerifySkipped,
    onBuildResidueOnly,
    walkProcessTree,
    hangSink, // #1427 r3 — per-call hang sink, threaded to the gate below
  } = options;
  const worktrees =
    Object.keys(state.pipelineState.worktrees ?? {}).length > 0
      ? (state.pipelineState.worktrees ?? {})
      : { default: ctx.repoRoot };
  const baseSha = state.pipelineState.baseSha;
  const changedWorktrees: string[] = [];
  // #948 — comment-retention paths. Overridable via env (tests inject a
  // scratch layout); defaults to the three trees the PM's check grepped.
  const commentRetentionPaths = process.env.PI_ENSEMBLE_COMMENT_RETENTION_PATHS
    ? process.env.PI_ENSEMBLE_COMMENT_RETENTION_PATHS.split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : COMMENT_RETENTION_PATHS;
  // #406 — every path the developers touched, across all worktrees, so the
  // protected-path gate below sees the whole change set rather than one
  // worktree's slice of it.
  const touchedPaths: string[] = [];
  // #1378 — the paths a rename moved AWAY from, across all worktrees. They reach
  // ONLY the protected-path check below: `touchedPaths` (above) and
  // `changedPathsByWorkstream` feed the frontend-only verify skip, the
  // falsily-green check and the #285 scope/fanout gate, none of which may see a
  // source the change no longer contains — `git mv .github/workflows/ci.yml
  // src/ci.yml` must halt, and must not classify as CSS-only.
  const protectedOnlyPaths: string[] = [];
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
  // #1012 — set to true when any per-worktree git read (status or diff) threw.
  // The frontend-only skip must not fire on a partial union: a CSS-only union
  // from the surviving worktree(s) is not evidence when one worktree's diff
  // is missing. The flag is passed to shouldSkipVerifyForFrontendOnly which
  // forces skip:false and records a note naming the incomplete union.
  let gitReadFailedAnyWorktree = false;
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
  // #1378 — resolved ONCE for the whole run: consulted in three places below, and a
  // harness that flipped the switch mid-loop would gate one worktree and not the next.
  const protectedGateOn = protectedPathsEnabled();
  for (const [id, cwd] of Object.entries(worktrees)) {
    let hasCommits = false;
    let hasUncommitted = false;
    let assessed = false;
    // #1378 — one NUL-separated read serves both consumers, and each half keeps
    // its own semantics. The protected-path gate wants BOTH sides of every rename
    // and a name that is not C-quoted (`-z`); the change-detection half (hasUncommitted,
    // `assessed`, the #679 frontend-only union) keeps the pre-fix shape exactly —
    // rename destinations only, `assessed` set only when git answered.
    // `--untracked-files=all`: without it a wholly untracked directory is one
    // `?? dir/` entry, and the protected-path gate would see a directory rather
    // than the files it contains (#1090).
    // maxBuffer: `-uall` lists every untracked file, so a large untracked set
    // exceeds 1 MiB; an overflow must not silently skip the protected-path
    // inspection of that worktree (see the fail-closed branch below).
    const status = await readProtectedStatusPaths(execFn, cwd);
    if (!status.ok) {
      // #1090 — with the protected-path gate on, an unreadable status means this
      // worktree's writes are never inspected: fail closed, do not pass with a note.
      if (protectedGateOn) {
        failures.push(
          `git status failed in worktree "${id}" (${cwd}) — its changed paths cannot be checked against the protected-path gate: ${status.unreadable}`,
        );
      } else {
        notes.push(`git status failed in ${id} (${status.unreadable.slice(0, 100)})`);
      }
      gitReadFailedAnyWorktree = true;
    } else {
      assessed = true;
      // Non-empty output is "has uncommitted work", the pre-fix `stdout.trim()`
      // test: a rename whose destination is empty string is still a change.
      if (status.paths.some((p) => p.trim().length > 0)) hasUncommitted = true;
      const ownSet = changedPathsByWorkstream.get(id);
      for (const file of status.paths) {
        // `porcelainPaths` never emitted a blank path, so the change-detection
        // union keeps only non-blank ones; blanks are the rename-pairing probe.
        if (file.trim().length === 0) continue;
        touchedPaths.push(file);
        if (ownSet) ownSet.add(normaliseScopePath(file));
      }
    }
    // #725 — diff against THIS workstream's effective base, not the cycle-
    // global baseSha: a dependent's worktree is created from its dependency's
    // post-commit SHA (#679), so a global-base diff spuriously includes the
    // dependency's files — the #607 false positive.
    const effBase = effectiveBaseFor(id);
    if (isValidSha(effBase)) {
      try {
        // Same bound as the two `-z` reads (#1378): this one used to have none, so a
        // wedged object store hung the whole develop step. Argv form like every
        // other git call here — a ref is data, never shell input — which is what
        // `test-git-range-1153.ts` requires of this file.
        const { stdout } = await execFn("git", {
          argv: ["rev-list", "--count", `${effBase}..HEAD`],
          cwd,
          maxBuffer: 64 * 1024,
          timeout: DEFAULT_GIT_TIMEOUT_MS,
        });
        if (Number.parseInt(stdout.trim(), 10) > 0) hasCommits = true;
        assessed = true;
      } catch (err) {
        // #1378 — the old `effBase !== baseSha` guard made this note conditional,
        // so the common case (`effBase === baseSha`) dropped the failure silently
        // and `assessed` stayed true on a worktree whose commits were never
        // counted. A base the code resolved that git could not read is a degraded
        // measurement either way (#384), and the flag below stops a CSS-only union
        // of the survivors skipping the verify chain.
        notes.push(
          `rev-list failed against base ${effBase} in ${id} — commit count unavailable, the worktree may be undercounted as changed (${(err as Error).message?.slice(0, 100)})`,
        );
        gitReadFailedAnyWorktree = true;
      }
      const committed = await readCommittedProtectedPaths(execFn, cwd, effBase);
      if (!committed.ok) {
        // #1378 — fail-closed on the same reasoning as the status read: a rename or
        // a C-quoted name is exactly what this read exists to catch, and a
        // `catch {}` that only set the flag let an unreadable range pass the gate
        // as "nothing protected changed". The escape hatch keeps the old behaviour.
        if (protectedGateOn) {
          failures.push(
            `git diff failed in worktree "${id}" (${cwd}) — its committed paths cannot be checked against the protected-path gate: ${committed.unreadable}`,
          );
        } else {
          notes.push(`git diff failed in ${id} (${committed.unreadable.slice(0, 100)})`);
        }
        gitReadFailedAnyWorktree = true;
      } else {
        const ownSet = changedPathsByWorkstream.get(id);
        for (const file of changedPaths(committed.targets)) {
          touchedPaths.push(file);
          if (ownSet) ownSet.add(normaliseScopePath(file));
        }
        // Rename sources stay out of the union above (#1378).
        protectedOnlyPaths.push(...renameSourcePaths(committed.targets));
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
  if (protectedGateOn) {
    // #1378 — the union carries the rename sources; the #285/#1012/#679 gates
    // above consumed `touchedPaths` alone and are byte-identical to before.
    const protectedHits = protectedPathsIn([...touchedPaths, ...protectedOnlyPaths]);
    // #1090 — only the operator's invocation grant (ctx), never the state file.
    const ungranted = ungrantedProtectedPaths(protectedHits, ctx.protectedGrant);
    if (ungranted.length > 0) {
      failures.push(explainProtectedPaths(ungranted, protectedHits, state.issues ?? [state.issue]));
    }
    const granted = protectedHits.filter((p) => !ungranted.includes(p));
    if (granted.length > 0) {
      notes.push(`operator grant (--allow-protected) admitted ${granted.join(", ")}`);
    }
    const prose = doctrineProsePathsIn([...touchedPaths, ...protectedOnlyPaths]);
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
  // #814 — the gate now also emits STRUCTURED violation records (violating
  // workstream, file, declaring sibling, kind). Fence HITS (both the
  // `sibling-declared` and `issue-fenced` kinds) BLOCK: a failure string
  // reaches `failures`, so `verifyStepOutcome` returns ok:false for the
  // whole develop step and the cycle routes through the existing
  // corrective/verify-failed path. An `undeclared` hit only warns (a note);
  // it cannot collide with a sibling. All record shapes land in
  // `verifyEvidence.fenceViolations` so the explain/handoff renderers can
  // attribute them (the #792 violations were unattributed). The records are
  // collected into the caller's `fenceViolations` array — the same reference
  // `verifyStepOutcome` passes through — so no local copy is needed here.
  runScopeFanoutGate(
    state.pipelineState.workstreams ?? {},
    changedPathsByWorkstream,
    failures,
    notes,
    fenceViolations,
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
  let verifyCmdEnd: number | undefined;
  if (!cmd) {
    notes.push(
      "no verify command discoverable (.pi/verify-cmd, package.json scripts, Cargo.toml) — diff evidence only",
    );
  } else {
    // #1012 — frontend-only diffs skip the DERIVED verify chain (package.json
    // scripts, Cargo.toml cargo check): a CSS-only change must not trigger a
    // backend build. The skip is derived-only — an explicit .pi/verify-cmd is
    // operator intent and ALWAYS runs (same philosophy as PI_ENSEMBLE_VERIFY=0:
    // explicit intent beats auto-detection). Classification uses the CUMULATIVE
    // union of all worktrees' changed paths (porcelain + diff), already
    // normalised by porcelainPaths/diff parsing; an empty union (nothing
    // readable) or any non-frontend path falls back to the full chain — a
    // classification failure never skips a check. The skip-ratchet, smoke and
    // comment-retention gates below are unaffected and run unconditionally.
    // shouldSkipVerifyForFrontendOnly (work-driver-verify-cmd.ts) uses
    // fs.access (async) to check for an explicit .pi/verify-cmd — consistent
    // with verifyCmdFor's own file-access pattern (no sync fs in this gate).
    const skipDecision = await shouldSkipVerifyForFrontendOnly(
      ctx.repoRoot,
      touchedPaths,
      gitReadFailedAnyWorktree,
    );
    if (skipDecision.skip) {
      notes.push(skipDecision.reason ?? "frontend-only skip");
    } else {
      // #1012 — a non-skip `reason` is diagnostic (git-failure suppression,
      // probe error, opt-in disabled): record it but still run the gate.
      // Only an actual skip suppresses the derived chain.
      if (skipDecision.reason) notes.push(skipDecision.reason);
      // #794 — the per-worktree loop + consolidated run + classification is
      // extracted to work-driver-verify-verify-cmd.ts (500-line gate); the
      // failure messages, the flake-retry precondition and the aggregation
      // semantics all live there unchanged.
      const before = failures.length;
      let attributed = false;
      await runVerifyCommandGate({
        // #1324 — `.pi/verify-cmd-fast` runs before every full run of `cmd`.
        execFn: withFastTier(execFn, cmd, await fastVerifyCmdFor(ctx.repoRoot)),
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
        // #814 — the fence records the gate just wrote (the scope gate runs
        // before the consolidated verify) — so a conflict the fence already
        // recorded is attributed, not re-diagnosed as an incoherent
        // decomposition.
        ...(fenceViolations !== undefined ? { fenceViolations } : {}),
        ...(onConsolidatedLogPath !== undefined ? { onConsolidatedLogPath } : {}),
        onBaselineAttributed: () => {
          attributed = true;
        },
        ...(onConsolidatedVerifySkipped !== undefined ? { onConsolidatedVerifySkipped } : {}),
        ...(onBuildResidueOnly !== undefined ? { onBuildResidueOnly } : {}),
        // #1427 — the walker reaches both legs; `hangSink` (round 3) is the
        // per-call sink this gate's reports land on, scoping a cap's logPaths.
        ...(walkProcessTree !== undefined ? { walkProcessTree } : {}),
        ...(hangSink !== undefined ? { hangSink } : {}),
      });
      // #1349 — only a base that fails the way the change does excuses it.
      verifyCmdEnd = before === 0 && attributed ? failures.length : undefined;
    }
  }

  // --- Skip-ratchet gate (PR277) + product smoke gate (PR277) ---
  // #451 — extracted to work-driver-verify-develop-gates.ts (AGENTS.md §12
  // file-size cap). The #782 flake-retry logic above pushed this file past
  // the 500-line limit; the two independent post-verify gates move there.
  // #1012 — these gates run UNCONDITIONALLY: the frontend-only skip above
  // gates only the verifyCmdFor → runVerifyCommandGate chain, never the
  // ratchet/smoke/comment-retention checks.
  await runSkipRatchetGate(execFn, ctx.repoRoot, baseSha, changedWorktrees, failures, notes);
  // #948 — comment-retention gate. Threaded like runFalsilyGreenCheck: per
  // worktree, against that workstream's effective base.
  for (const check of await collectCommentEvidence(
    execFn,
    effectiveBaseFor,
    new Map(Object.entries(worktrees)),
    commentRetentionPaths,
  )) {
    notes.push(check.note);
    commentEvidence.push(check);
  }
  await runSmokeGate(execFn, ctx.repoRoot, changedWorktrees, failures, notes);
  // The probe's marker leads the list (it is unshifted); no check before or
  // after the verify command added a failure of its own.
  if (failures.length === verifyCmdEnd && failures[0]?.startsWith(BASELINE_RED_MARKER)) {
    onBaselineRedOnly?.();
  }
  return undefined;
}
