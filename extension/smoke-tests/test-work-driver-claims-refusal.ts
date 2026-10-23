#!/usr/bin/env bun
/**
 * #1454 r3 — what a REFUSED claims registration tells the operator.
 *
 * Split from `test-work-driver-claims-lock-publish.ts` for the 500-line gate
 * (AGENTS.md §12) along the seam that file already had: that one asserts the
 * LOCK's internal properties (an atomic publish, no stolen holder, no
 * half-created file). This one asserts the two things an OPERATOR sees when the
 * lock refuses — the refusal's wording, and the cap the plan step records.
 *
 * Both are load-bearing and both regressed silently before:
 *
 * 1. The two refusals were one string. "Held by another cycle for over 5000ms"
 *    and "the lockfile cannot be created; check that .pi/work-state is
 *    writable" prescribe OPPOSITE actions (wait vs. chmod), so they are now
 *    distinct texts and pinned as such.
 *
 * 2. The refusal escaped `checkAndRegisterClaims` and the driver recorded
 *    `driver-crash:plan`, whose sentence reads "an unhandled error in the step
 *    handler". That sends the operator to debug the driver when the filesystem
 *    is what is broken. It is now a named `claims-lock-unavailable` park whose
 *    explanation names the directory.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { explainCap } from "../src/work-driver-explain.ts";
import { checkAndRegisterClaims, registerClaim } from "../src/work-driver-path-claims.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { workStateDir } from "../src/workflow-state.ts";
import { makeState } from "./lib/claims-test-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-claims-refusal-"));
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

console.log("\n#1454 r3 — the claims-lock refusal, as the operator reads it...");

{
  // 1 — the operator's real case: `.pi/work-state` not writable.
  //
  // A directory at the lock path makes the waiter report a BUSY lock (it
  // cannot tell a leftover directory from a file a sibling just released — both
  // `stat` as absent), so that shape lives in
  // `test-work-driver-claims-lock-publish.ts`. This is the one that actually
  // happens in the field: the lock DIRECTORY is read-only, so
  // `open(path,'wx')` fails EACCES — and this is the refusal that must name the
  // writable directory.
  const dir = tmpDir();
  try {
    const lockDir = workStateDir(dir);
    mkdirSync(lockDir, { recursive: true });
    chmodSync(lockDir, 0o500); // r-x: no write bit — EACCES on create
    let err: Error | null = null;
    const t0 = Date.now();
    try {
      await registerClaim(dir, 773, ["src/readonly.ts"]);
    } catch (e) {
      err = e as Error;
    }
    const waited = Date.now() - t0;
    chmodSync(lockDir, 0o700);
    assert(err !== null, "an unwritable .pi/work-state makes registerClaim throw");
    assert(
      err?.message.includes("cannot be created; check that .pi/work-state is writable"),
      `the refusal names the writable-directory fix (${err?.message.slice(0, 110)}…)`,
    );
    assert(
      waited < 2000,
      `it reports the fault at once (${waited}ms) instead of waiting out the window on a lock nobody holds`,
    );
    let claimsExist = true;
    try {
      readFileSync(path.join(lockDir, "path-claims.json"), "utf8");
    } catch {
      claimsExist = false;
    }
    assert(!claimsExist, "no claim reached the registry through an unwritable directory");
  } finally {
    try {
      chmodSync(workStateDir(dir), 0o700);
    } catch {
      /* already restored, or never created */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // 2 — the plan step turns the refusal into a NAMED cap-hit, not a crash.
  //
  // The legibility fix: `driver-crash:plan` explains itself as "an unhandled
  // error in the step handler", which sends the operator to debug the driver
  // when `.pi/work-state` is what is broken. `checkAndRegisterClaims` converts
  // the fail-closed throw into `claims-lock-unavailable` with the refusal as
  // evidence, and `explainCap` reads it back as the actionable sentence.
  const dir = tmpDir();
  try {
    const lockDir = workStateDir(dir);
    mkdirSync(lockDir, { recursive: true });
    chmodSync(lockDir, 0o500);
    const ctx = { repoRoot: dir, issue: 774 } as unknown as Parameters<
      typeof checkAndRegisterClaims
    >[0];
    let outcome: Awaited<ReturnType<typeof checkAndRegisterClaims>> | null = null;
    let escaped: Error | null = null;
    try {
      outcome = await checkAndRegisterClaims(ctx, makeState(774, dir), {
        default: { paths: ["src/locked.ts"], outOfScope: [] },
      });
    } catch (e) {
      escaped = e as Error;
    }
    chmodSync(lockDir, 0o700);
    // #1756 — the gate now reports its own park, so this case reads BOTH halves
    // of the contract: the event it appended, and the discriminant its caller
    // branches on.
    assert(
      outcome?.parked === true,
      `the gate reports its own park (got ${String(outcome?.parked)})`,
    );
    const state = outcome?.state ?? null;
    assert(
      escaped === null,
      `the refusal does not escape the step handler (${escaped?.message.slice(0, 80) ?? "no throw"})`,
    );
    const capHits = (state?.eventLog ?? []).filter((e) => e.kind === "cap-hit") as Extract<
      WorkEvent,
      { kind: "cap-hit" }
    >[];
    const named = capHits[capHits.length - 1];
    assert(
      named?.cap === "claims-lock-unavailable",
      `the park is a named cap-hit, not driver-crash (${String(named?.cap)})`,
    );
    assert(
      state?.pipelineState.status === "handoff" && state.pipelineState.currentStep === "plan",
      "the cycle parks at plan as a handoff, the same shape as a cross-group conflict",
    );
    const sentence = explainCap(named?.cap, state as WorkState);
    assert(
      /writable/.test(sentence) && !/unhandled error in the step handler/.test(sentence),
      `explainCap blames the directory, not the driver (${sentence.slice(0, 90)}…)`,
    );
  } finally {
    try {
      chmodSync(workStateDir(dir), 0o700);
    } catch {
      /* already restored, or never created */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(exit === 0 ? "\nAll claims-lock checks passed." : "\nFAILED");
process.exit(exit);
