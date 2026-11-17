#!/usr/bin/env bun
/**
 * lean/engine — `ready`'s facts land on the RUN, not only on its step.
 *
 * `settle()` copies `ready`'s two run-level fields off its verdict with
 * `applyReadyFacts`, and the copy is gated on the step's STATE. The step's KEY is
 * `<issue>:<state>:<n>` — `740:ready:1`, never the bare word `ready` — so a gate that
 * compares the key to `"ready"` is false in every drive, and the copy never fires.
 *
 * That is not a cosmetic miss. A derived contract exists on no issue: `ready` minted
 * it, and the run's record is the only place it lives. If it never reaches `run`
 * (`state.ts`'s `derivedSpec`), then on a resume — and in every later step, each of
 * which reads it through `loadRun` — `specFor(body, ctx.run)` falls back to the prose
 * body and refuses with `no pi-spec v1 block`: the derive mode's whole point, lost at
 * the step where a build has already been paid for.
 *
 * So the case drives the REAL `runLean` and the REAL `ready` handler and asserts on
 * what a later reader would see:
 *
 *   (a) the record `loadRun` returns carries `derivedSpec` at the run level, deep-equal
 *       to the contract the stubbed child drafted — `loadRun` is the only reader a
 *       resume has, so a field that exists only on the in-memory return value is a
 *       field that never landed;
 *   (b) the ready STEP holds the same document, so run and log agree about the contract
 *       the run executes (the two copies are written by one save). Both halves are read
 *       off `loadRun`, never off the bytes: the field is written by the engine and read
 *       back by the loader, and the only symptom of a loader that rebuilds it wrong is
 *       that the loaded step has no key for it — which a raw-bytes comparison, reading
 *       the same file the writer just wrote, cannot see. `baseSha` is asserted beside
 *       `derivedSpec` because one writer puts both on the step and the loader had no
 *       clause for either;
 *   (c) the next step's handler received a `run` holding it — exactly the object the
 *       later steps' own `specFor(body, ctx.run)` consults.
 *
 * (d) is the control that makes (a)–(c) mean derive mode specifically: a `require` run
 * over the same prose ticket is refused and carries no derived spec, so the assertions
 * above cannot pass on a fixture that leaked the mode.
 *
 * Everything offline: a real git repo for the base proof and the config read, the issue
 * read stubbed, `PI_ENSEMBLE_FORGE=none`, one stubbed drafting child. The `ready`
 * handler is production's — see the fixture for the seams.
 */

import { specFor } from "../src/lean/spec-for.ts";
import { isFullCommitSha } from "../src/commit-sha.ts";
import {
  DERIVED_SPEC,
  ISSUE,
  PROSE,
  driveDerivedRun,
  rawRecordOf,
  recordOf,
} from "./lib/lean-spec-intake-record-fixture.ts";

let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) console.log(`✓ ${label}`);
  else {
    failed++;
    console.log(`✗ ${label}`);
  }
}

/** A stable rendering for an assertion's expected/got pair. */
function json(value: unknown): string {
  return JSON.stringify(value);
}

