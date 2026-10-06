#!/usr/bin/env bun
/**
 * #279 — the two acceptance criteria the branch shipped without.
 *
 * `test-invariant-scan.ts` proves the scanner classifies diffs, and
 * `test-verify-full.ts` proves the tier's helpers behave. Neither proves the
 * features are WIRED: that scanner findings actually reach the lens, and that
 * a failing verify-full actually suppresses the ops dispatch. Those are the
 * claims the issue makes, and until now nothing checked them.
 *
 * Both run against `runLens` / `runCi` directly with injected seams — no Pi
 * child is spawned.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runLens } from "../src/work-driver-lens.ts";
import { runCi } from "../src/work-driver-stepback-ci.ts";
import { initialState } from "../src/workflow-state.ts";
import { mkLensSummary } from "./test-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-279-"));
const worktree = path.join(root, ".worktrees", "issue-279-default");
mkdirSync(worktree, { recursive: true });

/**
 * `runLens` resolves its diff through `fetchAllMergedDiffs`, which shells out
 * with raw `execp` and has no injection seam — so the only way to prove the
 * scanner's findings reach the lens is to give the driver a REAL repository
 * whose real diff contains the widening. Local bare "origin", no network.
 */
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
const originDir = path.join(root, "origin.git");
const repo = path.join(root, "repo");
execFileSync("git", ["init", "--bare", "--initial-branch=main", originDir], { stdio: "pipe" });
execFileSync("git", ["init", "--initial-branch=main", repo], { stdio: "pipe" });
git(repo, ["config", "user.email", "t@example.com"]);
git(repo, ["config", "user.name", "T"]);
mkdirSync(path.join(repo, "src"), { recursive: true });
writeFileSync(path.join(repo, "src", "lib.rs"), "struct S {\n    embedder: EmbeddingEngine,\n}\n");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "base"]);
git(repo, ["remote", "add", "origin", originDir]);
git(repo, ["push", "-q", "-u", "origin", "main"]);
// The vipune ea8c836 shape, as a real commit on a real branch.
git(repo, ["checkout", "-q", "-b", "feature/issue-279"]);
writeFileSync(
  path.join(repo, "src", "lib.rs"),
  "struct S {\n    embedder: Option<EmbeddingEngine>,\n}\n",
);
git(repo, ["commit", "-qam", "widen"]);
git(repo, ["push", "-q", "-u", "origin", "feature/issue-279"]);

function baseState() {
  const s = initialState(279);
  s.pipelineState.worktrees = { default: worktree };
  s.pipelineState.branchName = "feature/issue-279-ci-sentinel";
  return s;
}

/** State pointing at the real repo, for the lens cases. */
function lensState() {
  const s = initialState(279);
  s.pipelineState.worktrees = { default: repo };
  s.pipelineState.branchName = "feature/issue-279";
  return s;
}

// biome-ignore lint/suspicious/noExplicitAny: only the fields under test matter
const fakePi = { sendUserMessage: () => undefined } as any;

