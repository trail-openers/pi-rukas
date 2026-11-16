#!/usr/bin/env bun
/**
 * #2319 — the `PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL` switch is documented, and off ONLY on `"0"`.
 *
 * The rule this knob gates: a lean worktree's submodules are seeded from the SUPERPROJECT —
 * its module store under `.git/modules/<path>`, else its populated checkout — through a
 * per-path URL this harness computes, instead of git cloning each one from the URL
 * `.gitmodules` records. The field failure was an offline benchmark trial that handed back at
 * exit 10 over a transport while the operator's own checkout held the bytes.
 *
 * This is the switch's own contract, the parts nothing else observes: the docs row an operator
 * reads, and the truth table that makes `"0"` the ONLY off value. The behaviour is pinned where
 * it can be seen — `test-lean-submodule-local-source.ts` (the seeding, the no-network argv,
 * the disclosure, the depth rule, and the switch-off arm against origin/main's argv),
 * `test-lean-submodule-disclosure.ts` (the disclosure reaching a reason), and
 * `test-lean-specify-submodule.ts` (e3: the transport licence confined to one call).
 *
 * Two things this row has to say, because the switch is not a peer of its outer gate:
 * `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` WINS over it — with the runner untrusted no submodule
 * code runs at all, so this knob is observable only with preflight on — and `0` restores the
 * release's own call byte for byte, the `git config --file .gitmodules --get-regexp path`
 * probe included, for the operator whose submodule genuinely lives on a remote.
 *
 * The docs row is asserted here and nowhere else: `test-headless-inputs.ts` pins that the knob
 * is LISTED and that its live default agrees, and a knob in `HEADLESS_INPUTS` with no row is
 * one nobody can discover.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { leanSubmodulesLocalEnabled } from "../src/lean/submodules-local-switch.ts";
import { withEnv } from "./lib/env-scope.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`✓ ${msg}`);
  } else {
    failed++;
    console.log(`✗ ${msg}`);
  }
}

{
  const doc = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "docs", "configuration.md"),
    "utf8",
  );
  assert(
    doc.includes("`PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL",
  );
  const row = doc.split("\n").find((l) => l.includes("`PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL`")) ?? "";
  // The off arm is the operator's reason to reach for the knob, so the row has to say what `0`
  // puts back — the release's own command, probe included — rather than just "disables the rule".
  assert(
    row.includes("submodule update --init --recursive"),
    "the row names the command the off arm restores",
  );
  assert(
    row.includes("--get-regexp"),
    "the row says the off arm restores the listing probe too, not only the update call",
  );
  // The precedence is the thing an operator comparing two runs gets wrong without it: with the
  // runner untrusted nothing runs at all, so this knob cannot be the explanation for a run that
  // made no submodule call.
  assert(
    row.includes("PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT"),
    "the row names the outer gate that wins over this one",
  );
  assert(
    /superproject/i.test(row) && /disclos/i.test(row),
    "the row says where submodules come from with the knob on, and that a missing one is disclosed",
  );
}

// `withEnv` rather than `delete process.env.…`: the truth table's undefined case has to
// UNSET the variable (an empty string is a value, and this rule reads `""` as on), and the
// helper is what puts an absent variable back absent instead of leaving `undefined` behind.
await withEnv({ PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL: undefined }, async () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["off", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL: value }, async () => {
      assert(
        leanSubmodulesLocalEnabled() === want,
        `PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }
  // Read at CALL time, not at module load: every lean smoke file runs in one bun process and
  // pins arms with `withEnv`, so a load-time read would let one file's pin disarm the rule in
  // the next. The two reads below straddle a change made after the module was loaded.
  await withEnv({ PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL: "0" }, async () => {
    assert(leanSubmodulesLocalEnabled() === false, "the rule is off while the env says 0");
  });
  assert(
    leanSubmodulesLocalEnabled() === true,
    "and back on the moment the env stops saying so, without reloading the module",
  );
});

process.exit(failed === 0 ? 0 : 1);