// ── (a)–(c): a derive-mode run carries its contract on the record and to the next step.
{
  const driven = await driveDerivedRun({ tag: "derive" });
  try {
    const stored = recordOf(driven.dir);
    const recorded = stored?.derivedSpec;
    // BOTH halves of the step's copy come off `loadRun`, not off the bytes. The raw file is
    // written by the engine's own save path with no validation, so reading it back proves the
    // engine wrote a field and nothing about whether the loader keeps it — which is precisely
    // the defect this case exists to catch.
    const readyStep = stored?.steps.find((s) => s.state === "ready");
    const savedStep = readyStep?.outcome;

    assert(
      driven.run?.run.steps.find((s) => s.state === "ready")?.outcome?.kind === "ok",
      `the real ready step decided ok for a prose ticket in derive mode (state=${String(
        driven.run?.state,
      )} reason=${json(driven.run?.run.result?.reason)})`,
    );
    assert(stored !== undefined, `…and the engine left a record on disk at issue ${ISSUE}`);
    assert(
      /"derivedSpec"/.test(rawRecordOf(driven.dir)),
      "…and the bytes the engine wrote name derivedSpec, not just the in-memory return value",
    );
    assert(
      recorded !== undefined,
      `…and loadRun's record carries derivedSpec at the run level (got ${json(recorded)})`,
    );
    assert(
      json(recorded?.spec) === json(DERIVED_SPEC),
      `…and the contract on the record is the one the child drafted (want ${json(
        DERIVED_SPEC,
      )} got ${json(recorded?.spec)})`,
    );
    // The provenance is the run's own model resolution, which a case cannot name in
    // advance; what it MUST be is the document the step itself recorded.
    assert(
      json(savedStep?.derivedSpec) === json(recorded),
      `…and the run-level copy is the step's own, provenance included (run=${json(
        recorded,
      )} step=${json(savedStep?.derivedSpec)})`,
    );
    assert(
      typeof recorded?.model === "string" &&
        typeof recorded?.at === "number" &&
        Number.isFinite(recorded.at),
      `…and it carries the provenance a bad derivation is traced by (got ${json(
        recorded === undefined ? undefined : { model: recorded.model, at: recorded.at },
      )})`,
    );
    assert(
      savedStep?.derivedSpec !== undefined,
      `…and the ready step's own record holds it too, so the run and its log agree (loaded step keys ${json(
        savedStep === undefined ? undefined : Object.keys(savedStep),
      )} while the saved bytes name derivedSpec)`,
    );
    assert(
      json(savedStep?.derivedSpec) === json(recorded),
      `…and the step's copy is the run's own, provenance included (run=${json(
        recorded,
      )} step=${json(savedStep?.derivedSpec)})`,
    );
    assert(
      typeof savedStep?.baseSha === "string" && isFullCommitSha(savedStep.baseSha),
      `…and the step records the commit it read the config at, as a full oid (got ${json(
        savedStep?.baseSha,
      )})`,
    );
    assert(
      savedStep?.baseSha === driven.base,
      `…and it is the run's own base, not some other commit (step=${json(
        savedStep?.baseSha,
      )} run base=${json(driven.base)})`,
    );

    // (c) The read the later steps actually perform: the same accessor, on the object
    // the engine handed the next step's handler. A prose body plus a run that holds the
    // contract resolves to that contract, from the record, provenance `derived`.
    const read = specFor(PROSE, driven.ctxRun);
    assert(
      driven.ctxRun !== undefined,
      "…and the step after ready really ran, with a run in its context",
    );
    assert(
      read.ok === true && read.source === "derived",
      `…and that run is enough for specFor to return the derived contract (got ${json(read)})`,
    );
    assert(
      read.ok && json(read.spec) === json(DERIVED_SPEC),
      `…and the contract it returns is the recorded one (got ${json(
        read.ok ? read.spec : null,
      )})`,
    );
  } finally {
    driven.cleanup();
  }
}

// ── (d) the control: the same drive with the mode left at `require` carries no contract.
{
  const driven = await driveDerivedRun({ tag: "require", intake: "require" });
  try {
    const stored = recordOf(driven.dir);
    const readyKind = stored?.steps.find((s) => s.state === "ready")?.outcome?.kind;
    assert(
      readyKind === "fail",
      `a require-mode run really refused the prose ticket (got ${json(readyKind)})`,
    );
    assert(
      stored?.derivedSpec === undefined,
      `…and carries no derivedSpec at the run level (got ${json(stored?.derivedSpec)})`,
    );
    assert(
      specFor(PROSE, driven.ctxRun ?? {}).ok === false,
      "…and its next step's specFor really does refuse the prose body, so (a)–(c) are about derive mode",
    );
  } finally {
    driven.cleanup();
  }
}

process.exit(failed);
