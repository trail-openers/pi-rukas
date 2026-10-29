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
import { FIXTURE_BASE_SHA, makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";

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
    baseSha: FIXTURE_BASE_SHA,
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

/**
 * The base invariant, checked at load rather than at first use.
 *
 * `baseSha` is the ref every later read of the run is anchored to — the config
 * load, the diff, the verify verdict all resolve AT it. A record carrying
 * `main` in that field is not a slightly odd base: it is a run that silently
 * means "the mainline, whichever commit that happens to be", and only the load
 * path sees it before a model is billed — `ready` proves a base it was handed,
 * and `runLean` drives from the record without asking. So the loader holds a
 * NON-empty base to the same rule `ready` does, a full lowercase oid, and the
 * cases below pin both halves: a moving ref or a mangled oid is refused, and
 * the two legitimately empty-shaped values are not.
 */
function forgedBase(dir: string, issue: number, baseSha: string): void {
  mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
  const seed = {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha,
    branch: `feature/issue-${issue}`,
    state: "ready",
    counters: INITIAL_COUNTERS,
    steps: [],
  };
  writeFileSync(leanStateFile(dir, issue), JSON.stringify(seed, null, 2), "utf8");
}

for (const [label, issue, baseSha] of [
  ["a branch name", 55, "main"],
  ["an abbreviated oid", 56, "0123456"],
  ["a mixed-case oid", 57, FIXTURE_BASE_SHA.toUpperCase()],
] as const) {
  const { dir, cleanup } = tempDir();
  try {
    forgedBase(dir, issue, baseSha);
    let thrown: unknown;
    try {
      loadRun(dir, issue);
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error && thrown.name === "LeanStateError",
      `a hand-edited baseSha of ${label} is refused at load (got: ${String(thrown)})`,
    );
    assert(
      /baseSha/.test((thrown as Error)?.message ?? ""),
      `the refusal for ${label} names the field (got: ${(thrown as Error)?.message})`,
    );
    assert(
      (thrown as Error)?.message.includes(baseSha) === true,
      `the refusal for ${label} quotes the offending value (got: ${(thrown as Error)?.message})`,
    );
  } finally {
    cleanup();
  }
}

// The two shapes that are NOT corruptions: a full oid, and the empty string a
// seed whose probe failed legitimately writes (which `ready` then refuses with
// the reason the probe gave). Refusing either would refuse the only shape a
// first run can have.
for (const [label, issue, baseSha] of [
  ["a full oid", 58, FIXTURE_BASE_SHA],
  ["the empty base a failed seed writes", 59, ""],
] as const) {
  const { dir, cleanup } = tempDir();
  try {
    forgedBase(dir, issue, baseSha);
    let thrown: unknown;
    let loaded: unknown;
    try {
      loaded = loadRun(dir, issue);
    } catch (err) {
      thrown = err;
    }
    assert(thrown === undefined, `a baseSha of ${label} loads (got: ${String(thrown)})`);
    assert(
      (loaded as { baseSha?: string })?.baseSha === baseSha,
      `the loaded record keeps its ${label} (got ${JSON.stringify((loaded as { baseSha?: string })?.baseSha)})`,
    );
  } finally {
    cleanup();
  }
}

process.exit(failures());
