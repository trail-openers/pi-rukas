#!/usr/bin/env bun
/**
 * #2334 — a derived contract survives a RESUME in the STEP that minted it.
 *
 * Sibling of the resumed host-channel handback case in `test-lean-state-outcome.ts`, which
 * pins that `buildOutcome` — the whitelist `loadRun` runs every outcome through — copies the
 * two halves of the handback's reporting pair. The case here is the same shape against the
 * two fields `OWNER_OF_FIELD` gives to `ready` alone, and it existed as a gap: the loader
 * JUDGED `derivedSpec` (`outcomeProblem` runs it through `derivedSpecProblem`) and then
 * DROPPED it, so a ready step read back `kind,dispatches` where the saved bytes carried the
 * contract and the commit it read the config at.
 *
 * The step-level copy has no production reader today — `applyReadyFacts` copies both onto the
 * RUN at settle time and every later step reads the run's copy — so this is a latent
 * consistency defect, not a live one. What it makes true is that the log and the record agree
 * about the contract the run executed, which is what a resume is entitled to read.
 *
 * Seeded through the same shape the ownership cases in `test-lean-state-outcome.ts` use — a
 * real run's record plus the fields under test — so a refusal or a drop that came from anywhere
 * else would not pass as this rule working.
 *
 * (drive) is the case the rig cannot express: a record produced by the REAL engine, whose
 * base sha is a real commit rather than a fixture constant, loaded through `loadRun` twice.
 * The run-level copy is compared to the step's, and `specFor` is read through the STEP's
 * copy — the read that becomes load-bearing the moment anything starts reading the log.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { specFor } from "../src/lean/spec-for.ts";
import { isFullCommitSha } from "../src/commit-sha.ts";
import { INITIAL_COUNTERS, leanStateFile, loadRun } from "../src/lean/state.ts";
import {
  CLOCK,
  STEP,
} from "./lib/lean-state-outcome-rig.ts";
import {
  DERIVED_SPEC,
  PROSE,
  driveDerivedRun,
  rawRecordOf,
} from "./lib/lean-spec-intake-record-fixture.ts";
import { FIXTURE_BASE_SHA, makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();
const SELF = "test-lean-ready-facts-on-load.ts";
/** `makeAssert` prints the message verbatim, so the suite name rides on each one. */
function check(cond: boolean, msg: string): void {
  assert(cond, `${SELF}: ${msg}`);
}

const json = (value: unknown): string => JSON.stringify(value);

/** A whole derived contract of the shape `ready` writes for a derive run. */
const CONTRACT = { spec: DERIVED_SPEC, model: "rig-model", at: CLOCK };

/**
 * A run with `CONTRACT` on the RECORD beside the step, in `forgedOutcomeField`'s shape.
 *
 * The shared rig seeds the two fields a handback owns and nothing else, and its one use here
 * is the shape of a real record; the run-level `derivedSpec` has to be carried because the
 * claim being pinned is that the log and the run agree, which a seed holding only one copy
 * cannot express.
 */
function seedReadyFacts(dir: string, issue: number, outcome: Record<string, unknown>): void {
  mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
  writeFileSync(
    leanStateFile(dir, issue),
    JSON.stringify(
      {
        schema: 1,
        issue,
        version: "test",
        models: {},
        baseSha: FIXTURE_BASE_SHA,
        branch: `feature/issue-${String(issue)}`,
        state: "specify",
        counters: INITIAL_COUNTERS,
        steps: [STEP(issue, "ready", 0, "ok"), { key: `${String(issue)}:ready:1`, state: "ready", startedAt: CLOCK, endedAt: CLOCK, outcome: { kind: "ok", ...outcome } }],
        derivedSpec: CONTRACT,
      },
      null,
      2,
    ),
    "utf8",
  );
}

