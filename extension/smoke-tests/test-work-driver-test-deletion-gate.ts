#!/usr/bin/env bun
/**
 * Smoke tests for the #307 test-deletion ratchet in develop verification.
 *
 * The injected executor supplies deterministic git status/diff output, so the
 * tests exercise the production gate without spawning Pi or running a shell.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(condition: boolean, message: string): void {
  if (condition) console.log(`✓ ${message}`);
  else {
    console.error(`✗ ${message}`);
    exit = 1;
  }
}

function makePi(): ExtensionAPI {
  return {
    sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI;
}

async function runGate(diff: string, issue: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "pr307-test-delete-"));
  try {
    mkdirSync(path.join(dir, ".pi"), { recursive: true });
    writeFileSync(path.join(dir, ".pi", "verify-cmd"), "echo ok\n");
    const state = {
      ...initialState(issue, issue + 1),
      pipelineState: {
        ...initialState(issue, issue + 1).pipelineState,
        worktrees: { default: dir },
        baseSha: "abc123",
      },
    };
    const ctx: DriverContext = {
      pi: makePi(),
      repoRoot: dir,
      issue,
      issueBodyFetcherFn: () => ({ stdout: "test-deletion ratchet" }),
      verifyExecFn: async (command) => {
        if (command === "git status --porcelain") return { stdout: "M src/tests.ts\n" };
        if (command.startsWith("git diff")) return { stdout: diff };
        return { stdout: "" };
      },
    };
    return await verifyStepOutcome(ctx, state, "develop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const previousSkip = process.env.PI_ENSEMBLE_SKIP_RATCHET;
const previousSmoke = process.env.PI_ENSEMBLE_SMOKE;
const previousTolerance = process.env.PI_ENSEMBLE_TEST_DELETE_TOLERANCE;
process.env.PI_ENSEMBLE_SKIP_RATCHET = "1";
process.env.PI_ENSEMBLE_SMOKE = "0";

try {
  // A net removal is rejected and reports the number of removed test blocks.
  delete process.env.PI_ENSEMBLE_TEST_DELETE_TOLERANCE;
  const deletion = await runGate('-it("one");\n-test("two");\n+const changed = true;\n', 3070);
  const deletionFailure = deletion.failures.find((failure) => /test block/.test(failure));
  assert(
    !deletion.ok && deletionFailure?.includes("2") === true,
    "#307: net-removed test blocks fail with the named count",
  );

  // Removing and adding the same number of declarations is a valid move.
  const moved = await runGate('-describe("suite");\n+describe("suite");\n', 3071);
  assert(
    moved.ok && !moved.failures.some((failure) => /test block/.test(failure)),
    "#307: a test moved between files with net-zero declarations passes",
  );

  // A deleted test file is represented entirely by removed source lines and
  // must not receive a whole-file exemption.
  const wholeFile = await runGate(
    '-describe("deleted suite");\n-it("first");\n-it("second");\n',
    3072,
  );
  const wholeFileFailure = wholeFile.failures.find((failure) => /test block/.test(failure));
  assert(
    !wholeFile.ok && wholeFileFailure?.includes("3") === true,
    "#307: whole-file test deletion is counted",
  );

  // The configured tolerance permits a small, intentional refactor.
  process.env.PI_ENSEMBLE_TEST_DELETE_TOLERANCE = "2";
  const tolerated = await runGate('-it("one");\n-test("two");\n', 3073);
  assert(
    tolerated.ok && !tolerated.failures.some((failure) => /test block/.test(failure)),
    "#307: test deletions within PI_ENSEMBLE_TEST_DELETE_TOLERANCE pass",
  );
  delete process.env.PI_ENSEMBLE_TEST_DELETE_TOLERANCE;

  // Filtering remains load-bearing at the gate: comments, strings, and diff
  // headers must not become apparent test declarations.
  const filtered = await runGate(
    "--- a/test(\n+++ b/test(\n-// it(\n-const text = 'test(';\n-const template = `describe(`;\n+const changed = true;\n",
    3074,
  );
  assert(
    filtered.ok && !filtered.failures.some((failure) => /test block/.test(failure)),
    "#307: comments, strings, and diff headers are excluded from deletion counts",
  );

  // The existing skip-ratchet kill-switch controls this check too and emits
  // the established disabled note rather than silently changing behavior.
  process.env.PI_ENSEMBLE_SKIP_RATCHET = "0";
  process.env.PI_ENSEMBLE_TEST_DELETE_TOLERANCE = "0";
  const disabled = await runGate('-it("deleted");\n+#[ignore]\n', 3075);
  assert(
    disabled.ok &&
      disabled.notes.some((note) =>
        /PI_ENSEMBLE_SKIP_RATCHET=0 — skip-ratchet gate disabled/.test(note),
      ),
    "#307: PI_ENSEMBLE_SKIP_RATCHET=0 disables deletion and emits the disabled NOTE",
  );
} finally {
  if (previousSkip === undefined) delete process.env.PI_ENSEMBLE_SKIP_RATCHET;
  else process.env.PI_ENSEMBLE_SKIP_RATCHET = previousSkip;
  if (previousSmoke === undefined) delete process.env.PI_ENSEMBLE_SMOKE;
  else process.env.PI_ENSEMBLE_SMOKE = previousSmoke;
  if (previousTolerance === undefined) delete process.env.PI_ENSEMBLE_TEST_DELETE_TOLERANCE;
  else process.env.PI_ENSEMBLE_TEST_DELETE_TOLERANCE = previousTolerance;
}

console.log(`\nexit ${exit}`);
process.exit(exit);