try {
  // ============================ AC: findings provably reach the lens context

  {
    let seenContext = "";
    const ctx = {
      pi: fakePi,
      repoRoot: repo,
      issue: 279,
      lensReviewFn: async (args: { context: string }) => {
        seenContext = args.context;
        return mkLensSummary("APPROVED");
      },
      // biome-ignore lint/suspicious/noExplicitAny: partial context is sufficient
    } as any as DriverContext;

    const out = await runLens(ctx, lensState(), Date.now());

    assert(
      /MANDATE: the ARCHITECTURE lens must answer/.test(seenContext),
      "the framing mandate reaches the lens context verbatim",
    );
    assert(/option-widening-rust/.test(seenContext), "the finding's kind reaches the lens context");
    assert(
      /src\/lib\.rs/.test(seenContext),
      "the finding names the file so the lens can locate it",
    );
    const ev = out.eventLog.find((e) => e.kind === "widening-scan");
    assert(ev !== undefined, "a widening-scan event is emitted for audit");
    assert(
      ev?.kind === "widening-scan" && ev.findings.length > 0,
      "the audit event carries the findings, not just a flag",
    );
  }

  {
    // Route-only: a widening must never fail the cycle by itself.
    const ctx = {
      pi: fakePi,
      repoRoot: repo,
      issue: 279,
      lensReviewFn: async () => mkLensSummary("APPROVED"),
      // biome-ignore lint/suspicious/noExplicitAny: partial context is sufficient
    } as any as DriverContext;
    const out = await runLens(ctx, lensState(), Date.now());
    assert(
      out.eventLog.some((e) => e.kind === "lens-approved"),
      "a widening finding is ROUTE-ONLY — it does not block an otherwise-approved review",
    );
  }

  {
    // The kill-switch has to restore the previous behaviour exactly.
    const prev = process.env.PI_ENSEMBLE_WIDENING_SCAN;
    process.env.PI_ENSEMBLE_WIDENING_SCAN = "0";
    try {
      let seenContext = "";
      const ctx = {
        pi: fakePi,
        repoRoot: repo,
        issue: 279,
        lensReviewFn: async (args: { context: string }) => {
          seenContext = args.context;
          return mkLensSummary("APPROVED");
        },
        // biome-ignore lint/suspicious/noExplicitAny: partial context is sufficient
      } as any as DriverContext;
      const out = await runLens(ctx, lensState(), Date.now());
      assert(
        !/MANDATE/.test(seenContext),
        "PI_ENSEMBLE_WIDENING_SCAN=0 keeps the mandate out of the lens context",
      );
      assert(
        !out.eventLog.some((e) => e.kind === "widening-scan"),
        "and emits no widening-scan event",
      );
    } finally {
      if (prev === undefined) delete process.env.PI_ENSEMBLE_WIDENING_SCAN;
      else process.env.PI_ENSEMBLE_WIDENING_SCAN = prev;
    }
  }

  // ================================= AC: verify-full gates the ops dispatch

  function ciCtx(execImpl: (cmd: string, o?: { cwd?: string }) => Promise<{ stdout: string }>) {
    const dispatches: string[] = [];
    const prompts: string[] = [];
    const execCalls: Array<{ cmd: string; cwd?: string }> = [];
    const ctx = {
      pi: fakePi,
      repoRoot: root,
      issue: 279,
      verifyExecFn: async (cmd: string, o?: { cwd?: string }) => {
        execCalls.push({ cmd, cwd: o?.cwd });
        return execImpl(cmd, o);
      },
      dispatchFn: async (_pi: unknown, spec: { prompt: string }) => {
        dispatches.push("ops:ci");
        prompts.push(spec.prompt);
        return {
          role: "ops",
          ok: true,
          text: "ci-status: success",
          toolUses: [],
          ms: 1,
          exitCode: 0,
        };
      },
      // biome-ignore lint/suspicious/noExplicitAny: partial context is sufficient
    } as any as DriverContext;
    return { ctx, dispatches, prompts, execCalls };
  }

  {
    // Absent config → skipped, and VISIBLY so. A silent skip is the "fast
    // green, full unrun" failure this tier exists to make impossible.
    const { ctx, dispatches, prompts } = ciCtx(async () => ({ stdout: "" }));
    const out = await runCi(ctx, baseState(), Date.now());
    const ev = out.eventLog.find((e) => e.kind === "verify-full-status");
    assert(
      ev?.kind === "verify-full-status" && ev.status === "skipped",
      "no .pi/verify-cmd-full → verify-full-status: skipped (visible, not silent)",
    );
    assert(dispatches.length === 1, "and the ops CI watch still runs");
    assert(
      prompts[0]?.includes("feature/issue-279-ci-sentinel") && !prompts[0]?.includes("<branch>"),
      "#284: CI prompt carries the captured branch name and no placeholder",
    );

    const missingBranch = baseState();
    missingBranch.pipelineState.branchName = undefined;
    const missing = ciCtx(async () => ({ stdout: "" }));
    await runCi(missing.ctx, missingBranch, Date.now());
    assert(
      missing.prompts[0]?.includes(
        "branch not captured — discover via `git branch --show-current`",
      ) && !missing.prompts[0]?.includes("<branch>"),
      "#284: missing branch is an explicit discovery instruction, not a placeholder",
    );
  }

  // From here on the config file exists.
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(path.join(root, ".pi", "verify-cmd-full"), "cargo test --workspace\n");

  {
    const { ctx, dispatches, execCalls } = ciCtx(async (cmd) => {
      if (cmd === "cargo test --workspace") return { stdout: "test result: ok. 42 passed" };
      return { stdout: "" };
    });
    const out = await runCi(ctx, baseState(), Date.now());
    const ev = out.eventLog.find((e) => e.kind === "verify-full-status");
    assert(
      ev?.kind === "verify-full-status" && ev.status === "success",
      "green full suite → verify-full-status: success",
    );
    assert(dispatches.length === 1, "and the normal ops CI watch proceeds");

    // The addendum's hazard: under parallel groups repoRoot may sit on a
    // DIFFERENT group's branch by ci time, so testing there tests the wrong
    // code. This is the assertion the addendum explicitly asks for.
    const full = execCalls.find((c) => c.cmd === "cargo test --workspace");
    assert(full?.cwd === worktree, "verify-full executes in the group's WORKTREE");
    assert(
      !execCalls.some((c) => c.cmd === "cargo test --workspace" && c.cwd === root),
      "no verify-full invocation has cwd === repoRoot (addendum requirement)",
    );
  }

  {
    const before = baseState();
    const { ctx, dispatches } = ciCtx(async (cmd) => {
      if (cmd === "cargo test --workspace") throw new Error("test result: FAILED. 3 failed");
      return { stdout: "" };
    });
    const out = await runCi(ctx, before, Date.now());
    const ev = out.eventLog.find((e) => e.kind === "verify-full-status");
    assert(
      ev?.kind === "verify-full-status" && ev.status === "failure",
      "failing full suite → verify-full-status: failure",
    );
    assert(
      dispatches.length === 0,
      "and the ops dispatch is SKIPPED that round — the whole point of the gate",
    );
    assert(
      (out.pipelineState.ciRetryCount ?? 0) === (before.pipelineState.ciRetryCount ?? 0) + 1,
      "ciRetryCount is bumped so the existing ci-retry cap governs the loop",
    );
    assert(
      ev?.kind === "verify-full-status" && /FAILED/.test(ev.evidenceTail ?? ""),
      "the failure carries evidence, so the handoff can show fast and full separately",
    );
  }

  {
    const prev = process.env.PI_ENSEMBLE_VERIFY_FULL;
    process.env.PI_ENSEMBLE_VERIFY_FULL = "0";
    try {
      const { ctx, dispatches, execCalls } = ciCtx(async () => {
        throw new Error("must not run");
      });
      const out = await runCi(ctx, baseState(), Date.now());
      assert(
        !out.eventLog.some((e) => e.kind === "verify-full-status"),
        "PI_ENSEMBLE_VERIFY_FULL=0 emits no verify-full event at all",
      );
      assert(
        !execCalls.some((c) => c.cmd === "cargo test --workspace"),
        "and never executes the full command",
      );
      assert(dispatches.length === 1, "and the ops CI watch runs as it did pre-#279");
    } finally {
      if (prev === undefined) delete process.env.PI_ENSEMBLE_VERIFY_FULL;
      else process.env.PI_ENSEMBLE_VERIFY_FULL = prev;
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
