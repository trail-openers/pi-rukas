#!/usr/bin/env bun
/**
 * The `PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT` switch is documented, and off ONLY on `"0"`.
 *
 * Three things an operator and a later edit both need, asserted here and nowhere else:
 * the `docs/configuration.md` row (a `HEADLESS_INPUTS` entry nobody can discover is a
 * knob that does not exist — `test-headless-inputs.ts` checks the roster against the
 * readers and never opens `docs/`), the truth table on the exported reader (on for unset,
 * `"1"`, `""` and `"false"`; off for the literal `"0"`), and a row that states what the
 * knob actually reaches, so the operator who sets `=0` reads — from the docs alone — that
 * they are putting an unbounded, ungroup-killed network read back on the handback's path.
 *
 * The reader is read at CALL time, so every case pins the environment with `withEnv`: a
 * pin that leaked from another file in the same run, or an operator's exported `=0`,
 * would otherwise make the ON cases measure the wrong arm. The call shape each arm
 * produces is not checked here — `test-lean-handback-origin-net-git-off-arm.ts` pins it
 * against a literal transcribed from the pre-fix call, which is the only way the off arm
 * can be caught drifting rather than agreeing with itself.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { leanHandbackNetGitEnabled } from "../src/lean/handback-net-git-switch.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const docs = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

{
  const doc = docs("configuration.md");
  assert(
    doc.includes("`PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT",
  );
  // The row has to name what the knob routes and what that buys, not just the name: an
  // operator who sets `=0` is putting a credential prompt and an orphaned ssh back on the
  // handback's path, and should read that — and where the reads go instead — from the row.
  assert(
    doc.includes("ls-remote") && doc.includes("origin"),
    "and that row names the reads it reaches: the handback's origin ls-remote calls",
  );
  assert(
    doc.includes("runNetGit") || doc.includes("network-git wrapper"),
    "and that row names where they go with the knob on: the driver's network-git wrapper",
  );
  assert(
    doc.includes("BatchMode") && doc.includes("GIT_TERMINAL_PROMPT"),
    "and that row states what the wrapper supplies, so the knob's cost is legible",
  );
  // The push is the neighbour's argv, and a row that let a reader think this knob moved
  // it would make the two promises unverifiable. The rewind's lease/`--atomic` rule shipped
  // default-on with no switch of its own, so the row states that directly instead of pointing
  // at a knob that no longer exists.
  assert(
    (doc.split("PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT")[1] ?? "").includes("not this switch") &&
      (doc.split("PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT")[1] ?? "").includes("--atomic"),
    "and that row says the rewind push's argv — its --atomic and its lease-bound refspec — is not this knob's",
  );
}

await withEnv({ PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT: undefined }, async () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT: value }, async () => {
      assert(
        leanHandbackNetGitEnabled() === want,
        `PI_ENSEMBLE_LEAN_HANDBACK_NET_GIT=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }
});

console.log(
  `\n${failures() === 0 ? "switch green" : "switch RED"} (${String(failures())} failing)`,
);
process.exit(failures());
