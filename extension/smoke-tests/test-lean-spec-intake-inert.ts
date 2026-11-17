#!/usr/bin/env bun
/**
 * lean/spec-intake — `derive` is INERT for an issue that already carries a contract.
 *
 * The v0.14.88 release notes say the `derive` mode of #2326 changes nothing for an
 * issue whose body carries a valid `pi-spec v1` block, and cite this file. Four
 * claims, one drive:
 *
 *   (a) no deriving child is dispatched — the mode is a stand-in for a MISSING block
 *       (`spec-intake.ts` parses first and only consults the switch on the one reason
 *       `no pi-spec v1 block`), so a block that parses has to short-circuit it. The
 *       child is the only thing the mode costs, so a zero here is the release note's
 *       whole cost claim;
 *   (b) no comment is posted — the only comment `derive` mints is the derived table
 *       `ready` publishes where it mints it (`command.ts`, gated on `facts.derived`),
 *       and a run that reused the author's block has nothing to publish;
 *   (c) `specFor` returns the AUTHORED spec with provenance `issue` — nine steps read
 *       their criteria through that accessor, so "inert" means they are graded on the
 *       human's document, not on a machine's approximation of it;
 *   (d) the record on disk carries no `derivedSpec`, at the RUN level or on the ready
 *       STEP, and still carries none after `loadRun` rebuilt it — the field is what a
 *       later reader would mistake for the run's own contract, and `loadRun` is the
 *       only reader a resume has.
 *
 * (d) is stated at both levels and against the raw bytes as well as the reader, on
 * purpose. `buildOutcome` has no clause for the two fields only `ready` owns, so a
 * step-level absence read back through `loadRun` alone would pass on a record whose
 * bytes DID carry the document — and that document would then reach `applyReadyFacts` on
 * the next boot and re-mint `run.derivedSpec`. The raw check is what makes (d) mean the
 * engine never wrote it, rather than that one reader declines to surface it.
 *
 * Each claim is falsifiable only against an arm that would fail it, so the same drive
 * runs three times: once with the mode pinned to `derive` (the four assertions), once
 * with the knob left at its shipped `require` default (the same authored body, so its
 * ready still decides `ok` and its bytes carry no `derivedSpec` either — a green (d)
 * above cannot be the fixture quietly running in `require`), and once over a PROSE
 * ticket in `derive` mode so the counters are proved able to report a one: a child
 * counter that could only read zero, and a post recorder that never recorded, would make
 * (a) and (b) vacuously true.
 *
 * Everything offline: a real git repo for the base proof and the config read at the
 * run's base, `PI_ENSEMBLE_FORGE=none` so the forge adapter is refused outright (a post
 * that fell through to `forge.issueComment` would count zero at the in-process seam and
 * pass for the wrong reason), and a stubbed child. The `ready` handler is production's —
 * see the fixture for the seams.
 */

import { specFor } from "../src/lean/spec-for.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  AUTHORED,
  AUTHORED_BODY,
  DERIVED_SPEC,
  driveAuthoredRun,
  driveIntakeReadyDerived,
  stepDerivedOf,
} from "./lib/lean-spec-intake-inert-fixture.ts";

const { assert, failures } = makeAssert();

