/**
 * smoke-tests/lib/lean-build-reask-golden — where the off-arm goldens for the #2661 build re-ask
 * COME FROM, and what makes them goldens rather than a second copy of the code under test.
 *
 * The claim `test-lean-build-reask-off-arm.ts` defends is that `PI_ENSEMBLE_LEAN_BUILD_REASK=0`
 * leaves the build step's exhausted verdict byte-identical to what this repo wrote before the re-ask
 * existed — including on the arm where the child's recorded turn WAS cut at the output cap, which is
 * the arm a leaking switch would fail. A string re-derived from `lean/build.ts` in the same change
 * that edits it proves only that the module agrees with itself, so each constant below was captured
 * by checking out this branch's base commit — `740e56897a` — into a scratch directory under `tmp/`
 * with `git archive` (never a checkout over the working tree), copying `lib/lean-build-reask-fixture
 * -placeholder.ts` out of the way, and running this branch's OWN harness there with the switch unset
 * (the pre-change build has no knob to set):
 *
 *   runBuild({issue, dispatchResults: [CUT]}) where CUT is the field's shape —
 *   `ok: true, exitCode: 0, stopReason: "length", toolUses: [], observedToolCalls: 0,
 *   usage.output: 16384` — and the child acts in no way.
 *
 * What was recorded verbatim:
 *   - `GOLDEN_OFF_EXHAUSTED` — the exhausted reason that build wrote;
 *   - `GOLDEN_OFF_REASON_ON_UNASKED` — the same build's reason for a child that recorded NO stop
 *     reason at all (the arm that never asks: a switch that appended its clause on an un-vouchable
 *     child would fail byte-equality here, not on a phrase check);
 *   - `GOLDEN_OFF_DISPATCHES` — the cut run's whole `dispatches` array as JSON: exactly ONE
 *     `developer` row, which is what the re-ask must not widen on the off arm.
 *
 * Nothing re-runs the pre-change modules to derive the values and nothing re-types them: each is the
 * string a pre-change build emitted, pasted from the capture. The suite asserts the on arm's answers
 * are NOT equal to them beside this, so a constant quietly replaced with the on-arm's own output
 * fails rather than passing — a golden equal to the new behaviour is not an off arm, it is a missing
 * test.
 */

/** The base commit the capture was taken from — the last one without a build re-ask. */
export const GOLDEN_BASE_COMMIT = "740e56897a";

/** The exhausted reason the pre-change build wrote for a cut child that made no tool call.
 *  Compared with `===`, never with `includes`. */
export const GOLDEN_OFF_EXHAUSTED = "the developer produced no change";

/** The same build's reason for a child that recorded no stop reason — the never-asked arm. */
export const GOLDEN_OFF_REASON_ON_UNASKED = "the developer produced no change";

/** The cut run's dispatch rows as the record held them: one row, and its recorded stop reason. */
export const GOLDEN_OFF_DISPATCHES =
  '[{"role":"developer","ms":1,"ok":true,"usage":{"input":11,"output":16384,"cacheRead":0,"cacheWrite":0,"cost":0.4,"turns":1},"stopReason":"length"}]';

/** The clause the on arm appends and the off arm must never contain. */
export const ON_REASK_CLAUSES = ["output-token limit", "one continuation"];
