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
import { REPORTING_STATES } from "../src/lean/state-outcome.ts";
import { INITIAL_COUNTERS, REPORT_STATES, leanStateFile, loadRun } from "../src/lean/state.ts";
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
  [
    // The budget trio belongs to a `budget` verdict and nowhere else: `handback`
    // renders these three into the operator's cause line, so a ceiling reported on
    // an `ok` step is a run that stopped for a limit it never crossed. `build` is
    // one of the states that legitimately owns them, so only the `kind` separates
    // this record from a real verdict.
    "limit/value/used on an ok step",
    59,
    {
      key: "59:build:0",
      state: "build",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "ok", limit: "turns", value: 1, used: 2 },
    },
    /outcome limit is only recorded by a budget verdict/,
  ],
  [
    // `used` is a count the operator is told about, not a float: JSON turns
    // `1e400` into `Infinity`, and an infinite overshoot printed as a budget
    // verdict is a record that reads as evidence and compares against nothing.
    // Distinct key from the case above: the refusal message quotes the step key,
    // so two cases sharing one key cannot both assert on it.
    "budget verdict with an infinite used",
    60,
    {
      key: "60:build:0",
      state: "build",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "budget", limit: "turns", value: 3, used: 1e400 },
    },
    /outcome used must be a non-negative safe integer/,
  ],
  [
    // #1920 A — `draft` is what the publish step handed the forge, and the only
    // typed answer to "green and waiting, or a draft behind unverified bytes".
    // On any other step it is a readiness claim the run never made.
    "draft on a verify step",
    61,
    {
      key: "61:verify:0",
      state: "verify",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "green", verifiedHead: "b".repeat(40), draft: true },
    },
    /outcome draft is only recorded by a publish step/,
  ],
  [
    // #1920 B — `posted` is the two REPORTING steps' delivery claim, and the headless
    // result reads it to decide whether to tell a host a comment exists. On a step
    // that posts nothing it is a delivery the run never made.
    "posted on a publish step",
    62,
    {
      key: "62:publish:0",
      state: "publish",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "ok", prUrl: "https://github.com/o/r/pull/1", posted: true },
    },
    /outcome posted is only recorded by a handback,decline step/,
  ],
  [
    // A truthy string survives `if (outcome.posted)` and prints a park as
    // delivered, so the field is a boolean or the record is refused.
    "posted as a string on a handback step",
    63,
    {
      key: "63:handback:0",
      state: "handback",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "done", posted: "yes", reason: "handback comment posted" },
    },
    /outcome posted must be a boolean/,
  ],
  [
    // #1920 B — `publishedHead` is the head `publish` says it pushed, and the
    // result's `prState: "ready"` compares it to the green verify's
    // `verifiedHead`. On a step that shipped nothing it is a claim about a
    // commit that step never wrote, and `ready` would rest on it.
    "publishedHead on a verify step",
    64,
    {
      key: "64:verify:0",
      state: "verify",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "green", verifiedHead: "b".repeat(40), publishedHead: "c".repeat(40) },
    },
    /outcome publishedHead is only recorded by a publish step/,
  ],
  [
    // A 12-char prefix is what the reason line prints, never what the field
    // holds: the result compares it for EQUALITY against `verifiedHead`, so a
    // prefix would compare unequal forever and no reader could tell a broken
    // record from a run that shipped another commit.
    "publishedHead as an abbreviated oid",
    65,
    {
      key: "65:publish:0",
      state: "publish",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: {
        kind: "ok",
        prUrl: "https://github.com/o/r/pull/1",
        publishedHead: "a".repeat(12),
      },
    },
    /outcome publishedHead must be a 40-hex commit sha/,
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
 * The two lists of REPORTING states are one list. `state.ts` declares
 * `REPORT_STATES` (where `handback.ts` and every caller read it) and
 * `state-outcome.ts` keeps a local `REPORTING_STATES` for the `posted` row of its
 * ownership table, because it cannot import across the cycle its own loader
 * creates. Two lists that drift mean the ownership table enforces a set no
 * longer equal to the set the engine treats as reports — a `posted` claim on a
 * state one list calls a report and the other does not is exactly the forgery the
 * table exists to refuse, silently permitted or silently refused. This is what
 * makes the copy honest, and it is the only thing keeping it so.
 */
assert(
  JSON.stringify(REPORTING_STATES) === JSON.stringify(REPORT_STATES),
  `the ownership table's REPORTING_STATES equals state.ts's REPORT_STATES (got ${JSON.stringify(
    [REPORTING_STATES, REPORT_STATES],
  )})`,
);

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
