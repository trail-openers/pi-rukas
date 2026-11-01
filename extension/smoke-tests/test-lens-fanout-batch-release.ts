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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as dispatchDeck from "../src/dispatch-deck.ts";
import { runLensFanOut } from "../src/lens-review-fanout.ts";
import type { Finding, LensRunResult } from "../src/lens-review-types.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";

let exit = 0;
function check(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const DIFF = ["src/a.ts", "src/b.ts"]
  .flatMap((f) => [
    `diff --git a/${f} b/${f}`,
    `--- a/${f}`,
    `+++ b/${f}`,
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ])
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
  // `startBatchEntry` early-returns under `PI_ENSEMBLE_QUIET_STATUS=1`, so the
  // row these assertions measure would never exist and every pre-check below
  // would go red for an environmental reason rather than a code one. A host MAY
  // export the variable; CI does not, and none of these assertions may depend
  // on which — so the acquire runs with it removed. `clearBatchEntry` has no
  // quiet gate (unlike `startBatchEntry`, which early-returns), so the release
  // assertions stay meaningful whichever way the env sits. The restore is in
  // `finally`: if `startBatchEntry` throws (it reaches `startTickerIfNeeded`,
  // dispatch-deck.ts:299), an unrestored variable would leave the deck quiet
  // for every later test in the process, turning each later assertion
  // red-vacuous (a row that never registered) rather than red for a real reason.
  const savedQuiet = process.env.PI_ENSEMBLE_QUIET_STATUS;
  try {
    delete process.env.PI_ENSEMBLE_QUIET_STATUS;
    dispatchDeck.startBatchEntry(key, { label: "code-review-specialist", size });
  } finally {
    // Restore the host's quiet setting so the fan-out and these assertions
    // observe the deck as production does, even when the acquire threw.
    if (savedQuiet === undefined) delete process.env.PI_ENSEMBLE_QUIET_STATUS;
    else process.env.PI_ENSEMBLE_QUIET_STATUS = savedQuiet;
  }
}

