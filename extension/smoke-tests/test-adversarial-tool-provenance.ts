#!/usr/bin/env bun
/**
 * #1360 lens 4/5 — the `toolPath` provenance marker, seen from both ends.
 *
 * `test-adversarial-ledger-range.ts` proves what a marker DOES (a tool row is
 * bound, a driver row is not). This proves the two things that make it a
 * PROVENANCE claim rather than a parameter:
 *
 *   1. A caller cannot set it, and — the shape that mattered for `boolean` —
 *      cannot CLEAR it. A literal `true` widens through the untyped raw-args
 *      spread, so `toolPath: false` in raw args would have taken the row off
 *      the bindings. It is a branded string for exactly that reason.
 *   2. The `/work` driver path carries none at all, and runs no capture — so
 *      the driver spends no git subprocess on a binding nobody consults.
 *
 * Two halves, deliberately different in shape:
 *
 *   - Arms 1-2 drive the REAL tool registration with the loop stubbed, and read
 *     the params object the tool's `work` thunk handed it. That is the only
 *     object whose contents the issue is about.
 *   - Arms 3-4 drive the REAL loop (spawn stubbed) and observe what it DOES:
 *     how many captures it performed, and the rows the real writer left on
 *     disk. A stubbed loop here would make every one of those assertions read
 *     "it completed" off a mock.
 *
 * The two halves cannot share one process: `adversarial-tool.ts` resolves
 * `./adversarial.ts` once at its own module load, so the module registry either
 * has the stubbed loop (arms 1-2) or the real one (arms 3-4), never both. Each
 * half is therefore a child script, and this file is the runner — the same
 * shape `test-review-ledger-lock.ts` uses for its two-process race.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const here = path.dirname(new URL(import.meta.url).pathname);
const children = [
  ["tool-bound (arms 1-2): the params the tool hands the loop", "arms/tool-params.ts"],
  ["loop-bound (arms 3-4): what the real loop does with the marker", "arms/loop-behaviour.ts"],
];

for (const [label, rel] of children) {
  const script = path.join(here, "lib", rel);
  const r = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    cwd: path.join(here, ".."),
    timeout: 180_000,
    env: { ...process.env, PI_ENSEMBLE_REVIEW_LEDGER_FILE: "" },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const failed = out.split("\n").filter((l) => l.startsWith("✗"));
  assert(
    r.status === 0,
    `${label} — child exited 0${failed.length ? `\n${failed.join("\n")}` : `\n${out.slice(-800)}`}`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
