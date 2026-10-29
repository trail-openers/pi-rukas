#!/usr/bin/env bun
/**
 * lean/state-outcome — which step is allowed to record which piece of evidence.
 *
 * `prUrl` and `verifiedHead` are not descriptive prose: the land gate compares
 * `verifiedHead` against the PR head, and `handback` prints `prUrl` as a link.
 * A record that carries one on a step that never produced it is therefore not
 * extra detail but a forged claim — a PR the run never opened, or a head the run
 * never verified — and a later reader cannot tell it from the real thing.
 *
 * So `assertRun` refuses it at load, with the step's own key in the message, and
 * these two cases pin both halves of that: a `handback` step carrying `prUrl` and
 * a `build` step carrying `verifiedHead` are each refused, the refusal names the
 * field, and it names the step key so an operator can find the line. The cases go
 * through `loadRun`, the entry point the engine actually drives from, so a file
 * this shape can never be driven even by a hand-edited record.
 *
 * The `commandCriteria` / `commandNotRunnable` cases belong to the same rule: they
 * are the evidence the PR body prints, they belong to the `verify` step alone, and
 * the reason is now a MAP keyed by criterion id so each declined criterion carries
 * its own explanation. A bare string, a key that is not `AC<n>`, or a reason past
 * the bound is refused at load.
 *
 * Split out of `test-lean-engine-resume.ts`, whose subject is the replay fold:
 * these cases never reach a replay, because the record is refused before any
 * handler is dispatched.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INITIAL_COUNTERS, leanStateFile, loadRun } from "../src/lean/state.ts";
import { makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const CLOCK = 1000;

const STEP = (issue: number, state: string, n: number, kind: string) => ({
  key: `${issue}:${state}:${n}`,
  state,
  startedAt: CLOCK,
  endedAt: CLOCK,
  outcome: { kind },
});

/**
 * A seed whose ONLY fault is that one evidence-bearing field sits on a step that
 * never produces it. Everything else is the shape a real run writes, so a
 * refusal that came from anything else would be a false alarm.
 */
function forgedOutcomeField(dir: string, issue: number, step: Record<string, unknown>): void {
  mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
  const seed = {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: "base",
    branch: `feature/issue-${issue}`,
    state: "handback",
    counters: INITIAL_COUNTERS,
    steps: [STEP(issue, "ready", 0, "ok"), step],
  };
  writeFileSync(leanStateFile(dir, issue), JSON.stringify(seed, null, 2), "utf8");
}