/** (1) THE LEAK — a rejecting child must still release the deck batch. */
async function leakingChildReleasesBatch() {
  const key = "rev1942g/leak";
  openBatch(key, 6);
  // PRE-ACQUIRE POSITIVE CONTROL. `openBatch` cannot witness its own acquire —
  // `startBatchEntry` early-returns under `PI_ENSEMBLE_QUIET_STATUS=1` without
  // throwing — so this is the assertion that can tell "the row was registered"
  // from "the deck silently never had it". Without it, `length === 0` under a
  // quiet or otherwise unregistered deck reads as "released". A host that
  // exports the variable suppresses the row entirely and every pre-check below
  // goes red for an environmental reason; the in-test quiet arm
  // (`clearIsNotQuietGated`, section 3) forces that same condition on every
  // host rather than waiting for one that happens to set it.
  check(
    dispatchDeck.batchSnapshot().some((b) => b.key === key),
    "canary: the deck registered the batch the caller acquired before the fan-out (positive control: red when PI_ENSEMBLE_QUIET_STATUS suppresses the row entirely)",
  );
  check(
    dispatchDeck.isTicking(),
    "canary: the acquired batch started the deck ticker (red when the acquire is suppressed or the ticker never starts)",
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
  check(
    dispatchDeck.batchSnapshot().some((b) => b.key === key),
    "canary: the batch the caller acquired is present before the fan-out — the positive counterpart to the release assertion below (red when the acquire is suppressed by PI_ENSEMBLE_QUIET_STATUS)",
  );
  check(
    dispatchDeck.isTicking(),
    "canary: the acquired batch started the deck ticker (paired with the release assertion below)",
  );
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
  // PRE-ACQUIRE CONTROL: the sole witness that the row exists, so the release
  // assertion at the end of this function cannot be satisfied by a deck that
  // never had the row. (A second copy of this same predicate added nothing: it
  // reddened identically and was collapsed.)
  check(
    dispatchDeck.batchSnapshot().some((b) => b.key === key),
    "canary: the deck registered the batch before the zero-healthy fan-out ran",
  );
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
  check(
    dispatchDeck.batchSnapshot().some((b) => b.key === key),
    "canary: the batch the caller acquired is present before the gated fan-out (positive control; red when PI_ENSEMBLE_QUIET_STATUS suppresses the row)",
  );
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
  check(
    dispatchDeck.batchSnapshot().filter((b) => b.key === key).length === 0,
    "canary: the gated fan-out releases the deck batch too (paired with the pre-check above)",
  );
  dispatchDeck.reset();
}

/** (3) THE RELEASE IS NOT QUIET-GATED — the linchpin of every release assertion
 * above, pinned directly rather than by a comment.
 *
 * `startBatchEntry` early-returns under `PI_ENSEMBLE_QUIET_STATUS=1`
 * (dispatch-deck.ts:290); `clearBatchEntry` has NO such gate, so the row is
 * deleted whichever way the env sits. If someone later added an `isQuiet()`
 * early-return to `clearBatchEntry`, then on any quiet run the acquire would
 * register nothing, the `length === 0` release assertion would be trivially
 * true, and the pre-acquire control would be the ONLY thing that could have
 * caught it — and it fires only on a host that happens to set the variable.
 * This arm forces that condition in-test so the gate runs it on every host.
 *
 * Two directions, because the comment and the behaviour can drift separately:
 *   (a) a STRUCTURAL pin, in the style test-dispatch-deck-list-quiet.ts:195
 *       uses — the shipped `clearBatchEntry` body must contain no quiet gate;
 *   (b) a BEHAVIOURAL arm — acquire with the flag unset (so the row is really
 *       there), set the flag, clear, and assert the snapshot is empty.
 *
 * What this does NOT catch, stated plainly: it pins the quiet DIRECTION of the
 * release only. A clear that stopped deleting for a NON-quiet reason (an
 * early-return on a missing row, a renamed map, the `finally` dropped from the
 * fan-out) is caught by the release assertions in (1)/(1b)/(2)/(2b), not here;
 * and (a) greps the shipped text, so a gate reached indirectly — a helper that
 * itself early-returns under quiet, or `process.env["PI_ENSEMBLE_QUIET_STATUS"]`
 * bracket-spelled — slips past (a) while (b) would still catch it. That is why
 * both are present and neither alone is the pin. */
async function clearIsNotQuietGated() {
  const key = "rev1942g/quiet-clear";

  // (a) STRUCTURAL pin — read the shipped source, fail if the release grew a
  // quiet gate. Anchored on the function declaration, not the word "clear".
  const deckPath = join(dirname(import.meta.path), "..", "src", "dispatch-deck.ts");
  const deckSrc = readFileSync(deckPath, "utf8");
  const decl = deckSrc.indexOf("export function clearBatchEntry");
  check(decl >= 0, "canary: dispatch-deck.ts declares clearBatchEntry (structural pin anchor)");
  const bodyStart = decl >= 0 ? deckSrc.indexOf("{", decl) : -1;
  // Take the function body by brace balance so the grep is scoped to THIS
  // function and cannot be satisfied by a quiet gate elsewhere in the file.
  let body = "";
  if (bodyStart >= 0) {
    let depth = 0;
    for (let i = bodyStart; i < deckSrc.length; i++) {
      const ch = deckSrc[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          body = deckSrc.slice(bodyStart, i + 1);
          break;
        }
      }
    }
  }
  check(
    body.length > 0 && !/isQuiet\s*\(/.test(body) && !/PI_ENSEMBLE_QUIET_STATUS/.test(body),
    "canary: clearBatchEntry's body has NO quiet gate (if it grew one, every release assertion above goes green-vacuous on a quiet run)",
  );

  // (b) BEHAVIOURAL arm — the release must delete the row even while quiet.
  dispatchDeck.reset();
  const savedQuiet = process.env.PI_ENSEMBLE_QUIET_STATUS;
  try {
    delete process.env.PI_ENSEMBLE_QUIET_STATUS;
    dispatchDeck.startBatchEntry(key, { label: "code-review-specialist", size: 2 });
    check(
      dispatchDeck.batchSnapshot().some((b) => b.key === key),
      "canary: the row is really registered before the quiet clear (acquire ran unquiet)",
    );
    process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
    dispatchDeck.clearBatchEntry(key);
    check(
      dispatchDeck.batchSnapshot().filter((b) => b.key === key).length === 0,
      "canary: clearBatchEntry deletes the row EVEN under PI_ENSEMBLE_QUIET_STATUS=1 (a quiet gate here would make the release assertions vacuous)",
    );
  } finally {
    if (savedQuiet === undefined) delete process.env.PI_ENSEMBLE_QUIET_STATUS;
    else process.env.PI_ENSEMBLE_QUIET_STATUS = savedQuiet;
    dispatchDeck.reset();
  }
}

await leakingChildReleasesBatch();
await happyPathReleasesBatch();
await extraFindingsCannotCarryClaimAlone();
await extraFindingsCountWhenALaneRan();
await clearIsNotQuietGated();
// A stale assertion import keeps the module's contract honest: `assert` is
// used for the invariant that must throw loudly rather than report softly.
assert.ok(typeof runLensFanOut === "function", "the fan-out seam exists");

process.exit(exit);
