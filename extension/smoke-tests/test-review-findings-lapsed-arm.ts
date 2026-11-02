#!/usr/bin/env bun
/**
 * #1934 — the AC4 lapse disclosure witnessed through the SHARED setup helpers,
 * so a helper that drops the disclosure reddens in the helper family rather than
 * only in the store file that consumes it.
 *
 * Split from `test-review-findings-release-discriminant.ts` by the AGENTS.md §12
 * 500-line gate, and along the seam THAT file's header already draws rather than
 * at an arbitrary line: `release-discriminant` judges the release's sentinel ARM
 * — its discriminant and the process-global cache it must still clear — and drives
 * no store round at all. The two cases here are the opposite shape: each builds a
 * fixture, runs real rounds through `seed` / `reReport` / `silentRound`, reads the
 * store back with `rowsOf`, and asserts on the `SetupOutcome` arm the helpers
 * return. Nothing in the sentinel-arm file imports `seed`, `reReport`, `rowsOf` or
 * `workingTreePatchId`, and nothing here imports `findingsStateDir`,
 * `FINDINGS_FILE` or the migration fixture — so moving either pair into the other
 * drags four imports and a precondition across for no shared assertion. The gate
 * only asked; the seam was already there.
 *
 * WHY THE CHANNEL IS DUPLICATED RATHER THAN IMPORTED: a test file imported by
 * another test file runs its top level — including its `process.exit(exit)` —
 * inside the importer's run, so a test file cannot export its assertion channel.
 * Each file therefore declares its own `assert` and exits with its own code.
 */

import { execp } from "../src/exec.ts";
import { workingTreePatchId } from "../src/review-ledger.ts";
import { rowsOf, writeLedger } from "./lib/confirmation-store-fixture.ts";
import {
  CITED,
  FINDING,
  makeFixture,
  okFixture,
  reReport,
  releaseFixture,
  removeFixture,
  rowsOk,
  seed,
  seedOk,
  setupOk,
  silentRound,
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
// H3 — `SetupOutcome`'s success arm carries the lapse disclosure: an EMPTY list
// must be distinguishable from a MISSING one
// ---------------------------------------------------------------------------

// `lapsed` is the only place #1934 AC4's evidence survives: the row keeps the
// `confirmationLapsed` boolean, but the string that makes the disclosure a claim
// about a real review — the provenance of the confirmation it was retired on —
// exists only in the notice. With the field optional on the success arm, an
// `asSetup` that stopped forwarding it was indistinguishable from a round that
// found no lapse, and the AC4 witness in
// `test-review-findings-confirmed-store.ts` reads it through `?.some(...)`,
// which is `undefined` either way: ZERO reds for a vanished disclosure.
//
// The two halves of the property, and why each needs its own witness:
//
//  - TYPE half (checked by `tsc`, not by this case): the success arm requires
//    `lapsed`, so a helper that omits it does not compile. Measured by deleting
//    the `?? []` in `asSetup` — one error at the helper, which is the only place
//    the omission is cheap to catch.
//  - RUNTIME half (this case): the value the helpers produce for a round with no
//    lapse is an actual ARRAY. An implementation that "satisfied" the required
//    field by writing `undefined as never` — or that the store's own conditional
//    spread leaked past — would satisfy `tsc` and still leave every reader
//    staring at nothing. So the case asks for the field's identity, not its
//    truthiness: `Array.isArray` and `length === 0`, both of which `undefined`
//    fails.
lapsed_arm_case: {
  const f = makeFixture();
  try {
    if (!okFixture(f, "lapsed-arm", (m) => assert(false, m))) break lapsed_arm_case;
    const seeded = await seed(f.dir, f.headSha);
    if (!seedOk(seeded, "lapsed-arm: seed", (m) => assert(false, m))) break lapsed_arm_case;
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, `lapsed-arm: the review identity resolved (${String(pid)})`);
    // A round with NOTHING to lapse: it re-reports the row it just filed, so no
    // confirmation retired anything and no retirement went stale. This is the
    // case where the old optional field was absent, and where the new required
    // one must be an empty array rather than a hole.
    const quiet = await reReport(f.dir, f.headSha, pid!);
    if (!setupOk(quiet, "lapsed-arm: round", (m) => assert(false, m))) break lapsed_arm_case;
    assert(
      Array.isArray(quiet.lapsed) && quiet.lapsed.length === 0,
      `lapsed-arm: a round with nothing to lapse carries an EMPTY ARRAY, not a missing field (Array.isArray=${Array.isArray(quiet.lapsed)}, value=${JSON.stringify(quiet.lapsed)})`,
    );
    // And the two states remain distinguishable through the OTHER helper on the
    // same arm: a silent round over the same fixture is the shape the untouched
    // cases drive, and it must answer the same way.
    const silent = await silentRound(f.dir, f.headSha, pid!, Date.now() + 10_000);
    if (!setupOk(silent, "lapsed-arm: silent round", (m) => assert(false, m)))
      break lapsed_arm_case;
    assert(
      Array.isArray(silent.lapsed) && silent.lapsed.length === 0,
      `lapsed-arm: the silent round's arm also reports an empty array rather than omitting the key (Array.isArray=${Array.isArray(silent.lapsed)}, value=${JSON.stringify(silent.lapsed)})`,
    );
  } finally {
    releaseFixture(f);
    removeFixture(f);
  }
  break lapsed_arm_case;
}

