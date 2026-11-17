#!/usr/bin/env bun
/**
 * #2334 — the `PI_ENSEMBLE_LEAN_READY_FACTS_ON_LOAD` switch: what it rebuilds, and that
 * off is today's behaviour.
 *
 * `buildOutcome` is the whitelist `loadRun` runs every step outcome through, and it had no
 * clause for `derivedSpec` or `baseSha` — the two fields `OWNER_OF_FIELD` gives to `ready`
 * alone. `outcomeProblem` judged both and then the rebuilder dropped both, so the step log
 * disagreed with the run record about which contract the run executed.
 *
 * Three things, none of them covered by the drive case in
 * `test-lean-spec-intake-record.ts`:
 *
 *   (docs) a `docs/lean.md` sentence naming the knob — a switch nobody can discover is a
 *       switch that does not exist, and the roster check in `test-headless-inputs.ts` never
 *       opens `docs/`. Asserted on the guide, not on `docs/configuration.md`, whose rows are
 *       a separate workstream's;
 *   (truth table) on for unset, `"1"`, `""` and `"false"`; off for the literal `"0"` —
 *       read at CALL time, so a pin leaked from another file in this process cannot make an
 *       ON case measure the off arm;
 *   (round-trip) the two arms on the loader itself, not on a drive: with the knob on a loaded
 *       ready outcome carries `derivedSpec` and a full-oid `baseSha`, and a value the reader
 *       will not vouch for is DROPPED rather than carried or thrown; with it off the same
 *       bytes load as `kind` alone, the outcome v0.14.87 produced.
 *
 * The off arm is the load-bearing half: a switch that only ever measured the on arm would
 * pass on a build that ignored the env var entirely. Each arm seeds its own record and reads
 * back both the bytes and the loaded outcome, so "the file carried it" is a claim about the
 * file and "the loader kept it" is a claim about the loader.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { leanReadyFactsOnLoadEnabled } from "../src/lean/ready-facts-switch.ts";
import { INITIAL_COUNTERS, type LeanRun, type Outcome, leanStateFile, loadRun } from "../src/lean/state.ts";
import { buildOutcome } from "../src/lean/state-outcome.ts";
import type { DerivedSpec } from "../src/lean/state-derived-spec.ts";
import { FIXTURE_BASE_SHA, makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";
import { withEnv } from "./lib/env-scope.ts";

const { assert, failures } = makeAssert();
const SELF = "test-lean-ready-facts-on-load-switch.ts";
/** `makeAssert` prints the message verbatim, so the suite name rides on each one. */
function check(cond: boolean, msg: string): void {
  assert(cond, `${SELF}: ${msg}`);
}

const json = (value: unknown): string => JSON.stringify(value);

/** The contract a real `ready` step wrote, in the canonical shape `parsePiSpec` returns. */
const DERIVED = {
  spec: {
    problem: "a step log that drops the contract is no record of the run",
    criteria: [
      { id: "AC1", text: "the loaded step carries the contract", verify: "test" },
      { id: "AC2", text: "off is the release's own bytes", verify: "test" },
    ],
    size: "S",
  },
  model: "fixture-model",
  at: 1_600_000_000_000,
};

/** Seed a run whose only step is `ready + ok` carrying `outcome`, and load it back. */
function loadReadyRun(issue: number, outcome: Record<string, unknown>): LeanRun | undefined {
  const { dir, cleanup } = tempDir();
  try {
    const seed = {
      schema: 1,
      issue,
      version: "test",
      models: {},
      baseSha: FIXTURE_BASE_SHA,
      branch: `feature/issue-${String(issue)}`,
      state: "specify",
      counters: INITIAL_COUNTERS,
      steps: [
        {
          key: `${String(issue)}:ready:0`,
          state: "ready",
          startedAt: 1,
          endedAt: 2,
          outcome: { kind: "ok", ...outcome },
        },
      ],
      ...(outcome.derivedSpec === undefined
        ? {}
        : { derivedSpec: outcome.derivedSpec as DerivedSpec }),
    };
    mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
    writeFileSync(leanStateFile(dir, issue), JSON.stringify(seed, null, 2), "utf8");
    const loaded = loadRun(dir, issue);
    if (loaded === undefined) return undefined;
    // The raw bytes are what "the file carried it" means — `loadRun` rebuilds field by
    // field, so a claim about what the loader kept has to be made against a file that really
    // held it. A seed that did not round-trip its own bytes would let an off arm look correct.
    const raw = JSON.parse(readFileSync(leanStateFile(dir, issue), "utf8")).steps?.[0]?.outcome;
    if (json(raw) !== json({ kind: "ok", ...outcome }))
      throw new Error(`seed did not round-trip its own bytes: ${json(raw)}`);
    return loaded;
  } finally {
    cleanup();
  }
}

/** The loaded step's outcome, the half of the record the switch reaches. */
function loadReadyOutcome(
  issue: number,
  outcome: Record<string, unknown>,
): Outcome | undefined {
  const loaded = loadReadyRun(issue, outcome);
  return loaded === undefined ? undefined : loaded.steps[loaded.steps.length - 1]?.outcome;
}

