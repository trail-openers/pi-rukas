#!/usr/bin/env bun
/**
 * The `PI_ENSEMBLE_LEAN_REQUEST_STALL` switch: default ON, off only at the literal `0`.
 *
 * Three things an operator and a later edit both need, asserted here and nowhere else: the
 * `docs/configuration.md` row (`test-headless-inputs.ts` checks the roster against the readers
 * and never opens `docs/`), the truth table on the exported reader, and a `docs/lean.md`
 * statement of what the lever actually ends — a child whose stream went quiet with no tool
 * call in flight, never a child running a silent command.
 *
 * The reader is one expression over one env name: only the literal `"0"` takes the change
 * out, because a switch a shell accident could flip is a lost cell waiting to happen, and a
 * mangled `" 0 "` or `"false"` is not an operator asking for the pre-change behaviour. It is
 * read at CALL time, so every case pins the environment with `withEnv`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { leanRequestStallEnabled } from "../src/request-stall-policy.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const docs = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

{
  const doc = docs("configuration.md");
  assert(
    doc.includes("`PI_ENSEMBLE_LEAN_REQUEST_STALL`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_REQUEST_STALL",
  );
  const row = doc
    .split("\n")
    .find((l) => l.startsWith("| `PI_ENSEMBLE_LEAN_REQUEST_STALL`"));
  assert(row !== undefined, "and that row is an env-table row of its own");
  assert(
    (row ?? "").includes("`0`") && (row ?? "").includes("ONLY off"),
    "and that row states that 0 is the only off value",
  );
  assert(
    (row ?? "").includes("tool call in flight") && (row ?? "").includes("derived"),
    "and that row names the tool-in-flight exception and says the window is derived",
  );
  const lean = docs("lean.md");
  assert(
    lean.includes("PI_ENSEMBLE_LEAN_REQUEST_STALL") &&
      lean.includes("stall") &&
      lean.includes("AbortController"),
    "docs/lean.md states the lever, its verdict and the switch",
  );
}

await withEnv({ PI_ENSEMBLE_LEAN_REQUEST_STALL: undefined }, async () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["NO", true],
    [" 0 ", true],
    ["00", true],
    // The one value that means it.
    ["0", false],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_LEAN_REQUEST_STALL: value }, async () => {
      assert(
        leanRequestStallEnabled() === want,
        `PI_ENSEMBLE_LEAN_REQUEST_STALL=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }
});

process.exit(failures());
