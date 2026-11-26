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

const rows = GOLDEN_CHANGED_SETS.map((c) => [c.join("+"), c] as const);

// --- the OFF arm is byte-identical to the base commit ------------------------
await withEnv({ PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS: "0" }, () => {
  let mismatched: string[] = [];
  for (const [key, changed] of rows) {
    const got = answer(changed);
    const want = golden[key];
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
  for (const key of MUST_DIFFER) {
    const changed = key.split("+");
    if (JSON.stringify(answer(changed)) === JSON.stringify(golden[key])) same.push(key);
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
    const r = selectVerifyTests(extensionDir, ["docs/troubleshooting.md"]);
    const off = r.mode === "full" && r.fallbackReason === "outside-graph:docs/troubleshooting.md";
    assert(
      off === expectOff,
      `PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS=${JSON.stringify(value)} → ${expectOff ? "the pre-#2649 answer" : "the #2649 classification"} (got ${r.mode}/${r.fallbackReason ?? "-"})`,
    );
  });
}

console.log(exit === 0 ? "\nAll #2649 off-arm golden checks passed." : "\nFAILED");
process.exit(exit);
