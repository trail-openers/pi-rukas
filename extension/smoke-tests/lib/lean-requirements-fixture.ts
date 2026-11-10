/**
 * lib/lean-requirements-fixture — the golden prompt bytes the requirement
 * lever's off-state test compares against, and the record it renders when on.
 *
 * The lever is measured by a bench that runs lean with and without it on one
 * commit, so "off" must be the release without the lever down to the bytes a
 * child reads. `assert(prompt.includes(...))` cannot pin that: it survives a
 * rewrite of everything around the sentence it looks for. These bytes are the
 * comparison, checked in as JSON so a change to a prompt is a reviewable diff
 * rather than a passing test.
 *
 * Regenerate after a DELIBERATE prompt rewrite:
 *
 *     bun run smoke-tests/lib/lean-requirements-fixture.ts --write
 *
 * The generator lives beside the reader and writes ONE key set: the fixture
 * cannot be rewritten by the assertions that read it, only by an operator who
 * ran `--write` after deciding the prompt was meant to change.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildPrompt } from "../../src/lean/build-prompt.ts";
import { challengePrompt } from "../../src/lean/challenge-prompt.ts";
import type { RequirementsRecord } from "../../src/lean/requirements.ts";
import type { PiSpec } from "../../src/lean/spec.ts";
import { specifyPrompt } from "../../src/lean/specify-prompt.ts";

/** The checked-in fixture. JSON, not TS, so a stale entry is a diff nobody misses. */
export const GOLDEN_FILE = path.join(import.meta.dirname, "lean-requirements-golden.json");

/** The one spec the golden bytes are captured for — three criteria, one of each verify kind. */
export const GOLDEN_SPEC: PiSpec = {
  problem: "The retry helper gives up on the first transient failure.",
  size: "S",
  criteria: [
    { id: "AC1", text: "a transient failure is retried", verify: "test" },
    { id: "AC2", text: "the existing suite still passes", verify: "command", command: "tests/x" },
    { id: "AC3", text: "the docs name the new flag", verify: "manual" },
  ],
};

export const GOLDEN_WT = "/tmp/lean-req-bytes/.worktrees/lean-2161";
export const GOLDEN_RUNNER = "bun run {file}";
export const GOLDEN_FROZEN = ["tests/AC1-retry.test.ts", "tests/AC2-bound.test.ts"];

/** The three prompts, all with the lever OFF — the state the golden bytes pin. */
export function offPrompts(): Record<string, string> {
  return {
    specify: specifyPrompt({
      issue: 2161,
      spec: GOLDEN_SPEC,
      testRunner: GOLDEN_RUNNER,
      worktree: GOLDEN_WT,
    }),
    challenge: challengePrompt({
      issue: 2161,
      spec: GOLDEN_SPEC,
      frozenPaths: GOLDEN_FROZEN,
      worktree: GOLDEN_WT,
      testRunner: GOLDEN_RUNNER,
    }),
    build: buildPrompt({
      issue: 2161,
      spec: GOLDEN_SPEC,
      frozenPaths: GOLDEN_FROZEN,
      worktree: GOLDEN_WT,
      attempt: 1,
      testRunner: GOLDEN_RUNNER,
    }),
  };
}

/**
 * The requirement record the build prompt renders in the ON state. Two covered
 * items and one preserved gap, because a section that only ever showed covered
 * items would not fail a test that dropped the uncovered line.
 */
export function buildRequirementsRecord(): RequirementsRecord {
  return {
    total: 3,
    byKind: { behaviour: 1, edge: 1, preserved: 1 },
    covered: ["R1", "R2"],
    uncovered: ["R3"],
    items: [
      {
        id: "R1",
        kind: "behaviour",
        text: "a transient failure is retried twice before giving up",
        tests: [{ path: "tests/AC1-retry.test.ts", red: true }],
        covered: true,
      },
      {
        id: "R2",
        kind: "edge",
        text: "an empty list of attempts is accepted and treated as no retry",
        tests: [{ path: "tests/AC1-empty.test.ts", red: true }],
        covered: true,
      },
      {
        id: "R3",
        kind: "preserved",
        text: "a non-transient error still fails on the first attempt",
        tests: [{ path: "tests/non-transient.test.ts", existing: true }],
        covered: false,
        reason: "no existing test covers the non-transient path",
      },
    ],
  };
}

/** Read the fixture; a missing file is a hard error, never an empty comparison. */
export function readGolden(): Record<string, string> {
  if (!existsSync(GOLDEN_FILE))
    throw new Error(
      `the golden prompt fixture is missing: ${GOLDEN_FILE} — regenerate it with bun run smoke-tests/lib/lean-requirements-fixture.ts --write`,
    );
  return JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as Record<string, string>;
}

/** Regenerate the fixture from the production builders. Called only by `--write`. */
export function writeGolden(): string {
  const prompts = offPrompts();
  // Key order fixed, so a regeneration that changes no bytes changes no file.
  const ordered = { specify: prompts.specify, challenge: prompts.challenge, build: prompts.build };
  writeFileSync(GOLDEN_FILE, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
  return GOLDEN_FILE;
}

if (import.meta.main && process.argv.includes("--write")) {
  console.log(`wrote ${writeGolden()}`);
}
