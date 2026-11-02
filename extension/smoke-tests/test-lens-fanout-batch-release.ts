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
import { join } from "node:path";
import * as dispatchDeck from "../src/dispatch-deck.ts";
import { runLensFanOut } from "../src/lens-review-fanout.ts";
import {
  coverageClaimUnitArms,
  acquireTickerArms,
  silentLaneRoundArms,
} from "./lib/lens-coverage-liveness-probe.ts";
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
    // Restore the host's quiet setting even when `startBatchEntry` throws (it
    // reaches `startTickerIfNeeded`, dispatch-deck.ts:299). The reason is
    // narrower than "the deck would stay quiet for everything later": this
    // helper DELETES the variable before the acquire, so a throw that skipped
    // the restore would leave the host's own setting lost for the rest of the
    // process — and a host that had exported `1` would find later tests reading
    // a deck that is no longer quiet, while a host that had it unset would find
    // it restored to nothing. A throw here cannot leave the deck quiet for
    // later code that does not clear it itself; what it can do is lose the
    // host's value, which is what this `finally` prevents.
    if (savedQuiet === undefined) delete process.env.PI_ENSEMBLE_QUIET_STATUS;
    else process.env.PI_ENSEMBLE_QUIET_STATUS = savedQuiet;
  }
}

/** (1) THE LEAK — a rejecting child must still release the deck batch. */
async function leakingChildReleasesBatch() {
  const key = "rev1942g/leak";
  openBatch(key, 6);
  // PRE-ACQUIRE CONTROLS. `openBatch` cannot witness its own acquire —
  // `startBatchEntry` early-returns under `PI_ENSEMBLE_QUIET_STATUS=1` without
  // throwing — so these are the assertions that can tell "the row was
  // registered" from "the deck silently never had it". Without them,
  // `length === 0` under a quiet or otherwise unregistered deck reads as
  // "released". They are TWO witnesses, not one assertion and a copy: the row
  // lives in `batches`, the ticker in a module-level handle, and
  // `clearBatchEntry` early-returns on a missing row before it ever reaches the
  // ticker stop — so the row arm tells you the acquire happened and the ticker
  // arm tells you the timer actually started. Measured 2026-11-04 in a scratch
  // copy: blinding `isTicking()` to `return false` (dispatch-deck.ts, the
  // `tickHandle !== undefined` read) reddens BOTH ticker pre-checks in this
  // file while leaving every row assertion green — which is the proof that the
  // ticker arm observes something the row arm cannot, and that collapsing the
  // pair as "byte-duplicates" would have deleted a live witness.
  check(
    dispatchDeck.batchSnapshot().some((b) => b.key === key),
    "canary: the deck registered the batch the caller acquired before the fan-out (positive control: red when PI_ENSEMBLE_QUIET_STATUS suppresses the row entirely)",
  );
  acquireTickerArms(check, dispatchDeck.isTicking, "leak-path");
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
    "a rejecting lensChildFn still releases the deck batch (no leaked row)",
  );
  // The ticker is a different resource from the row and needs its own witness:
  // the deck is empty by this point, so a still-running ticker is a real leak
  // rather than another batch holding the timer up. `clearBatchEntry` returns
  // early on a missing row, so a leaked ticker is exactly the failure a row-only
  // check cannot see.
  check(
    !dispatchDeck.isTicking(),
    "canary: the rejecting path also stops the deck ticker (the deck holds no batch here, so a running ticker is leaked — the row assertion above cannot see this)",
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
  // Both healthy lanes must have run AND produced evidence: `lensResults` is
  // the rows the round reports, and `hasReviewEvidence` is what the liveness
  // flag reads, so a lane that returned a blank row would pass a length-only
  // check and then silently poison the coverage claim (section 4b).
  check(
    out.lensResults.length === 2 &&
      out.lensResults.every((r) => (r.findings?.length ?? 0) > 0 || (r.summary ?? "").trim() !== ""),
    "canary: both healthy lanes produced rows, and each row carries evidence (a blank row would pass a length-only check and still make the round's liveness flag false)",
  );
  dispatchDeck.reset();
}

/** (2) THE UNGATED MERGE — one `extraFindings` row cannot earn the ✓ alone. */
async function extraFindingsCannotCarryClaimAlone() {
  const key = "rev1942g/ungated";
  openBatch(key, 0);
  // PRE-ACQUIRE CONTROLS, one per resource: the row arm and the ticker arm
  // below are not duplicates of each other (see section (1) — blinding the
  // `tickHandle` read reddens the ticker arms and leaves the row arms green).
  // They are the per-function guarantee that the release assertion at the end
  // of this function cannot be satisfied by a deck that never held the row.
  check(
    dispatchDeck.batchSnapshot().some((b) => b.key === key),
    "canary: the deck registered the batch before the zero-healthy fan-out ran (row arm — red when the acquire is suppressed)",
  );
  acquireTickerArms(check, dispatchDeck.isTicking, "zero-healthy");
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
 * fan-out) is caught by the release assertions in (1)/(1b)/(2)/(2b), not here.
 *
 * WHICH ASSERTION WITNESSES WHICH SPELLING, from whole-arm measurements rather
 * than from this comment's earlier guess (it claimed an indirectly-reached quiet
 * gate "slips past (a) while (b) would still catch it", and that a bracket-
 * spelled gate slipped past — a lens measured that the bracket spelling reddens
 * BOTH arms, so the two claims were wrong and are replaced by what was observed):
 *   - a literal `isQuiet()` call written into the body → (a) reddens (its
 *     `/isQuiet\s*\(/` test), and (b) reddens too if the gate actually skips the
 *     delete; (a) is the one that fires on a gate that cannot take effect.
 *   - `process.env["PI_ENSEMBLE_QUIET_STATUS"]`, the bracket spelling → (a)
 *     reddens. The earlier text said it slipped past; it does not — (a) tests
 *     `/PI_ENSEMBLE_QUIET_STATUS/` against the body, which matches bracketed and
 *     dotted forms alike. NOT EXAMINED: whether (b) reddens for this spelling,
 *     which depends on whether such a gate would skip the delete.
 *   - a gate reached INDIRECTLY, through a helper that itself early-returns
 *     under quiet → (a) cannot see it (the gate is not textually in the body),
 *     so (b) is the sole witness, and only because the delete then stops
 *     happening. NOT EXAMINED: no fixture in this file installs such a helper.
 *   - the `finally` dropped from `runLensFanOut` → not examined here; that is
 *     what (1) covers.
 * The scanner that scopes (a) to one body is itself load-bearing, so its
 * extraction is asserted below rather than trusted: a (a) that greps the wrong
 * span is green forever, which is the bug class this file exists to remove. */
