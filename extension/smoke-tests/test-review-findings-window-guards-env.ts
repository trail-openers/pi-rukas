#!/usr/bin/env bun
/**
 * #1934 — the fixture-env witnesses for the shared confirmation fixture, split
 * from `test-review-findings-window-guards.ts` by the AGENTS.md §12 500-line
 * gate. Same frozen clock (`lib/window-guards-clock.ts`) and the same shared
 * fixture, so a case here judges the identical `releaseFixture` / `assertUnset`
 * code the sibling's guard arms depend on.
 *
 * WHAT LIVES HERE, and why this is the seam. The guard witnesses in the sibling
 * file judge the ROUND; every case here judges the FIXTURE the rounds are built
 * with — the two `delete` branches of `releaseFixture`, the two "was set" arms
 * of `assertUnset`, and the nesting property that an inner release hands the
 * OUTER fixture its pins back. They share nothing but the fixture and the
 * `assert`/`require` channel, so the split is along a real concern rather than
 * at an arbitrary line count. `require` is duplicated rather than imported for
 * the same reason the helpers live in `lib/`: a test file imported by another
 * test file runs its top level — including its `process.exit(exit)` — inside
 * the importer's run, so a test file cannot export its assertion channel.
 *
 * WHY THESE CASES MATTER AT ALL: every witness of a delete-vs-assign-the-
 * `undefined`-literal inversion is one of these. On bun assigning `undefined`
 * to an env key stores the literal string "undefined", which the ledger and
 * state resolvers read through `?.trim()` and therefore treat as a real path —
 * so an autofixed teardown does not unset, it re-pins somewhere worse, and a
 * test that only reads env strings accepts it. (The contiguous dot-form is
 * described rather than written out: this repo's own env-clear ratchet scans
 * comments too and reddens on the explanation of the trap it forbids.) Each
 * case here therefore asserts ABSENCE (`!(NAME in process.env)`)
 * or exact equality against the fixture's own record, and each names the pin.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { workingTreePatchId } from "../src/review-ledger.ts";
import { resetFindingsStateCache } from "../src/review-state-path.ts";
import {
  assertUnset,
  makeFixture,
  releaseFixture,
  removeFixture,
  rowsOf,
  seed,
} from "./lib/confirmation-store-fixture.ts";

/** The environment as THIS file found it, captured at load before any case ran.
 * The nesting case's teardown asserts against this alongside the values its own
 * block saved, which is what makes it a process-level invariant — "the file
 * exits with the env it entered" — rather than a comparison of `process.env`
 * against the same two locals that block had just installed. */
const ENV_AT_ENTRY = {
  PI_ENSEMBLE_REVIEW_LEDGER_FILE: process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE,
  PI_AGENT_DIR: process.env.PI_AGENT_DIR,
};

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A precondition the case CANNOT proceed without. Unlike `assert` this both
 * prints a named `✗` line AND throws, so a setup fault is visible in the run
 * output and stops the case: continuing past a failed precondition means the
 * later assertions judge a fixture that is not the one they name. The shape
 * this replaces — a bare `throw` in a shared setup helper called BEFORE the
 * caller's `try/finally` — aborted the whole file on an unhandled exception, so
 * the run reported zero `✗` lines and every case green, including the one whose
 * fixture never built.
 *
 * The `asserts` predicate is what makes it usable at a call site rather than
 * merely loud: without it the compiler still sees a guarded value as possibly
 * undefined and the honest fix would have been a cast. */