// ---------------------------------------------------------------------------
// H3 (second half) — the AC4 lapse disclosure driven through the SHARED helper,
// so a helper that drops it reddens in the helper family
// ---------------------------------------------------------------------------

// Why a second AC4 case beside `test-review-findings-confirmed-store.ts`'s: that
// file drives the lapse round through `recordFindingRunOutcome` DIRECTLY, so it
// reads the STORE's answer. The disclosure these confirmation tests consume
// arrives through `SetupOutcome`, which `asSetup` builds — and that hop is where
// the field went missing while every file stayed green. The witness therefore
// drives the same real store path and asserts on the HELPER's arm: the row must
// be open, the notice must name it, and the notice's provenance must be the
// confirmation the retirement actually stood on.
ac4_helper_case: {
  const f = makeFixture();
  try {
    if (!okFixture(f, "ac4-helper", (m) => assert(false, m))) break ac4_helper_case;
    const seeded = await seed(f.dir, f.headSha);
    if (!seedOk(seeded, "ac4-helper: seed", (m) => assert(false, m))) break ac4_helper_case;
    const row = seeded.row;
    const pid = (await workingTreePatchId(execp, f.dir)).patchId;
    assert(pid !== undefined, `ac4-helper: the review identity resolved (${String(pid)})`);
    // The confirmation that retires the row, bound to this commit.
    writeLedger(f.ledgerFile, [
      {
        branch: "feature/work",
        kind: "adversarial",
        patchId: pid!,
        passed: true,
        at: Date.now(),
        headSha: f.headSha,
        rowId: row.id,
        round: 2,
      },
    ]);
    const retiring = await reReport(f.dir, f.headSha, pid!);
    if (!setupOk(retiring, "ac4-helper: retiring round", (m) => assert(false, m)))
      break ac4_helper_case;
    const retired = await rowsOf(f.dir);
    if (!rowsOk(retired, "ac4-helper: read after retire", (m) => assert(false, m)))
      break ac4_helper_case;
    const gone = retired.rows.find((r) => r.id === row.id);
    assert(
      gone?.status === "resolved" && gone.confirmedBy !== undefined,
      `ac4-helper: the row was retired BY A CONFIRMATION, so it has a provenance to lapse (${gone?.status}/${JSON.stringify(gone?.confirmedBy)})`,
    );
    // Precondition for the lapse itself: a retiring round reports no lapse. This
    // is the empty-array arm, asserted where the event has not happened yet, so
    // the red below cannot be satisfied by a field that is always populated.
    assert(
      Array.isArray(retiring.lapsed) && retiring.lapsed.length === 0,
      `ac4-helper: the retiring round itself reports an empty lapse list (Array.isArray=${Array.isArray(retiring.lapsed)}, value=${JSON.stringify(retiring.lapsed)})`,
    );
    // Now the confirmation stops binding: same row, a patchId that is not the
    // reviewed one. The next full round must re-open it AND report the lapse.
    writeLedger(f.ledgerFile, [
      {
        branch: "feature/work",
        kind: "adversarial",
        patchId: "a-different-patch-not-the-reviewed-one",
        passed: true,
        at: Date.now() + 1_000,
        headSha: f.headSha,
        rowId: row.id,
        round: 3,
      },
    ]);
    const lapsing = await silentRound(f.dir, f.headSha, pid!, Date.now() + 20_000);
    if (!setupOk(lapsing, "ac4-helper: lapsing round", (m) => assert(false, m)))
      break ac4_helper_case;
    const after = await rowsOf(f.dir);
    if (!rowsOk(after, "ac4-helper: read after lapse", (m) => assert(false, m)))
      break ac4_helper_case;
    const back = after.rows.find((r) => r.id === row.id);
    assert(
      back?.status === "open" && back.confirmationLapsed === true,
      `ac4-helper: the row is open again and stamped as lapsed (${back?.status}/${String(back?.confirmationLapsed)})`,
    );
    // THE disclosure, read off the helper's arm: non-empty, naming this row, with
    // a provenance that carries the confirmation's patch marker.
    assert(
      Array.isArray(lapsing.lapsed) &&
        lapsing.lapsed.length === 1 &&
        lapsing.lapsed[0]?.rowId === row.id &&
        lapsing.lapsed[0]?.title === FINDING.title &&
        typeof lapsing.lapsed[0]?.provenance === "string" &&
        lapsing.lapsed[0]!.provenance.includes("patch="),
      `ac4-helper: the helper's arm reports the lapse with the provenance it lapsed on (value=${JSON.stringify(lapsing.lapsed)}, want rowId=${row.id})`,
    );
  } finally {
    releaseFixture(f);
    removeFixture(f);
  }
  break ac4_helper_case;
}

process.exit(exit);
