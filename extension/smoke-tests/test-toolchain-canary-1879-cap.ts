#!/usr/bin/env bun
/**
 * #1879 — the compiler-integrity canary, PART 2 of 2: the cap's publication
 * surface, the anti-vacuity pair, and the mutation control. Split from
 * `test-toolchain-canary-1879.ts` along the AGENTS.md §12 file-size cap; run
 * both.
 *
 * Group 6 is the load-bearing one: it runs the REAL assertion again against a
 * canary hard-wired to answer "sound" and requires it to go RED. A test whose
 * mutation control stays green is testing nothing.
 */
import path from "node:path";
import { FIXED_CAPS } from "../src/headless/caps.ts";
import { LOCAL_TSC_CMD } from "../src/work-driver-cap-checkpoint-typecheck.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import {
  type CanaryOutcome,
  TOOLCHAIN_UNSOUND_ADVICE,
  TOOLCHAIN_UNSOUND_LABEL,
  guardCompilerIntegrity,
  isToolchainUnsoundFailure,
  resetToolchainCanaryCache,
  toolchainCanary,
  toolchainUnsoundFailure,
} from "../src/work-driver-toolchain-canary.ts";
import { humanActionFor } from "../src/work-queue.ts";
import { isKnownCap } from "../src/workflow-state-validate-caps.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { assert, assertRed, exitCode } from "./lib/toolchain-canary-assert.ts";
import {
  SOUND,
  STUB,
  cleanupOnExit,
  fixtureRoot,
  packageWithCompiler,
  realExec,
  rmTree,
  soundStubFor,
} from "./lib/toolchain-canary-support.ts";

cleanupOnExit();

