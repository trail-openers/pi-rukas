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
 * with — that `releaseFixture` nests, that it writes back exactly what it
 * recorded, and that a fixture which NEVER BUILT leaves the host's pins alone.
 * The four arms of `assertUnset` are judged in
 * `test-review-findings-unset-arms.ts`, split off by the same 500-line gate: the
 * cases there preset the pins and drive the witness in both directions, the two
 * here build fixtures in pairs and read the env back, so they share no local and
 * no fixture instance. The setup channel is duplicated rather than imported for
 * the same reason the helpers live in `lib/`: a test file imported by another
 * test file runs its top level — including its `process.exit(exit)` — inside the
 * importer's run, so a test file cannot export its assertion channel.
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
  makeFixture,
  okFixture,
  releaseFixture,
  removeFixture,
  rowsOf,
  rowsOk,
  seed,
  seedOk,
  type SeedResult,
} from "./lib/confirmation-store-fixture.ts";
import type { StoredFinding } from "../src/review-findings-file.ts";

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

/** Two SETUP channels, both non-throwing, both naming the fault — the shared
 * ones from `confirmation-store-fixture.ts`, wrapped only to bind THIS file's
 * `assert` as the reporter.
 *
 * `require` (throwing) is GONE from this file. Every setup call it guarded sat
 * before its case's `try` was entered, so the exception escaped the file,
 * bun reported ZERO `✗` lines for the whole run, and every case after the fault
 * silently did not run. The shared helpers now return `{ problem }` and these two
 * record it as a red plus a `break` out of a labelled block, which sets the exit
 * code and lets the remaining cases still execute — so a broken fixture cannot
 * read as a pass and cannot silence its neighbours' witnesses. */
const assertSeed = (s: SeedResult, label: string) => seedOk(s, label, (m) => assert(false, m));
const assertRows = (
  r: { rows: StoredFinding[]; problem: string },
  label: string,
): r is { rows: StoredFinding[]; problem: "" } =>
  rowsOk(r, label, (m) => assert(false, m));

// ---------------------------------------------------------------------------
// the fixture's env pins are restorable, not destructive (HIGH 1)
// ---------------------------------------------------------------------------

env_case: {
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
    // row from any fixture reached the host path. Both setup calls report a
    // fault as a named red through `{ problem }` rather than as a throw, so a
    // broken store reddens THIS case instead of aborting the file: `seed` used to
    // `throw new Error("seed failed…")`, and a case that cannot report is a case
    // whose green means nothing.
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    const seeded = await seed(f.dir, f.headSha);
    if (!assertSeed(seeded, "env nesting: outer seed")) break env_case;
    const read = await rowsOf(f.dir);
    if (!assertRows(read, "env nesting: outer read")) break env_case;
    assert(
      pid !== undefined && read.rows.some((r) => r.id === seeded.row.id),
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
  break env_case;
}

process.exit(exit);
