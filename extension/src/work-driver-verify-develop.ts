/**
 * work-driver-verify-develop — develop-branch outcome verification.
 *
 * Extracted from work-driver-verify.ts (issue #338, file-size cap).
 * Checks diff evidence, verify command, skip-ratchet, and product smoke gates.
 * Import chain: work-driver-verify.ts → this file → work-driver-verify-cmd.ts
 * (acyclic). The #679 falsily-green check lives in work-driver-falsily-green.ts.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { runConsolidatedVerify } from "./work-driver-consolidated-verify.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { provisionDepsHint } from "./work-driver-deps-hint.ts";
import {
  doctrineProsePathsIn,
  explainProtectedPaths,
  porcelainPaths,
  protectedPathsEnabled,
  protectedPathsIn,
} from "./work-driver-doctrine.ts";
import { runFalsilyGreenCheck } from "./work-driver-falsily-green.ts";
import { runScopeFanoutGate } from "./work-driver-scope-fanout.ts";
import {
  TEST_BLOCK_MARKERS,
  countMarkersInDiffLine,
  countSkipMarkersInDiffLine,
} from "./work-driver-skip-ratchet.ts";
import {
  declaredPathsHaveSource,
  readFirstConfigLine,
  verifyCmdFor,
} from "./work-driver-verify-cmd.ts";
import type { WorkState } from "./workflow-state.ts";
import { looksLikeMissingDeps } from "./worktree-provision.ts";

/** #285 — normalise a scope path like git would spell it. */
function normaliseScopePath(raw: string): string {
  return raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** PR17 — bounded wall-clock for the verify command (default 10 min). */
function verifyTimeoutMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_VERIFY_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return 10 * 60_000;
}

/** PR338 — validate a git SHA before shell interpolation. */
const VALID_SHA_RE = /^[0-9a-f]{40}$/;
function isValidSha(s: string | undefined): s is string {
  return typeof s === "string" && VALID_SHA_RE.test(s);
}

/** #307 — maximum number of net-removed test blocks tolerated in a diff. */
function testDeleteTolerance(): number {
  const env = Number(process.env.PI_ENSEMBLE_TEST_DELETE_TOLERANCE);
  if (!Number.isFinite(env) || env < 0) return 0;
  return Math.floor(env);
}

