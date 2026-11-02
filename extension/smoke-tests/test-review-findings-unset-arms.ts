#!/usr/bin/env bun
/**
 * #1934 — the `assertUnset` arm witnesses, split from
 * `test-review-findings-window-guards-env.ts` by the AGENTS.md §12 500-line gate.
 * Same fixture, same assertion-channel shape, same `delete`-vs-assign discipline.
 *
 * WHAT LIVES HERE vs. in the sibling: THIS file judges the WITNESS — the four
 * arms of `assertUnset`, two per env pin, each of which must be able to go red
 * (arm-by-arm mutation results are recorded on the function's jsdoc in
 * `lib/confirmation-store-fixture.ts`, and the agent was-unset arm is witnessed
 * here and nowhere else). The sibling judges the BEHAVIOUR those arms describe:
 * that `releaseFixture` nests, restores what it recorded, and — the case that
 * gave this split its reason — leaves the host's pins alone when the fixture
 * never installed them.
 *
 * WHY THE SPLIT IS ALONG THIS SEAM AND NOT AN ARBITRARY LINE: the two cases here
 * build a fixture with the pins PRESET and drive `assertUnset` in both
 * directions over a record the fixture owns; the two there build fixtures in
 * *pairs* and read the env back. They share no local, no helper and no fixture
 * instance, so neither file's cases can be moved to the other for convenience.
 *
 * WHY THE CHANNEL IS DUPLICATED RATHER THAN IMPORTED: a test file imported by
 * another test file runs its top level — including its `process.exit(exit)` —
 * inside the importer's run, so a test file cannot export its assertion channel.
 * Both files therefore declare their own `assert` and their own thin wrappers
 * over the shared `lib/` predicates, and both exit with their own code.
 */

import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { resetFindingsStateCache } from "../src/review-state-path.ts";
import {
  assertUnset,
  makeFixture,
  okFixture,
  releaseFixture,
  removeFixture,
} from "./lib/confirmation-store-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// assertUnset's OTHER half: the "was set" arms, which no fixture in the repo
// reached until this case (HIGH 2)
// ---------------------------------------------------------------------------

// Labelled, not bare: every case block in this file and its sibling is labelled
// so a setup fault skips the rest of the case with `break <label>`. A bare `{`
// makes that `break` a syntax error, so the next person who adds a skip path
// here discovers the convention by being unable to write it.
restore_case: {
  // `assertUnset` has two arms per pin: a "was unset" arm that requires the
  // variable to be ABSENT, and a "was set" arm that requires it to EQUAL what
  // the fixture recorded. Every caller in the tree forced `priorEnv` to two
  // `undefined`s, so the set-arms had no witness anywhere — measured: deleting
  // the whole ledger set-branch (the `else if` that compares against
  // `f.priorEnv.ledgerFile`) left every confirmation test green. A branch that
  // cannot fail while reading as coverage is dead code with a green tick on it,
  // so this case builds a fixture whose pins were ALREADY SET (both to
  // sentinels a correct restore must put back verbatim) and drives the arm in
  // both directions: a correct restore reports nothing, and a corrupted
  // restore — the value `releaseFixture` should have written replaced by a
  // different path, exactly what a re-derived value or an `= undefined` teardown
  // produces — reports one, naming the pin.
  //
  // The fixture comes from the SHARED `makeFixture` with both pins set, so
  // `priorEnv` holds two strings BY CONSTRUCTION rather than through a
  // hand-built record: this judges the function's real record, not a stand-in
  // shaped like one.
  const hostDir = mkdtempSync(path.join(os.tmpdir(), "host-ledger-restore-"));
  const sentinelLedger = path.join(hostDir, "sentinel-ledger.json");
  const sentinelAgent = path.join(hostDir, "sentinel-agent");
  const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const savedAgent = process.env.PI_AGENT_DIR;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = sentinelLedger;
  process.env.PI_AGENT_DIR = sentinelAgent;
  resetFindingsStateCache();
  const f = makeFixture();
  try {
    // The precondition every earlier case could not state: BOTH members of the
    // record are strings, which is what selects the set-arms below.
    assert(
      f.priorEnv.ledgerFile === sentinelLedger && f.priorEnv.agentDir === sentinelAgent,
      `restore: the fixture recorded both pins as SET to the sentinels (${JSON.stringify(f.priorEnv)})`,
    );
    releaseFixture(f);
    assert(
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === sentinelLedger &&
        process.env.PI_AGENT_DIR === sentinelAgent,
      `restore: the release put both sentinels back verbatim (ledger=${String(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE)}, agent=${String(process.env.PI_AGENT_DIR)})`,
    );
    // The set-arms over a correct restore: NOTHING to report. This is the arm's
    // positive witness — an implementation that returned `[]` unconditionally
    // would pass here and fail the assertions below.
    const clean = assertUnset(f, "restore");
    assert(
      clean.length === 0,
      `restore: a correct restore of SET pins reports no problems (problems=${JSON.stringify(clean)})`,
    );
    // Corrupt the LEDGER side of the restore: the env now holds a different
    // string than the record says.
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(hostDir, "other.json");
    const ledgerProblems = assertUnset(f, "restore-corrupt");
    assert(
      ledgerProblems.length === 1 &&
        ledgerProblems[0]?.includes("PI_ENSEMBLE_REVIEW_LEDGER_FILE") === true,
      `restore: a corrupted LEDGER restore is exactly one problem naming that pin (problems=${JSON.stringify(ledgerProblems)})`,
    );
    // Repair it and corrupt the AGENT side in turn: the second set-arm must
    // answer for its own pin rather than inheriting the first's verdict. The
    // corrupting value here is the literal string "undefined" — the exact value
    // bun leaves behind for an `= undefined` teardown, so this arm also witnesses
    // that `assertUnset` does not read the pin through `?.trim()` and accept it.
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = sentinelLedger;
    process.env.PI_AGENT_DIR = "undefined";
    const agentProblems = assertUnset(f, "restore-corrupt-agent");
    assert(
      agentProblems.length === 1 && agentProblems[0]?.includes("PI_AGENT_DIR") === true,
      `restore: a corrupted AGENT_DIR restore is exactly one problem naming that pin (problems=${JSON.stringify(agentProblems)})`,
    );
  } finally {
    // `releaseFixture` cannot repair this block: its own record was already
    // spent inside the `try`. The pins go back the way every other block here
    // does it — the two-branch restore, `delete` for a pin the host did not set.
    if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    resetFindingsStateCache();
    removeFixture(f);
    rmSync(hostDir, { recursive: true, force: true });
  }
  break restore_case;
}

