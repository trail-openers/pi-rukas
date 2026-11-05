#!/usr/bin/env bun
/**
 * #2051 AC3 — a REAL reviewer child through the real `spawnSpecialist` (stub
 * child process, no Pi, no model, no tokens) that leaves large ALLOCATED bytes
 * under the temp root it ran with is reported on
 * `DispatchResult.operatorConfig`, the same channel the new-`$HOME` entries use:
 * one line, `temp-bytes: <delta> (allocated) during the <role> run`.
 *
 * Cloned from `test-AC4-reviewer-home-entry-spawn.ts` — same `installStubChild`
 * + `stub.body` seam (`stub.body` runs when the child's process is created, so it
 * lands inside the guard's window), and `lib/temp-bytes-stub-2051.ts` for the
 * write itself: real bytes, never a sparse file, because the measure is
 * `st_blocks * 512` and a truncated file would clear the threshold while
 * allocating nothing.
 *
 * TMPDIR is pointed at a scratch dir this case owns for every dispatch: the walk
 * measures the directory TMPDIR names at CALL time, so the fixture measures
 * exactly the directory it controls and never walks the host's real temp dir.
 *
 * Observations: the leak is reported and `ok` is untouched; a child that leaves
 * nothing, and one below the threshold, append nothing and leave the field
 * ABSENT; and the threshold arm is shown non-vacuous at the arm itself.
 */

// Must stay first: points the role prompts at a test-owned dir before src/roles.ts
// resolves them at module load (#1579, same helper as test-AC4).
import "./lib/cancel-prompts.ts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withOperatorConfigGuard } from "../src/spawn-operator-config.ts";
import type { DispatchResult } from "../src/types.ts";
import { TEMP_BYTES_REPORT_THRESHOLD } from "../src/temp-watch.ts";
import { withEnv } from "./lib/env-scope.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";
import { installStubChild } from "./lib/reviewer-child-stub.ts";
import { childFreeTemp, writeRealBytes } from "./lib/temp-bytes-stub-2051.ts";

const SELF = "test-AC3-reviewer-temp-bytes.ts";
isolateLedger();
// The child is a `node` stub, never a Pi process, but the dispatch reaches the
// real `child_process.spawn` seam the suite forbids by default.
process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";
const stub = installStubChild(gitTestEnv());

const realErrWrite = process.stderr.write.bind(process.stderr);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    realErrWrite(`✗ ${SELF}: ${msg}\n`);
    exit = 1;
  }
}

const { spawnSpecialist } = await import("../src/spawn.ts");

/** Bytes a leak case writes: above the 64 MB threshold, small enough to be cheap. */
const LEAK_BYTES = 70 * 1024 * 1024;
const LEAK_NAME = "synthetic-transcript.bin";

/**
 * One dispatch whose child writes `leakBytes` of real content into a temp root
 * this case owns, passed as TMPDIR through the env the spawn hands the child so
 * the parent's walk and the child's writes agree on one directory.
 */
async function dispatchWithLeak(role: string, leakBytes: number | null) {
  const scratch = childFreeTemp("root");
  stub.body =
    leakBytes === null
      ? undefined
      : () => void writeRealBytes(path.join(scratch, LEAK_NAME), leakBytes);
  let res: DispatchResult | undefined;
  await withEnv({ TMPDIR: scratch }, async () => {
    res = await spawnSpecialist({ role, prompt: "review", cwd: mkdtempSync(path.join(os.tmpdir(), `pi-2051-ac3-${role}-`)) }, {});
  });
  stub.body = undefined;
  const written = readdirSync(scratch);
  const lines = (res?.operatorConfig ?? []).filter((l) => l.includes("temp-bytes:"));
  rmSync(scratch, { recursive: true, force: true });
  return { res, lines, written };
}

// 1 — the leak is reported on the same channel as the $HOME entries; ok untouched
{
  const { res, lines, written } = await dispatchWithLeak("code-review-specialist", LEAK_BYTES);
  // The spawn path makes its own entries inside the root we handed it as TMPDIR
  // (the workdir, the per-uid slot dir, bun's compile cache), so "what the child
  // left" is the names neither side owns, not "exactly one entry".
  const left = written.filter(
    (n) => !n.startsWith("pi-2051-ac3-") && !n.startsWith("pi-rukas-") && n !== "node-compile-cache",
  );
  assert(
    left.length === 1 && left[0] === LEAK_NAME,
    `AC3: the child really left one file under the measured temp root (${JSON.stringify(written)})`,
  );
  assert(res?.ok === true, `AC3: the reviewer dispatch still succeeded (${res?.ok})`);
  assert(
    lines.length === 1 &&
      lines[0] === `temp-bytes: ${LEAK_BYTES} (allocated) during the code-review-specialist run`,
    `AC3: one line names the allocated delta and the role (got ${JSON.stringify(res?.operatorConfig ?? [])})`,
  );
}

// 2/3 — nothing left, and a below-threshold leak: no line, and NO field at all
for (const [tag, leak] of [
  ["a reviewer child that leaves nothing", null],
  [`a reviewer child under the ${TEMP_BYTES_REPORT_THRESHOLD}-byte threshold`, 2 * 1024 * 1024],
] as const) {
  const { res, lines, written } = await dispatchWithLeak("code-review-specialist", leak);
  assert(
    lines.length === 0 && res?.operatorConfig === undefined,
    `AC3: ${tag} appends no byte line and leaves operatorConfig absent (got ${JSON.stringify(res?.operatorConfig ?? null)}, root held ${JSON.stringify(written)})`,
  );
}

// 4 — the threshold arm is not vacuous, observed AT the arm: a real guard window
// whose child leaves nothing, and a below-bar delta the child did not produce.
// With the arm in place that delta prints nothing; with the arm removed the same
// delta is a line. If that pair ever goes green-to-green, the threshold is
// decoration and case 1 proved only that a leak gets reported.
{
  const scratch = childFreeTemp("mutant");
  const leak = 8 * 1024 * 1024; // below the bar: the arm's own ground
  let res: DispatchResult | undefined;
  await withEnv({ TMPDIR: scratch }, async () => {
    res = await withOperatorConfigGuard("code-review-specialist", async () => ({
      role: "code-review-specialist",
      ok: true,
      text: "done",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    }));
  });
  const shipped = (res?.operatorConfig ?? []).filter((l) => l.includes("temp-bytes:"));
  const armless = `temp-bytes: ${leak} (allocated) during the code-review-specialist run`;
  assert(
    shipped.length === 0 && !shipped.includes(armless),
    `AC3 mutant "threshold arm removed": a ${leak}-byte delta prints nothing with the arm in place and would print \`${armless}\` without it (got ${JSON.stringify(shipped)})`,
  );
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