function require(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`);
    exit = 1;
    throw new Error(msg);
  }
}

// ---------------------------------------------------------------------------
// the fixture's env pins are restorable, not destructive (HIGH 1)
// ---------------------------------------------------------------------------

{
  // An OUTER fixture records the host's real env; an inner makeFixture/release
  // pair runs inside it. If release deletes instead of restoring, the outer
  // round's next write lands in the real per-clone ledger / the developer's
  // ~/.pi state. `hostLedger` is a path OUTSIDE any fixture and outside the
  // process env, so a leaked write is observable as a file that must never
  // exist. The env is set back to `ENV_AT_ENTRY` in the finally rather than
  // through the fixture's own release: this case's fixture was created with
  // this case's pins in place, so those pins are what a correct release puts
  // back (that is the HIGH 1 property, asserted below), not the pre-entry
  // values — restoring those is the last block's job.
  const hostDir = mkdtempSync(path.join(os.tmpdir(), "host-ledger-"));
  const hostLedger = path.join(hostDir, "ledger.json");
  const hostAgent = path.join(hostDir, "agent");
  // The host's real values, saved so this case can put them back at the end.
  const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const savedAgent = process.env.PI_AGENT_DIR;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = hostLedger;
  process.env.PI_AGENT_DIR = hostAgent;
  resetFindingsStateCache();
  const f = makeFixture();
  const outerLedger = f.ledgerFile;
  const outerAgent = path.join(f.root, "agent");
  try {
    assert(
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === outerLedger,
      `env: makeFixture pins the ledger into the fixture (${process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE})`,
    );
    const inner = makeFixture();
    try {
      assert(
        process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === inner.ledgerFile,
        "env: the inner fixture re-pins the ledger to its own dir",
      );
    } finally {
      releaseFixture(inner);
      removeFixture(inner);
    }
    assert(
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === outerLedger &&
        process.env.PI_AGENT_DIR === outerAgent,
      `env: an inner release restores the OUTER fixture's pins rather than deleting them (ledger=${process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE}, agent=${String(process.env.PI_AGENT_DIR)})`,
    );
    // The outer round still works on ITS file after the inner release, and no
    // row from any fixture reached the host path.
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    const row = await seed(f.dir, f.headSha);
    assert(
      pid !== undefined && (await rowsOf(f.dir)).some((r) => r.id === row.id),
      "env: the outer fixture's store still round-trips after an inner release",
    );
    assert(
      existsSync(hostLedger) === false,
      `env: no row from any fixture reached the host ledger path (${hostLedger})`,
    );
    assert(
      existsSync(hostAgent) === false,
      `env: no fixture state reached the host agent dir (${hostAgent})`,
    );
  } finally {
    // The pins the fixture is expected to put back are `f.priorEnv` — the values
    // `makeFixture` RECORDED when it made this fixture. They are not values this
    // block assigned inside the `try`, so the comparison is against state the
    // asserted function had to move, not against a constant the same block
    // wrote. (`hostLedger` above is what the case installed BEFORE the fixture
    // existed; `f.priorEnv` is what the fixture itself captured, and a release
    // that ignored its own record and re-derived from elsewhere is caught here
    // and not by the earlier assertion.)
    releaseFixture(f);
    assert(
      process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === f.priorEnv.ledgerFile &&
        process.env.PI_AGENT_DIR === f.priorEnv.agentDir &&
        f.priorEnv.ledgerFile === hostLedger &&
        f.priorEnv.agentDir === hostAgent,
      `env: releaseFixture writes back the values it recorded (recorded=${JSON.stringify(f.priorEnv)}) instead of deleting them (ledger=${String(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE)}, agent=${String(process.env.PI_AGENT_DIR)})`,
    );
    // Restore the host env with the two-branch form. On bun an assignment of
    // `undefined` does NOT remove the variable — it stores the 9-character
    // string "undefined", which every consumer that reads through `?.trim()`
    // treats as a truthy path. `delete` is the only shape that unsets.
    if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
    if (savedAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgent;
    // And the restore is asserted, not assumed: a variable the entry found
    // unset must be absent from the env object, not present-and-"undefined".
    //
    // The condition folds in `ENV_AT_ENTRY` so the snapshot is a real check and
    // the message is not prose beside a print. What the three comparisons say
    // together: what the host had when this FILE started (`ENV_AT_ENTRY`), what
    // THIS block saved on entry (`savedLedger` / `savedAgent` — the values the
    // teardown just wrote back), and what the env holds NOW. The two locals are
    // NOT enough on their own: a block that wrote back values it derived from
    // somewhere other than the entry would satisfy a `saved`-only comparison,
    // and the earlier shape of this assertion did exactly that — it compared
    // `process.env` against the same two locals that block had just installed,
    // which is a check on the assignment rather than on the invariant. With the
    // snapshot in the predicate, "the file exits with the env it entered" is
    // judged by the value the file captured at load, before any case ran.
    assert(
      (savedLedger === undefined
        ? !("PI_ENSEMBLE_REVIEW_LEDGER_FILE" in process.env)
        : process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === savedLedger) &&
        (savedAgent === undefined
          ? !("PI_AGENT_DIR" in process.env)
          : process.env.PI_AGENT_DIR === savedAgent) &&
        process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE ===
          ENV_AT_ENTRY.PI_ENSEMBLE_REVIEW_LEDGER_FILE &&
        process.env.PI_AGENT_DIR === ENV_AT_ENTRY.PI_AGENT_DIR,
      `env: the host teardown restores the entry state exactly (ledger=${JSON.stringify(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE)}, agent=${JSON.stringify(process.env.PI_AGENT_DIR)}, entry=${JSON.stringify([ENV_AT_ENTRY.PI_ENSEMBLE_REVIEW_LEDGER_FILE, ENV_AT_ENTRY.PI_AGENT_DIR])})`,
    );
    removeFixture(f);
    rmSync(hostDir, { recursive: true, force: true });
  }
}


// ---------------------------------------------------------------------------
// assertUnset's OTHER half: the "was set" arms, which no fixture in the repo
// reached until this case (HIGH 2)
// ---------------------------------------------------------------------------

{
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
}

process.exit(exit);