// ─────────────────────────────────────────────────────────── (docs) the knob is discoverable
{
  const lean = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "docs", "lean.md"),
    "utf8",
  );
  check(
    lean.includes("PI_ENSEMBLE_LEAN_READY_FACTS_ON_LOAD"),
    "(docs) docs/lean.md names the switch where it describes where the derived contract lives",
  );
  for (const needle of ["buildOutcome", "ready", "step log"]) {
    check(
      lean.includes(needle),
      `and that passage states what the reader needs to know about it: "${needle}"`,
    );
  }
}

// ───────────────────────────────────────────────────────────── (truth table) the reader
await withEnv({ PI_ENSEMBLE_LEAN_READY_FACTS_ON_LOAD: undefined }, async () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_LEAN_READY_FACTS_ON_LOAD: value }, async () => {
      assert(
        leanReadyFactsOnLoadEnabled() === want,
        `${SELF}: PI_ENSEMBLE_LEAN_READY_FACTS_ON_LOAD=${json(value)} reads ${String(want)}`,
      );
    });
  }
});

// ────────────────────────────────────────────────────────────── (on) the loader rebuilds both
await withEnv({ PI_ENSEMBLE_LEAN_READY_FACTS_ON_LOAD: undefined }, async () => {
  const oc = loadReadyOutcome(801, { derivedSpec: DERIVED, baseSha: FIXTURE_BASE_SHA });
  check(
    oc !== undefined,
    `(on) the seeded ready step loaded at all (got ${json(oc === undefined ? "not loaded" : oc.kind)})`,
  );
  check(
    json(oc?.derivedSpec) === json(DERIVED),
    `(on) the loaded step carries the contract the file holds (got ${json(oc?.derivedSpec)})`,
  );
  check(
    oc?.baseSha === FIXTURE_BASE_SHA,
    `(on) and the commit the step read the config at (got ${json(oc?.baseSha)})`,
  );
  // The two clauses sit at the END of the spread, so the key order the handback key-list
  // case pins for every other outcome is untouched by them.
  check(
    json(Object.keys(oc ?? {})) === json(["kind", "derivedSpec", "baseSha"]),
    `(on) and the two keys are appended, not spliced in (got ${json(Object.keys(oc ?? {}))})`,
  );
});

// ─────────────────────────────────────────────────── (on) the reader vouches, or drops
await withEnv({ PI_ENSEMBLE_LEAN_READY_FACTS_ON_LOAD: undefined }, async () => {
  // `assertRunFile` refuses a record whose `derivedSpec` `derivedSpecProblem` dislikes, so the
  // rebuilder only ever sees a value that passed. Its own guard is the other half of the
  // contract, and the only way to reach it is `buildOutcome` directly: a value the reader will
  // not vouch for is DROPPED, and nothing throws. A rebuilder that asserted instead would turn
  // a field it disagrees with into a record that will not load.
  const dropped = buildOutcome({ kind: "ok", derivedSpec: { spec: DERIVED.spec, model: 42, at: 1 }, baseSha: "abc123" });
  const keys = Object.keys(dropped);
  check(
    json(keys) === json(["kind"]),
    `(drop) a ready outcome whose contract and sha the reader will not vouch for rebuilds to the fields it can stand behind, with no throw (keys ${json(
      keys,
    )})`,
  );
  check(
    dropped.kind === "ok",
    `(drop) and the fields it did vouch for are intact (kind ${json(dropped.kind)})`,
  );
  // The same rebuilder with the switch off, on bytes a real record carries: the guard is the
  // knob, not the shape, so a valid contract still comes back absent.
  await withEnv({ PI_ENSEMBLE_LEAN_READY_FACTS_ON_LOAD: "0" }, async () => {
    const off = buildOutcome({ kind: "ok", derivedSpec: DERIVED, baseSha: FIXTURE_BASE_SHA });
    check(
      json(Object.keys(off)) === json(["kind"]),
      `(drop) and with the switch off the same guard leaves a VALID contract out too (keys ${json(
        Object.keys(off),
      )})`,
    );
  });
});

// ──────────────────────────────────────────────────────────── (off) the release's own bytes
await withEnv({ PI_ENSEMBLE_LEAN_READY_FACTS_ON_LOAD: "0" }, async () => {
  const oc = loadReadyOutcome(804, { derivedSpec: DERIVED, baseSha: FIXTURE_BASE_SHA });
  const keys = Object.keys(oc ?? {});
  check(
    oc !== undefined,
    `(off) the same record loads (got ${json(oc === undefined ? "not loaded" : oc.kind)})`,
  );
  check(
    json(keys) === json(["kind"]),
    `(off) and its outcome is the key set v0.14.87 loaded — neither field rebuilt (got ${json(
      keys,
    )})`,
  );
  check(
    !keys.includes("derivedSpec") && !keys.includes("baseSha"),
    `(off) stated as the absence of the two keys, since an undefined-valued key would hide in a value read (got ${json(
      keys,
    )})`,
  );
  // The run-level copy is NOT the switch's: `settle`/`applyReadyFacts` put it there whatever
  // the env says, and it is the only copy every later step reads. Without this, an off arm that
  // took the run's copy too would still be green here.
  const loaded = loadReadyRun(804, { derivedSpec: DERIVED, baseSha: FIXTURE_BASE_SHA });
  check(
    json(loaded?.derivedSpec) === json(DERIVED),
    `(off) while the run's own copy still loads, so derive mode works on either arm (got ${json(
      loaded?.derivedSpec,
    )})`,
  );
});

console.log(`\n${failures() === 0 ? "switch green" : "switch RED"} (${String(failures())} failing)`);
process.exit(failures());