// ── The release note's four claims, in `derive` mode over an authored contract.
{
  const run = await driveAuthoredRun({ tag: "derive", intake: "derive" });
  try {
    // The preconditions every claim below rests on: the mode really was `derive`, the
    // ticket really did carry a parsable block, and the drive really reached the step
    // after `ready` and saved a terminal record — so a green (a)–(d) is neither a run
    // that took another branch nor an absence asserted off a file never written.
    assert(
      run.readyOutcome === "ok",
      `an authored contract passes ready in derive mode (got ${JSON.stringify(run.readyOutcome)})`,
    );
    assert(
      run.ctxRun !== undefined,
      `…and the drive really reached the step after ready (log ${run.log}, state ${JSON.stringify(
        run.reloaded?.state,
      )}, ready ${JSON.stringify(run.readyOutcome)})`,
    );
    assert(
      run.reloaded?.state === "landed",
      `…and the engine saved a record that loads and ends landed (got ${JSON.stringify(
        run.reloaded?.state,
      )}, log ${run.log})`,
    );
    assert(
      run.raw.includes('"state": "landed"'),
      "…and those bytes are that saved terminal record, not an interim write",
    );

    assert(
      run.derives === 0,
      `(a) no deriving child is dispatched for an issue that carries a block (got ${String(run.derives)})`,
    );

    assert(
      run.derivedPosts.length === 0,
      `(b) …and the derived acceptance table is not posted (got ${String(
        run.derivedPosts.length,
      )} derived-table posts)`,
    );
    assert(
      run.posted.length === 0,
      `(b) …and this run asked for no comment at all (got ${String(run.posted.length)}) — ${JSON.stringify(
        run.posted,
      )}`,
    );

    assert(
      run.read.ok === true && run.read.source === "issue",
      `(c) the accessor that nine steps read their criteria through returns the authored block (got ${JSON.stringify(
        run.read,
      )})`,
    );
    assert(
      run.read.ok && JSON.stringify(run.read.spec) === JSON.stringify(AUTHORED),
      `(c) …and it is the author's own document, field for field (got ${JSON.stringify(
        run.read.ok ? run.read.spec : null,
      )})`,
    );
    // What the record holds about the contract is exactly `ready`'s own verdict, and for
    // an authored contract that is the bare `{kind:"ok"}`: `command.ts` writes `baseSha`
    // and `derivedSpec` onto a verdict only when the intake derived one. That key set is
    // the durable witness that this run was judged by the author's block, since the issue
    // body itself reaches no record — no step copies it there. It also catches the leak
    // the four claims alone would miss: a `ready` that stamped or published anything it
    // mints only for a derived contract.
    assert(
      JSON.stringify(Object.keys(run.readyVerdict ?? {}).sort()) === JSON.stringify(["kind"]),
      `…and the ready step's own verdict carries nothing but its kind, the shape an authored contract's does (got ${JSON.stringify(
        run.readyVerdict,
      )})`,
    );
    // The read is performed by the accessor itself, on the object the engine handed the
    // next step, so it is not the fixture's own call with a hand-built run. Its twin:
    // the same body and an EMPTY run still resolve to the authored block — which is what
    // makes the `(c)` provenance the interesting half, since a derived contract could not
    // have come from an empty record.
    assert(
      specFor(AUTHORED_BODY, {}).ok === true,
      "…and the same accessor on the same body and no record at all still returns the block, so (c)'s `issue` provenance is the accessor's own answer about this body",
    );

    assert(
      run.saved?.derivedSpec === undefined,
      `(d) the saved record carries no derivedSpec at the run level (got ${JSON.stringify(
        run.saved?.derivedSpec,
      )})`,
    );
    assert(
      stepDerivedOf(run.saved) === undefined,
      `(d) …nor on the ready step the engine wrote (got ${JSON.stringify(stepDerivedOf(run.saved))})`,
    );
    assert(
      run.raw.includes("derivedSpec") === false,
      "…and the bytes the engine wrote name no derivedSpec anywhere, at either level",
    );
    assert(
      run.raw.includes(DERIVED_SPEC.problem) === false,
      "…and no trace of the contract that child would have drafted is anywhere in those bytes",
    );
    // …and the reader's half: `loadRun` is the only reader a resume has, so this is the
    // absence that actually governs the steps after `ready`.
    assert(
      run.reloaded?.derivedSpec === undefined,
      `(d) …and still carries none after loadRun rebuilt it at the run level (got ${JSON.stringify(
        run.reloaded?.derivedSpec,
      )})`,
    );
    assert(
      stepDerivedOf(run.reloaded) === undefined,
      `(d) …nor on its ready step (got ${JSON.stringify(stepDerivedOf(run.reloaded))})`,
    );
  } finally {
    run.cleanup();
  }
}

// ── The control: the same ticket at the shipped default behaves the same, so the
// block — not the mode — is what kept the intake inert above.
{
  const run = await driveAuthoredRun({ tag: "require" });
  try {
    assert(
      run.readyOutcome === "ok",
      `the same authored contract passes ready with the knob left at require (got ${JSON.stringify(
        run.readyOutcome,
      )})`,
    );
    assert(
      run.derives === 0 && run.derivedPosts.length === 0,
      `(e) …and pays no child and posts no derived table there either (got ${String(
        run.derives,
      )} children, ${String(run.derivedPosts.length)} derived-table posts)`,
    );
    assert(
      run.read.ok === true && run.read.source === "issue",
      `(e) …and reads the same authored contract (got ${JSON.stringify(run.read)})`,
    );
    assert(
      run.raw.includes("derivedSpec") === false &&
        run.reloaded?.derivedSpec === undefined &&
        stepDerivedOf(run.reloaded) === undefined,
      "…and its bytes and its reloaded record carry no derivedSpec, so (d) above is not the fixture defaulting to require",
    );
  } finally {
    run.cleanup();
  }
}

// ── The reachability arm: the same wiring over a PROSE ticket, where the mode IS
// consulted. Without this, (a) and (b) could be counters that only ever read zero.
{
  const derived = await driveIntakeReadyDerived();
  assert(
    derived.derives === 1,
    `(f) the deriving child really is reachable in this wiring — the same drive over a PROSE ticket pays it (got ${String(
      derived.derives,
    )})`,
  );
  assert(
    derived.derivedPosts.length === 1,
    `(f) …and the post seam reports the derived table it mints (got ${String(
      derived.derivedPosts.length,
    )} derived-table posts; log ${derived.log}, state ${derived.state})`,
  );
  assert(
    derived.derivedPosts[0]?.includes("derived by") === true &&
      derived.derivedPosts[0]?.includes(DERIVED_SPEC.problem) === true,
    `(f) …and the comment it recorded is the derived table production's own poster builds — fenced block and drafting model named — so the (b) filter above selects a real document (got ${JSON.stringify(
      derived.derivedPosts[0]?.slice(0, 90),
    )})`,
  );
  assert(
    derived.record?.steps.find((s) => s.state === "ready")?.outcome?.kind === "ok",
    `…and that drive really did derive (ready ${JSON.stringify(
      derived.record?.steps.find((s) => s.state === "ready")?.outcome?.kind,
    )}, log ${derived.log})`,
  );
  assert(
    derived.record?.derivedSpec?.spec.problem === DERIVED_SPEC.problem,
    `(f) …and its contract is on the run record, so (d) above is a property of the authored body and not of a rig that never records one (got ${JSON.stringify(
      derived.record?.derivedSpec?.spec.problem,
    )})`,
  );
}

process.exit(failures());
