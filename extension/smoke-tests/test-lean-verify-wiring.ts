#!/usr/bin/env bun
/**
 * lean/verify + lean/handback — the wiring the steps run under.
 *
 * The steps' own behaviour is test-lean-verify.ts. This file pins the two things
 * a later edit could quietly undo: that `phase1Handlers` really wires the step
 * (a notBuilt stub answers `done` and would let a run walk past its own gate),
 * and that the record refuses a `verifiedHead` that is not a commit sha — since
 * the land gate later compares that field to the PR head, a truncated or mistyped
 * value surviving a save/load round trip is a gate that silently never matches.
 *
 *   (n) phase1Handlers.verify is the real step, not the stub
 *   (o) phase1Handlers.handback is the real step, not the stub
 *   (p) a green outcome round-trips verifiedHead through the durable record
 *   (q) a `verifiedHead` that is not 40-hex is refused on load
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { phase1Handlers } from "../src/lean/command.ts";
import { type LeanRun, type Outcome, leanStateFile, loadRun, saveRun } from "../src/lean/state.ts";
import { VerifyInfraError } from "../src/lean/verify-types.ts";
import { ROOTS, buildFixtureForWiring } from "./lib/lean-verify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --------------------------- (n) the verify handler is the step, not the stub
{
  const f = buildFixtureForWiring(301);
  const verify = phase1Handlers(f.repoRoot, 301).verify;
  const settled = verify
    ? await verify(f.ctx).then(
        (o) => o,
        (err: unknown) => err,
      )
    : "no verify handler";
  assert(
    settled instanceof VerifyInfraError,
    `(n) phase1Handlers.verify is the real step (got ${settled instanceof Error ? settled.message : JSON.stringify(settled)})`,
  );
  // The stub's answer is `done`; the real step got as far as its own config read
  // and refused there, which is the other half of "this is not the stub".
  assert(
    !((settled as Error).message ?? "").includes("not built yet"),
    `(n) its refusal is the step's own, not the stub's (${(settled as Error).message})`,
  );
}

// -------------------------- (o) the handback handler is the step, not the stub
{
  const f = buildFixtureForWiring(302);
  const handback = phase1Handlers(f.repoRoot, 302).handback;
  const settled = handback
    ? await handback(f.ctx).then(
        (o) => o,
        (err: unknown) => err,
      )
    : "no handback handler";
  // It never throws: with no forge adapter in a temp repo it reports `done` and
  // says the comment did not go out. The stub would say "work-lean stage handback
  // is not built yet", which is a different sentence and the point of the case.
  assert(
    settled instanceof Object && (settled as Outcome).kind === "done",
    `(o) phase1Handlers.handback is the real step (got ${JSON.stringify(settled)})`,
  );
  assert(
    !((settled as Outcome).reason ?? "").includes("not built yet"),
    `(o) and its reason is its own, not the stub's (${(settled as Outcome).reason})`,
  );
}

// --------------------- (p) verifiedHead survives the durable record round trip
{
  const dir = mkdtempSync(path.join(tmpdir(), "lean-verify-state-"));
  ROOTS.push(dir);
  const head = "c".repeat(40);
  const run: LeanRun = {
    schema: 1,
    issue: 303,
    version: "test",
    models: {},
    baseSha: "a".repeat(40),
    branch: "lean/issue-303",
    state: "verify",
    counters: {
      buildAttempts: 1,
      challengeDone: false,
      reviewDone: false,
      ciFixUsed: false,
      draft: false,
    },
    steps: [
      {
        key: "303:verify:0",
        state: "verify",
        startedAt: 1,
        endedAt: 2,
        outcome: { kind: "green", reason: "passed", verifiedHead: head },
      },
    ],
  };
  saveRun(dir, run);
  const back = loadRun(dir, 303);
  assert(back?.steps[0]?.outcome?.verifiedHead === head, "(p) verifiedHead round-trips intact");
  assert(
    leanStateFile(dir, 303).includes("303.json"),
    "(p) the record lives where the engine looks",
  );
}

// ---------------------------- (q) a malformed verifiedHead is refused on load
{
  const dir = mkdtempSync(path.join(tmpdir(), "lean-verify-bad-"));
  ROOTS.push(dir);
  for (const bad of ["c".repeat(39), "z".repeat(40), "c".repeat(64)]) {
    const run: LeanRun = {
      schema: 1,
      issue: 304,
      version: "test",
      models: {},
      baseSha: "a".repeat(40),
      branch: "lean/issue-304",
      state: "verify",
      counters: {
        buildAttempts: 1,
        challengeDone: false,
        reviewDone: false,
        ciFixUsed: false,
        draft: false,
      },
      steps: [
        {
          key: "304:verify:0",
          state: "verify",
          startedAt: 1,
          outcome: { kind: "green", verifiedHead: bad },
        },
      ],
    };
    saveRun(dir, run);
    let refused = "";
    try {
      loadRun(dir, 304);
    } catch (err) {
      refused = (err as Error).message;
    }
    assert(refused.includes("verifiedHead"), `(q) ${bad.slice(0, 6)}… is refused (${refused})`);
  }
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
