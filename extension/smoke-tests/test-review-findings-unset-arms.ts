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
  releaseUnpinProblems,
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
    // The same gate its two sibling cases apply. Without it a build fault leaves
    // this block running with `f.dir` / `f.headSha` unusable and `f.priorEnv`
    // reading `installed: false` — and the assertions below would then be
    // reporting on a fixture that never built: the precondition would go red for
    // the wrong reason and the three assertions after it would judge nothing.
    // `okFixture` reddens BY NAME and skips, so the fault is attributed to the
    // build rather than to the arms.
    if (!okFixture(f, "restore", (m) => assert(false, m))) break restore_case;
    // The precondition every earlier case could not state: BOTH members of the
    // record are strings, which is what selects the set-arms below. The
    // discriminant is in the predicate because it is what makes the record
    // auditable at all: `assertUnset` refuses a record whose fixture installed
    // nothing, so a case that dropped this test could drive the sentinel arm's
    // refusal while reading as a witness for the set-arms.
    assert(
      f.priorEnv.installed === true &&
        f.priorEnv.ledgerFile === sentinelLedger &&
        f.priorEnv.agentDir === sentinelAgent,
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
    // go unexecuted while every assertion still read green. The discriminant is
    // part of the predicate for the same reason as the other two cases: the arm
    // this case judges is selected by it.
    assert(
      f.priorEnv.installed === true &&
        f.priorEnv.ledgerFile === undefined &&
        f.priorEnv.agentDir === undefined,
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
    //
    // And a THIRD reading, from `releaseUnpinProblems` — the unpin asserted as
    // the release's OWN post-condition on the variable it just wrote, rather than
    // reconstructed by the caller from a `process.env` a mutant may already have
    // poisoned. Each of the three is a different failure surface: `assertUnset`
    // audits the record against the env, the direct `in` tests audit the env
    // against nothing, and `releaseUnpinProblems` audits the release against its
    // own branch. Measured: replacing either `delete` with Biome's autofixed
    // assignment reddens exactly the one line naming that pin, and leaves the
    // other file's 20 greens alone.
    const problems = assertUnset(f, "release");
    const unpin = releaseUnpinProblems(f, "release");
    assert(
      problems.length === 0 &&
        unpin.length === 0 &&
        !("PI_ENSEMBLE_REVIEW_LEDGER_FILE" in process.env) &&
        !("PI_AGENT_DIR" in process.env),
      `release: a fixture whose pin was UNSET deletes it rather than storing "undefined" (${JSON.stringify([process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE, process.env.PI_AGENT_DIR])}, problems=${JSON.stringify(problems)}, unpin=${JSON.stringify(unpin)})`,
    );
    // And the helper must ANSWER for the inversion, not merely miss it: with the
    // pins written back as the literal string bun leaves behind, `assertUnset`
    // reports exactly the pin it names. Without this arm a faulting
    // `releaseFixture` that assigned instead of deleting would satisfy the
    // absence test above only because the assignment happened to be absent.
    // The predicate is the SPECIFIC problem string, not `length === 1` plus a
    // substring. `length === 1` was the reading that let a deleted arm hide: with
    // this arm's body removed the array is simply `[]`, and a `length >= 1` or a
    // "some problem mentions the pin" reading both accept a different arm's
    // problem in its place (measured: `reds=0` across all five fixture-family
    // files for each of the two was-unset arms under body deletion). Requiring
    // the arm's OWN message — "still present", which only the was-unset arms
    // produce, and carrying the pin's own name — pins the witness to the branch.
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = "undefined";
    const inverted = assertUnset(f, "release-inverted");
    assert(
      inverted.length === 1 &&
        inverted[0]?.includes("PI_ENSEMBLE_REVIEW_LEDGER_FILE") === true &&
        inverted[0]?.includes("still present") === true &&
        inverted[0]?.includes('\"undefined\"') === true &&
        // The was-SET arm's own message must NOT appear. Deleting the
        // was-unset arm does not make the array empty: the `else if` below
        // then compares a recorded `undefined` against the pin and pushes
        // `<PIN> != undefined`, which mentions the pin and its value and
        // would satisfy every other clause here. The two arms' messages
        // differ only by "still present" vs "!=", so the absence of the
        // other arm's spelling is what pins this witness to the branch.
        inverted[0]?.includes("!=") === false,
      `release: an "unset" pin re-pinned to the literal string is exactly one problem naming that pin AND its value, and not the was-set arm's comparison (problems=${JSON.stringify(inverted)})`,
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
      invertedAgent.length === 1 &&
        invertedAgent[0]?.includes("PI_AGENT_DIR") === true &&
        invertedAgent[0]?.includes("still present") === true &&
        invertedAgent[0]?.includes('\"undefined\"') === true &&
        // Same reasoning as the ledger probe: the was-set arm's `!=` message
        // is the only thing a deleted was-unset arm can substitute here.
        invertedAgent[0]?.includes("!=") === false,
      `release: an "unset" AGENT_DIR pin re-pinned to the literal string is exactly one problem naming that pin AND its value, and not the was-set arm's comparison (problems=${JSON.stringify(invertedAgent)})`,
    );
    // ---------------------------------------------------------------------
    // The SAME probes over the OTHER witness — `releaseUnpinProblems`, the
    // release answering for its own branch. H5 gave `assertUnset`'s four arms
    // this treatment and these two arms were left with the single
    // `unpin.length === 0` in the conjunction above, which is why deleting
    // EITHER `problems.push` body measured `reds=0` in all three fixture-family
    // files: the sibling's direct `!(NAME in process.env)` tests were catching
    // Biome's `noDelete` autofix all along, and this module's stated reason for
    // existing — being the release's own post-condition rather than a caller's
    // reconstruction — was never witnessed. Each arm now answers for its own
    // string, with the other arm's spelling excluded, for the reason H5 states:
    // an `include`s-the-other-arm's-message reading lets one arm certify the
    // other. The probes run on the env state `releaseFixture` just left — both
    // pins ABSENT — so each has exactly one candidate cause, and setting the
    // other pin back to absent between them is the same discipline as the two
    // `assertUnset` probes above.
    // ---------------------------------------------------------------------
    // `releaseFixture` proved both pins ABSENT above, and the two `assertUnset`
    // probes between then and here left the AGENT pin holding the literal string.
    // Put it back to ABSENT so this probe's array has exactly ONE candidate cause:
    // the same single-cause discipline the two probes above state, and for the
    // same reason — with both pins poisoned the array holds two problems, one per
    // arm, and neither arm can be told apart from the other by a reader that only
    // checks the array's contents.
    delete process.env.PI_AGENT_DIR;
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = "undefined";
    const unpinLedger = releaseUnpinProblems(f, "release-unpin-ledger");
    // The clauses below name the substrings by which the two arms are TOLD
    // APART, and they are not the two full env names: each body interpolates
    // only its OWN `LEDGER_ENV` / `AGENT_DIR_ENV`, so the LEDGER arm's line
    // contains `PI_ENSEMBLE_REVIEW_LEDGER_FILE` and never `PI_AGENT_DIR`, and
    // vice versa. The shared word of each pair (`LEDGER` / `AGENT_DIR`) is what
    // the arm's own sentence prints even where the interpolated name is the
    // other constant's spelling, so `an "unset" LEDGER pin` is the arm's own
    // spelling and `AGENT` is the other arm's. An earlier draft of this probe
    // required the full `PI_ENSEMBLE_REVIEW_LEDGER_FILE` and could not pass for
    // any implementation — a witness nobody can satisfy is as useless as one
    // nothing can fail, so each clause here is matched against the string the
    // shipped body actually prints.
    assert(
      unpinLedger.length === 1 &&
        unpinLedger[0]?.includes('an "unset" LEDGER pin') === true &&
        unpinLedger[0]?.includes("still in process.env after the release") === true &&
        // The value the release failed to remove, quoted: an arm that named the
        // pin but not what it left behind would not distinguish the autofix's
        // 9-character string from any other residue.
        unpinLedger[0]?.includes('"undefined"') === true &&
        unpinLedger[0]?.includes("only a delete expression unsets") === true &&
        // The AGENT arm must not have answered for the LEDGER pin. The two
        // bodies differ only in which name they interpolate, so an
        // `unpin.length >= 1` or "some problem mentions a pin" reading accepts
        // the wrong arm and this witness certifies nothing.
        unpinLedger[0]?.includes("AGENT") === false,
      `release: releaseUnpinProblems answers for the LEDGER unpin with its own message naming that pin and its leftover value, and not the AGENT_DIR arm's (problems=${JSON.stringify(unpinLedger)})`,
    );
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    process.env.PI_AGENT_DIR = "undefined";
    const unpinAgent = releaseUnpinProblems(f, "release-unpin-agent");
    assert(
      unpinAgent.length === 1 &&
        unpinAgent[0]?.includes('an "unset" AGENT_DIR pin') === true &&
        unpinAgent[0]?.includes("still in process.env after the release") === true &&
        unpinAgent[0]?.includes('"undefined"') === true &&
        unpinAgent[0]?.includes("only a delete expression unsets") === true &&
        // Mirror of the clause above: with the AGENT body deleted the ledger
        // arm's problem is not available here (the ledger pin is absent), so a
        // length-only reading would go green on an empty array instead — the
        // point of requiring the arm's OWN spelling is that the array being
        // empty and the array holding the other arm's answer must both redden.
        unpinAgent[0]?.includes("LEDGER") === false,
      `release: releaseUnpinProblems answers for the AGENT_DIR unpin with its own message naming that pin and its leftover value, and not the LEDGER arm's (problems=${JSON.stringify(unpinAgent)})`,
    );
    delete process.env.PI_AGENT_DIR;
    removeFixture(f);
    if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    resetFindingsStateCache();
  }
  break unset_case;
}

process.exit(exit);
