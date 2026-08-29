#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: PR18: gate hardening — R1 note-suppression, R6 verify-cmd precedence, R4 end-to-end cap-wiring; #285 scope/fanout.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DriverContext, nextStep } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { verifyCmdFor, verifyStepOutcome } from "../src/work-driver-verify.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { initialState, readState } from "../src/workflow-state.ts";

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

// PR11 — default issue-body fetcher for tests. runExplore's empty-body
// halt guard (PR11 §C) would otherwise fire when execp("gh issue view N")
// rejects or returns empty stdout — true for almost every test (the test
// repos don't have GitHub remotes). Tests that deliberately exercise
// the empty-body path pass their own injection; everything else gets
// this stub so the cycle proceeds to plan/branch/develop normally.
const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue} — non-empty placeholder so PR11's empty-body guard doesn't fire`,
});

// Fake DispatchResult builder.
function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub explore output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
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

// PR18 — gate hardening: R1 note-suppression fix, R6 verify-cmd
// precedence fix, R4 end-to-end cap-wiring integration tests.
{
  const prevVerify = process.env.PI_ENSEMBLE_VERIFY;
  process.env.PI_ENSEMBLE_VERIFY = "1";
  const fsSync = await import("node:fs");
  try {
    // --- R1: one worktree's git-status error must NOT suppress the
    // hollow-diff failure for the others (pre-PR18 it did — the exact
    // silent-pass class PR17 exists to kill).
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-r1-"));
      try {
        let s = initialState(998, 1000);
        s = {
          ...s,
          pipelineState: {
            ...s.pipelineState,
            worktrees: { "task-a": path.join(dir, "a"), "task-b": path.join(dir, "b") },
            baseSha: "abc123",
          },
        };
        const oneErrOneEmpty: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, opts) => {
          if (cmd === "git status --porcelain") {
            if (opts?.cwd?.endsWith("/a")) throw new Error("not a git repository");
            return { stdout: "" };
          }
          if (cmd.startsWith("git rev-list --count")) {
            if (opts?.cwd?.endsWith("/a")) throw new Error("bad revision");
            return { stdout: "0\n" };
          }
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 998,
          verifyExecFn: oneErrOneEmpty,
        };
        const gate = await verifyStepOutcome(ctx, s, "develop");
        assert(
          !gate.ok && gate.failures.some((f) => /empty diff/.test(f)),
          "R1: one worktree erroring does NOT suppress the hollow-diff failure for the assessed one",
        );
        assert(
          gate.notes.some((n) => /git status failed/.test(n)),
          "R1: the erroring worktree is still surfaced as a note",
        );

        // All worktrees unassessable → degrade to pass-with-note, no failure.
        const allErr: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git status --porcelain") throw new Error("not a git repository");
          if (cmd.startsWith("git rev-list --count")) throw new Error("bad revision");
          return { stdout: "" };
        };
        const degraded = await verifyStepOutcome({ ...ctx, verifyExecFn: allErr }, s, "develop");
        assert(
          degraded.ok && degraded.notes.some((n) => /no worktree could be assessed/.test(n)),
          "R1: ALL worktrees unassessable → degrade to pass-with-note (no evidence either way)",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // --- R6: Cargo.toml beats a bare package.json `test` script; an
    // explicit `typecheck` script still wins over Cargo.toml.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-r6-"));
      try {
        fsSync.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname='x'\n");
        fsSync.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({ scripts: { test: "node tools/docs-lint.js" } }),
        );
        assert(
          (await verifyCmdFor(dir)) === "cargo check --quiet",
          "R6: Rust repo with tooling package.json (test only) → cargo check wins",
        );
        fsSync.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({ scripts: { test: "x", typecheck: "tsc --noEmit" } }),
        );
        assert(
          (await verifyCmdFor(dir)) === "npm run typecheck",
          "R6: explicit typecheck script wins even next to Cargo.toml (intentional signal)",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // --- R4: end-to-end cap wiring. Drive the FULL runWorkDriver with
    // scripted dispatchFn + verifyExecFn and assert the gate's cap-hit,
    // evidence persistence, and handoff routing through the real state
    // machine (pre-PR18 the wiring was asserted only via explainCap text).

    // R4a — hollow develop claim → cap-hit verify-failed:develop →
    // handoff terminal.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-r4a-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const hollowExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git status --porcelain") return { stdout: "" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 991,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: hollowExec,
          dispatchFn: async (_pi, spec, opts) => {
            const label = opts?.label ?? spec.role;
            if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
            if (label === "plan") return mkResult({ text: "" });
            if (label === "ops")
              return mkResult({ role: "ops", text: "branch: feature/issue-991" });
            if (label === "developer")
              return mkResult({ role: "developer", text: "done — implemented the fix" });
            if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
            throw new Error(`unexpected dispatch: ${label}`);
          },
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 991);
        const capEvent = after?.eventLog.find(
          (e) => e.kind === "cap-hit" && e.cap === "verify-failed:develop",
        );
        assert(
          capEvent !== undefined,
          "R4a: hollow develop claim fires cap-hit verify-failed:develop through the real wiring",
        );
        assert(
          after?.pipelineState.verifyEvidence?.step === "develop" &&
            (after?.pipelineState.verifyEvidence?.failures.length ?? 0) > 0,
          "R4a: verifyEvidence persisted to the state file with the failure detail",
        );
        assert(
          after?.pipelineState.status === "handoff",
          "R4a: cycle terminal status is handoff (gate failure routed through nextStep)",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // R4b — good develop evidence passes the gate; cycle reaches
    // adversarial and (with an approving loop) commit-pr, whose gate then
    // catches a zero-commit claim.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-r4b-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git status --porcelain") return { stdout: " M src/lib.rs\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("gh pr view"))
            return { stdout: JSON.stringify({ state: "OPEN", headRefName: "feature/issue-991" }) };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 992,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: async (_pi, spec, opts) => {
            const label = opts?.label ?? spec.role;
            if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
            if (label === "plan") return mkResult({ text: "" });
            if (label === "ops")
              return mkResult({ role: "ops", text: "branch: feature/issue-992" });
            if (label === "developer")
              return mkResult({ role: "developer", text: "done — implemented" });
            if (label === "ops:commit-pr")
              return mkResult({ role: "ops", text: "Committed and pushed.\npr: 556" });
            if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
            throw new Error(`unexpected dispatch: ${label}`);
          },
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 992);
        assert(
          !after?.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "verify-failed:develop"),
          "R4b: real develop evidence passes the gate (no verify-failed:develop)",
        );
        assert(
          after?.eventLog.some((e) => e.kind === "adversarial-approved"),
          "R4b: cycle proceeded through adversarial after the develop gate",
        );
        const commitCap = after?.eventLog.find(
          (e) => e.kind === "cap-hit" && e.cap === "verify-failed:commit-pr",
        );
        assert(
          commitCap !== undefined,
          "R4b: zero-commits-ahead claim fires cap-hit verify-failed:commit-pr through the real wiring",
        );
        assert(
          after?.pipelineState.verifyEvidence?.step === "commit-pr" &&
            after?.pipelineState.verifyEvidence?.failures.some((f) => /zero commits/.test(f)),
          "R4b: commit-pr verifyEvidence persisted with the zero-commits failure",
        );
        assert(
          after?.pipelineState.status === "handoff",
          "R4b: commit-pr gate failure routes the cycle to handoff",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // R4c — pr:-marker omission repaired via gh pr list adoption; no
    // cap fires and pipelineState.prNumber is written back.
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-r4c-"));
      try {
        await (await import("node:fs/promises")).mkdir(path.join(dir, ".git", "info"), {
          recursive: true,
        });
        const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git rev-parse HEAD") return { stdout: "base123\n" };
          if (cmd === "git status --porcelain") return { stdout: " M src/lib.rs\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "2\n" };
          if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
          if (cmd.startsWith("gh pr list")) return { stdout: "789\n" };
          if (cmd.startsWith("gh pr view"))
            return { stdout: JSON.stringify({ state: "OPEN", headRefName: "feature/issue-993" }) };
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 993,
          issueBodyFetcherFn: mockIssueBodyOk,
          verifyExecFn: exec,
          adversarialLoopFn: async () =>
            mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
          dispatchFn: async (_pi, spec, opts) => {
            const label = opts?.label ?? spec.role;
            if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
            if (label === "plan") return mkResult({ text: "" });
            if (label === "ops")
              return mkResult({ role: "ops", text: "branch: feature/issue-993" });
            if (label === "developer")
              return mkResult({ role: "developer", text: "done — implemented" });
            if (label === "ops:commit-pr")
              return mkResult({ role: "ops", text: "Committed and pushed. (forgot the marker)" });
            if (label === "ops:ci") throw new Error("halt at ci: integration assertion boundary");
            if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
            throw new Error(`unexpected dispatch: ${label}`);
          },
        };
        await runWorkDriver(ctx).catch(() => {});
        const after = await readState(dir, 993);
        assert(
          !after?.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "verify-failed:commit-pr"),
          "R4c: missing pr: marker repaired via gh pr list — no verify-failed:commit-pr cap",
        );
        assert(
          after?.pipelineState.prNumber === 789,
          "R4c: adopted PR number written back to pipelineState.prNumber (bonus repair wired)",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // --- #285: deterministic develop scope/fanout gate ---
    {
      const dir = mkdtempSync(path.join(tmpdir(), "verify-scope-"));
      const previousScopeEnv = {
        gate: process.env.PI_ENSEMBLE_SCOPE_GATE,
        factor: process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR,
        minimum: process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN,
      };
      let files = ["src/private/secret.ts"];
      let committedFiles: string[] = [];
      const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
        if (cmd === "git status --porcelain") {
          return { stdout: files.map((file) => ` M ${file}`).join("\n") };
        }
        if (cmd.startsWith("git rev-list --count")) {
          return { stdout: files.length > 0 || committedFiles.length > 0 ? "1\n" : "0\n" };
        }
        if (cmd.startsWith("git diff --name-only")) {
          return { stdout: committedFiles.join("\n") };
        }
        return { stdout: "" };
      };
      const stateFor = (paths: string[], outOfScope: string[] = []) => {
        const state = initialState(998, 1000);
        return {
          ...state,
          pipelineState: {
            ...state.pipelineState,
            baseSha: "a".repeat(40),
            worktrees: { "task-a": dir },
            workstreams: { "task-a": { id: "task-a", scope: "scope test", paths, outOfScope } },
          },
        };
      };
      const ctx: DriverContext = {
        pi: makeFakePi().pi,
        repoRoot: dir,
        issue: 998,
        verifyExecFn: exec,
      };
      try {
        Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SCOPE_GATE");
        Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SCOPE_FANOUT_FACTOR");
        Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SCOPE_FANOUT_MIN");

        const outOfScope = await verifyStepOutcome(
          ctx,
          stateFor(["src/foo.ts"], ["src/private"]),
          "develop",
        );
        assert(
          !outOfScope.ok &&
            outOfScope.failures.some((failure) => /out-of-scope path src\/private/.test(failure)),
          "#285: outOfScope path prefix fails develop verification",
        );

        files = ["src/cron/wiki_state.rs", ...Array.from({ length: 10 }, (_, i) => `src/x${i}.rs`)];
        const fanout = await verifyStepOutcome(
          ctx,
          stateFor(["src/cron/wiki_state.rs"]),
          "develop",
        );
        assert(
          !fanout.ok && fanout.failures.some((failure) => /scope fanout: 11 files/.test(failure)),
          "#285: eleven changed files versus one declared path fails fanout verification",
        );

        files = [];
        committedFiles = ["src/private/committed.ts"];
        const committed = await verifyStepOutcome(
          ctx,
          stateFor(["src/foo.ts"], ["src/private"]),
          "develop",
        );
        assert(
          !committed.ok &&
            committed.failures.some((failure) =>
              /out-of-scope path src\/private\/committed/.test(failure),
            ),
          "#285: committed base diff paths are included in scope verification",
        );
        committedFiles = [];

        files = ["src/feature/new.ts"];
        assert(
          (await verifyStepOutcome(ctx, stateFor(["src/feature"]), "develop")).ok,
          "#285: a file below a declared directory path passes",
        );

        files = ["src/one.ts", "src/two.ts", "src/three.ts"];
        process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR = "1";
        process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN = "1";
        const tuned = await verifyStepOutcome(
          ctx,
          stateFor(["src/one.ts", "src/two.ts"]),
          "develop",
        );
        assert(
          !tuned.ok && tuned.failures.some((failure) => /scope fanout/.test(failure)),
          "#285: factor and minimum environment tunables are respected",
        );

        files = ["src/legacy.ts"];
        const empty = await verifyStepOutcome(ctx, stateFor([]), "develop");
        assert(
          empty.ok && empty.notes.some((note) => /scope fanout check skipped/.test(note)),
          "#285: empty declared paths skip fanout with a note",
        );

        process.env.PI_ENSEMBLE_SCOPE_GATE = "0";
        const disabled = await verifyStepOutcome(
          ctx,
          stateFor(["src/foo.ts"], ["src/private"]),
          "develop",
        );
        assert(
          disabled.ok && disabled.notes.some((note) => /PI_ENSEMBLE_SCOPE_GATE=0/.test(note)),
          "#285: scope gate kill-switch restores previous behavior",
        );
      } finally {
        if (previousScopeEnv.gate === undefined)
          Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SCOPE_GATE");
        else process.env.PI_ENSEMBLE_SCOPE_GATE = previousScopeEnv.gate;
        if (previousScopeEnv.factor === undefined)
          Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SCOPE_FANOUT_FACTOR");
        else process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR = previousScopeEnv.factor;
        if (previousScopeEnv.minimum === undefined)
          Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SCOPE_FANOUT_MIN");
        else process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN = previousScopeEnv.minimum;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    if (prevVerify === undefined) process.env.PI_ENSEMBLE_VERIFY = undefined;
    else process.env.PI_ENSEMBLE_VERIFY = prevVerify;
    process.env.PI_ENSEMBLE_VERIFY = "0";
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
