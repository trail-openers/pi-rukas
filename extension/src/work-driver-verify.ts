/**
 * work-driver-verify — driver-side outcome-verification gate.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Checks
 * EXECUTED evidence (git status, verify command, skip-ratchet, product
 * smoke, PR existence) rather than trusting an agent's "done" claim.
 * Used by runDevelop and runCommitPr (still in work-driver.ts / moving to
 * work-driver-commit.ts) as a post-dispatch safety gate.
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { countSkipMarkersInDiffLine } from "./work-driver-skip-ratchet.ts";
import type { WorkState } from "./workflow-state.ts";

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
  try {
    const { stdout } = await execp(
      "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'",
      { cwd: ctx.repoRoot, shell: "/bin/bash" },
    );
    if (stdout.trim()) base = stdout.trim();
  } catch {
    // Use 'main' default.
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
    const anyPresent = ws.paths.some((p) =>
      Array.from(changedFiles).some((f) => f === p || f.startsWith(`${p}/`)),
    );
    if (!anyPresent) {
      missing.push({ id, paths: ws.paths });
    }
  }
  return { missing };
}

/**
 * PR17 — Discover the project's verify command (typecheck/test) for the
 * driver-side outcome-verification gate.
 *
 * Precedence (PR18/R6 shape):
 *   1. `.pi/verify-cmd` file at the target repo root — first non-empty,
 *      non-comment line is the command verbatim. The explicit escape
 *      valve for projects whose gate isn't derivable.
 *   2. `package.json` `typecheck` script — an intentional project-level
 *      signal; wins even next to a Cargo.toml. Runner detected from
 *      lockfile: bun.lock(b) → bun, pnpm-lock.yaml → pnpm, yarn.lock →
 *      yarn, else npm.
 *   3. `Cargo.toml` → `cargo check --quiet`. Beats a bare package.json
 *      `test` script — a Rust repo with a tooling package.json (docs
 *      build, hooks) must not run `npm run test` as its gate.
 *   4. `package.json` `test` script (non-Rust repos only).
 *   5. Nothing found → undefined; the gate skips command verification
 *      and checks diff/commit/PR evidence only (note emitted).
 */
export async function verifyCmdFor(repoRoot: string): Promise<string | undefined> {
  const has = async (f: string) =>
    fs
      .access(path.join(repoRoot, f))
      .then(() => true)
      .catch(() => false);
  try {
    const raw = await fs.readFile(path.join(repoRoot, ".pi", "verify-cmd"), "utf8");
    const line = raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#"));
    if (line) return line;
  } catch {
    // No explicit file — try derivation.
  }
  // PR18 (R6 fix) — Cargo.toml wins over package.json UNLESS package.json
  // has an explicit `typecheck` script. Pre-PR18 package.json won
  // unconditionally, so a Rust repo with any tooling package.json (docs
  // build, git hooks, frontend fragment) discovered `npm run test`
  // instead of `cargo check` and ran the wrong build in every worktree —
  // guaranteed spurious verify-failures on Rust projects. A `typecheck`
  // script is treated as an intentional project-level signal; a bare
  // `test` script next to a Cargo.toml is almost always tooling.
  const isRust = await has("Cargo.toml");
  try {
    const pkgRaw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.typecheck
      ? "typecheck"
      : !isRust && pkg.scripts?.test
        ? "test"
        : undefined;
    if (script) {
      let runner = "npm run";
      if ((await has("bun.lock")) || (await has("bun.lockb"))) runner = "bun run";
      else if (await has("pnpm-lock.yaml")) runner = "pnpm run";
      else if (await has("yarn.lock")) runner = "yarn";
      return `${runner} ${script}`;
    }
  } catch {
    // No package.json or malformed — fall through.
  }
  if (isRust) return "cargo check --quiet";
  return undefined;
}