for (const [label, issue, step, expect] of [
  [
    "prUrl on a handback step",
    48,
    {
      key: "48:handback:0",
      state: "handback",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "done", prUrl: "https://github.com/o/r/pull/1" },
    },
    /prUrl/,
  ],
  [
    "verifiedHead on a build step",
    49,
    {
      key: "49:build:0",
      state: "build",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "ok", verifiedHead: "b".repeat(40) },
    },
    /verifiedHead/,
  ],
  [
    // A `frozen` key is looked up by exact string against the bytes at HEAD, so
    // one that traverses outside the tree can never match a blob: the record
    // reads as tamper evidence and compares unequal forever.
    "frozen key that escapes the worktree",
    50,
    {
      key: "50:specify:0",
      state: "specify",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "ok", frozen: { "../outside": "a".repeat(64) } },
    },
    /frozen key/,
  ],
  [
    // `next()` calls `.join` on `failedRules` when it routes a refusal, so a
    // number in that array is a crash waiting in the report path.
    "failedRules carrying a number",
    51,
    {
      key: "51:build:0",
      state: "build",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "blocked", failedRules: [1] },
    },
    /failedRules/,
  ],
  [
    // `commandCriteria` is what licenses `passed (command)` in the PR body, so it
    // belongs to the gate and nowhere else — and a `commandNotRunnable` map whose
    // value is a number would reach the table renderer as something with no length.
    "commandCriteria on a publish step",
    52,
    {
      key: "52:publish:0",
      state: "publish",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "ok", commandCriteria: { AC1: "passed" } },
    },
    /commandCriteria/,
  ],
  [
    // Each declined command criterion explains itself, keyed by criterion id: a
    // key that is not AC<n> is a record no row can be matched to.
    "commandNotRunnable keyed by something that is not a criterion id",
    53,
    {
      key: "53:verify:0",
      state: "verify",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: {
        kind: "green",
        verifiedHead: "b".repeat(40),
        commandNotRunnable: { "not-an-id": "tests/x.test.sh is a symlink" },
      },
    },
    /commandNotRunnable key/,
  ],
  [
    // The reason is prose out of a tree check and reaches the PR table, so it is
    // bounded like every other piece of prose in the record.
    "commandNotRunnable carrying a 400-character reason",
    54,
    {
      key: "54:verify:0",
      state: "verify",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: {
        kind: "green",
        verifiedHead: "b".repeat(40),
        commandNotRunnable: { AC1: "x".repeat(400) },
      },
    },
    /commandNotRunnable\["AC1"\] must be at most/,
  ],
  [
    // A map, not a bare string: the single-slot record could explain one declined
    // criterion and silently drop the rest.
    "commandNotRunnable as a string",
    55,
    {
      key: "55:verify:0",
      state: "verify",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: {
        kind: "green",
        verifiedHead: "b".repeat(40),
        commandNotRunnable: "tests/x.test.sh is a symlink",
      },
    },
    /commandNotRunnable must be an object/,
  ],
  [
    // `commandCriteria` is what licenses `passed (command)` in the PR body, so it
    // belongs to the gate and nowhere else — and `buildOutcome` rebuilds the map
    // from entries it actually validated, so an object value (or any word but
    // `passed`) is refused at load rather than spread through a cast and printed as
    // evidence for a check the gate never made.
    "commandCriteria whose value is an object rather than the word passed",
    56,
    {
      key: "56:verify:0",
      state: "verify",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: {
        kind: "green",
        verifiedHead: "b".repeat(40),
        commandCriteria: { AC1: { kind: "passed" } },
      },
    },
    /commandCriteria\["AC1"\] must be "passed"/,
  ],
  [
    // Any other string is the same forgery in a different costume: `passed-ish`
    // reads as evidence and never matched anything the gate recorded.
    "commandCriteria whose value is a string that is not `passed`",
    57,
    {
      key: "57:verify:0",
      state: "verify",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: {
        kind: "green",
        verifiedHead: "b".repeat(40),
        commandCriteria: { AC1: "probably-passed" },
      },
    },
    /commandCriteria\["AC1"\] must be "passed"/,
  ],
  [
    // The map carries one entry per criterion the gate can execute, and no more:
    // a record with more was not written by the gate.
    "commandCriteria holding more criteria than the gate can run",
    58,
    {
      key: "58:verify:0",
      state: "verify",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: {
        kind: "green",
        verifiedHead: "b".repeat(40),
        commandCriteria: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`AC${i + 1}`, "passed"]),
        ),
      },
    },
    /commandCriteria must hold at most 32/,
  ],
] as const) {
  const { dir, cleanup } = tempDir();
  try {
    forgedOutcomeField(dir, issue, step);
    let thrown: unknown;
    try {
      loadRun(dir, issue);
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error && thrown.name === "LeanStateError",
      `a forged ${label} is refused at load (got: ${String(thrown)})`,
    );
    assert(
      expect.test((thrown as Error)?.message ?? ""),
      `the refusal for a forged ${label} names the field (got: ${(thrown as Error)?.message})`,
    );
    assert(
      (thrown as Error)?.message.includes(String(step.key)) === true,
      `the refusal names the step key (got: ${(thrown as Error)?.message})`,
    );
  } finally {
    cleanup();
  }
}

process.exit(failures());
