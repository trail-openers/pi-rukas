#!/usr/bin/env bun
/**
 * The `PI_ENSEMBLE_LEAN_REPORT_BOUND` switch is documented, and off ONLY on
 * `"0"`.
 *
 * Three things an operator and a later edit both need, asserted here and nowhere
 * else: the `docs/configuration.md` row (a `HEADLESS_INPUTS` entry nobody can
 * discover is a knob that does not exist — `test-headless-inputs.ts` checks the
 * roster against the readers and never opens `docs/`), the truth table on the
 * exported reader (on for unset, `"1"`, `""` and `"false"`; off for the literal
 * `"0"`), and a sentence on `docs/lean.md`'s caller's-clock section saying what
 * bounds the routed report.
 *
 * The reader is read at CALL time, so every case pins the environment with
 * `withEnv`: a pin that leaked from another file in the same run, or an operator's
 * exported `=0`, would otherwise make the ON cases measure the wrong arm.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { leanReportBoundEnabled } from "../src/lean/handback-report-bound-switch.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const docs = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

{
  const doc = docs("configuration.md");
  assert(
    doc.includes("`PI_ENSEMBLE_LEAN_REPORT_BOUND`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_REPORT_BOUND",
  );
  // The row has to state the arithmetic, not just name the knob: an operator who
  // sets `=0` is putting an unbounded await back on the one step the clock cannot
  // refuse, and should read that — and the number it is bounded at — from the row.
  assert(
    doc.includes("handoffAllowanceMs") || doc.includes("handoff allowance"),
    "and that row says the bound is the handoff allowance, so the knob is understandable from the docs alone",
  );
  assert(
    doc.includes("handback") && doc.includes("deadline"),
    "and that row names what gets bounded: the report a deadline stop routes into",
  );
}

{
  // The engine guide's caller's-clock section is where a reader learns what the
  // deadline does and does not bound; it has to say the routed report is bounded,
  // say what by, and name the switch.
  const lean = docs("lean.md");
  assert(
    lean.includes("PI_ENSEMBLE_LEAN_REPORT_BOUND"),
    "docs/lean.md names the switch in the caller's-clock section",
  );
  for (const needle of ["allowance", "unbounded", "routed"]) {
    assert(
      lean.includes(needle),
      `and the section states what the reader needs about the routed report: "${needle}"`,
    );
  }
}

await withEnv({ PI_ENSEMBLE_LEAN_REPORT_BOUND: undefined }, async () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_LEAN_REPORT_BOUND: value }, async () => {
      assert(
        leanReportBoundEnabled() === want,
        `PI_ENSEMBLE_LEAN_REPORT_BOUND=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }
});

console.log(
  `\n${failures() === 0 ? "switch green" : "switch RED"} (${String(failures())} failing)`,
);
process.exit(failures());