// ---------------------------------------------------------------------------
// assertUnset's OTHER half: the two "was UNSET" arms, restored
// ---------------------------------------------------------------------------

unset_case: {
  // The fixture's "was unset" branches, witnessed on the SHARED function. Both
  // pins are removed before `makeFixture`, so `priorEnv` holds two `undefined`s
  // and `releaseFixture` must reach its two `delete` branches. The assertion is
  // `!(NAME in process.env)` — NOT `=== undefined` — because on bun assigning
  // `undefined` leaves the key present holding the literal string "undefined",
  // which any consumer reading through `?.trim()` treats as a truthy path.
  // Biome's autofix for `delete x` produces exactly that assignment; measured,
  // all four confirmation tests stayed green under it while this case reddens —
  // which is why the property is asserted on `releaseFixture` itself.
  //
  // WHY THIS CASE IS HERE AND NOT ONLY IN A TEST FILE'S PRIVATE COPY: the
  // counter-witness `assertUnset` documents was deleted in the split that moved
  // these cases out of the sibling file, and the split left the jsdoc claiming
  // all four branches were witnessed while only the two "was set" arms still
  // were. A branch with no red is a branch nobody verified, and the autofix that
  // inverts it is silent, so the witnesses are restored here and the jsdoc now
  // says what is actually asserted.
  const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const savedAgent = process.env.PI_AGENT_DIR;
  delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  delete process.env.PI_AGENT_DIR;
  resetFindingsStateCache();
  const f = makeFixture();
  try {
    if (!okFixture(f, "release", (m) => assert(false, m))) break unset_case;
    // WITNESS 1 of 3 — the record itself. A `priorEnv` that held strings would
    // drive the "was set" arms instead, and the two `delete` branches below would
    // go unexecuted while every assertion still read green.
    assert(
      f.priorEnv.ledgerFile === undefined && f.priorEnv.agentDir === undefined,
      `release: the fixture recorded both pins as unset (${JSON.stringify(f.priorEnv)})`,
    );
    // WITNESS 2 of 3 — they were really installed first, so the absence asserted
    // in the finally is something `releaseFixture` did and not the state the
    // process happened to be in.
    assert(
      "PI_ENSEMBLE_REVIEW_LEDGER_FILE" in process.env && "PI_AGENT_DIR" in process.env,
      "release: makeFixture installed both pins as own keys",
    );
  } finally {
    releaseFixture(f);
    // WITNESS 3 of 3 — the two `delete` branches, judged through the SHARED
    // `assertUnset` (so a mutation of those branches reddens here) AND by direct
    // `in` tests (so a mutation of `assertUnset` itself cannot quietly stop
    // reporting them). The two together are the point: an `assertUnset` that
    // returned `[]` unconditionally passes its own arm and fails these.
    const problems = assertUnset(f, "release");
    assert(
      problems.length === 0 &&
        !("PI_ENSEMBLE_REVIEW_LEDGER_FILE" in process.env) &&
        !("PI_AGENT_DIR" in process.env),
      `release: a fixture whose pin was UNSET deletes it rather than storing "undefined" (${JSON.stringify([process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE, process.env.PI_AGENT_DIR])}, problems=${JSON.stringify(problems)})`,
    );
    // And the helper must ANSWER for the inversion, not merely miss it: with the
    // pins written back as the literal string bun leaves behind, `assertUnset`
    // reports exactly the pin it names. Without this arm a faulting
    // `releaseFixture` that assigned instead of deleting would satisfy the
    // absence test above only because the assignment happened to be absent.
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = "undefined";
    const inverted = assertUnset(f, "release-inverted");
    assert(
      inverted.length === 1 && inverted[0]?.includes("PI_ENSEMBLE_REVIEW_LEDGER_FILE") === true,
      `release: an "unset" pin re-pinned to the literal string is exactly one problem naming that pin (problems=${JSON.stringify(inverted)})`,
    );
    // The MIRROR of that probe for `PI_AGENT_DIR`. The ledger-only version above
    // leaves the agent was-unset arm unjudged: with that arm's body deleted the
    // probe still sees "exactly one problem naming PI_ENSEMBLE_REVIEW_LEDGER_FILE"
    // and stays green (measured: `reds=0`). Corrupting the SECOND pin and
    // requiring the problem to name THAT pin is what makes the arm able to go
    // red. The ledger pin is restored first so this probe has exactly one
    // candidate cause — two problems would pass a `length >= 1` reading and the
    // agent arm could hide behind the ledger's.
    // The LEDGER pin must be back to the state the release left it in — ABSENT —
    // before this probe runs, so the array has exactly ONE candidate cause. A
    // leftover `"undefined"` on the ledger side would put two problems in the
    // array and the `length === 1` reading below could then never be satisfied by
    // the agent arm: the two probes share one `priorEnv`, so the first probe's
    // residue is the second probe's false witness. Re-`delete` is not inventing
    // an expectation — it is putting the variable back where `releaseFixture`
    // had just proved it, and the probe that follows mutates only its own pin.
    // (`null` on `priorEnv.ledgerFile` is not an option either: `assertUnset`
    // refuses a record whose pins were never installed, so the probe has to
    // present a record it is entitled to audit.)
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    process.env.PI_AGENT_DIR = "undefined";
    const invertedAgent = assertUnset(f, "release-inverted-agent");
    assert(
      invertedAgent.length === 1 && invertedAgent[0]?.includes("PI_AGENT_DIR") === true,
      `release: an "unset" AGENT_DIR pin re-pinned to the literal string is exactly one problem naming that pin (problems=${JSON.stringify(invertedAgent)})`,
    );
    removeFixture(f);
    if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    resetFindingsStateCache();
  }
  break unset_case;
}