async function clearIsNotQuietGated() {
  const key = "rev1942g/quiet-clear";

  // (a) STRUCTURAL pin — read the shipped source, fail if the release grew a
  // quiet gate. Anchored on the function declaration, not the word "clear".
  const deckPath = join(import.meta.dirname, "..", "src", "dispatch-deck.ts");
  const deckSrc = readFileSync(deckPath, "utf8");
  const decl = deckSrc.indexOf("export function clearBatchEntry");
  check(decl >= 0, "canary: dispatch-deck.ts declares clearBatchEntry (structural pin anchor)");
  const bodyStart = decl >= 0 ? deckSrc.indexOf("{", decl) : -1;
  // Take the function body by brace balance so the grep is scoped to THIS
  // function and cannot be satisfied by a quiet gate elsewhere in the file. A
  // scanner whose failure mode is silence is not a guard, so each step of its
  // extraction is asserted separately below — a declaration index, a body start,
  // a non-empty body, and a token that only the REAL body contains.
  check(bodyStart >= 0, "canary: the structural pin located the body-open brace after the declaration (red if the declaration moved or lost its brace)");
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
  // POSITIVE CONTROLS ON THE SCANNER ITSELF. Without these, a scan that
  // extracted the wrong span (or nothing) would make the pin below pass green
  // forever, since "no quiet gate found in the empty string" is indistinguishable
  // from "none found in the real body". `batches.delete` is a token from
  // `clearBatchEntry`'s actual body and from no neighbouring function, so it
  // witnesses that the extraction landed on the right one.
  check(decl >= 0, "canary: the scanner found the clearBatchEntry declaration index (red if the declaration is renamed or removed)");
  check(bodyStart > decl, "canary: the scanner's body start sits AFTER the declaration it was anchored to (red if the anchor and the brace disagree)");
  check(body.length > 0, "canary: the scanner extracted a non-empty body (an empty span would make the quiet-gate grep below pass vacuously)");
  check(
    body.includes("batches.delete"),
    `canary: the extracted span really is clearBatchEntry's body — it contains \`batches.delete\` (got ${JSON.stringify(body.slice(0, 80))})`,
  );
  check(
    body.length < deckSrc.length,
    "canary: the extracted span is a SUBSET of the file, not the whole file (a whole-file span would let a quiet gate elsewhere satisfy or veto this pin)",
  );
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

/** (4) THE LIVENESS CONJUNCT HAS A WITNESS OF ITS OWN.
 *
 * `coverageClaimEarned` ANDs three conditions, and the fan-out's own comment
 * calls `allLanesProducedEvidence` the flag that actually closes the liveness
 * lock. Hard-wiring it to `true` in `lens-review-fanout.ts` reddened NOTHING:
 * every existing case either passes `true` or is caught by another conjunct, so
 * the real lock had no witness.
 *
 * Two kinds of witness, and the measurements say you need both — see
 * `lib/lens-coverage-liveness-probe.ts` for the full account. The DIRECT arms
 * pin the conjunction's shape (they pass the flag in, so dropping the conjunct
 * from the AND reddens them). The END-TO-END round below pins the flag as the
 * fan-out COMPUTES it: hard-wiring `allLanesProducedEvidence = true` at its
 * definition site (blob `6b086460…`) reddens NOTHING among the direct arms —
 * they judge the argument, not the expression — and only this round catches it.
 *
 * Measured pair, same fixture, only the flag's expression differing:
 *   shipped  (blob `16a748e9…`) → `findingClaimedFile === false`
 *   mutant   (blob `6b086460…`) → `findingClaimedFile === true` */
coverageClaimUnitArms(check);

/** (4b) THE END-TO-END WITNESS for the same flag, driving the fan-out rather
 * than calling the predicate — the case the direct arms cannot replace.
 *
 * One healthy lane is SILENT (no findings, no summary) and the other cites a
 * denominator file, so `hasFindingClaimedFile` is satisfied and the ONLY thing
 * standing between the round and the ✓ is liveness. Under the shipped code the
 * answer is `false`; under `allLanesProducedEvidence = true` it is `true`
 * (measured — see the block above). `unaccounted` is asserted alongside so the
 * case cannot pass by having no denominator to speak of. The round itself is
 * built in `lib/lens-coverage-liveness-probe.ts`, next to the direct arms it
 * complements. */
await silentLaneRoundArms(check, openBatch);

// A stale assertion import keeps the module's contract honest: `assert` is
// used for the invariant that must throw loudly rather than report softly.
assert.ok(typeof runLensFanOut === "function", "the fan-out seam exists");

process.exit(exit);
