#!/usr/bin/env bun
/**
 * #2212 — the `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT` switch is documented, and off
 * ONLY on `"0"`.
 *
 * #2179 shipped the runner preflight, the reset's submodule init and the
 * never-submitted decline wording with no switch, so a run could not be compared
 * against v0.14.71 at all: every specify paid one extra runner invocation, every
 * lean reset paid a `git submodule update --init --recursive`, and a runner that
 * dies on an empty file ended the run `handed-back` at 10 where the older release
 * declined `not-ready` at 11. This is the switch's own contract — the docs row an
 * operator reads, and the truth table that makes `"0"` the ONLY off value. The
 * behaviour itself is pinned where it can be observed: the off arms of
 * `test-lean-specify-preflight-off.ts`, `test-lean-submodule-reset-off.ts` and
 * `test-lean-specify-decline-wording.ts`, split from the on-arm files for the
 * 500-line gate. The reset's off arm is asserted on the primitive itself, which is
 * where the gate sits: the switch lives inside `resetWorktreeToBase`, not at its six
 * call sites, so one arm there covers `build`'s fold and the review fix round too.
 *
 * The docs row is asserted here and nowhere else: `test-headless-inputs.ts` pins
 * that the knob is LISTED and that its live default agrees, and a knob in
 * `HEADLESS_INPUTS` with no row is one nobody can discover.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { leanRunnerPreflightEnabled } from "../src/lean/runner-preflight-switch.ts";

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
    doc.includes("`PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT",
  );
  // The row is the operator's ONLY statement of the off arm (R6): docs/lean.md and
  // docs/troubleshooting.md describe the default-on behaviour and merely name the
  // way back. So the row has to say what `0` restores, in words a comparison
  // against v0.14.71 can be decided from.
  const row = doc.split("\n").find((l) => l.includes("`PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT`")) ?? "";
  assert(row.includes("v0.14.71"), "the row names the release the off arm restores");
  assert(
    row.includes("submodule") && row.includes("preflight"),
    "the row names both behaviours the switch gates",
  );
}

{
  const saved = process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT;
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    if (value === undefined) delete process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT;
    else process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT = value;
    assert(
      leanRunnerPreflightEnabled() === want,
      `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=${JSON.stringify(value)} reads ${String(want)}`,
    );
  }
  // Read at CALL time, not at module load: every lean smoke file runs in one bun
  // process, so a load-time read would let one file's pin disable the probe in the
  // next. The two calls below are the whole point of that sentence.
  process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT = "0";
  const off = leanRunnerPreflightEnabled();
  delete process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT;
  assert(
    off === false && leanRunnerPreflightEnabled() === true,
    "the reader follows the environment between calls rather than caching it",
  );
  if (saved === undefined) delete process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT;
  else process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT = saved;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