// ---------------------------------------------------------------------------
// a fixture that NEVER BUILT must not touch the host's pins (the release that
// deleted a pin it never installed — HIGH, and new with the `{problem}` channel)
// ---------------------------------------------------------------------------

never_built_case: {
  // The hazard: `makeFixture`'s fault arm returns a fixture rather than throwing
  // (that is the `{problem}` channel), and EVERY consumer calls `releaseFixture`
  // in its `finally`. Before this fix the fault arm recorded `priorEnv` as two
  // `undefined`s, which is the record that means "this pin was unset when I
  // installed mine, so delete it" — so releasing a fixture that installed
  // NOTHING deleted the HOST's pins, and every case after it resolved through
  // the non-override branch and wrote rows into the real per-clone review ledger
  // or the developer's `~/.pi`. Nothing failed; the data was simply gone. It is
  // NEW behaviour: before the `{problem}` channel a faulting `makeFixture` threw
  // and no `finally` ran.
  //
  // The fault is forced by taking `git` off PATH: the recipe's first call is
  // `git init`, so the try block faults BEFORE the two env assignments at its
  // foot — exactly the window the fix covers. `PATH` is put back in the finally
  // (a process-wide mutation this case owns, so it restores it the way every
  // block here restores its own pins).
  const hostDir = mkdtempSync(path.join(os.tmpdir(), "host-ledger-neverbuilt-"));
  const hostLedger = path.join(hostDir, "ledger.json");
  const hostAgent = path.join(hostDir, "agent");
  const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const savedAgent = process.env.PI_AGENT_DIR;
  const savedPath = process.env.PATH;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = hostLedger;
  process.env.PI_AGENT_DIR = hostAgent;
  resetFindingsStateCache();
  // Force the fault by taking `git` off PATH: the recipe's first call is
  // `git init`, so the try block faults at its HEAD — before the two env
  // assignments at its foot, which is exactly the window the fix covers.
  process.env.PATH = "/nonexistent-bin-dir-for-1934";
  const f = makeFixture();
  // The host's PATH goes back IMMEDIATELY, before any assertion or control
  // fixture runs. Keeping it neutered across the control below would make the
  // control's `makeFixture` fault for the wrong reason — a control that cannot
  // build proves nothing about the release, and the red it reports would be
  // about PATH rather than about the thing under test. The `finally` still
  // restores it as a backstop, guarded on the value this block installed.
  const pathAfterFault = process.env.PATH;
  process.env.PATH = savedPath;
  try {
    // WITNESS 1 of 3 — the fixture really faulted. A fixture that built
    // successfully drives the ordinary release path, so this case would judge
    // nothing while still reading green; the fault is asserted before anything
    // is released.
    assert(
      f.problem !== "" && f.headSha === "",
      `never-built: the fixture failed to build (${f.problem.slice(0, 60) || "no head sha"})`,
    );
    // WITNESS 2 of 3 — the record says "never installed", which is what selects
    // the no-op arm of the release. Asserted BEFORE the release because the
    // release is the thing under test: a `priorEnv` that still read `undefined`
    // here takes the `delete` arm and WITNESS 3 is the red that reports it.
    assert(
      f.priorEnv.ledgerFile === null && f.priorEnv.agentDir === null,
      `never-built: the faulted fixture recorded both pins as NEVER INSTALLED rather than unset (${JSON.stringify(f.priorEnv)})`,
    );
    // WITNESS 3 of 3 — the shipped teardown leaves the host alone. This is the
    // probe that measured `after=[null,null]` against the shipped code before
    // the fix: the host's pins were deleted by a release that had installed
    // nothing.
    releaseFixture(f);
    assert(
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === hostLedger &&
        process.env.PI_AGENT_DIR === hostAgent,
      `never-built: releasing a fixture that never installed the pins leaves BOTH host pins intact (ledger=${JSON.stringify(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE)}, agent=${JSON.stringify(process.env.PI_AGENT_DIR)}, expected=${JSON.stringify([hostLedger, hostAgent])})`,
    );
    // The witness is NOT VACUOUS. The laziest way to satisfy the assertion above
    // is to make `releaseFixture` a total no-op, which would leave the host
    // permanently pinned by every fixture in the file; so the same release run
    // on a fixture that DID install its pins must move the env and put the host
    // values back.
    const built = makeFixture();
    if (!okFixture(built, "never-built: control", (m) => assert(false, m))) break never_built_case;
    assert(
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === built.ledgerFile &&
        process.env.PI_AGENT_DIR === path.join(built.root, "agent"),
      `never-built: control — a fixture that DID build re-pinned both vars away from the host values (${process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE})`,
    );
    releaseFixture(built);
    assert(
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === hostLedger &&
        process.env.PI_AGENT_DIR === hostAgent,
      `never-built: control — the release of a BUILT fixture restores the host pins it replaced (ledger=${JSON.stringify(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE)}, agent=${JSON.stringify(process.env.PI_AGENT_DIR)})`,
    );
    removeFixture(built);
    // And `assertUnset` must REFUSE to certify a fixture that installed nothing,
    // rather than returning `[]` and reading as a clean release.
    const refusal = assertUnset(f, "never-built");
    assert(
      refusal.length === 1 && refusal[0]?.includes("never installed") === true,
      `never-built: assertUnset reports the faulted fixture as un-auditable rather than clean (problems=${JSON.stringify(refusal)})`,
    );
  } finally {
    // `PATH` is restored from the value recorded right after the fault: if any
    // case between here and there moved it, that case owns the value and this
    // one leaves it alone rather than clobbering it with the entry snapshot.
    if (process.env.PATH !== pathAfterFault) process.env.PATH = savedPath;
    if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    resetFindingsStateCache();
    removeFixture(f);
    rmSync(hostDir, { recursive: true, force: true });
  }
  break never_built_case;
}

process.exit(exit);
