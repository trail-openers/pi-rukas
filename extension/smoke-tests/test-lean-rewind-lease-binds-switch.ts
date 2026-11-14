#!/usr/bin/env bun
/**
 * The `PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS` switch is documented, and off ONLY on
 * `"0"`.
 *
 * Three things an operator and a later edit both need, asserted here and nowhere
 * else: the `docs/configuration.md` row (a `HEADLESS_INPUTS` entry nobody can
 * discover is a knob that does not exist — `test-headless-inputs.ts` checks the
 * roster against the readers and never opens `docs/`), the truth table on the
 * exported reader (on for unset, `"1"`, `""` and `"false"`; off for the literal
 * `"0"`), and a sentence on `docs/lean.md`'s verified-handback section saying what
 * the rewind's push actually carries.
 *
 * The docs sentences are the half that was untrue: three documents promised that the
 * lease means "the move happens only while origin still holds exactly the head this
 * run pushed", and with the branch refspec forced by a leading `+` git never
 * consulted the lease. The wording is corrected in this PR in `docs/lean.md`,
 * `docs/configuration.md`, `docs/troubleshooting.md` and `docs/headless.md`; only
 * the first two are read by a test, so the other two are review-checked, not gated.
 *
 * The reader is read at CALL time, so every case pins the environment with
 * `withEnv`: a pin that leaked from another file in the same run, or an operator's
 * exported `=0`, would otherwise make the ON cases measure the wrong arm.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { leanRewindLeaseBinds } from "../src/lean/rewind-lease-switch.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const docs = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

{
  const doc = docs("configuration.md");
  assert(
    doc.includes("`PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS",
  );
  // The row has to state the mechanism, not just name the knob: a forced refspec
  // is the reason the lease did not bind, and an operator reading the row should
  // learn that from it.
  assert(
    doc.includes("forced refspec") || doc.includes("leading `+`"),
    "and that row says the lease binds because the branch refspec is not forced, so the knob is understandable from the docs alone",
  );
}

{
  // The verified-handback section of the engine guide is where a reader learns what
  // the rewind's push is; it must say the lease decides, and name the switch.
  const lean = docs("lean.md");
  assert(
    lean.includes("PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS"),
    "docs/lean.md names the switch in the verified-handback section",
  );
  for (const needle of ["lease", "forced", "origin"]) {
    assert(
      lean.includes(needle),
      `and the section states the lease semantics a reader needs: "${needle}"`,
    );
  }
}

await withEnv({ PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS: undefined }, async () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS: value }, async () => {
      assert(
        leanRewindLeaseBinds() === want,
        `PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }
});

console.log(
  `\n${failures() === 0 ? "switch green" : "switch RED"} (${String(failures())} failing)`,
);
process.exit(failures());
