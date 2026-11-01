#!/usr/bin/env bun
/**
 * The fan-out half of the lens review owns the DECK BATCH's release: the caller
 * (`runLensReview`) opens it with `startPersistentBatch` and `runLensFanOut` is
 * the only place that clears it. Two defects this file pins, both found by a
 * six-lens round on this branch:
 *
 *   1. THE LEAK. `clearBatchEntry` used to run only on the line after
 *      `await Promise.all(...)`, and `Promise.all` REJECTS on the first
 *      rejected child. A `lensChildFn` that threw therefore skipped the clear
 *      and left the batch row (and its 1s ticker) in the deck for the rest of
 *      the run — a `code-review-specialist×6` row nobody could account for,
 *      with no error anywhere to explain it. The clear now sits in `finally`.
 *
 *   2. THE UNGATED MERGE. `claimedEvidence` merged the caller's
 *      `extraFindings` while `accountedEvidence` gated the same merge behind
 *      `results.length > 0`. On a zero-healthy round one caller-supplied row
 *      could satisfy the POSITIVE coverage claim (`hasFindingClaimedFile`)
 *      with no lane evidence at all — the ✓ for a round that reviewed nothing.
 *      Both lists now read the same gate. Stated honestly: this is
 *      defence-in-depth, not the bug fix — `coverageClaimEarned` already
 *      refuses on `allLanesProducedEvidence`, so the gate this test exercises
 *      is unreachable-by-construction and the file stays green with it removed
 *      (two independent rounds measured this). The test pins that the two lists
 *      agree, not that a hole is closed.
 *
 * Offline: no child, no forge, no spawn — `lensChildFn` is a stub that either
 * answers or rejects.
 */

import assert from "node:assert";
import * as dispatchDeck from "../src/dispatch-deck.ts";
import { runLensFanOut } from "../src/lens-review-fanout.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";
import type { Finding, LensRunResult } from "../src/lens-review-types.ts";

