#!/usr/bin/env bun
/**
 * lean/verify — a frozen test that FLOODS its output is not a hang (#2085).
 *
 * `execp`'s group executor kills a run two ways. The wall clock stamps
 * `killed: true` + `timedOutKill: true`; `maxBuffer` stamps `killed: true` too, with
 * `timedOutKill: false` and the stream named in `overflow` — the distinction
 * `tierObserved` in `verify-baseline.ts` already makes. `runTestFile` asked only
 * `wasKilled`, so the flood arrived as `infraShape: "killed"` and `frozenTestFailure`
 * graded it with the hangs: a test that printed too much came back
 * `frozen tests timed out (the head's code may hang)` and the next build round went
 * looking for a loop that was never there.
 *
 * The classifier now asks about the overflow FIRST — an overflow IS a kill, so the
 * other order cannot tell them apart — and the flood becomes its own shape, which
 * `frozenTestFailure` throws exactly as it throws a runner that never started.
 *
 *   (a) the flood really overflows: the kill, the stamps and the classification all
 *       come from the real `execp`, with the runner's own bound shrunk by the case
 *   (b) a flood and a genuine hang are the two different shapes, from two real kills
 *   (c) the graded hang is untouched: a hang is still a red, the flood is a throw
 *
 * A stub could answer (c) but not (a): only the executor knows when its own bound
 * breaks, and a hand-stamped rejection would prove the classifier reads a stamp
 * rather than that the flood it is meant to catch reaches it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { runTestFile } from "../src/lean/specify-proof.ts";
import { frozenTestFailure } from "../src/lean/verify-steps.ts";
import { VerifyInfraError, type VerifyExec } from "../src/lean/verify-types.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ROOT = mkdtempSync(path.join(tmpdir(), "lean-frozen-flood-"));
const FLOOD_FILE = "tests/AC2-flood.test.sh";
/** Enough bytes to break any bound the case can name, without being a big write. */
const FLOOD_BYTES = 1_000_000;

/** A frozen test that names itself, prints a flood, and finishes — no hang in it. */
function floodingTest(rel: string): string {
  return (
    "#!/bin/sh\n" +
    `echo "not ok - ${rel}" 1>&2\n` +
    `yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c ${FLOOD_BYTES}\n` +
    "exit 1\n"
  );
}

/** A frozen test that names itself and then never returns: the real hang. */
function hangingTest(rel: string): string {
  return `#!/bin/sh\necho "not ok - ${rel}" 1>&2\nsleep 30\n`;
}

const wt = path.join(ROOT, "wt");
mkdirSync(path.join(wt, "tests"), { recursive: true });
writeFileSync(path.join(wt, FLOOD_FILE), floodingTest(FLOOD_FILE), { mode: 0o755 });
writeFileSync(path.join(wt, "tests/AC3-hang.test.sh"), hangingTest("tests/AC3-hang.test.sh"), {
  mode: 0o755,
});

const exec: VerifyExec = (cmd, o) =>
  // The frozen runner reaches the executor with the bound the case names (see
  // `TestRunLimits.maxBuffer`); a real `runTestFile` passes the production 8 MiB.
  // `execp` is what kills the run and stamps the rejection, in both paths.
  execp(cmd, { ...o, maxBuffer: 64 * 1024 });

// ---------------------- (a) a run whose output breaks the bound classifies as `overflowed`
{
  const proof = await runTestFile(exec, {
    wt,
    template: "sh {file}",
    file: FLOOD_FILE,
    // The case shrinks the runner's OWN bound, so the executor's overflow kill is
    // what fires; nothing here stamps the rejection by hand.
    limits: { timeoutMs: 30_000, maxBuffer: 64 * 1024 },
  });
  assert(
    proof.kind === "infra",
    `(a) a flooded run is infra, not a verdict (got ${proof.kind})`,
  );
  assert(
    proof.kind === "infra" && proof.infraShape === "overflowed",
    `(a) and its shape is the overflow, never the kill (got ${proof.kind === "infra" ? proof.infraShape : proof.kind})`,
  );
  assert(
    proof.kind === "infra" && /output passed the executor's bound/.test(proof.detail),
    `(a) the detail says the output bound is what broke (${proof.kind === "infra" ? proof.detail : ""})`,
  );
  assert(
    proof.kind === "infra" && !/timed out|killed/.test(proof.detail),
    `(a) nothing in the reason claims a timeout or a kill (${proof.kind === "infra" ? proof.detail : ""})`,
  );
}

// ------------------ (b) a flood and a hang are the two shapes, both from real kills
{
  const flooded = await runTestFile(exec, {
    wt,
    template: "sh {file}",
    file: FLOOD_FILE,
    limits: { timeoutMs: 30_000, maxBuffer: 64 * 1024 },
  });
  const hung = await runTestFile(exec, {
    wt,
    template: "sh {file}",
    file: "tests/AC3-hang.test.sh",
    limits: { timeoutMs: 300 },
  });
  assert(
    flooded.kind === "infra" && flooded.infraShape === "overflowed",
    `(b) the flood is "overflowed" (got ${flooded.kind === "infra" ? flooded.infraShape : flooded.kind})`,
  );
  assert(
    hung.kind === "infra" && hung.infraShape === "killed",
    `(b) the hang is "killed" (got ${hung.kind === "infra" ? hung.infraShape : hung.kind})`,
  );
}

// --------------- (c) the step throws for the flood, and still grades the hang red
{
  const r = await frozenTestFailure(
    { [FLOOD_FILE]: floodingTest(FLOOD_FILE) },
    "sh {file}",
    wt,
    // The runner's bound comes from `exec` above, exactly as its 8 MiB default comes
    // from `runTestFile`: what the case shrinks is the executor's bound, not a stamp.
    exec,
    // The step's per-file wall clock, generous here so the ONLY kill this run can
    // take is the output one — a timeout would classify `killed`, not `overflowed`.
    30_000,
  ).then(
    (ran) => ({ ran, threw: undefined as Error | undefined }),
    (err: unknown) => ({ ran: undefined, threw: err as Error }),
  );
  assert(
    r.threw instanceof VerifyInfraError,
    `(c) a frozen test that floods its output throws VerifyInfraError rather than being graded (got ${r.ran?.kind ?? `${r.threw?.name}: ${r.threw?.message}`})`,
  );
  assert(
    (r.threw?.message ?? "").includes("could not be judged"),
    `(c) the throw says the frozen test could not be judged, as an un-startable runner does (${r.threw?.message})`,
  );
  assert(
    r.threw !== undefined && !/may hang/.test(r.threw.message),
    `(c) the reason does not accuse the code of hanging (${r.threw?.message})`,
  );
}

{
  const r = await frozenTestFailure(
    { "tests/AC3-hang.test.sh": hangingTest("tests/AC3-hang.test.sh") },
    "sh {file}",
    wt,
    exec,
    300,
  );
  assert(
    r.kind === "fail" && r.reason.includes("may hang"),
    `(c) a real hang is still graded red with the hang wording, untouched by this fix (got ${r.kind})`,
  );
}

rmSync(ROOT, { recursive: true, force: true });
process.exit(exit);