// ───────────────────────────────── (resume) the rig-seeded round trip, both fields
{
  const { dir, cleanup } = tempDir();
  try {
    seedReadyFacts(dir, 810, { derivedSpec: CONTRACT, baseSha: FIXTURE_BASE_SHA });
    const resumed = loadRun(dir, 810);
    const ready = resumed?.steps.find((s) => s.key === "810:ready:1")?.outcome;
    check(
      ready !== undefined,
      `(resume) the seeded record loaded at all (got ${json(
        resumed === undefined ? "not loaded" : resumed.steps.map((s) => s.key),
      )})`,
    );
    check(
      json(ready?.derivedSpec) === json(CONTRACT),
      `(resume) the step that minted the contract still holds it after a load, so the log and the run agree (got ${json(
        ready?.derivedSpec,
      )})`,
    );
    check(
      ready?.baseSha === FIXTURE_BASE_SHA,
      `(resume) and the commit it read the config at survived too (got ${json(ready?.baseSha)})`,
    );
    // The whole reason the drop was silent: the run-level copy was always right, so no reader
    // ever noticed the step's was missing. Pinning that pair keeps the two copies from being
    // allowed to drift apart again by a change to either rebuild.
    check(
      json(resumed?.derivedSpec) === json(ready?.derivedSpec),
      `(resume) and it is the SAME document the run carries, provenance included (run=${json(
        resumed?.derivedSpec,
      )} step=${json(ready?.derivedSpec)})`,
    );
    // The rig's other step is a ready with no facts of its own; nothing about this rule may
    // reach a step that never minted a contract.
    const other = resumed?.steps.find((s) => s.key === "810:ready:0")?.outcome;
    check(
      other?.derivedSpec === undefined && other?.baseSha === undefined,
      `(resume) and the sibling step in the same record carries neither field (got ${json([
        other?.derivedSpec,
        other?.baseSha,
      ])} for kind ${json(other?.kind)})`,
    );
  } finally {
    cleanup();
  }
}

// ───────────────────────────────── (resume) a bad sha is dropped, the contract is kept
{
  const { dir, cleanup } = tempDir();
  try {
    seedReadyFacts(dir, 811, { derivedSpec: CONTRACT, baseSha: "0".repeat(39) });
    const resumed = loadRun(dir, 811);
    const ready = resumed?.steps.find((s) => s.key === "811:ready:1")?.outcome;
    const keys = Object.keys(ready ?? {});
    check(
      resumed !== undefined,
      "(drop) a ready step with a truncated baseSha still loads — `buildOutcome` runs after `outcomeProblem` never vouches for this field, so it drops rather than throwing",
    );
    check(
      !keys.includes("baseSha"),
      `(drop) and the unvalidated oid is absent rather than handed to a reader (keys ${json(keys)})`,
    );
    check(
      json(ready?.derivedSpec) === json(CONTRACT),
      `(drop) and the field that IS valid survives the drop beside it (got ${json(
        ready?.derivedSpec,
      )})`,
    );
  } finally {
    cleanup();
  }
}

// ───────────────────────────────────────────────────────────── (drive) the engine's own bytes
{
  const driven = await driveDerivedRun({ tag: "resume-facts" });
  try {
    const bytes = rawRecordOf(driven.dir);
    const saved = (JSON.parse(bytes || "{}").steps ?? []).find(
      (s: { state?: string }) => s.state === "ready",
    )?.outcome as { derivedSpec?: unknown; baseSha?: string } | undefined;
    check(
      saved?.derivedSpec !== undefined && saved?.baseSha !== undefined,
      `(drive) the engine really wrote both fields into the ready step (saved outcome keys ${json(
        saved === undefined ? undefined : Object.keys(saved),
      )})`,
    );
    const loaded = loadRun(driven.dir, 742);
    const step = loaded?.steps.find((s) => s.state === "ready")?.outcome;
    check(
      step !== undefined,
      `(drive) …and the record the engine wrote loads (got ${json(
        loaded === undefined ? "not loaded" : loaded.steps.map((s) => s.key),
      )})`,
    );
    check(
      json(step?.derivedSpec) === json(saved?.derivedSpec),
      `(drive) and the loaded step's contract is the bytes the engine wrote (loaded=${json(
        step?.derivedSpec,
      )})`,
    );
    check(
      step?.baseSha === driven.base && isFullCommitSha(step?.baseSha ?? ""),
      `(drive) and the loaded base sha is the run's own commit (step=${json(
        step?.baseSha,
      )} base=${json(driven.base)})`,
    );
    // The read a step performs today is `specFor(body, ctx.run)` — the RUN's copy. This is the
    // same accessor pointed at the STEP's copy, which is what makes the step's copy a durable
    // audit record rather than a decoration: it answers the same question the run does.
    const fromStep = specFor(PROSE, { derivedSpec: step?.derivedSpec });
    check(
      fromStep.ok === true && json(fromStep.spec) === json(DERIVED_SPEC),
      `(drive) and reading the contract off the STEP resolves to the derived one, the way reading it off the run does (got ${json(
        fromStep,
      )})`,
    );
  } finally {
    driven.cleanup();
  }
}

process.exit(failures());
