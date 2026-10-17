#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: PR18: gate hardening — R1 note-suppression, R6 verify-cmd precedence;
 * #285 scope/fanout. (R4 end-to-end cap-wiring split out to
 * test-work-driver-verify-cap-wiring.ts for the file-size cap.)
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
import { commandOf } from "./lib/argv-shell.ts";
import {
  isNulDiffRead,
  isNulStatusRead,
  nulNameStatus,
  nulStatus,
} from "./lib/nul-porcelain.ts";

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
          cmd = commandOf(cmd, opts);
          if (isNulStatusRead(cmd)) {
            if (opts?.cwd?.endsWith("/a")) throw new Error("not a git repository");
            return { stdout: "" };
          }
          if (cmd.includes("rev-parse --verify --end-of-options origin/"))
            return { stdout: "a".repeat(40) + "\n" };
          if (cmd.startsWith("git rev-list --count")) {
            if (opts?.cwd?.endsWith("/a")) throw new Error("bad revision");
            return { stdout: "0\n" };
          }
          return { stdout: "" };
        };
        const ctx: DriverContext = {
          host: makeFakePi().pi,
          repoRoot: dir,
          issue: 998,
          verifyExecFn: oneErrOneEmpty,
        };
        const gate = await verifyStepOutcome(ctx, s, "develop");
        assert(
          !gate.ok && gate.failures.some((f) => /empty diff/.test(f)),
          "R1: one worktree erroring does NOT suppress the hollow-diff failure for the assessed one",
        );
        // #1090 — with the protected-path gate on, an unreadable status fails
        // closed (its writes cannot be inspected), naming the worktree.
        assert(
          gate.failures.some((f) => /git status failed in worktree "task-a"/.test(f)),
          "R1: the erroring worktree is surfaced as a failure naming it (gate on)",
        );

        // #1378 — the committed read fails closed on the same reasoning. Before this
        // change its `catch {}` only set a flag, so an unreadable range passed the
        // protected-path gate as "nothing protected changed".
        {
          const diffErr: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
            const line = commandOf(cmd, o);
            if (isNulStatusRead(line)) return { stdout: "" };
            if (line.includes("rev-parse --verify --end-of-options origin/"))
              return { stdout: "a".repeat(40) + "\n" };
            // A 40-hex base is the only form the committed read accepts (isValidSha).
            if (line.startsWith("git rev-list --count")) return { stdout: "1\n" };
            if (isNulDiffRead(line)) throw new Error("stdout maxBuffer length exceeded");
            return { stdout: "" };
          };
          const diffState = {
            ...s,
            pipelineState: { ...s.pipelineState, baseSha: "a".repeat(40) },
          };
          const diffGate = await verifyStepOutcome(
            { ...ctx, verifyExecFn: diffErr },
            diffState,
            "develop",
          );
          assert(
            diffGate.failures.some(
              (f) => /git diff failed in worktree "task-a"/.test(f) && f.includes("maxBuffer"),
            ),
            "R1/#1378: an unreadable committed-diff read fails develop naming the worktree (gate on)",
          );
          process.env.PI_ENSEMBLE_PROTECTED_PATHS = "0";
          try {
            const diffNote = await verifyStepOutcome(
              { ...ctx, verifyExecFn: diffErr },
              diffState,
              "develop",
            );
            assert(
              !diffNote.failures.some((f) => /git diff failed/.test(f)) &&
                diffNote.notes.some((n) => /git diff failed in task-a/.test(n)),
              "R1/#1378: PI_ENSEMBLE_PROTECTED_PATHS=0 makes the unreadable committed read a note",
            );
          } finally {
            delete process.env.PI_ENSEMBLE_PROTECTED_PATHS;
          }
        }

        // All worktrees unassessable → degrade to pass-with-note, no failure.
        const allErr: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, stubOpts) => {
          cmd = commandOf(cmd, stubOpts);
          if (isNulStatusRead(cmd)) throw new Error("not a git repository");
          if (cmd.includes("rev-parse --verify --end-of-options origin/"))
            return { stdout: "a".repeat(40) + "\n" };
          if (cmd.startsWith("git rev-list --count")) throw new Error("bad revision");
          return { stdout: "" };
        };
        const degraded = await verifyStepOutcome({ ...ctx, verifyExecFn: allErr }, s, "develop");
        assert(
          !degraded.ok && degraded.failures.some((f) => /git status failed in worktree/.test(f)),
          "R1: ALL worktrees unreadable → fails closed on the protected-path gate (gate on)",
        );
        process.env.PI_ENSEMBLE_PROTECTED_PATHS = "0";
        try {
          const passNote = await verifyStepOutcome({ ...ctx, verifyExecFn: allErr }, s, "develop");
          assert(
            passNote.ok && passNote.notes.some((n) => /no worktree could be assessed/.test(n)),
            "R1: ALL worktrees unassessable → degrade to pass-with-note when the gate is off",
          );
        } finally {
          delete process.env.PI_ENSEMBLE_PROTECTED_PATHS;
        }
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
      const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, stubOpts) => {
        cmd = commandOf(cmd, stubOpts);
        if (isNulStatusRead(cmd)) {
          return { stdout: nulStatus(...files.map((file) => ` M ${file}`)) };
        }
        if (cmd.includes("rev-parse --verify --end-of-options origin/"))
          return { stdout: "a".repeat(40) + "\n" };
        if (cmd.startsWith("git rev-list --count")) {
          return { stdout: files.length > 0 || committedFiles.length > 0 ? "1\n" : "0\n" };
        }
        if (isNulDiffRead(cmd)) {
          return { stdout: nulNameStatus(...committedFiles) };
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
        host: makeFakePi().pi,
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
          !fanout.ok && fanout.failures.some((f) => /scope fanout: 10 undeclared/.test(f)),
          "#285/#724: ten undeclared changed files versus one declared path fails fanout verification",
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
        files = [
          "src/one.ts",
          "src/two.ts",
          ...Array.from({ length: 8 }, (_, i) => `src/rogue${i}.ts`),
        ];
        process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR = "1";
        process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN = "1";
        const tuned = await verifyStepOutcome(
          ctx,
          stateFor(["src/one.ts", "src/two.ts"]),
          "develop",
        );
        assert(
          !tuned.ok && tuned.failures.some((f) => /scope fanout: 8 undeclared/.test(f)),
          "#285: factor and minimum environment tunables are respected (limit max(2*1,1)=2, 8>2)",
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
    if (prevVerify === undefined) delete process.env.PI_ENSEMBLE_VERIFY;
    else process.env.PI_ENSEMBLE_VERIFY = prevVerify;
    process.env.PI_ENSEMBLE_VERIFY = "0";
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
