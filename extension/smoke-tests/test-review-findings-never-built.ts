#!/usr/bin/env bun
/**
 * #1934 — the "a fixture that NEVER BUILT must not touch the host's pins" family,
 * split from `test-review-findings-unset-arms.ts` by the AGENTS.md §12 500-line
 * gate.
 *
 * The seam is the FIXTURE'S STATE, not a line count. The two cases that stayed
 * in that file build fixtures that BUILT and drive `assertUnset`'s four env arms
 * over a record with pins in it; the three here all require a fixture that did
 * NOT build, and their whole content is the record `makeFixture`'s fault arm
 * returns and what the shared release and witness do with it. They share no
 * local, no helper, and no fixture instance — and moving these three into the
 * arms file is what pushed it over the cap, which is the empirical statement
 * that the two sets are different work.
 *
 * WHY THREE BLOCKS AND NOT ONE: the control that proves the release is not a
 * no-op, and the null-arm witness that proves `assertUnset` refuses rather than
 * certifies, were both assertions inside `never_built_case`. A `break` on a
 * failing control then skipped an unrelated witness — a control that could not
 * build (a transient `git`, a full tmpfs) silently removed a check and left the
 * run reading as though it had made all of them. Each is its own labelled block
 * now, so one case's skip cannot reach another's witness.
 *
 * WHY THE CHANNEL IS DUPLICATED RATHER THAN IMPORTED: a test file imported by
 * another test file runs its top level — including its `process.exit(exit)` —
 * inside the importer's run, so a test file cannot export its assertion channel.
 * Both files therefore declare their own `assert` and exit with their own code.
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
  // about PATH rather than about the thing under test. The `finally` restores it
  // UNCONDITIONALLY from the entry snapshot: this block owns `PATH` exclusively
  // (no other block in this file touches it), so a guard on "did it move" was a
  // tautology — the variable was compared against the very value the block had
  // just written there, and the backstop could only ever have fired for a move
  // this block itself made.
  process.env.PATH = savedPath;
  try {
    // WITNESS 1 of 3 — the fixture really faulted, AND faulted at the step this
    // case claims to install. "Any fault" proved only that something failed: with
    // the check reduced to `problem !== ""` the case stayed green when the recipe
    // died in `mkdirSync`, in `writeFileSync`, or in any of the seven `git` calls
    // — including the later ones, so the case would have been witnessing a
    // different window than the one its name and comments claim.
    //
    // Matched on `faultCode`, NOT on the wording in `problem`, and that is a
    // correction rather than a preference: the brief asked for the substring
    // `execFile` "actually reports", and what it actually reports depends on the
    // runtime. The same call on a `PATH` with no `git` gives
    // `spawnSync git ENOENT` under node and `Executable not found in $PATH:
    // "git"` under bun 1.4.3 — both measured here, in this repo, on the same
    // fixture. A substring match on either greens the case on the other runtime,
    // which is the same fail-open shape as accepting any fault. `error.code ===
    // "ENOENT"` is what both agree on, and `makeFixture` now carries it on
    // `faultCode` rather than making the case re-derive it from prose. A fixture
    // that faulted for any other reason — a broken `mkdir`, a disk error, a `git`
    // that exists but refuses — leaves this red.
    assert(
      f.problem !== "" && f.headSha === "" && f.faultCode === "ENOENT",
      `never-built: the fixture faulted AT THE GIT STEP with ENOENT, i.e. the recipe died where the pins are not yet installed (faultCode=${JSON.stringify(f.faultCode)}, problem=${JSON.stringify(f.problem.slice(0, 100))})`,
    );
    // WITNESS 2 of 3 — the record says "never installed", which is what selects
    // the no-op arm of the release. Asserted BEFORE the release because the
    // release is the thing under test: a `priorEnv` that still read `undefined`
    // here takes the `delete` arm and WITNESS 3 is the red that reports it.
    //
    // The discriminant is the predicate, and it is the whole predicate. The
    // member-equality form this replaces — `ledgerFile === null && agentDir ===
    // null` — was measured green across the WHOLE fixture family in a compiler-
    // valid mutant (all six confirmation files, `reds=0` on every one, this file
    // included at 16 greens): a record with two `null`s on the
    // old two-member interface satisfied it, so weakening the guard changed what
    // the case ASSERTED without changing what it OBSERVED. Requiring
    // `installed === false` is what makes the guard itself answerable — see
    // `FixtureEnv` for the union that makes the half-installed record a compile
    // error rather than a thing a mutant can quietly produce.
    assert(
      f.priorEnv.installed === false &&
        f.priorEnv.ledgerFile === null &&
        f.priorEnv.agentDir === null,
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
    //
    // THE CONTROL IS ITS OWN LABELLED BLOCK, not another assertion inside
    // `never_built_case`. It sat in the same block as the assertion it guards,
    // so `break never_built_case` on a failing control skipped the `assertUnset`
    // null-arm witness at the end of that block: a control that could not build
    // — a transient `git`, a full tmpfs — silently removed an unrelated witness
    // and left the run reading as though it had made all its checks. Here the
    // control's failure reddens the CONTROL and the null-arm witness still runs.
    // It also builds its fixture independently of `f`: `f` is the faulted
    // fixture, and a control built from the same call whose PATH was just
    // restored shares nothing with it but the function name.
  } finally {
    // Unconditional restore from the entry snapshot — see the note above the
    // `try`. This block owns `PATH` exclusively, so there is no other owner's
    // value to preserve and no condition worth writing.
    process.env.PATH = savedPath;
    if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    resetFindingsStateCache();
    removeFixture(f);
    rmSync(hostDir, { recursive: true, force: true });
  }
  break never_built_case;

  // The null-arm witness, in `never_built_case`'s own scope but AFTER its
  // `finally`: it audits the faulted fixture's record, which the release above
  // left untouched, and it must not be reachable-by-skipping from any control.
}

control_case: {
  const hostDir = mkdtempSync(path.join(os.tmpdir(), "host-ledger-control-"));
  const hostLedger = path.join(hostDir, "ledger.json");
  const hostAgent = path.join(hostDir, "agent");
  const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const savedAgent = process.env.PI_AGENT_DIR;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = hostLedger;
  process.env.PI_AGENT_DIR = hostAgent;
  resetFindingsStateCache();
  const built = makeFixture();
  try {
    // The same gate the other cases apply. On a build fault `built.ledgerFile`
    // is still a path the fixture never wrote and `priorEnv` reads
    // `installed: false`, so the release below would be the sentinel no-op and
    // the "restores the host pins it replaced" assertion would be judged by a
    // release that restored nothing.
    if (!okFixture(built, "control", (m) => assert(false, m))) break control_case;
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
  } finally {
    if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    resetFindingsStateCache();
    removeFixture(built);
    rmSync(hostDir, { recursive: true, force: true });
  }
  break control_case;
}

nullarm_case: {
  // The fault is installed HERE rather than inherited from `never_built_case`:
  // this witness audits the record of a fixture that never installed the pins,
  // so it needs a faulted fixture of its own, and taking one from the case above
  // would put it behind that case's skips.
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent-bin-dir-for-1934-nullarm";
  const f = makeFixture();
  process.env.PATH = savedPath;
  try {
    // The INVERSE gate: every other case in this file requires the fixture to
    // have BUILT, and this one requires it NOT to have. Both directions need a
    // named red — a `makeFixture` that silently succeeded here (PATH restored
    // early, a stale PATH) would leave `priorEnv` installed and `assertUnset`
    // auditing a real record, which is the same silent-green in the other
    // direction. `okFixture` is deliberately NOT used: it reports the opposite
    // fault.
    assert(
      f.problem !== "" && f.headSha === "" && f.faultCode === "ENOENT",
      `null-arm: the witness's own fixture faulted at the git step, so its record is the one this witness audits (faultCode=${JSON.stringify(f.faultCode)}, problem=${JSON.stringify(f.problem.slice(0, 80))})`,
    );
    // And `assertUnset` must REFUSE to certify a fixture that installed nothing,
    // rather than returning `[]` and reading as a clean release. The refusal is
    // checked for its SUBJECT ("never installed") and not just its shape: the
    // two was-unset arms also return a one-element array, and a fallthrough into
    // them would otherwise read as this witness passing.
    const refusal = assertUnset(f, "null-arm");
    // The same structural independence WITNESS 5 of
    // `test-review-findings-release-discriminant.ts` now applies to its copy of
    // this arm, and the same reasoning as H5's four probes: `"never installed"`
    // alone is not a witness of this branch, because `length === 1` plus one
    // own-substring is satisfied by another arm's message. The `!=` exclusion
    // already caught the was-SET cross-emission (measured red on it); the
    // `its release judges nothing` clause is what pins the witness to THIS
    // sentence rather than to any text that happens to contain the first phrase.
    assert(
      refusal.length === 1 &&
        refusal[0]?.includes("never installed") === true &&
        refusal[0]?.includes("its release judges nothing") === true &&
        refusal[0]?.includes("still present") === false &&
        refusal[0]?.includes("!=") === false &&
        refusal[0]?.includes("still in process.env after the release") === false,
      `null-arm: assertUnset reports the faulted fixture as un-auditable rather than clean, and not via either was-unset arm (problems=${JSON.stringify(refusal)})`,
    );
  } finally {
    removeFixture(f);
  }
  break nullarm_case;
}

process.exit(exit);
