#!/usr/bin/env bun
/**
 * #861 — (7) the `integration-worktree-violation` cap in explainCap, in
 * the recovery renderer, and accepted by the validator (the cap union +
 * CAP_HIT_FIXED_LITERALS live in the source and are covered by the full
 * gate; this asserts the two renderers).
 *
 * Split out of test-work-driver-integrate-pin-realgit.ts for the AGENTS.md
 * §12 500-line smoke-test cap (the #861 scenarios 8 + 9 pushed it over).
 */
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { explainCap } from "../src/work-driver-explain.ts";
import { recoveryStepsForCap } from "../src/work-driver-handoff-recovery.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const git = (cwd: string, args: string[]) => promisify(execFile)("git", args, { cwd });

  // =====================================================================
  // (5b) repoRootHoldsBranch error-class discrimination (#861): the probe
  // runs REAL git, and "cannot answer" and "holds the branch" have opposite
  // consequences. A directory that is NOT a repository must read as not
  // holding (a non-repo cannot hold a branch — the #861 spurious-violation
  // shape: the fallback audit probed a temp repoRoot that is not a repo and
  // the old fail-closed default read it as the offending holder). A real
  // repo on the branch → true; a real repo detached → false. A GENUINE git
  // error (lock/permission) is not simulated here: making `symbolic-ref`
  // fail on a real repo without also making `git status` fail is not
  // possible (both probe the same repo), and a chmod-000 .git would still
  // let git read it (git opens .git by path; it does not follow the
  // directory's own permission bits for its own .git). The other-error
  // fail-closed branch IS covered at the audit level by (8) in
  // test-work-driver-integrate-pin-realgit.ts with a simulated failing
  // exec, and the ENOENT shape (the directory is gone) takes the
  // same not-a-repo path as the non-repo case.
  // =====================================================================
  {
    const prefix = mkdtempSync(path.join(tmpdir(), "861-holds-"));
    try {
      const nonRepo = path.join(prefix, "not-a-repo");
      mkdirSync(nonRepo);
      writeFileSync(path.join(nonRepo, "x.txt"), "x\n");
      const { repoRootHoldsBranch } = await import("../src/work-driver-integrate-worktree.ts");
      assert(
        (await repoRootHoldsBranch(nonRepo, "feature/issue-1-any")) === false,
        "a NON-REPO directory reads as NOT holding the branch (not fail-closed true)",
      );
      const repo = path.join(prefix, "repo");
      mkdirSync(repo);
      writeFileSync(path.join(repo, "shared.txt"), "line1\n");
      await git(repo, ["init", "-q", "--initial-branch=main"]);
      await git(repo, ["config", "user.email", "t@example.com"]);
      await git(repo, ["config", "user.name", "T"]);
      await git(repo, ["add", "shared.txt"]);
      await git(repo, ["commit", "-q", "-m", "base"]);
      const { stdout: baseSha } = await git(repo, ["rev-parse", "HEAD"]);
      const branch1 = "feature/issue-1-holds";
      await git(repo, ["checkout", "-q", "-B", branch1]);
      assert(
        (await repoRootHoldsBranch(repo, branch1)) === true,
        "a REAL repo ON the branch reads as holding it",
      );
      await git(repo, ["checkout", "--detach", "-q", baseSha.trim()]);
      assert(
        (await repoRootHoldsBranch(repo, branch1)) === false,
        "a REAL repo DETACHED (clean) reads as NOT holding the branch",
      );
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  }

  // =====================================================================
  // (7) The cap in explainCap + recovery renderer + validator.
  // =====================================================================
  {
    const state: WorkState = {
      schemaVersion: 1,
      resumable: false,
      issue: 1,
      startedAt: 1,
      updatedAt: 2,
      pipelineState: {
        currentStep: "handoff",
        inFlightJobIds: [],
        worktrees: {},
        reviewRound: 0,
        ciRetryCount: 0,
        plumbReports: [],
        status: "handoff",
        branchName: "feature/issue-1",
      },
      eventLog: [
        {
          kind: "cap-hit",
          at: 3,
          cap: "integration-worktree-violation",
          evidence:
            "holder: /x/.worktrees/issue-2-task-a (integration branch feature/issue-1; expected holder /x/.worktrees/issue-1-integrate)",
          reviewRound: 0,
          nextStep: "handoff",
        },
      ],
    };
    const explained = explainCap("integration-worktree-violation", state);
    assert(
      /wrong tree|NOT the driver-owned integrate worktree/i.test(explained),
      "explainCap renders a defined sentence for integration-worktree-violation",
    );
    const recovery = recoveryStepsForCap(state, "github");
    const section = recovery.steps.find((s) => s.section === "integration-worktree-violation");
    assert(
      section !== undefined,
      "recoveryStepsForCap renders an integration-worktree-violation section",
    );
    // The validator accepts the cap (it is in CAP_HIT_FIXED_LITERALS).
    const findings = validateDiscriminants(state);
    assert(
      !findings.some((f) => /integration-worktree-violation/.test(f)),
      "the validator accepts integration-worktree-violation (no unknown-value finding)",
    );
  }

console.log(`\nexit ${exit}`);
process.exit(exit);
