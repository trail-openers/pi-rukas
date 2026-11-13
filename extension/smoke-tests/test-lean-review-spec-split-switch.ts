#!/usr/bin/env bun
/**
 * The `PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT` switch is documented, and off ONLY on
 * `"0"`.
 *
 * Three things an operator and a later edit both need, asserted here and nowhere
 * else: the `docs/configuration.md` row (a `HEADLESS_INPUTS` entry nobody can
 * discover is a knob that does not exist), the truth table on the exported reader
 * (on for unset, `"1"`, `""` and `"false"`; off for the literal `"0"`), and a
 * sentence on `docs/lean.md`'s `review` row saying what the three review seats
 * actually see — the docs criterion this feature ships with, which no other gate
 * in the repo checks.
 *
 * The reader is read at CALL time, so every case pins the environment with
 * `withEnv`: a pin that leaked from another file in the same run, or an operator's
 * exported `=0`, would otherwise make the ON cases measure the wrong arm.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { leanReviewSpecSplitEnabled } from "../src/lean/review-spec-split.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const docs = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

{
  const doc = docs("configuration.md");
  assert(
    doc.includes("`PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT",
  );
  assert(
    doc.includes("…(criteria truncated)"),
    "and that row names the criteria marker, so an operator can tell the two cuts apart from the docs alone",
  );
}

{
  // The `review` row of the step table is where a reader learns what the gates
  // read; it must say the criteria arrive whole and un-truncated.
  const row = docs("lean.md")
    .split("\n")
    .find((l) => l.startsWith("| `review` |")) ?? "";
  assert(row !== "", "docs/lean.md has a `review` row");
  assert(
    row.includes("PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT"),
    "and it names the switch, so the behaviour is discoverable from the step's own row",
  );
  for (const needle of [
    "acceptance criteria",
    "own section",
    "printed in full",
    "pi-spec v1",
    "stripped",
  ]) {
    assert(row.includes(needle), `and the review row states what the reviewers see: "${needle}"`);
  }
}

await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: undefined }, async () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: value }, async () => {
      assert(
        leanReviewSpecSplitEnabled() === want,
        `PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }
});

console.log(`\n${failures() === 0 ? "switch green" : "switch RED"} (${String(failures())} failing)`);
process.exit(failures());
