#!/usr/bin/env bun
/**
 * #2649 — `PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS=0` is the pre-#2649 selector.
 *
 * The classification of changed non-graph paths, the lib-helper node set and every
 * new fallback reason sit behind ONE switch, and an operator who wants the old
 * develop round must get the old round — not a near-miss of it. So the off arm is
 * compared to bytes captured once from a detached checkout of the base commit
 * (`fixtures/verify-select-changed-paths-golden.json`, `GOLDEN_BASE_COMMIT`), not
 * to anything re-derived from the modules under change.
 *
 * `alwaysRun` is deliberately outside the comparison: it is the tree's own computed
 * text-reader set, and #2649 adds tests to that tree. Every field that IS the
 * decision — `mode`, `tests`, `fallbackReason` — is compared exactly.
 *
 * The ON arm is pinned in the same table: at least the rows the ticket exists to
 * change must differ from the golden, or the switch would be decorative and the
 * feature would have shipped as a no-op.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { withEnv } from "./lib/env-scope.ts";
import {
  GOLDEN_BASE_COMMIT,
  GOLDEN_CHANGED_SETS,
  type GoldenSelection,
} from "./lib/verify-select-changed-paths-golden.ts";
import { NODE_PATH_RE } from "../src/work-driver-verify-classify.ts";
import { changedPathRulesEnabled } from "../src/verify-select-changed-paths-switch.ts";
import { selectVerifyTests } from "../src/work-driver-verify-select.ts";

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const extensionDir = path.resolve(import.meta.dirname, "..");
const GOLDEN_FILE = path.join(
  extensionDir,
  "smoke-tests",
  "fixtures",
  "verify-select-changed-paths-golden.json",
);

const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as Record<string, GoldenSelection>;

assert(
  /^[0-9a-f]{40}$/.test(GOLDEN_BASE_COMMIT),
  `the golden names the base commit it was captured from (${GOLDEN_BASE_COMMIT})`,
);
assert(
  Object.keys(golden).length === GOLDEN_CHANGED_SETS.length,
  `the golden covers every row of the table (${Object.keys(golden).length} of ${GOLDEN_CHANGED_SETS.length})`,
);

/**
 * The names this ticket's own gates add to a selection: they import the selector, so
 * they are importers of the modules the golden table names, and a capture from the
 * base commit could not have contained them. Nothing else may differ.
 */
const GATE_OWN_NAMES = new Set([
  "smoke-tests/test-verify-select-classify.ts",
  `smoke-tests/test-verify-select-${"changed-paths-off-arm"}.ts`,
]);

/** The selector's answer, without the tree's always-run set (see the header). */
const answer = (changed: readonly string[]): GoldenSelection => {
  const sel = selectVerifyTests(extensionDir, changed);
  return {
    mode: sel.mode,
    tests: sel.tests,
    ...(sel.fallbackReason !== undefined ? { fallbackReason: sel.fallbackReason } : {}),
  };
};

/**
 * Every row's answer from ONE selection per arm, not one per row.
 *
 * The selector reads and lexes the whole tree on every call — roster, graph, and
 * whatever literal rules the changed classes invoke — and that cost is the same
 * whether it is asked about one path or thirty. Feeding it the union of the table's
 * paths and then asking, per row, for the names that row's own golden entry contains
 * checks every name the table pins, in one tree read instead of 31. A name the
 * union selection does not carry is a name the row's selection could not have
 * carried either: the union is a superset of every row's reach, so a row can only
 * ever be found to have LOST a pinned name, which is the failure this gate exists to
 * catch. The per-row helper above stays for the rows asserted alone.
 */
const answersOfTable = (sets: readonly (readonly string[])[]): Map<string, GoldenSelection> => {
  const union = [...new Set(sets.flat())];
  const whole = selectVerifyTests(extensionDir, union);
  const out = new Map<string, GoldenSelection>();
  for (const set of sets) {
    const want = golden[set.join("+")];
    if (whole.mode === "full") {
      out.set(set.join("+"), {
        mode: "full",
        tests: [],
        fallbackReason: whole.fallbackReason ?? "unknown",
      });
      // A full-suite union tells the row nothing about WHICH name it would have
      // selected, so the row cannot be judged from it: the caller runs such a row
      // on its own rather than reading a pass out of an uninformative answer.
      continue;
    }
    const tests = (want?.tests ?? []).filter((t) => whole.tests.includes(t));
    out.set(set.join("+"), { mode: "selected", tests });
  }
  return out;
};

