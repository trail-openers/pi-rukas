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
