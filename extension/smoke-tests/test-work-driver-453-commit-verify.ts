#!/usr/bin/env bun
/**
 * #453 (task-a) — the developer commits in their own worktree.
 *
 * Pins the task-a surfaces of the commit-transfer model:
 *
 *  1. `verifyDevelopOutcome` requires at least one commit ahead of baseSha —
 *     an uncommitted-only worktree fails the develop gate, because the
 *     transfer unit is now a commit (cherry-picked at integration), not a
 *     patch. Invalid/absent baseSha (older state files) keeps the old
 *     uncommitted-counts behaviour.
 *  2. `fetchDiff(cwd, baseSha)` prefers the committed range
 *     `git diff baseSha..HEAD` and falls back to `git diff HEAD` for
 *     uncommitted work — so the adversarial gate keeps reviewing the real
 *     work after the developer commits (pre-#453, `git diff HEAD` was
 *     empty on a committed worktree and the gate would trivially approve).
 *  3. `runAdversarial`'s fan-out feeds the loop exactly that committed
 *     diff: after a developer commit the gate's diff is non-empty and
 *     carries the committed content (the DoD's "adversarial still reviews
 *     real work" assertion, at the fan-out level).
 *
 * Split out of test-work-driver-always-worktree.ts (500-line hard cap,
 * AGENTS.md §12; same seam kind as the #507 mechanized-commit split).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { fetchDiff } from "../src/work-driver-diff.ts";
import { verifyDevelopOutcome } from "../src/work-driver-verify-develop.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// A 40-char hex SHA that passes `isValidSha` — used to trigger the new
// commit-required path in `verifyDevelopOutcome`.
const VALID_SHA_40 = "a".repeat(40); // "aaaa..." is valid [0-9a-f]{40}

// Minimal ExtensionAPI stub.
function makeFakePi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

// Minimal approved DispatchResult for the mocked adversarial loop.
function mkApproved(): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: true,
    text: "Adversarial APPROVED after round 1.\n",
    toolUses: [],
    ms: 1,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    loopOutcome: "approved",
    roundsExecuted: 1,
    adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
  };
}

// Fixture: a real repo with a detached worktree at the base commit and a
// committed developer change — the exact shape /work produces post-#453.
async function mkCommittedWorktree(): Promise<{ root: string; wt: string; baseSha: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ens-453-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await execFileP("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileP("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "base.txt"), "base\n");
  await execFileP("git", ["-C", repo, "add", "base.txt"]);
  await execFileP("git", ["-C", repo, "commit", "-q", "-m", "base"]);
  const { stdout: baseShaRaw } = await execFileP("git", ["-C", repo, "rev-parse", "HEAD"]);
  const baseSha = baseShaRaw.trim();
  const wt = path.join(root, "wt");
  await execFileP("git", ["-C", repo, "worktree", "add", "-q", "--detach", wt, "HEAD"]);
  // Developer makes a commit in the worktree.
  writeFileSync(path.join(wt, "change.txt"), "developer work\n");
  await execFileP("git", ["-C", wt, "add", "change.txt"]);
  await execFileP("git", ["-C", wt, "commit", "-q", "-m", "feat(#453): default — test"]);
  return { root, wt, baseSha };
}

// --------------------- #453: commit-required verify gate (unit tests) ------

// Minimal DriverContext for verifyDevelopOutcome: no verify cmd, no smoke cmd.
// verifyCmdFor uses the repoRoot to look for .pi/verify-cmd etc.; an empty
// temp dir yields `undefined` (diff-evidence-only mode).
{
  const tmpDir = mkdtempSync(path.join(tmpdir(), "verify-commit-"));
  try {
    const mkCtx = (execFn: NonNullable<DriverContext["verifyExecFn"]>): DriverContext =>
      ({
        pi: makeFakePi(),
        issue: 453,
        repoRoot: tmpDir,
        verifyExecFn: execFn,
      }) as unknown as DriverContext;

    // Uncommitted-only worktree with a valid baseSha → must fail.
    {
      let s = initialState(453, 1000);
      s = {
        ...s,
        pipelineState: {
          ...s.pipelineState,
          worktrees: { default: tmpDir },
          baseSha: VALID_SHA_40,
        },
      };
      const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
        if (cmd === "git status --porcelain") return { stdout: " M src/foo.ts\n" };
        if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
        return { stdout: "" };
      };
      const failures: string[] = [];
      const notes: string[] = [];
      await verifyDevelopOutcome(mkCtx(execFn), s, execFn, failures, notes);
      const uncommittedFailure = failures.find((f) => /uncommitted changes but no commit/.test(f));
      assert(
        Boolean(uncommittedFailure),
        "#453 verify: uncommitted-only worktree with valid baseSha fails with 'no commit' message",
      );
      // #621 (AC3) — the error message is actionable: it tells the developer
      // the exact commands to run, and does not reference a phantom
      // "driver-required message format" that never existed.
      assert(
        uncommittedFailure !== undefined && uncommittedFailure.includes("git add -A && git commit"),
        "#621 verify error message: names the exact `git add -A && git commit` fix",
      );
      assert(
        uncommittedFailure !== undefined &&
          !uncommittedFailure.includes("driver-required message format"),
        "#621 verify error message: no longer references a phantom 'driver-required message format'",
      );
      assert(
        !failures.some((f) => /empty diff/.test(f)),
        "#453 verify: uncommitted-only failure does NOT also emit the generic 'empty diff' message",
      );
    }

    // Committed worktree (clean tree, rev-list > 0) → passes the diff gate.
    {
      let s = initialState(453, 1000);
      s = {
        ...s,
        pipelineState: {
          ...s.pipelineState,
          worktrees: { default: tmpDir },
          baseSha: VALID_SHA_40,
        },
      };
      const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
        if (cmd === "git status --porcelain") return { stdout: "" }; // clean tree
        if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" }; // 1 commit
        if (cmd.startsWith("git diff --name-only")) return { stdout: "src/foo.ts\n" };
        return { stdout: "" };
      };
      const failures: string[] = [];
      const notes: string[] = [];
      await verifyDevelopOutcome(mkCtx(execFn), s, execFn, failures, notes);
      assert(
        failures.length === 0,
        `#453 verify: committed worktree with valid baseSha passes diff gate (failures: ${failures.join("; ")})`,
      );
    }

    // Fallback: invalid baseSha (old state files) → uncommitted still counts.
    {
      let s = initialState(453, 1000);
      s = {
        ...s,
        pipelineState: {
          ...s.pipelineState,
          worktrees: { default: tmpDir },
          baseSha: "abc123", // too short → isValidSha returns false
        },
      };
      const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
        if (cmd === "git status --porcelain") return { stdout: " M src/foo.ts\n" };
        return { stdout: "" };
      };
      const failures: string[] = [];
      const notes: string[] = [];
      await verifyDevelopOutcome(mkCtx(execFn), s, execFn, failures, notes);
      assert(
        failures.length === 0,
        "#453 verify: invalid baseSha (old state file) — uncommitted work still passes (backwards compat)",
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --------------------- #453: fetchDiff with baseSha (live git) --------------

async function mainFetchDiffBaseSha(): Promise<void> {
  const { root, wt, baseSha } = await mkCommittedWorktree();
  try {
    // fetchDiff with baseSha → shows committed diff (non-empty).
    const withBase = await fetchDiff(wt, baseSha);
    assert(
      withBase.includes("developer work"),
      "#453 fetchDiff(wt, baseSha): returns committed diff when baseSha provided",
    );

    // fetchDiff without baseSha → git diff HEAD, which is empty (tree is clean).
    const withoutBase = await fetchDiff(wt);
    assert(
      withoutBase === "",
      "#453 fetchDiff(wt) without baseSha: clean tree returns empty (committed work not shown)",
    );

    // fetchDiff with baseSha but uncommitted changes → committed range wins.
    writeFileSync(path.join(wt, "extra.txt"), "uncommitted\n");
    const withExtraUncommitted = await fetchDiff(wt, baseSha);
    // baseSha..HEAD has content (the commit), so that path wins — extra.txt
    // (uncommitted) is NOT in the diff.
    assert(
      withExtraUncommitted.includes("developer work") &&
        !withExtraUncommitted.includes("extra.txt"),
      "#453 fetchDiff(wt, baseSha): committed diff wins over uncommitted when both present",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --------------------- #453: adversarial reviews the committed work ---------
//
// DoD shape: after a developer commit, the diff the adversarial gate is
// fed is non-empty and matches the committed content. The fan-out builds
// it via `fetchDiff(cwd, baseSha)`; the mocked loop records what it got.

async function mainAdversarialCommittedDiff(): Promise<void> {
  const { root, wt, baseSha } = await mkCommittedWorktree();
  try {
    const s = initialState(453, 1000);
    s.pipelineState = {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: { default: wt },
      baseSha,
      workstreams: {
        default: { id: "default", scope: "test", paths: [], outOfScope: [] },
      },
    };

    let seenDiff: string | undefined;
    const ctx = {
      pi: makeFakePi(),
      repoRoot: root,
      issue: 453,
      adversarialLoopFn: async (params: { diff?: string }) => {
        seenDiff = params.diff;
        return mkApproved();
      },
    } as unknown as DriverContext;

    const out = await runAdversarial(ctx, s, Date.now());
    assert(
      (seenDiff ?? "").includes("developer work"),
      "#453 adversarial: after the developer commit, the gate's diff is non-empty and carries the committed content",
    );
    assert(
      out.eventLog.some((e) => e.kind === "adversarial-approved"),
      "#453 adversarial: committed work flows to an adversarial-approved aggregate (not an empty-diff skip)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------- #679 (task-evidence): falsily-green evidence check -----------
//
// A workstream whose declared paths are source but which produced ZERO commits
// ahead of its base AND no source changes is falsely green → records ok:false
// (a per-worktree failure). A genuine docs-only workstream (declared paths are
// entirely non-source, e.g. docs/*.md) is NOT penalised, even with zero commits.
async function mainFalsilyGreen(): Promise<void> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "verify-fg-"));
  try {
    // A JS project (package.json present) so the classifier is manifest-aware
    // and classifies .ts/.js as source and .md as non-source.
    writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));

    const mkCtx = (execFn: NonNullable<DriverContext["verifyExecFn"]>): DriverContext =>
      ({
        pi: makeFakePi(),
        issue: 679,
        repoRoot: tmpDir,
        verifyExecFn: execFn,
      }) as unknown as DriverContext;

    const run = async (opts: {
      worktrees: Record<string, string>;
      workstreams: Record<
        string,
        { id: string; scope: string; paths: string[]; outOfScope: string[] }
      >;
      execFn: NonNullable<DriverContext["verifyExecFn"]>;
      baseSha?: string;
    }) => {
      let s = initialState(679, 1000);
      s = {
        ...s,
        pipelineState: {
          ...s.pipelineState,
          worktrees: opts.worktrees,
          workstreams: opts.workstreams,
          baseSha: opts.baseSha ?? VALID_SHA_40,
        },
      };
      const failures: string[] = [];
      const notes: string[] = [];
      await verifyDevelopOutcome(mkCtx(opts.execFn), s, opts.execFn, failures, notes);
      return { failures, notes };
    };

    // (1) Falsely green: declared source paths, uncommitted non-source work,
    // zero commits ahead of base. The developer declared source but only did
    // docs — falsely green.
    {
      const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
        if (cmd === "git status --porcelain")
          return { stdout: " M docs/notes.md\n" }; // uncommitted docs
        if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" }; // no commits
        if (cmd.startsWith("git diff --name-only")) return { stdout: "" }; // no committed changes
        return { stdout: "" };
      };
      const { failures } = await run({
        worktrees: { "task-src": tmpDir },
        workstreams: {
          "task-src": {
            id: "task-src",
            scope: "add feature",
            paths: ["src/foo.ts"],
            outOfScope: [],
          },
        },
        execFn,
      });
      assert(
        failures.some((f) => /falsely green/.test(f)),
        `#679 falsily-green: source-declared workstream with uncommitted non-source work + zero commits fails (failures: ${failures.join("; ")})`,
      );
    }

    // (1b) Completely empty workstream (clean tree, 0 commits, source-declared)
    // is the EXISTING "empty diff" case, NOT falsely-green — the developer
    // produced nothing at all, which the generic empty-diff message catches.
    {
      const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
        if (cmd === "git status --porcelain") return { stdout: "" }; // clean tree
        if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" }; // no commits
        if (cmd.startsWith("git diff --name-only")) return { stdout: "" };
        return { stdout: "" };
      };
      const { failures } = await run({
        worktrees: { "task-empty": tmpDir },
        workstreams: {
          "task-empty": {
            id: "task-empty",
            scope: "add feature",
            paths: ["src/foo.ts"],
            outOfScope: [],
          },
        },
        execFn,
      });
      assert(
        !failures.some((f) => /falsely green/.test(f)),
        `#679 falsily-green: completely empty workstream is NOT falsely-green (failures: ${failures.join("; ")})`,
      );
      assert(
        failures.some((f) => /empty diff/.test(f)),
        `#679 falsily-green: completely empty workstream gets the generic empty-diff message (failures: ${failures.join("; ")})`,
      );
    }

    // (2) Docs-only workstream: declared paths are non-source → NOT penalised
    // as falsely green. A genuine docs-only workstream may have uncommitted doc
    // changes (legitimate non-source deliverable) and zero commits ahead of base;
    // neither the falsily-green check nor the generic empty-diff message should
    // fire against it.
    {
      const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
        if (cmd === "git status --porcelain") return { stdout: " M docs/guide.md\n" }; // uncommitted doc
        if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" }; // no commits
        if (cmd.startsWith("git diff --name-only")) return { stdout: "" };
        return { stdout: "" };
      };
      const { failures } = await run({
        worktrees: { "task-docs": tmpDir },
        workstreams: {
          "task-docs": {
            id: "task-docs",
            scope: "write docs",
            paths: ["docs/guide.md"],
            outOfScope: [],
          },
        },
        execFn,
      });
      assert(
        !failures.some((f) => /falsely green/.test(f)),
        `#679 falsily-green: docs-only workstream (declared non-source) is NOT penalised (failures: ${failures.join("; ")})`,
      );
      assert(
        !failures.some((f) => /uncommitted changes but no commit/.test(f)),
        `#679 falsily-green: docs-only workstream with uncommitted docs is not flagged as uncommitted-only (failures: ${failures.join("; ")})`,
      );
      assert(
        !failures.some((f) => /empty diff/.test(f)),
        `#679 falsily-green: docs-only workstream does NOT trigger the generic empty-diff message (failures: ${failures.join("; ")})`,
      );
    }

    // (3) Source workstream that DID commit → not falsely green.
    {
      const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
        if (cmd === "git status --porcelain") return { stdout: "" };
        if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" }; // 1 commit
        if (cmd.startsWith("git diff --name-only")) return { stdout: "src/foo.ts\n" };
        return { stdout: "" };
      };
      const { failures } = await run({
        worktrees: { "task-ok": tmpDir },
        workstreams: {
          "task-ok": { id: "task-ok", scope: "add feature", paths: ["src/foo.ts"], outOfScope: [] },
        },
        execFn,
      });
      assert(
        !failures.some((f) => /falsely green/.test(f)),
        `#679 falsily-green: source workstream with a real source commit is not penalised (failures: ${failures.join("; ")})`,
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

await mainFetchDiffBaseSha();
await mainAdversarialCommittedDiff();
await mainFalsilyGreen();

console.log(`\nexit ${exit}`);
process.exit(exit);