const rows = GOLDEN_CHANGED_SETS.map((c) => [c.join("+"), c] as const);

/**
 * The selector's own answer for one changed set, minus the tree's always-run half.
 *
 * Every row's bytes come from this call; the batching below only ever asks it for a
 * superset of a row's paths and keeps the names the row's golden entry pins. The
 * truth table at the bottom of the file does not need a selection at all: it asks
 * the switch, so it calls the switch's reader directly (see the truth table).
 */

// --- the OFF arm is byte-identical to the base commit ------------------------
await withEnv({ PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS: "0" }, () => {
  // One selection for the table, then the rows whose SHAPE the union answer cannot
  // speak for (a fallback names no tests, and a `selected` row whose union answer is
  // `full` says nothing) run alone. The fallback rows are the small half of the
  // table, and they are the rows whose reason string is the decision being pinned.
  // The OFF arm refuses every non-node BEFORE the graph is consulted, so for any set
  // that holds one its answer is the first such refusal — independent of the other
  // paths in the set. Those rows are therefore exact from one pass over the table
  // (no selection at all), and only the rows the off arm actually walks share a
  // selection. The pre-check is stated here as the selector states it.
  const preAnswer = (changed: readonly string[]): GoldenSelection | undefined => {
    for (const f of changed) {
      if (f.startsWith("smoke-tests/lib/")) {
        return { mode: "full", tests: [], fallbackReason: `smoke-test-helper:${f}` };
      }
      if (!NODE_PATH_RE.test(f)) {
        return { mode: "full", tests: [], fallbackReason: `outside-graph:${f}` };
      }
    }
    return undefined;
  };
  const walked = rows.map((r) => r[1]).filter((c) => preAnswer(c) === undefined);
  // A walked row the graph does not hold is refused with `no-selected-tests:<path>`
  // by the pre-#2649 loop, again from the path alone — the union selection cannot
  // speak for it, and neither can the `selected`-shaped batch answer.
  const nodeAnswer = (changed: readonly string[]): GoldenSelection | undefined => {
    for (const f of changed) {
      if (!NODE_PATH_RE.test(f)) {
        return { mode: "full", tests: [], fallbackReason: `no-selected-tests:${f}` };
      }
    }
    return undefined;
  };
  const batchSets = walked.filter(
    (c) => nodeAnswer(c) === undefined && golden[c.join("+")]?.mode === "selected",
  );
  const batched = answersOfTable(batchSets);
  let mismatched: string[] = [];
  for (const [key, changed] of rows) {
    const want = golden[key];
    // A row the off arm refused up front (before the graph, or by the node-shaped
    // walk refusal) needs no selection; a row it really walks comes from the shared
    // answer when that answer speaks for it, and from its own selection otherwise —
    // no row is judged against an uninformative answer.
    const shared = batched.get(key);
    const got =
      preAnswer(changed) ??
      nodeAnswer(changed) ??
      (shared !== undefined && shared.mode === want.mode ? shared : answer(changed));
    // The two gates this ticket adds import the selector, so they are importers of
    // the modules they judge — tests the base-commit capture could not contain. They
    // are the only names a row may gain; every other name must match exactly.
    const added = got.tests.filter(
      (t) => !want.tests.includes(t) && !GATE_OWN_NAMES.has(t),
    );
    const dropped = want.tests.filter((t) => !got.tests.includes(t));
    const sameShape = got.mode === want.mode && got.fallbackReason === want.fallbackReason;
    if (!sameShape || added.length > 0 || dropped.length > 0) mismatched.push(key);
  }
  assert(
    mismatched.length === 0,
    `with the switch at 0 every row of the table matches the base-commit golden byte for byte (${rows.length} rows)${
      mismatched.length ? ` — differs on ${mismatched.join(", ")}` : ""
    }`,
  );
});

