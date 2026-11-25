#!/usr/bin/env bun
/**
 * The `PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE` switch: a whole percent, off only at `0`.
 *
 * Three things the operator and a later edit both need, asserted here and nowhere else: the
 * `docs/configuration.md` row (`test-headless-inputs.ts` checks the roster against the readers and
 * never opens `docs/`), the truth table on the exported reader, and a `docs/lean.md` statement of
 * what the number actually bounds — the pair of steps before the first verify, never a child that
 * is already running.
 *
 * The reader is a single expression over one env name with the default in the same expression, so
 * a value that is not a whole number from 0 to 100 is not a share anyone meant and reads as the
 * default rather than as off. `0` is the ONLY off value. The reader is read at CALL time, so every
 * case pins the environment with `withEnv`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_PRE_VERIFY_SHARE_PERCENT,
  leanPreVerifySharePercent,
} from "../src/lean/pre-verify-share-switch.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const docs = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

{
  const doc = docs("configuration.md");
  assert(
    doc.includes("`PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE",
  );
  const row = doc.split("\n").find((l) => l.startsWith("| `PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE`"));
  assert(row !== undefined, "and that row is an env-table row of its own");
  assert(
    (row ?? "").includes("40") && (row ?? "").includes("`0`"),
    "and that row states the default share and that only 0 turns the whole change off",
  );
  assert(
    (row ?? "").includes("specify") && (row ?? "").includes("challenge"),
    "and that row names the two steps the share bounds",
  );
  assert(
    (row ?? "").includes("never cuts a child already running") ||
      (row ?? "").includes("not a kill"),
    "and that row says the bound is a no-dispatch check and never a kill",
  );
  const lean = docs("lean.md");
  assert(
    lean.includes("PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE") &&
      lean.includes("challenge is skipped") &&
      lean.includes("one verify"),
    "docs/lean.md states the share, the skip rule and the switch",
  );
}

await withEnv({ PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE: undefined }, async () => {
  const cases: [string | undefined, number][] = [
    [undefined, 40],
    ["40", 40],
    ["0", 0],
    ["1", 1],
    ["100", 100],
    ["7", 7],
    // Not a whole percent in range: not a share the operator meant, so the default, never off.
    ["40.5", 40],
    ["-1", 40],
    ["101", 40],
    ["abc", 40],
    ["", 40],
    ["  40 ", 40],
    ["0x10", 40],
    ["1e2", 40],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE: value }, async () => {
      assert(
        leanPreVerifySharePercent() === want,
        `PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }
  assert(
    DEFAULT_PRE_VERIFY_SHARE_PERCENT === 40,
    `the shipped default is 40 (got ${String(DEFAULT_PRE_VERIFY_SHARE_PERCENT)})`,
  );
});

process.exit(failures());
