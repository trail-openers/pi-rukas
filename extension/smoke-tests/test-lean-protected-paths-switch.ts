#!/usr/bin/env bun
/**
 * The `PI_ENSEMBLE_LEAN_PROTECTED_PATHS` switch — documented, and off ONLY on
 * `"0"`.
 *
 * Three things an operator and a later edit both need, asserted here and nowhere
 * else: the `docs/configuration.md` row (a `HEADLESS_INPUTS` entry nobody can
 * discover is a knob that does not exist), the truth table on the exported reader
 * (on for unset, `"1"`, `""` and `"false"`; off for the literal `"0"`), and the
 * two interaction facts the row promises:
 *
 *   - `"0"` disables the CONFIGURED globs only — the built-in reverts belong to
 *     `work-driver-doctrine.ts`, which this reader never imports, and the behaviour
 *     half of that claim is pinned in `test-lean-protected-paths.ts` (d) and
 *     `test-lean-review-fix-capture.ts` (e), each of which keeps a built-in edit as
 *     its control inside the off arm;
 *   - the process-wide `PI_ENSEMBLE_PROTECTED_PATHS` is a DIFFERENT knob and is not
 *     consulted here. It is classic `/work`'s gate kill-switch and takes the
 *     built-ins with it, so a lean run would lose its revert for a reason the
 *     operator aimed at the classic driver. Pinning that means setting the two
 *     against each other rather than trusting the prose.
 *
 * The reader is read at CALL time, so every case pins the environment with
 * `withEnv`: a pin that leaked from another file in the same run, or an operator's
 * exported `=0`, would otherwise make the ON cases measure the wrong arm.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { leanProtectedPathsEnabled } from "../src/lean/protected-paths-switch.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const doc = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

{
  const text = doc("configuration.md");
  assert(
    text.includes("`PI_ENSEMBLE_LEAN_PROTECTED_PATHS`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_PROTECTED_PATHS",
  );
  for (const needle of [
    "lean.protectedPaths",
    "Only the literal `0`",
    "built-in list",
    "PI_ENSEMBLE_PROTECTED_PATHS",
    "not consulted here",
  ]) {
    assert(
      text.includes(needle),
      `and that row states the scope claim an operator needs: "${needle}"`,
    );
  }
}

{
  // The docs criterion this feature ships with: `docs/lean.md` must document the
  // field, its matcher semantics, its validity rules AND the residual — no other
  // gate in the repo checks any of the four.
  const text = doc("lean.md");
  for (const needle of [
    "`lean.protectedPaths`",
    "gitignore-style",
    "zero or more",
    "at any depth",
    "LeanConfigError",
    "matched nothing",
    "--allow-protected",
  ]) {
    assert(text.includes(needle), `docs/lean.md documents the field and its rules: "${needle}"`);
  }
}

await withEnv({ PI_ENSEMBLE_PROTECTED_PATHS: undefined }, async () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_LEAN_PROTECTED_PATHS: value }, async () => {
      assert(
        leanProtectedPathsEnabled() === want,
        `PI_ENSEMBLE_LEAN_PROTECTED_PATHS=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }

  // The two knobs do not speak to each other: the classic driver's kill-switch set
  // to `0` must not read as "lean's configured globs are off", and setting it to
  // `1` must not read as "on" when lean's own knob says off.
  await withEnv({ PI_ENSEMBLE_PROTECTED_PATHS: "0" }, async () => {
    assert(
      leanProtectedPathsEnabled() === true,
      "PI_ENSEMBLE_PROTECTED_PATHS=0 leaves the lean configured globs ON — a different knob, a different scope",
    );
  });
  await withEnv(
    { PI_ENSEMBLE_PROTECTED_PATHS: "1", PI_ENSEMBLE_LEAN_PROTECTED_PATHS: "0" },
    async () => {
      assert(
        leanProtectedPathsEnabled() === false,
        "and PI_ENSEMBLE_PROTECTED_PATHS=1 cannot turn the lean globs back on over an explicit `0`",
      );
    },
  );
});

console.log(
  `\n${failures() === 0 ? "switch green" : "switch RED"} (${String(failures())} failing)`,
);
process.exit(failures());
