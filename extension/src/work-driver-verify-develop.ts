/**
 * work-driver-verify-develop — develop-branch outcome verification.
 *
 * Extracted from work-driver-verify.ts (issue #338, file-size cap).
 * Checks diff evidence, verify command, skip-ratchet, and product smoke gates.
 * Import chain: work-driver-verify.ts → this file → work-driver-verify-cmd.ts (acyclic).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { DriverContext } from "./work-driver-context.ts";
import {
  doctrineProsePathsIn,
  explainProtectedPaths,
  porcelainPaths,
  protectedPathsEnabled,
  protectedPathsIn,
} from "./work-driver-doctrine.ts";
import { couplesTo, isTestPath } from "./work-driver-plan-paths.ts";
import {
  TEST_BLOCK_MARKERS,
  countMarkersInDiffLine,
  countSkipMarkersInDiffLine,
} from "./work-driver-skip-ratchet.ts";
import { readFirstConfigLine, verifyCmdFor } from "./work-driver-verify-cmd.ts";
import type { WorktreeProvisionedEvent } from "./workflow-state-events-provision.ts";
import type { WorkState } from "./workflow-state.ts";
import { looksLikeMissingDeps } from "./worktree-provision.ts";

/** #285 — escape hatch for the deterministic develop scope/fanout gate. */
function scopeGateEnabled(): boolean {
  const value = process.env.PI_ENSEMBLE_SCOPE_GATE;
  return value !== "0" && value !== "false";
}