/** PR338 — format an exec error with bounded output tail. */
function formatExecError(
  e: Error & { stdout?: string; stderr?: string; killed?: boolean },
  timeoutMsg: string,
  failMsg: string,
): string {
  const tail = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim().slice(-1500);
  return e.killed ? timeoutMsg : `${failMsg}: ${tail || e.message?.slice(0, 300)}`;
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
  // a live Set (the pre-fix code called `.get(id)?.add()` before any
  // `.set()`, a silent no-op), and it is never overwritten with the
  // cross-worktree cumulative `touchedPaths` union (the pre-fix post-loop
  // `.set(id, new Set(touchedPaths))` made every id's Set an identical copy
  // of the union of ALL worktrees' paths). `touchedPaths` stays cumulative
  // — the #406 protected-path gate and the diagnostics rely on it.
  const changedPathsByWorkstream = new Map<string, Set<string>>(
    Object.keys(worktrees).map((id) => [id, new Set<string>()]),
  );
  // #453 — count worktrees with uncommitted-only changes (no commits ahead
  // of baseSha). When > 0 and changedWorktrees is empty, the per-worktree
  // failures already explain the issue — skip the generic "empty diff" message.
  let uncommittedOnlyCount = 0;
  // #679 (task-evidence) — workstream ids whose declared paths are entirely
  // non-source (docs-only). EXEMPT from the "uncommitted but no commit"
  // failure (uncommitted work is a legitimate non-source deliverable) and from
  // the generic "every worktree empty" message (absence of commits is expected).
  const legitimateNonSourceWorkstreams = new Set<string>();
  // #679 (task-evidence) — per-workstream base resolution. A dependent
  // workstream's EFFECTIVE base is its dependency's post-commit SHA (persisted
  // in `workstreamBaseShas`); every other workstream falls back to the global
  // `baseSha`. The falsily-green check compares each worktree against THIS ref,
  // not always the global base, so a dependent worktree whose base ≠ the global
  // base is judged against the right ref.
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
    if (isValidSha(baseSha)) {
      try {
        const { stdout } = await execFn(`git rev-list --count ${baseSha}..HEAD`, {
          cwd,
          maxBuffer: 64 * 1024,
        });
        if (Number.parseInt(stdout.trim(), 10) > 0) hasCommits = true;
        assessed = true;
      } catch {
        // baseSha may not exist in this worktree's history — not evidence either way.
      }
      try {
        const { stdout } = await execFn(`git diff --name-only ${baseSha}..HEAD`, {
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
    // #453 — when baseSha is valid, only committed work counts: the transfer
    // unit is now a commit (cherry-picked in Step 6), not a patch. Without a
    // valid baseSha (older state files / ops-dispatch fallback) fall back to
    // the previous behaviour: uncommitted work also counts.
    const changed = isValidSha(baseSha) ? hasCommits : hasCommits || hasUncommitted;
    if (changed) changedWorktrees.push(cwd);
    // Per-worktree diagnostic: uncommitted work exists but hasn't been committed.
    // #679 (task-evidence) — a workstream whose declared paths are entirely
    // non-source (docs-only) is NOT penalised for leaving its uncommitted work
    // uncommitted: that uncommitted work IS the deliverable (a docs change),
    // and the falsily-green check below handles the source case explicitly.
    const isLegitNonSource = declaredSourceByWorkstream.get(id) === false;
    if (isValidSha(baseSha) && hasUncommitted && !hasCommits) {
      if (isLegitNonSource) {
        legitimateNonSourceWorkstreams.add(id);
        // Legitimate docs-only deliverable — no failure; the safety net will
        // still commit it driver-side so the transfer unit is a real commit.
      } else {
        uncommittedOnlyCount++;
        // #621 — the developer commits in their own worktree with their own
        // conventional-commit subject; what matters is that the work is
        // committed ahead of baseSha before the adversarial gate runs.
        failures.push(
          `worktree "${id}": has uncommitted changes but no commit ahead of baseSha — run \`git add -A && git commit -m \"<type>(scope): concise subject\"\` in the worktree before completing the develop step`,
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
  //
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
    // The consolidated run. With N=1 there is nothing to consolidate — the
    // single worktree IS the combined tree. N>1 (or the legacy default-map
    // shape where the worktree is repoRoot itself) needs a real consolidation
    // to see the combination. A worktree with no commit ahead of baseSha
    // contributes nothing to the combined tree (it cannot be cherry-picked).
    const consolidationNeeded =
      changedWorktrees.length > 1 ||
      (changedWorktrees.length === 1 && changedWorktrees[0] !== ctx.repoRoot);
    const hasNonRootWorktrees = Object.values(state.pipelineState.worktrees ?? {}).some(
      (cwd) => cwd !== ctx.repoRoot,
    );
    if (!consolidationNeeded || !isValidSha(baseSha) || !hasNonRootWorktrees) {
      // No consolidation possible: the per-worktree results are the verdict.
      failures.push(...perWorktreeVerifyFailures);
      if (consolidationNeeded) {
        notes.push(
          "consolidated verify skipped — no non-repoRoot worktrees with a valid baseSha to cherry-pick into a combined tree; per-worktree evidence is the verdict",
        );
      }
    } else {
      const cons = await runConsolidatedVerify(execFn, {
        repoRoot: ctx.repoRoot,
        baseSha: baseSha as string,
        branchName: state.pipelineState.branchName,
        worktrees: state.pipelineState.worktrees ?? {},
        scratchDir: path.join(ctx.repoRoot, "tmp", `issue-${ctx.issue}`),
        verifyCmd: cmd,
        timeoutMs: verifyTimeoutMs(),
      });
      if (cons.status === "conflict") {
        failures.push(
          `consolidated verify could not combine the workstreams' commits — cherry-pick / apply conflict (${cons.detail}). Two workstreams edited the same lines; the decomposition is incoherent, which is distinct from a verify failure`,
        );
      } else if (cons.status === "failed") {
        failures.push(
          `verify command \`${cmd}\` failed on the CONSOLIDATED tree (all workstreams' changes combined): ${cons.detail}`,
        );
      } else {
        notes.push(
          `consolidated verify passed — workstreams ${cons.applied.join(", ")} combined in one tree passed \`${cmd}\`; per-worktree verify failures are recorded as evidence, not failures, because the combined tree is the verdict for cross-worktree artifacts`,
        );
      }
      // The aggregation rule: a consolidated PASS downgrades every per-worktree
      // verify failure to evidence (cross-worktree artifacts — the #645 shape,
      // where a workstream's test reads a file only a sibling's commit
      // supplies). A consolidated FAILURE (or a conflict that prevented the
      // combined run from completing) keeps them as failures: a workstream
      // that fails alone while the combined run also fails has a genuine
      // per-worktree defect the combined verdict cannot explain away, and the
      // operator needs BOTH the per-worktree detail and the combined verdict.
      if (cons.status === "passed") {
        for (const f of perWorktreeVerifyFailures)
          notes.push(`per-worktree verify (evidence) — ${f}`);
      } else {
        failures.push(...perWorktreeVerifyFailures);
      }
    }
  }

  // --- Skip-ratchet gate (PR277) ---
  if (process.env.PI_ENSEMBLE_SKIP_RATCHET !== "0") {
    // F4: if baseSha is absent, note the weakened scope of the check
    if (!baseSha) {
      notes.push(
        "baseSha unavailable — skip-ratchet compared working tree against HEAD only; committed changes not inspected",
      );
    }

    for (const cwd of changedWorktrees) {
      let diffContent = "";
      try {
        const baseRef = isValidSha(baseSha) ? baseSha : "HEAD";
        const { stdout } = await execFn(`git diff ${baseRef} -U0`, {
          cwd,
          timeout: verifyTimeoutMs(),
          maxBuffer: 64 * 1024 * 1024,
        });
        diffContent = stdout;
      } catch (err) {
        failures.push(
          `skip-ratchet: git diff failed in ${cwd} (${(err as Error).message?.slice(0, 100)}) — cannot inspect diff`,
        );
      }
      if (!diffContent) continue;

      let netIncrease = 0;
      let netTestBlockDeletion = 0;
      const lines = diffContent.split("\n");
      for (const line of lines) {
        // Diff file headers are not source lines. Do not let a marker in a
        // filename influence either ratchet.
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+")) {
          netIncrease += countSkipMarkersInDiffLine(line);
          netTestBlockDeletion -= countMarkersInDiffLine(line, TEST_BLOCK_MARKERS);
        } else if (line.startsWith("-")) {
          netIncrease -= countSkipMarkersInDiffLine(line);
          netTestBlockDeletion += countMarkersInDiffLine(line, TEST_BLOCK_MARKERS);
        }
      }
      if (netIncrease > 0) {
        failures.push(
          `diff adds ${netIncrease} skipped-test marker(s) — a skipped test is a disabled gate`,
        );
      }
      const tolerance = testDeleteTolerance();
      if (netTestBlockDeletion > tolerance) {
        failures.push(
          `diff removes ${netTestBlockDeletion} test block(s), beyond the tolerance of ${tolerance} — a shrinking test suite is a disabled gate`,
        );
      }
    }
  } else {
    notes.push("PI_ENSEMBLE_SKIP_RATCHET=0 — skip-ratchet gate disabled");
  }

  // --- Product smoke command gate (PR277) ---
  // #451 — runs in the first changed worktree, not at ctx.repoRoot.
  // Under worktree isolation the repo root sits on mainline; running the
  // smoke there would exercise the wrong tree. The worktree has the
  // developer's changes and its provisioned dependencies.
  if (process.env.PI_ENSEMBLE_SMOKE !== "0") {
    let smokeCmd: string | undefined;
    try {
      const smokeFile = path.join(ctx.repoRoot, ".pi", "smoke-cmd");
      const content = await fs.readFile(smokeFile, "utf8");
      smokeCmd = readFirstConfigLine(content);
    } catch {
      // No smoke-cmd file — not a failure, just a note
    }
    if (smokeCmd) {
      const smokeCwd = changedWorktrees[0] ?? ctx.repoRoot;
      try {
        await execFn(smokeCmd, {
          cwd: smokeCwd,
          timeout: verifyTimeoutMs(),
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch (err) {
        const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
        failures.push(
          formatExecError(
            e,
            `smoke: command \`${smokeCmd}\` exceeded its ${Math.round(verifyTimeoutMs() / 60000)}-min timeout in ${smokeCwd}`,
            `smoke: command \`${smokeCmd}\` failed in ${smokeCwd}`,
          ),
        );
      }
    } else {
      notes.push("no .pi/smoke-cmd — product smoke not run");
    }
  } else {
    notes.push("PI_ENSEMBLE_SMOKE=0 — smoke gate disabled");
  }
}