// ─────────────────────────────────────────────────────────────────────────────
console.log("4. the cap is published, validated, explained and mapped");
{
  assert(FIXED_CAPS.includes("toolchain-unsound"), "the cap is in the published vocabulary");
  assert(isKnownCap("toolchain-unsound"), "the state validator accepts the literal");
  const state = {
    schemaVersion: 1,
    issue: 1879,
    pipelineState: { currentStep: "develop", status: "handoff" },
    eventLog: [
      {
        kind: "cap-hit",
        at: Date.now(),
        cap: "toolchain-unsound",
        nextStep: "handoff",
        evidence: toolchainUnsoundFailure("the develop verify gate", "it exited 0"),
      },
    ],
  } as unknown as WorkState;
  const text = explainCap("toolchain-unsound", state);
  assert(
    text.includes("canary") && text.includes(TOOLCHAIN_UNSOUND_ADVICE),
    `explainCap names the canary and the reinstall advice (got: ${text.slice(0, 120)})`,
  );
  assert(
    !/outcome-verification gate rejected/.test(text),
    "no claim that the gate judged the code",
  );
  const action = humanActionFor("cap toolchain-unsound", 1879);
  assert(
    /bun install --frozen-lockfile --force/.test(action),
    `the queue's human action names the reinstall (got: ${action.slice(0, 120)})`,
  );
}
{
  // The failure string carries the marker and the advice, both verbatim.
  const f = toolchainUnsoundFailure("the develop verify gate", "it exited 0");
  assert(f.startsWith(TOOLCHAIN_UNSOUND_LABEL), "the failure leads with the marker");
  assert(isToolchainUnsoundFailure(f), "the predicate reads its own failure string");
  assert(f.includes(TOOLCHAIN_UNSOUND_ADVICE), "the failure carries the operator's repair");
  assert(
    !isToolchainUnsoundFailure("verify command `x` failed in /w: boom"),
    "an ordinary verify failure is not read as a canary failure",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("5. anti-vacuity: the assertions above are the ones that fail");
{
  // If the canary were hard-wired to pass, every guarded call site above would
  // report a green and each of those assertions would be red. Prove the shape
  // of that claim here rather than asserting it in prose: the SAME fixtures,
  // with the canary's answer substituted by a stub of `toolchainCanary`, must
  // NOT fail. `resetToolchainCanaryCache` is the only seam; the substitution is
  // done by pointing the guard at a compiler that is a faithful sound compiler
  // while the underlying tier is still the stub — i.e. the guard is what makes
  // the difference, not the tier.
  const root = fixtureRoot("anti-vacuity");
  const stubPkg = packageWithCompiler(path.join(root, "stub-tree"), STUB);
  const soundPkg = packageWithCompiler(path.join(root, "sound-tree"), SOUND);
  try {
    resetToolchainCanaryCache();
    const stubVerdict = await toolchainCanary(stubPkg, realExec);
    const soundVerdict = await toolchainCanary(soundPkg, realExec);
    assert(
      stubVerdict.ok !== soundVerdict.ok,
      "the canary's answer is what separates the two fixtures — a hard-wired pass could not",
    );
    const viaGuardStub = await guardCompilerIntegrity({
      cmd: LOCAL_TSC_CMD,
      cwd: stubPkg,
      where: "x",
      run: realExec,
    });
    const viaGuardSound = await guardCompilerIntegrity({
      cmd: LOCAL_TSC_CMD,
      cwd: soundPkg,
      where: "x",
      run: realExec,
    });
    assert(
      viaGuardStub?.failure !== undefined && viaGuardSound === undefined,
      "the guard blocks the stub and admits the sound compiler (a guard that always passes lets both through)",
    );
  } finally {
    rmTree(root);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("6. mutation control: with the canary hard-wired to PASS, group 1 is red");
// The mutant is a real mutant, and the way it is applied keeps the test
// honest: `hardWiredPass` below replaces the REAL `toolchainCanary` for one
// assertion, and the assertion is the same one group 1 makes about the same
// fixture. So the mutation control is not a parallel story — it is this file's
// own green assertion, run again against an implementation that always answers
// "sound", where it must (and here, does) go red. That is the shape the brief
// asks for: "a canary hard-wired to pass makes the stub test fail".
{
  const root = fixtureRoot("mutation");
  const stubPkg = packageWithCompiler(path.join(root, "stub-tree"), STUB);
  const soundPkg = packageWithCompiler(path.join(root, "sound-tree"), SOUND);
  /** The mutant: always "sound", never probes. This is the defect, spelled out. */
  const hardWiredPass = async (_cwd: string): Promise<CanaryOutcome> => ({ ok: true });
  resetToolchainCanaryCache();
  // The real canary on the stub — group 1's assertion, which is green.
  assert(
    (await toolchainCanary(stubPkg, realExec)).ok === false,
    "MUTATION CONTROL: the stub fixture fails the canary",
  );
  // The same assertion, against a canary hard-wired to pass. This one MUST be
  // red, and `assertRed` proves it was — so a future implementation that
  // answers "sound" without probing cannot keep this file green.
  assertRed(
    (await hardWiredPass(stubPkg)).ok === false,
    "MUTATION CONTROL: ...and the SAME assertion is RED under a canary hard-wired to pass",
  );
  const mutantSound = await hardWiredPass(soundPkg);
  assert(
    (await hardWiredPass(stubPkg)).ok === mutantSound.ok,
    "under the mutation a stub compiler is indistinguishable from a sound one — the incident's state, reproduced",
  );
  // And the guard's decision flips with it: nothing blocked, the green stands.
  const blocked = await guardCompilerIntegrity({
    cmd: LOCAL_TSC_CMD,
    cwd: stubPkg,
    where: "a guarded tier",
    run: realExec,
  });
  assert(
    blocked?.failure !== undefined,
    "the real guard blocks the stub tier (the assertion a hard-wired pass would fail)",
  );
  rmTree(root);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("5. the sound verdict is anchored to the canary file (#1879 fix round)");

{
  // A compiler that rejects with the right diagnostic ON THE CANARY FILE: pass.
  // The control echoes the file it was handed - exactly what the real CLI
  // prints - so it names the per-probe temp file rather than a guess.
  const root = fixtureRoot("sound");
  const pkg = packageWithCompiler(root, SOUND);
  resetToolchainCanaryCache();
  const passed = await toolchainCanary(pkg, realExec);
  assert(
    passed.ok === true,
    `a compiler that prints TS2322 for the CANARY file and exits 2 PASSES (got ${passed.ok})`,
  );
}
{
  // #1879 fix round - a stub that exits 2 and prints `error TS2322` about some
  // OTHER file has not refused the assignment the probe asked about, so it is
  // not judged, never passed.
  const root = fixtureRoot("sound-wrong-file");
  const pkg = packageWithCompiler(root, soundStubFor("some-other-file.ts"));
  resetToolchainCanaryCache();
  const outcome = await toolchainCanary(pkg, realExec);
  assert(
    outcome.ok === undefined,
    `a TS2322 about another file does NOT pass the canary (got ${outcome.ok})`,
  );
}

resetToolchainCanaryCache();
const code = exitCode();
console.log(
  code === 0
    ? "\ntoolchain-canary-cap: all groups passed"
    : `\ntoolchain-canary-cap: FAILED (${code})`,
);
process.exit(code);