/** #285 — normalise a scope path like git would spell it. */
function normaliseScopePath(raw: string): string {
  return raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** #285 — check whether a file path matches a declared scope path. */
function matchesScopePath(file: string, declared: string): boolean {
  return file === declared || file.startsWith(`${declared}/`);
}

/** #285 — maximum changed files allowed per declared path, by default. */
function scopeFanoutFactor(): number {
  const value = Number(process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR);
  if (!Number.isFinite(value) || value < 0) return 3;
  return value;
}

/** #285 — minimum changed files that trigger a fanout failure. */
function scopeFanoutMinimum(): number {
  const value = Number(process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN);
  if (!Number.isFinite(value) || value < 0) return 6;
  return Math.floor(value);
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
 * Build a missing-deps hint message tailored to what the provisioner
 * actually did for this worktree, using the `worktree-provisioned` event
 * the branch step emitted. Falls back to the generic hint when no event
 * exists (e.g. the branch step predates this event).
 */
function provisionDepsHint(state: WorkState, cwd: string): string {
  const event = state.eventLog
    .filter((e): e is WorktreeProvisionedEvent => e.kind === "worktree-provisioned")
    .find((e) => e.worktreePath === cwd);
  if (!event) {
    return (
      " — this looks like missing dependencies in the worktree rather than a defect" +
      " in the diff. Provisioning discovers `node_modules` at `repoRoot` and in" +
      " depth-1 package dirs with a manifest/lockfile; if the tree is elsewhere or" +
      " empty, add or fix `.pi/worktree-setup`"
    );
  }
  switch (event.outcome) {
    case "hook-ran":
      return (
        " — provisioning ran via `.pi/worktree-setup` (hook succeeded) but" +
        " dependencies are still missing; the hook may not install all needed packages"
      );
    case "hook-failed":
      return ` — the \`.pi/worktree-setup\` hook failed during provisioning${event.problem ? `: ${event.problem.slice(0, 200)}` : ""} — fix the hook and re-run`;
    case "symlink":
      return (
        " — provisioning symlinked dependency directories but the needed package may" +
        " not be present in the symlinked tree; check the symlink targets with" +
        " `ls -la` in the worktree"
      );
    case "none":
      return ` — provisioning found no usable dependency directory to link${event.problem ? ` (${event.problem.slice(0, 200)})` : ""}; add or fix \`.pi/worktree-setup\``;
    case "ops-fallback-unprovisioned":
      return (
        " — the ops-dispatch branch-step fallback was used and does not run" +
        " `provisionWorktree`; the worktree contains only tracked files." +
        " Run `.pi/worktree-setup` manually in the worktree, or fix the SSH/env" +
        " issue that caused the mechanized branch step to fall back"
      );
    default:
      // Cross-version state file: outcome value written by a newer build.
      // Return the generic hint rather than falling off the end and returning
      // undefined, which would corrupt the failure message.
      return (
        " — this looks like missing dependencies in the worktree rather than a defect" +
        " in the diff. Provisioning discovers `node_modules` at `repoRoot` and in" +
        " depth-1 package dirs with a manifest/lockfile; if the tree is elsewhere or" +
        " empty, add or fix `.pi/worktree-setup`"
      );
  }
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
  // PR18 (R1): track per-worktree assessability so one erroring worktree
  // doesn't suppress the hollow-diff check for all others.
  // #285 — per-worktree changed-paths map for scope/fanout gate.
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
  // of baseSha). When this is > 0 and changedWorktrees is empty, the
  // per-worktree failures already explain the issue — skip the generic
  // "empty diff" message to avoid duplicate / contradictory output.
  let uncommittedOnlyCount = 0;
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
        // baseSha may not exist in this worktree's history — not evidence
        // either way.
      }
      // Collect committed path names for the protected-path gate.
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
    // Collect committed path names for the protected-path gate.
    // Note: touchedPaths already has status paths; this adds committed paths.
    // #453 — when baseSha is valid, only committed work counts: the transfer
    // unit is now a commit (cherry-picked in Step 6), not a patch.
    // Without a valid baseSha (older state files / ops-dispatch fallback)
    // fall back to the previous behaviour: uncommitted work also counts.
    const changed = isValidSha(baseSha) ? hasCommits : hasCommits || hasUncommitted;
    if (changed) changedWorktrees.push(cwd);
    // Per-worktree diagnostic: uncommitted work exists but hasn't been committed.
    if (isValidSha(baseSha) && hasUncommitted && !hasCommits) {
      uncommittedOnlyCount++;
      failures.push(
        // #621 — actionable text: the driver no longer prescribes a commit
        // message format (the developer commits in their own worktree with
        // their own conventional-commit subject); what matters is that the
        // work is committed ahead of baseSha before the adversarial gate
        // runs. The old wording referenced a message format that never
        // existed — the developer's own subject is fine.
        `worktree "${id}": has uncommitted changes but no commit ahead of baseSha — run \`git add -A && git commit -m \"<type>(scope): concise subject\"\` in the worktree before completing the develop step`,
      );
    }
  }

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

  // --- Scope/fanout gate (#285) ---
  //
  // This is intentionally separate from the hollow-diff check: a changed
  // worktree can prove that a developer wrote code while still showing that
  // the workstream's decomposition was too broad. An empty paths list has no
  // declared boundary to measure, so preserve legacy/default behaviour and
  // report the skipped check instead of inventing one.
  if (!scopeGateEnabled()) {
    notes.push("PI_ENSEMBLE_SCOPE_GATE=0 — develop scope/fanout gate disabled");
  } else {
    // #672 (sub-defect 2) — the FENCE's permitted set is the union of ALL
    // workstreams' declared paths in this plan, not just the current
    // workstream's slice: a file legitimately owned by sibling B must not
    // fail workstream A's undeclared-path check when A's worktree picked it
    // up. Two things deliberately do NOT widen:
    //   - the workstream's OWN `outOfScope` fence (an explicit do-not-touch
    //     entry is a conflict the gate must catch even when a sibling
    //     declares the same file), and
    //   - the fanout DENOMINATOR (stays the workstream's own declared count
    //     — widening it would raise how many files a single workstream may
    //     touch, which the ticket forbids).
    const workstreams = state.pipelineState.workstreams ?? {};
    const planDeclaredPaths = new Set<string>();
    for (const ws of Object.values(workstreams)) {
      for (const p of ws?.paths ?? []) {
        const n = normaliseScopePath(p);
        if (n.length > 0) planDeclaredPaths.add(n);
      }
    }
    for (const [id, changedPaths] of changedPathsByWorkstream) {
      const workstream = workstreams[id];
      const declaredPaths = (workstream?.paths ?? [])
        .map(normaliseScopePath)
        .filter((p) => p.length > 0);
      const outOfScope = (workstream?.outOfScope ?? [])
        .map(normaliseScopePath)
        .filter((p) => p.length > 0);
      const changedFiles = [...changedPaths].sort();
      const outOfScopeHits = changedFiles.filter((file) =>
        outOfScope.some((declared) => matchesScopePath(file, declared)),
      );
      for (const file of outOfScopeHits) {
        failures.push(`developer touched out-of-scope path ${file} — declared fence violated`);
      }
      if (declaredPaths.length === 0) {
        notes.push(`scope fanout check skipped for ${id} — workstream has no declared paths`);
        continue;
      }
      const limit = Math.max(declaredPaths.length * scopeFanoutFactor(), scopeFanoutMinimum());
      // #672 (sub-defect 3) — the test-file exception: a changed path that
      // matches the existing `isTestPath` convention is fence-permitted when
      // its INFERRED SUBJECT (via `couplesTo`) is in the plan-wide declared
      // set. Inference-gated, not a blanket test-path exemption: an
      // unrelated `test-bar.ts` whose stem names nothing declared still fails.
      // The exception counts the file as declared for the fanout check —
      // a test legitimately asked for alongside a declared subject must not
      // inflate the changed-file count.
      const isDeclaredOrExempt = (file: string): boolean =>
        declaredPaths.some((declared) => matchesScopePath(file, declared)) ||
        [...planDeclaredPaths].some((declared) => matchesScopePath(file, declared)) ||
        (isTestPath(file) &&
          [...planDeclaredPaths].some(
            (declared) => !isTestPath(declared) && couplesTo(file, declared),
          ));
      const undeclaredFiles = changedFiles.filter((file) => !isDeclaredOrExempt(file));
      if (changedFiles.length > limit) {
        const listedFiles = (undeclaredFiles.length > 0 ? undeclaredFiles : changedFiles).join(
          ", ",
        );
        failures.push(
          `scope fanout: ${changedFiles.length} files changed vs ${declaredPaths.length} declared — likely mis-decomposition; split the work or update the plan. Files: ${listedFiles}`,
        );
      }
    }
  }

  if (changedWorktrees.length === 0) {
    if (assessedCount > 0 && uncommittedOnlyCount === 0) {
      // No uncommitted-only failures: every worktree is genuinely empty.
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
  // (b) verify command in each changed worktree.
  const cmd = await verifyCmdFor(ctx.repoRoot);
  if (!cmd) {
    notes.push(
      "no verify command discoverable (.pi/verify-cmd, package.json scripts, Cargo.toml) — diff evidence only",
    );
  } else {
    for (const cwd of changedWorktrees) {
      try {
        await execFn(cmd, {
          cwd,
          timeout: verifyTimeoutMs(),
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch (err) {
        const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
        // A verify command that fails for want of `node_modules` reports the
        // same shape as one that fails on a real defect, and the operator reads
        // the second. Development happens in a fresh worktree, so this is the
        // likelier of the two when it matches — say so rather than implying the
        // diff is at fault.
        const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
        const depsHint = looksLikeMissingDeps(output) ? provisionDepsHint(state, cwd) : "";
        failures.push(
          formatExecError(
            e,
            `verify command \`${cmd}\` exceeded its ${Math.round(verifyTimeoutMs() / 60000)}-min timeout in ${cwd}`,
            `verify command \`${cmd}\` failed in ${cwd}${depsHint}`,
          ),
        );
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
