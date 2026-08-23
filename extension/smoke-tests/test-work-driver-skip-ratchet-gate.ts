#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: PR277 — skip-ratchet + smoke-cmd gates. Inject verifyExecFn to
 * return canned diff output with skip-marker patterns, canned smoke-cmd
 * file content, and canned issue bodies. Verifies the verify-failed:develop
 * cap fires with correct evidence and env vars disable checks with notes.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
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

{
  const prevVerify = process.env.PI_ENSEMBLE_VERIFY;
  process.env.PI_ENSEMBLE_VERIFY = "1";

  try {
    // PR277 — skip-ratchet + smoke-cmd gates. Inject verifyExecFn to
    // return canned diff output with skip-marker patterns, canned
    // smoke-cmd file content, and canned issue bodies. Verify the
    // verify-failed:develop cap fires with correct evidence and env vars
    // disable checks with notes.
    {
      const prevSkipRatchet = process.env.PI_ENSEMBLE_SKIP_RATCHET;
      const prevSmoke = process.env.PI_ENSEMBLE_SMOKE;
      const fsSync = await import("node:fs");
      process.env.PI_ENSEMBLE_SKIP_RATCHET = "1";
      process.env.PI_ENSEMBLE_SMOKE = "1";
      try {
        // --- Skip-ratchet: net increase of markers fails gate ---
        {
          const dir = mkdtempSync(path.join(tmpdir(), "pr277-skip-"));
          try {
            fsSync.mkdirSync(path.join(dir, ".pi"), { recursive: true });
            fsSync.writeFileSync(path.join(dir, ".pi", "verify-cmd"), "echo ok\n");
            let s = initialState(1000, 1001);
            s = {
              ...s,
              pipelineState: {
                ...s.pipelineState,
                worktrees: { default: dir },
                baseSha: "abc123",
              },
            };
            const execWithSkipMarkers: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
              if (cmd === "git status --porcelain") return { stdout: "M src/test.ts\n" };
              if (cmd.includes("verify-cmd")) return { stdout: "ok\n" };
              if (cmd.startsWith("git diff")) {
                return {
                  stdout: '+#[ignore]\n+it.skip("test1");\n+test.skip("test2");\n',
                };
              }
              return { stdout: "" };
            };
            const ctx: DriverContext = {
              pi: makeFakePi().pi,
              repoRoot: dir,
              issue: 1000,
              issueBodyFetcherFn: () => ({ stdout: "mock body without exemption" }),
              verifyExecFn: execWithSkipMarkers,
            };
            const gate = await verifyStepOutcome(ctx, s, "develop");
            const markerFail = gate.failures.find((f) => /skip.*marker/.test(f));
            assert(
              !gate.ok && markerFail !== undefined && markerFail.includes("3"),
              "PR277: net increase of skip markers fails gate with correct count",
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }

        // --- Skip-ratchet: net zero (addition + removal) passes gate ---
        {
          const dir = mkdtempSync(path.join(tmpdir(), "pr277-decrease-"));
          try {
            fsSync.mkdirSync(path.join(dir, ".pi"), { recursive: true });
            fsSync.writeFileSync(path.join(dir, ".pi", "verify-cmd"), "echo ok\n");
            let s = initialState(1002, 1003);
            s = {
              ...s,
              pipelineState: {
                ...s.pipelineState,
                worktrees: { default: dir },
                baseSha: "abc123",
              },
            };
            // Diff has one addition and one removal, netting to zero — exercises the net-delta arithmetic
            const execWithNetZeroMarkers: NonNullable<DriverContext["verifyExecFn"]> = async (
              cmd,
            ) => {
              if (cmd === "git status --porcelain") return { stdout: "M src/test.ts\n" };
              if (cmd.includes("verify-cmd")) return { stdout: "ok\n" };
              if (cmd.startsWith("git diff")) {
                return { stdout: '+it.skip("new");\n-#[ignore]\n' };
              }
              return { stdout: "" };
            };
            const ctx: DriverContext = {
              pi: makeFakePi().pi,
              repoRoot: dir,
              issue: 1002,
              issueBodyFetcherFn: () => ({ stdout: "replacing skips" }),
              verifyExecFn: execWithNetZeroMarkers,
            };
            const gate = await verifyStepOutcome(ctx, s, "develop");
            assert(
              gate.ok && !gate.failures.some((f) => /skip.*marker/.test(f)),
              "PR277: net-zero markers (addition + removal) pass gate — net-delta arithmetic is exercised",
            );
            // Also verify net-negative (more removals than additions) does not fail
            const execWithNetNegative: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
              if (cmd === "git status --porcelain") return { stdout: "M src/test.ts\n" };
              if (cmd.includes("verify-cmd")) return { stdout: "ok\n" };
              if (cmd.startsWith("git diff")) {
                return { stdout: '+it.skip("new");\n-#[ignore]\n-it.skip("old");\n' };
              }
              return { stdout: "" };
            };
            const ctxNegative: DriverContext = {
              pi: makeFakePi().pi,
              repoRoot: dir,
              issue: 1002,
              issueBodyFetcherFn: () => ({ stdout: "removing more skips" }),
              verifyExecFn: execWithNetNegative,
            };
            const gateNegative = await verifyStepOutcome(ctxNegative, s, "develop");
            assert(
              gateNegative.ok && !gateNegative.failures.some((f) => /skip.*marker/.test(f)),
              "PR277: net-negative markers (more removals) do not produce marker failure",
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }

        // --- Skip-ratchet: comments, strings, and template literals are excluded ---
        {
          const dir = mkdtempSync(path.join(tmpdir(), "pr277-false-positive-"));
          try {
            fsSync.mkdirSync(path.join(dir, ".pi"), { recursive: true });
            fsSync.writeFileSync(path.join(dir, ".pi", "verify-cmd"), "echo ok\n");
            let s = initialState(1003, 1004);
            s = {
              ...s,
              pipelineState: {
                ...s.pipelineState,
                worktrees: { default: dir },
                baseSha: "abc123",
              },
            };
            const execWithFalsePositives: NonNullable<DriverContext["verifyExecFn"]> = async (
              cmd,
            ) => {
              if (cmd === "git status --porcelain") return { stdout: "M src/docs.ts\n" };
              if (cmd.includes("verify-cmd")) return { stdout: "ok\n" };
              if (cmd.startsWith("git diff")) {
                return {
                  stdout: `+// TODO: convert to it.skip\n+console.log('it.skip(')\n+\`it.skip("test")\`\n+'actual code'`,
                };
              }
              return { stdout: "" };
            };
            const ctx: DriverContext = {
              pi: makeFakePi().pi,
              repoRoot: dir,
              issue: 1003,
              issueBodyFetcherFn: () => ({ stdout: "adding documentation" }),
              verifyExecFn: execWithFalsePositives,
            };
            const gate = await verifyStepOutcome(ctx, s, "develop");
            assert(
              gate.ok && !gate.failures.some((f) => /skip.*marker/.test(f)),
              "PR277: markers in comments, strings, and template literals should be excluded, not counted",
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }

        // --- Skip-ratchet: multiple same-marker instances are counted ---
        {
          const dir = mkdtempSync(path.join(tmpdir(), "pr277-multiple-"));
          try {
            fsSync.mkdirSync(path.join(dir, ".pi"), { recursive: true });
            fsSync.writeFileSync(path.join(dir, ".pi", "verify-cmd"), "echo ok\n");
            let s = initialState(1004, 1005);
            s = {
              ...s,
              pipelineState: {
                ...s.pipelineState,
                worktrees: { default: dir },
                baseSha: "abc123",
              },
            };
            const execWithMultipleMarkers: NonNullable<DriverContext["verifyExecFn"]> = async (
              cmd,
            ) => {
              if (cmd === "git status --porcelain") return { stdout: "M src/test.ts\n" };
              if (cmd.includes("verify-cmd")) return { stdout: "ok\n" };
              if (cmd.startsWith("git diff")) {
                return {
                  stdout: '+it.skip("test1"); it.skip("test2"); it.skip("test3");\n',
                };
              }
              return { stdout: "" };
            };
            const ctx: DriverContext = {
              pi: makeFakePi().pi,
              repoRoot: dir,
              issue: 1004,
              issueBodyFetcherFn: () => ({ stdout: "adding tests" }),
              verifyExecFn: execWithMultipleMarkers,
            };
            const gate = await verifyStepOutcome(ctx, s, "develop");
            const markerFail = gate.failures.find((f) => /skip.*marker/.test(f));
            assert(
              !gate.ok && markerFail !== undefined && markerFail.includes("3"),
              "PR277: multiple same-marker instances on one line are all counted",
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }

        // --- Smoke-cmd: present and exits non-zero fails gate ---
        {
          const dir = mkdtempSync(path.join(tmpdir(), "pr277-smoke-fail-"));
          try {
            fsSync.mkdirSync(path.join(dir, ".pi"), { recursive: true });
            fsSync.writeFileSync(path.join(dir, ".pi", "verify-cmd"), "echo ok\n");
            fsSync.writeFileSync(
              path.join(dir, ".pi", "smoke-cmd"),
              "# Smoke test command\nbun run smoke\n",
            );
            let s = initialState(1005, 1006);
            s = {
              ...s,
              pipelineState: {
                ...s.pipelineState,
                worktrees: { default: dir },
                baseSha: "abc123",
              },
            };
            const execFailingSmoke: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
              if (cmd === "git status --porcelain") return { stdout: "M src/main.ts\n" };
              if (cmd.startsWith("git diff")) return { stdout: "+new code\n" };
              if (cmd.includes("run smoke")) {
                throw new Error("Smoke failed: assertion error\n    at test/e2e/smoke.test.ts:42");
              }
              return { stdout: "" };
            };
            const ctx: DriverContext = {
              pi: makeFakePi().pi,
              repoRoot: dir,
              issue: 1005,
              issueBodyFetcherFn: () => ({ stdout: "fixing smoke" }),
              verifyExecFn: execFailingSmoke,
            };
            const gate = await verifyStepOutcome(ctx, s, "develop");
            assert(
              !gate.ok && gate.failures.some((f) => /^smoke:/.test(f)),
              "PR277: smoke-cmd exiting non-zero fails gate with smoke:-prefixed failure",
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }

        // --- Smoke-cmd: absent produces note, not failure ---
        {
          const dir = mkdtempSync(path.join(tmpdir(), "pr277-smoke-absent-"));
          try {
            fsSync.mkdirSync(path.join(dir, ".pi"), { recursive: true });
            fsSync.writeFileSync(path.join(dir, ".pi", "verify-cmd"), "echo ok\n");
            let s = initialState(1006, 1007);
            s = {
              ...s,
              pipelineState: {
                ...s.pipelineState,
                worktrees: { default: dir },
                baseSha: "abc123",
              },
            };
            const ctx: DriverContext = {
              pi: makeFakePi().pi,
              repoRoot: dir,
              issue: 1006,
              issueBodyFetcherFn: () => ({ stdout: "adding feature" }),
              verifyExecFn: async (cmd) => {
                if (cmd === "git status --porcelain") return { stdout: "M src/main.ts\n" };
                if (cmd.includes("verify-cmd")) return { stdout: "ok\n" };
                if (cmd.startsWith("git diff")) return { stdout: "+new code\n" };
                return { stdout: "" };
              },
            };
            const gate = await verifyStepOutcome(ctx, s, "develop");
            assert(
              gate.ok &&
                gate.notes.some((n) => /smoke.*not run/.test(n) || /no.*smoke-cmd/.test(n)),
              "PR277: absent smoke-cmd produces note, not failure",
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }

        // --- Env vars disable each check independently ---
        {
          const dir = mkdtempSync(path.join(tmpdir(), "pr277-env-disable-"));
          try {
            fsSync.mkdirSync(path.join(dir, ".pi"), { recursive: true });
            fsSync.writeFileSync(path.join(dir, ".pi", "verify-cmd"), "echo ok\n");

            // Test: PI_ENSEMBLE_SMOKE=0 disables smoke gate (skip-ratchet still enabled, so feed harmless diff)
            const prevSmoke = process.env.PI_ENSEMBLE_SMOKE;
            process.env.PI_ENSEMBLE_SMOKE = "0";
            try {
              let s = initialState(1007, 1008);
              s = {
                ...s,
                pipelineState: {
                  ...s.pipelineState,
                  worktrees: { default: dir },
                  baseSha: "abc123",
                },
              };
              const execSmokeDisabled: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
                if (cmd === "git status --porcelain") return { stdout: "M src/main.ts\n" };
                if (cmd.includes("verify-cmd")) return { stdout: "ok\n" };
                if (cmd.startsWith("git diff")) return { stdout: "+new code\n" }; // No skip markers, so ratchet won't fail
                if (cmd.includes("run smoke")) throw new Error("Smoke failed"); // Smoke fails but is disabled
                return { stdout: "" };
              };
              const ctxSmokeDisabled: DriverContext = {
                pi: makeFakePi().pi,
                repoRoot: dir,
                issue: 1007,
                issueBodyFetcherFn: () => ({ stdout: "testing smoke disable" }),
                verifyExecFn: execSmokeDisabled,
              };
              fsSync.mkdirSync(path.join(dir, ".pi"), { recursive: true });
              fsSync.writeFileSync(path.join(dir, ".pi", "smoke-cmd"), "bun run smoke\n");
              const smokeDisabled = await verifyStepOutcome(ctxSmokeDisabled, s, "develop");
              assert(
                smokeDisabled.ok && smokeDisabled.notes.some((n) => /PI_ENSEMBLE_SMOKE=0/.test(n)),
                "PR277: PI_ENSEMBLE_SMOKE=0 disables smoke gate (failing smoke is ignored) and emits disabled note",
              );
            } finally {
              if (prevSmoke === undefined) delete process.env.PI_ENSEMBLE_SMOKE;
              else process.env.PI_ENSEMBLE_SMOKE = prevSmoke;
              rmSync(path.join(dir, ".pi", "smoke-cmd"), { force: true });
            }

            // Test: PI_ENSEMBLE_SKIP_RATCHET=0 disables skip-ratchet gate (smoke still enabled, so make it pass)
            const prevRatchet = process.env.PI_ENSEMBLE_SKIP_RATCHET;
            process.env.PI_ENSEMBLE_SKIP_RATCHET = "0";
            try {
              let s = initialState(1008, 1009);
              s = {
                ...s,
                pipelineState: {
                  ...s.pipelineState,
                  worktrees: { default: dir },
                  baseSha: "abc123",
                },
              };
              const execRatchetDisabled: NonNullable<DriverContext["verifyExecFn"]> = async (
                cmd,
              ) => {
                if (cmd === "git status --porcelain") return { stdout: "M src/test.ts\n" };
                if (cmd.includes("verify-cmd")) return { stdout: "ok\n" };
                if (cmd.startsWith("git diff"))
                  return { stdout: '+#[ignore]\n+it.skip("test");\n' }; // Skip markers but ratchet disabled
                return { stdout: "" };
              };
              const ctxRatchetDisabled: DriverContext = {
                pi: makeFakePi().pi,
                repoRoot: dir,
                issue: 1008,
                issueBodyFetcherFn: () => ({ stdout: "testing ratchet disable" }),
                verifyExecFn: execRatchetDisabled,
              };
              const ratchetDisabled = await verifyStepOutcome(ctxRatchetDisabled, s, "develop");
              assert(
                ratchetDisabled.ok &&
                  ratchetDisabled.notes.some((n) => /PI_ENSEMBLE_SKIP_RATCHET=0/.test(n)),
                "PR277: PI_ENSEMBLE_SKIP_RATCHET=0 disables skip-ratchet gate and emits disabled note",
              );
            } finally {
              if (prevRatchet === undefined) delete process.env.PI_ENSEMBLE_SKIP_RATCHET;
              else process.env.PI_ENSEMBLE_SKIP_RATCHET = prevRatchet;
            }
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      } finally {
        if (prevSkipRatchet === undefined) delete process.env.PI_ENSEMBLE_SKIP_RATCHET;
        else process.env.PI_ENSEMBLE_SKIP_RATCHET = prevSkipRatchet;
        if (prevSmoke === undefined) delete process.env.PI_ENSEMBLE_SMOKE;
        else process.env.PI_ENSEMBLE_SMOKE = prevSmoke;
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
