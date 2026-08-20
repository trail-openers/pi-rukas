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
import { countSkipMarkersInDiffLine } from "./work-driver-skip-ratchet.ts";
import { readFirstConfigLine, verifyCmdFor } from "./work-driver-verify-cmd.ts";
import type { WorkState } from "./workflow-state.ts";
import { looksLikeMissingDeps } from "./worktree-provision.ts";

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
  // PR18 (R1): track per-worktree assessability so one erroring worktree
  // doesn't suppress the hollow-diff check for all others.
  let assessedCount = 0;
  for (const [id, cwd] of Object.entries(worktrees)) {
    let changed = false;
    let assessed = false;
    try {
      const { stdout } = await execFn("git status --porcelain", {
        cwd,
        maxBuffer: 1024 * 1024,
      });
      assessed = true;
      if (stdout.trim().length > 0) changed = true;
      touchedPaths.push(...porcelainPaths(stdout));
    } catch (err) {
      notes.push(`git status failed in ${id} (${(err as Error).message?.slice(0, 100)})`);
    }
    if (isValidSha(baseSha)) {
      try {
        const { stdout } = await execFn(`git rev-list --count ${baseSha}..HEAD`, {
          cwd,
          maxBuffer: 64 * 1024,
        });
        if (Number.parseInt(stdout.trim(), 10) > 0) changed = true;
        assessed = true;
      } catch {
        // baseSha may not exist in this worktree's history — not evidence
        // either way.
      }
      // Committed work counts too: a developer that commits a workflow edit
      // rather than leaving it uncommitted must not slip past the gate.
      try {
        const { stdout } = await execFn(`git diff --name-only ${baseSha}..HEAD`, {
          cwd,
          maxBuffer: 4 * 1024 * 1024,
        });
        touchedPaths.push(...stdout.split("\n").filter((l) => l.trim().length > 0));
      } catch {
        // Same as above — an absent baseSha in this worktree is not evidence.
      }
    }
    if (assessed) assessedCount++;
    if (changed) changedWorktrees.push(cwd);
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
  if (changedWorktrees.length === 0) {
    if (assessedCount > 0) {
      failures.push(
        "developer claimed done but every assessed worktree has an empty diff (no uncommitted changes, no commits ahead of base) — the claim is not backed by any code change",
      );
    } else {
      notes.push(
        "no worktree could be assessed (git status / rev-list failed everywhere) — diff evidence unavailable, gate degrading to pass-with-note",
      );
    }
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
        const depsHint = looksLikeMissingDeps(output)
          ? " — this looks like missing dependencies in the worktree rather than a defect in the diff. Provisioning discovers `node_modules` at `repoRoot` and in depth-1 package dirs with a manifest/lockfile; if the tree is elsewhere or empty, add or fix `.pi/worktree-setup`"
          : "";
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
      const lines = diffContent.split("\n");
      for (const line of lines) {
        if (line.startsWith("+")) {
          netIncrease += countSkipMarkersInDiffLine(line);
        } else if (line.startsWith("-")) {
          netIncrease -= countSkipMarkersInDiffLine(line);
        }
      }
      if (netIncrease > 0) {
        failures.push(
          `diff adds ${netIncrease} skipped-test marker(s) — a skipped test is a disabled gate`,
        );
      }
    }
  } else {
    notes.push("PI_ENSEMBLE_SKIP_RATCHET=0 — skip-ratchet gate disabled");
  }

  // --- Product smoke command gate (PR277) ---
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
      try {
        await execFn(smokeCmd, {
          cwd: ctx.repoRoot,
          timeout: verifyTimeoutMs(),
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch (err) {
        const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
        failures.push(
          formatExecError(
            e,
            `smoke: command \`${smokeCmd}\` exceeded its ${Math.round(verifyTimeoutMs() / 60000)}-min timeout`,
            `smoke: command \`${smokeCmd}\` failed`,
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
