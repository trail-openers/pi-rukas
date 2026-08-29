#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: PR17: driver-side outcome-verification gate (verifyCmdFor + verifyStepOutcome).
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { verifyCmdFor, verifyConsolidation, verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";

/**
 * The branch these fixtures put on the cycle.
 *
 * `gh pr view` is now asked for `state,headRefName`, and the gate refuses a PR
 * whose head is not this cycle's branch — existing was never proof the number
 * belonged to this cycle. A fake that reports only `state` is a pre-fix fake.
 */
const BRANCH_UNDER_TEST = "feature/issue-999";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Minimal ExtensionAPI stub — only the methods runWorkDriver actually calls.
function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

// #297 — transient retries are exercised by dedicated tests below; zero the
// inter-attempt backoff so persistent-failure tests don't sleep 5-10s per
// retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// Offline-suite safety net: a few flow tests deliberately reach the
// adversarial / lens steps without injecting a loopFn. Cap any such
// accidental live spawn at 2s so the suite stays deterministic and fast.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// PR17 — the outcome-verification gate is disabled globally here; dedicated
// gate tests re-enable it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";

// PR17 — driver-side outcome-verification gate (verifyCmdFor +
// verifyStepOutcome). These tests re-enable the gate (disabled globally
// at the top of this file) and inject verifyExecFn so no real git/gh
// runs. Types: the injected fn sees the command string and returns
// canned outputs.
{
  const prevVerify = process.env.PI_ENSEMBLE_VERIFY;
  process.env.PI_ENSEMBLE_VERIFY = "1";
  const fsSync = await import("node:fs");
  try {
    // --- verifyCmdFor discovery ---
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-cmd-"));
      try {
        // Nothing → undefined.
        assert(
          (await verifyCmdFor(dir)) === undefined,
          "verifyCmdFor: empty dir → undefined (diff-evidence-only mode)",
        );
        // package.json with test script only, no lockfile → npm run test.
        fsSync.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({ scripts: { test: "vitest run" } }),
        );
        assert(
          (await verifyCmdFor(dir)) === "npm run test",
          "verifyCmdFor: package.json test script, no lockfile → npm run test",
        );
        // typecheck preferred over test; bun lockfile → bun run.
        fsSync.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }),
        );
        fsSync.writeFileSync(path.join(dir, "bun.lock"), "");
        assert(
          (await verifyCmdFor(dir)) === "bun run typecheck",
          "verifyCmdFor: typecheck preferred over test; bun.lock → bun run",
        );
        // Explicit .pi/verify-cmd wins over everything.
        fsSync.mkdirSync(path.join(dir, ".pi"), { recursive: true });
        fsSync.writeFileSync(
          path.join(dir, ".pi", "verify-cmd"),
          "# comment line\ncargo test --workspace\n",
        );
        assert(
          (await verifyCmdFor(dir)) === "cargo test --workspace",
          "verifyCmdFor: .pi/verify-cmd wins; comments skipped",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      // Cargo.toml → cargo check.
      const rustDir = mkdtempSync(path.join(tmpdir(), "verify-cmd-rs-"));
      try {
        fsSync.writeFileSync(path.join(rustDir, "Cargo.toml"), "[package]\nname='x'\n");
        assert(
          (await verifyCmdFor(rustDir)) === "cargo check --quiet",
          "verifyCmdFor: Cargo.toml → cargo check --quiet",
        );
      } finally {
        rmSync(rustDir, { recursive: true, force: true });
      }
    }

    // --- verifyStepOutcome: develop ---
    const mkCtx = (
      repoRoot: string,
      execFn: NonNullable<DriverContext["verifyExecFn"]>,
    ): DriverContext => ({
      pi: makeFakePi().pi,
      repoRoot,
      issue: 999,
      verifyExecFn: execFn,
    });

    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-develop-"));
      try {
        // Empty diff everywhere → failure.
        let s = initialState(999, 1000);
        s = {
          ...s,
          pipelineState: { ...s.pipelineState, worktrees: { default: dir }, baseSha: "abc123" },
        };
        const emptyExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git status --porcelain") return { stdout: "" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
          return { stdout: "" };
        };
        const emptyGate = await verifyStepOutcome(mkCtx(dir, emptyExec), s, "develop");
        assert(!emptyGate.ok, "develop gate: all-empty worktrees → NOT ok");
        assert(
          emptyGate.failures.some((f) => /empty diff/.test(f)),
          "develop gate: failure names the hollow claim (empty diff)",
        );

        // Changed worktree + verify cmd passes → ok. (.pi/verify-cmd so
        // discovery finds a command; the fake exec passes it.)
        fsSync.mkdirSync(path.join(dir, ".pi"), { recursive: true });
        fsSync.writeFileSync(path.join(dir, ".pi", "verify-cmd"), "run-verify\n");
        const passExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git status --porcelain") return { stdout: " M src/foo.ts\n" };
          if (cmd === "run-verify") return { stdout: "all good" };
          return { stdout: "" };
        };
        const passGate = await verifyStepOutcome(mkCtx(dir, passExec), s, "develop");
        assert(
          passGate.ok && passGate.failures.length === 0,
          "develop gate: changed worktree + passing verify cmd → ok",
        );

        // Changed worktree + verify cmd FAILS → failure with output tail.
        const failExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git status --porcelain") return { stdout: " M src/foo.ts\n" };
          if (cmd === "run-verify") {
            const err = new Error("Command failed: run-verify") as Error & {
              stdout?: string;
              stderr?: string;
            };
            err.stdout = "";
            err.stderr = "error[E0308]: mismatched types --> src/foo.rs:42";
            throw err;
          }
          return { stdout: "" };
        };
        const failGate = await verifyStepOutcome(mkCtx(dir, failExec), s, "develop");
        assert(!failGate.ok, "develop gate: failing verify cmd → NOT ok");
        assert(
          failGate.failures.some((f) => /E0308/.test(f)),
          "develop gate: failure carries the verify-cmd output tail as evidence",
        );

        // Escape hatch.
        process.env.PI_ENSEMBLE_VERIFY = "0";
        const skipped = await verifyStepOutcome(mkCtx(dir, emptyExec), s, "develop");
        assert(
          skipped.ok && skipped.notes.some((n) => /skipped/.test(n)),
          "develop gate: PI_ENSEMBLE_VERIFY=0 → skipped with note",
        );
        process.env.PI_ENSEMBLE_VERIFY = "1";
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // --- verifyStepOutcome: commit-pr ---
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-commitpr-"));
      try {
        let s = initialState(999, 1000);
        s = {
          ...s,
          pipelineState: {
            ...s.pipelineState,
            branchName: "feature/issue-999",
            prNumber: 556,
          },
        };
        // Zero commits ahead → failure even though PR resolves.
        const zeroCommits: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
          if (cmd.startsWith("gh pr view"))
            return { stdout: JSON.stringify({ state: "OPEN", headRefName: BRANCH_UNDER_TEST }) };
          return { stdout: "" };
        };
        const zeroGate = await verifyStepOutcome(mkCtx(dir, zeroCommits), s, "commit-pr");
        assert(!zeroGate.ok, "commit-pr gate: zero commits ahead → NOT ok");
        assert(
          zeroGate.failures.some((f) => /zero commits/.test(f)),
          "commit-pr gate: failure names the missing commits",
        );

        // Commits ahead + PR resolves → ok.
        const happy: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "2\n" };
          if (cmd.startsWith("gh pr view"))
            return { stdout: JSON.stringify({ state: "OPEN", headRefName: BRANCH_UNDER_TEST }) };
          return { stdout: "" };
        };
        const happyGate = await verifyStepOutcome(mkCtx(dir, happy), s, "commit-pr");
        assert(happyGate.ok, "commit-pr gate: commits ahead + PR resolves → ok");

        // prNumber missing + gh pr list resolves → ok + adoptedPrNumber.
        let sNoPr = initialState(999, 1000);
        sNoPr = {
          ...sNoPr,
          pipelineState: { ...sNoPr.pipelineState, branchName: "feature/issue-999" },
        };
        const adopt: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "2\n" };
          if (cmd.startsWith("gh pr list")) return { stdout: "789\n" };
          if (cmd.startsWith("gh pr view"))
            return { stdout: JSON.stringify({ state: "OPEN", headRefName: BRANCH_UNDER_TEST }) };
          return { stdout: "" };
        };
        const adoptGate = await verifyStepOutcome(mkCtx(dir, adopt), sNoPr, "commit-pr");
        assert(
          adoptGate.ok && adoptGate.adoptedPrNumber === 789,
          "commit-pr gate: missing pr: marker resolved via gh pr list → adoptedPrNumber (bonus repair)",
        );

        // prNumber missing + NO PR for branch → failure.
        const noPr: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "2\n" };
          if (cmd.startsWith("gh pr list")) return { stdout: "\n" };
          return { stdout: "" };
        };
        const noPrGate = await verifyStepOutcome(mkCtx(dir, noPr), sNoPr, "commit-pr");
        assert(!noPrGate.ok, "commit-pr gate: no marker + no PR on branch → NOT ok");
        assert(
          noPrGate.failures.some((f) => /not backed by an actual PR/.test(f)),
          "commit-pr gate: failure names the hollow PR claim",
        );

        // prNumber set but gh pr view errors → failure.
        const ghosted: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "2\n" };
          if (cmd.startsWith("gh pr view")) {
            const err = new Error("gh failed") as Error & { stderr?: string };
            err.stderr = "GraphQL: Could not resolve to a PullRequest with the number of 556.";
            throw err;
          }
          return { stdout: "" };
        };
        const ghostGate = await verifyStepOutcome(mkCtx(dir, ghosted), s, "commit-pr");
        assert(!ghostGate.ok, "commit-pr gate: PR number doesn't resolve via gh → NOT ok");
        assert(
          ghostGate.failures.some((f) => /does not resolve/.test(f)),
          "commit-pr gate: failure carries the gh stderr evidence",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // --- explainCap renders the evidence ---
    {
      let s = initialState(999, 1000);
      s = {
        ...s,
        pipelineState: {
          ...s.pipelineState,
          verifyEvidence: {
            step: "develop",
            failures: ["developer claimed done but every worktree has an empty diff"],
            at: 2000,
          },
        },
      };
      const text = explainCap("verify-failed:develop", s);
      assert(
        /outcome-verification gate/.test(text) && /empty diff/.test(text),
        "explainCap verify-failed:develop: names the gate + surfaces the evidence lines",
      );
      assert(/PI_ENSEMBLE_VERIFY=0/.test(text), "explainCap verify-failed: names the escape hatch");
    }

    // --- F5 (#540): verifyConsolidation coverage rule (full-set subsumption) ---
    //
    // Coverage rule: a workstream W is COVERED iff for EVERY declared path p
    // of W: p is in the committed diff, OR p is declared by a sibling S whose
    // ENTIRE declared path set is present in the committed diff. A partial
    // sibling cannot cover another workstream's path. Cap fires iff some
    // workstream is not covered.
    //
    // These use a REAL git repo so `git diff --name-only origin/main..HEAD`
    // produces actual output (baseline commit = origin/main; committed files
    // = the feature-branch diff).
    {
      const fs = await import("node:fs/promises");
      const { exec: execChild } = await import("node:child_process");
      const { promisify: promisifyUtil } = await import("node:util");
      const execp2 = promisifyUtil(execChild);

      const mkGitRepo = async (dir: string, committedFiles: string[]) => {
        await execp2("git init -q", { cwd: dir });
        await execp2('git config user.email "t@t" && git config user.name "T"', {
          cwd: dir,
          shell: "/bin/bash",
        });
        await fs.writeFile(path.join(dir, ".gitkeep"), "\n");
        await execp2("git add . && git commit -q -m baseline", {
          cwd: dir,
          shell: "/bin/bash",
        });
        await execp2("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
        await execp2("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
          cwd: dir,
        });
        await execp2("git checkout -qb feature/issue-540-test", { cwd: dir });
        for (const f of committedFiles) {
          const fp = path.join(dir, f);
          await fs.mkdir(path.dirname(fp), { recursive: true });
          await fs.writeFile(fp, `content of ${f}\n`);
        }
        if (committedFiles.length > 0) {
          await execp2("git add . && git commit -q -m 'committed work'", {
            cwd: dir,
            shell: "/bin/bash",
          });
        }
      };

      const mkConsolidationState = (
        workstreams: Record<string, WorkState["pipelineState"]["workstreams"][string]>,
      ) => {
        let s = initialState(540, 1_000_000);
        s = {
          ...s,
          pipelineState: {
            ...s.pipelineState,
            branchName: "feature/issue-540-test",
            worktrees: Object.fromEntries(
              Object.keys(workstreams).map((id) => [id, `/tmp/fake-${id}`]),
            ),
            workstreams,
          },
        };
        return s;
      };

      const wsA = (paths: string[]) => ({ id: "a", scope: "task-a", paths, outOfScope: [] });
      const wsB = (paths: string[]) => ({ id: "b", scope: "task-b", paths, outOfScope: [] });

      // F5.1 + F5.2 — commit={a.ts,b.ts} → both covered (B's full set present,
      // A's own paths present) → no missing.
      {
        const dir = mkdtempSync(path.join(tmpdir(), "f5-covered-"));
        try {
          await mkGitRepo(dir, ["src/a.ts", "src/b.ts"]);
          const state = mkConsolidationState({
            a: wsA(["src/a.ts", "src/b.ts"]),
            b: wsB(["src/b.ts"]),
          });
          const ctx: DriverContext = { pi: makeFakePi().pi, repoRoot: dir, issue: 540 };
          const res = await verifyConsolidation(ctx, state);
          assert(
            res.missing.length === 0,
            `F5.1/F5.2: both paths committed → both covered (got: ${JSON.stringify(res.missing)})`,
          );
          assert(
            JSON.stringify(res.filesPresent.sort()) === JSON.stringify(["src/a.ts", "src/b.ts"]),
            `F5.1: filesPresent records the committed file list (got: ${JSON.stringify(res.filesPresent)})`,
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }

      // F5.3 — commit={b.ts} only: B covered (own full set present), A NOT
      // covered (a.ts absent; B's full set {b.ts} does not cover a.ts).
      // Cap fires naming A — the false-pass direction must NOT be allowed.
      {
        const dir = mkdtempSync(path.join(tmpdir(), "f5-partial-"));
        try {
          await mkGitRepo(dir, ["src/b.ts"]);
          const state = mkConsolidationState({
            a: wsA(["src/a.ts", "src/b.ts"]),
            b: wsB(["src/b.ts"]),
          });
          const ctx: DriverContext = { pi: makeFakePi().pi, repoRoot: dir, issue: 540 };
          const res = await verifyConsolidation(ctx, state);
          assert(
            res.missing.length === 1 && res.missing[0].id === "a",
            `F5.3: partial sibling cannot cover — A not covered (got: ${JSON.stringify(res.missing)})`,
          );
          assert(
            !res.missing.some((m) => m.id === "b"),
            "F5.3: B is covered (b.ts in diff) — not flagged missing",
          );
          const aVerdict = res.verdicts.find((v) => v.id === "a");
          assert(
            aVerdict?.status === "uncovered" &&
              JSON.stringify(aVerdict.uncoveredPaths) === JSON.stringify(["src/a.ts"]),
            `F5.3: A's verdict names exactly the uncovered path (got: ${JSON.stringify(aVerdict)})`,
          );
          const bVerdict = res.verdicts.find((v) => v.id === "b");
          assert(
            bVerdict?.status === "complete",
            `F5.3: B's verdict is complete (got: ${JSON.stringify(bVerdict)})`,
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }

      // F5.4 — empty diff → all workstreams missing.
      {
        const dir = mkdtempSync(path.join(tmpdir(), "f5-empty-"));
        try {
          await mkGitRepo(dir, []);
          const state = mkConsolidationState({
            a: wsA(["src/a.ts", "src/b.ts"]),
            b: wsB(["src/b.ts"]),
          });
          const ctx: DriverContext = { pi: makeFakePi().pi, repoRoot: dir, issue: 540 };
          const res = await verifyConsolidation(ctx, state);
          const ids = res.missing.map((m) => m.id).sort();
          assert(
            JSON.stringify(ids) === JSON.stringify(["a", "b"]),
            `F5.4: empty diff → all missing (got: ${JSON.stringify(ids)})`,
          );
          assert(res.filesPresent.length === 0, "F5.4: empty diff → empty filesPresent");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  } finally {
    if (prevVerify === undefined) process.env.PI_ENSEMBLE_VERIFY = undefined;
    else process.env.PI_ENSEMBLE_VERIFY = prevVerify;
    // Restore the top-of-file default for any code that runs after.
    process.env.PI_ENSEMBLE_VERIFY = "0";
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