let exit = 0;
function check(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const DIFF = ["src/a.ts", "src/b.ts"]
  .flatMap((f) => [`diff --git a/${f} b/${f}`, `--- a/${f}`, `+++ b/${f}`, "@@ -1 +1 @@", "-x", "+y"])
  .join("\n");

/** The three-file-shaped denominator the assertions measure against. */
const RESOLVED = { kind: "ok", diffSource: "computed", diff: DIFF };

function healthyRow(lens: string, findings: Finding[] = []): LensRunResult {
  return {
    lens,
    ok: true,
    ms: 1,
    startMs: Date.now(),
    attempts: 1,
    blocked: false,
    findings,
    summary: "Reviewed the change, no issues.",
  } as unknown as LensRunResult;
}

function finding(p: string): Finding {
  return { lens: "SECURITY", severity: "LOW", path: p, line: 1, title: "x" } as unknown as Finding;
}

const slot = (_lens: string, fn: () => Promise<LensRunResult>) => fn();

/** Open a batch exactly as `runLensReview` does, and hand back the key. */
function openBatch(key: string, size: number) {
  dispatchDeck.reset();
  dispatchDeck.startBatchEntry(key, { label: "code-review-specialist", size });
}

/** (1) THE LEAK — a rejecting child must still release the deck batch. */
async function leakingChildReleasesBatch() {
  const key = "rev1942g/leak";
  openBatch(key, 6);
  check(
    dispatchDeck.batchSnapshot().some((b) => b.key === key),
    "canary: the batch the caller acquired is present before the fan-out",
  );
  const boom = new Error("lens child threw");
  let rejected = false;
  try {
    await runLensFanOut({
      healthy: LENS_ROSTER.slice(0, 2),
      blocked: [],
      // The first child rejects; `Promise.all` therefore rejects and the code
      // after it never runs — which is precisely the path that used to leak.
      lensChildFn: async (a: { lens: { name: string } }) => {
        if (a.lens.name === LENS_ROSTER[0]?.name) throw boom;
        return healthyRow(a.lens.name);
      },
      runId: "rev1942g",
      skillsDir: "/tmp/rev1942g",
      context: "",
      roster: LENS_ROSTER.slice(0, 2),
      opts: { diff: DIFF },
      bumpBatch: () => {},
      batchKey: key,
      modelSlot: slot,
      resolved: RESOLVED,
    });
  } catch (e) {
    rejected = e === boom;
  }
  check(rejected, "the rejecting child's error still propagates to the caller (not swallowed)");
  check(
    dispatchDeck.batchSnapshot().filter((b) => b.key === key).length === 0,
    "a rejecting lensChildFn still releases the deck batch (no leaked row / ticker)",
  );
  dispatchDeck.reset();
}

/** (1b) The happy path releases too, so the fix is not just an extra clear. */
async function happyPathReleasesBatch() {
  const key = "rev1942g/happy";
  openBatch(key, 2);
  const out = await runLensFanOut({
    healthy: LENS_ROSTER.slice(0, 2),
    blocked: [],
    lensChildFn: async (a: { lens: { name: string } }) => healthyRow(a.lens.name),
    runId: "rev1942g",
    skillsDir: "/tmp/rev1942g",
    context: "",
    roster: LENS_ROSTER.slice(0, 2),
    opts: { diff: DIFF },
    bumpBatch: () => {},
    batchKey: key,
    modelSlot: slot,
    resolved: RESOLVED,
  });
  check(
    dispatchDeck.batchSnapshot().filter((b) => b.key === key).length === 0,
    "canary: the healthy fan-out still releases the deck batch",
  );
  check(out.lensResults.length === 2, "canary: both healthy lanes produced rows");
  dispatchDeck.reset();
}

/** (2) THE UNGATED MERGE — one `extraFindings` row cannot earn the ✓ alone. */
async function extraFindingsCannotCarryClaimAlone() {
  const key = "rev1942g/ungated";
  openBatch(key, 0);
  const out = await runLensFanOut({
    // ZERO healthy lanes: nobody ran. `claimedEvidence` used to merge the
    // caller's rows here ungated, so `hasFindingClaimedFile` saw a citation
    // and the round earned the positive claim with no lane evidence.
    healthy: [],
    blocked: LENS_ROSTER.slice(0, 2),
    lensChildFn: async () => {
      throw new Error("must not be called with a zero-healthy roster");
    },
    runId: "rev1942g",
    skillsDir: "/tmp/rev1942g",
    context: "",
    roster: LENS_ROSTER.slice(0, 2),
    opts: { diff: DIFF },
    bumpBatch: () => {},
    batchKey: key,
    modelSlot: slot,
    resolved: RESOLVED,
    extraFindings: [finding("src/a.ts")],
  });
  check(
    out.findingClaimedFile === false,
    "a zero-healthy round earns no positive coverage claim from a caller-supplied finding alone",
  );
  check(out.hasDenominator === true, "canary: the round still HAD a denominator");
  check(
    dispatchDeck.batchSnapshot().filter((b) => b.key === key).length === 0,
    "canary: the zero-healthy fan-out releases the deck batch too",
  );
  dispatchDeck.reset();
}

/** (2b) With a lane that ran, the caller's row still counts — the gate is the
 * lane, not the caller's rows. */
async function extraFindingsCountWhenALaneRan() {
  const key = "rev1942g/gated-ok";
  openBatch(key, 1);
  const out = await runLensFanOut({
    healthy: LENS_ROSTER.slice(0, 1),
    blocked: [],
    // The lane's own finding cites the OTHER file, so the only citation for
    // `src/a.ts` is the caller's merged row.
    lensChildFn: async (a: { lens: { name: string } }) =>
      healthyRow(a.lens.name, [finding("src/b.ts")]),
    runId: "rev1942g",
    skillsDir: "/tmp/rev1942g",
    context: "",
    roster: LENS_ROSTER.slice(0, 1),
    opts: { diff: DIFF },
    bumpBatch: () => {},
    batchKey: key,
    modelSlot: slot,
    resolved: RESOLVED,
    extraFindings: [finding("src/a.ts")],
  });
  check(
    out.findingClaimedFile === true,
    "canary: with a lane that ran, a merged deterministic finding still earns the claim",
  );
  check(out.unaccounted.length === 0, "canary: both denominator files accounted for");
  dispatchDeck.reset();
}

await leakingChildReleasesBatch();
await happyPathReleasesBatch();
await extraFindingsCannotCarryClaimAlone();
await extraFindingsCountWhenALaneRan();
// A stale assertion import keeps the module's contract honest: `assert` is
// used for the invariant that must throw loudly rather than report softly.
assert.ok(typeof runLensFanOut === "function", "the fan-out seam exists");

process.exit(exit);