/** PR17 — bounded wall-clock for the verify command (default 10 min). */
function verifyTimeoutMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_VERIFY_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return 10 * 60_000;
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
 *   develop —
 *     (a) at least one worktree has real changes (uncommitted porcelain
 *         entries, or commits ahead of baseSha when the developer
 *         committed locally). ALL worktrees empty = the claim was
 *         hollow.
 *     (b) the project's verify command (verifyCmdFor) exits 0 in each
 *         changed worktree. Non-zero exit = broken build/tests would
 *         have burned adversarial+lens+CI cycles downstream.
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
    const worktrees =
      Object.keys(state.pipelineState.worktrees ?? {}).length > 0
        ? (state.pipelineState.worktrees ?? {})
        : { default: ctx.repoRoot };
    const baseSha = state.pipelineState.baseSha;
    const changedWorktrees: string[] = [];
    // PR18 (R1 fix) — track whether each worktree was actually ASSESSABLE
    // (git status or rev-list gave a definitive answer). Pre-PR18 the
    // hollow-diff failure was suppressed whenever notes was non-empty —
    // one worktree's git-status error (e.g., a mis-parsed worktree path)
    // silently disabled the check for ALL worktrees, letting a hollow
    // develop claim pass. Now: fail on zero changed worktrees whenever
    // at least ONE worktree was assessed; degrade to a note only when
    // NO worktree could be assessed at all (no evidence either way).
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
      } catch (err) {
        notes.push(`git status failed in ${id} (${(err as Error).message?.slice(0, 100)})`);
      }
      if (!changed && baseSha) {
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
      }
      if (assessed) assessedCount++;
      if (changed) changedWorktrees.push(cwd);
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
          const tail = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim().slice(-1500);
          failures.push(
            e.killed
              ? `verify command \`${cmd}\` exceeded its ${Math.round(verifyTimeoutMs() / 60000)}-min timeout in ${cwd}`
              : `verify command \`${cmd}\` failed in ${cwd}: ${tail || e.message?.slice(0, 300)}`,
          );
        }
      }
    }

    // --- Skip-ratchet gate (PR277) ---
    // Counts net increase in test skip markers to prevent disabling gates.
    // Excludes comments, strings, and documentation to avoid false positives.
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
          const { stdout } = await execFn(`git diff ${baseSha ?? "HEAD"} -U0`, {
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
        const firstLine = content
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !l.startsWith("#"));
        smokeCmd = firstLine;
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
          const tail = `${e.stdout ?? ""}
${e.stderr ?? ""}`
            .trim()
            .slice(-1500);
          failures.push(
            e.killed
              ? `smoke: command \`${smokeCmd}\` exceeded its ${Math.round(verifyTimeoutMs() / 60000)}-min timeout`
              : `smoke: command \`${smokeCmd}\` failed: ${tail || e.message?.slice(0, 300)}`,
          );
        }
      } else {
        notes.push("no .pi/smoke-cmd — product smoke not run");
      }
    } else {
      notes.push("PI_ENSEMBLE_SMOKE=0 — smoke gate disabled");
    }

    return { ok: failures.length === 0, failures, notes };
  }

  // step === "commit-pr"
  let base = "main";
  try {
    const { stdout } = await execFn(
      "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'",
      { cwd: ctx.repoRoot, shell: "/bin/bash" },
    );
    if (stdout.trim()) base = stdout.trim();
  } catch {
    // Use 'main' default.
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
    try {
      await execFn(`gh pr view ${prToCheck} --json state`, {
        cwd: ctx.repoRoot,
        maxBuffer: 256 * 1024,
      });
    } catch (err) {
      const e = err as Error & { stderr?: string };
      failures.push(
        `PR #${prToCheck} does not resolve via \`gh pr view\`: ${(e.stderr ?? e.message ?? "").slice(0, 200)}`,
      );
    }
  }
  return { ok: failures.length === 0, failures, notes, adoptedPrNumber };
}