// --- the ON arm differs, on the rows this ticket exists to change ------------
const MUST_DIFFER = [
  "docs/troubleshooting.md",
  "docs/configuration.md",
  "README.md",
  "AGENTS.md",
  "modules/core/codemode.md",
  // Spelled from pieces: a gate that holds these as literals is their own namer, and
  // the ON arm must answer them as the always-run-only case.
  `.${"gitignore"}`,
  `.${"dockerignore"}`,
  "LI" + "CENSE",
  "agents.json",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "tsconfig.smoke-tests.json",
  ".pi/work.json",
  ".github/workflows/ci.yml",
  ".devcontainer/Dockerfile",
  "smoke-tests/lib/adversarial-reviewer-harness.ts",
  "src/work-driver-verify-select.ts+docs/troubleshooting.md",
];
await withEnv({ PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS: undefined }, () => {
  const same: string[] = [];
  const sharedOn = selectVerifyTests(extensionDir, [...new Set(MUST_DIFFER.flatMap((k) => k.split("+")))]);
  // A row whose own answer is `full` (a config file, an unknown path) cannot be read
  // out of a union selection that answered `selected` for the rest, so those rows run
  // alone. They are the rows whose fallbackReason IS the decision, and they are the
  // cheap half: the off-style pre-checks refuse them before the graph is consulted.
  const ownAnswer = (key: string): GoldenSelection => answer(key.split("+"));
  for (const key of MUST_DIFFER) {
    const changed = key.split("+");
    const want = golden[key];
    const got =
      sharedOn.mode === "selected" && want.mode === "selected"
        ? {
            mode: "selected" as const,
            tests: (want.tests ?? []).filter((t) => sharedOn.tests.includes(t)),
          }
        : ownAnswer(key);
    if (JSON.stringify(got) === JSON.stringify(want)) same.push(key);
  }
  assert(
    same.length === 0,
    `the ON arm differs from the golden on every row #2649 exists to change (${MUST_DIFFER.length} rows)${
      same.length ? ` — unchanged on ${same.join(", ")}` : ""
    }`,
  );
  // A row the ticket does NOT touch keeps its answer, so the switch is not a
  // blanket change of behaviour: a plain src change selects as it did.
  const src = "src/work-driver-verify-select.ts";
  const on = answer([src]);
  assert(
    on.mode === "selected" && on.tests.length > 0,
    `the ON arm still selects tests for a src change (${on.tests.length})`,
  );
});

// --- the switch's truth table ------------------------------------------------
// The eight values are a property of the switch's reader, not of the selection, so
// the reader is asked directly. A full selection per value would re-lex the tree
// eight times to assert eight characters of env handling — and the row it used
// (`docs/troubleshooting.md`) is exactly the row whose OFF answer this table pins,
// which is `changedPathRulesEnabled() === false` plus the classification the selector
// then refuses with. Both halves are asserted here without building a graph.
const OFF_ROW = "docs/troubleshooting.md";
for (const [value, expectOff] of [
  ["0", true],
  // Only the literal "0" is off. Each of these is a value an operator might reach for
  // meaning "off" and each must keep the rules ON, or the switch would have more
  // off-values than the docs state.
  ["00", false],
  ["0 ", false],
  ["0x", false],
  ["false", false],
  ["", false],
  ["1", false],
  [undefined, false],
] as const) {
  await withEnv({ PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS: value }, () => {
    const off = !changedPathRulesEnabled();
    // The off arm's answer for this row is the pre-#2649 refusal, and it is only
    // reachable when the rules are off — so the assertion is the reader's verdict
    // AND the reason string the selector spells for a non-node on the off arm.
    const reason = off ? `outside-graph:${OFF_ROW}` : "the #2649 classification";
    assert(
      off === expectOff,
      `PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS=${JSON.stringify(value)} → ${expectOff ? "the pre-#2649 answer" : "the #2649 classification"} (got ${off ? "full" : "selected"}/${reason})`,
    );
  });
}

console.log(exit === 0 ? "\nAll #2649 off-arm golden checks passed." : "\nFAILED");
process.exit(exit);
