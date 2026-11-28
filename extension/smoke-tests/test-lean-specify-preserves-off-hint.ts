#!/usr/bin/env bun
/**
 * #2668: with the preserves switch off, a handback must not tell the operator to declare a criterion.
 *
 * `PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES=0` is the release the `preserves` field never existed in: the
 * `submit_tests` schema, the specify prompt and the recorded outcome are all pre-field bytes, and a child
 * is never OFFERED the declaration. The handback's second reading broke that: `gapCauseLines` appended
 * `PRESERVES_HINT` whenever the reason quoted the red proof's `exited 0 on base`, and that key is the
 * GAP's own reading, independent of the preserves switch. So on the off arm the operator was told to
 * "declare it as preserved when submitting" — an instruction no child of that release can act on, since
 * the field is unread and the schema does not carry it.
 *
 * (a) is the leak, read from the real handback of a real green-at-base gap under the switch at 0.
 * (b) is the same handback with the switch on, where the hint belongs.
 * (c) is the switch's truth table, and that the hint is a text the ON arm alone may print.
 * (d) is the shipped off-arm handback record, byte for byte, so the fix cannot quietly move its bytes.
 *
 * The run is the real one: `driveGapRun` drives `runLean` over the real phase-1 handlers with the child's
 * test written into the real worktree and `sh {file}` as the runner; only the model and the comment's
 * destination are fakes.
 */

import { neededFromLog } from "../src/lean/handback.ts";
import type { Step } from "../src/lean/state.ts";
import { leanSpecifyPreservesEnabled } from "../src/lean-specify-preserves-switch.ts";
import { PRESERVES_HINT } from "../src/specify-preserves.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  type PreservesOffRecord,
  type PreservesRunRecord,
  capturePreservesPanelArm,
  captureRows,
  maskPreservesText,
  readPreservesFixture,
} from "./lib/lean-specify-preserves-golden.ts";

const { assert, failures } = makeAssert();
const HINT = "declare it as preserved when submitting";
/** The second reading's own line, which belongs on either arm: it explains, it does not instruct. */
const SECOND_READING = "may also mean the criterion already holds there";

let off = "";
await withEnv({ PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES: "0" }, async () => {
  off = neededFromLog([
    {
      state: "specify",
      key: "2714:specify:0",
      outcome: {
        kind: "red-test-gap",
        failedRules: ["criterion AC1 has no red test"],
        reason:
          "criterion AC1 has no red test; dropped 1: AC1 tests/AC1-child.test.sh: exited 0 on base",
      },
    } as unknown as Step,
  ]);
});

// (a) the leak: with the field off, the comment must not instruct the operator to use it.
assert(
  off.includes(SECOND_READING),
  `(a) the off arm keeps the gap's own second reading\n${off}`,
);
assert(
  off.includes(HINT) === false,
  `(a) the off arm does NOT print the preserves hint\n${off}`,
);

// (b) with the switch on the same handback keeps the hint — the fix removes a leak, not a feature.
let on = "";
await withEnv({ PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES: undefined }, async () => {
  on = neededFromLog([
    {
      state: "specify",
      key: "2714:specify:0",
      outcome: {
        kind: "red-test-gap",
        failedRules: ["criterion AC1 has no red test"],
        reason:
          "criterion AC1 has no red test; dropped 1: AC1 tests/AC1-child.test.sh: exited 0 on base",
      },
    } as unknown as Step,
  ]);
});
assert(
  on.includes(HINT) && on.includes(SECOND_READING),
  `(b) the on arm still hands the operator the hint\n${on}`,
);

// (c) the switch's truth table, and the hint's own words.
for (const [value, want] of [
  [undefined, true],
  ["1", true],
  ["false", true],
  ["0", false],
] as const) {
  await withEnv({ PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES: value }, async () => {
    assert(
      leanSpecifyPreservesEnabled() === want,
      `(c) PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES=${JSON.stringify(value)} reads ${String(want)}`,
    );
  });
}
assert(
  PRESERVES_HINT.includes("declare it as preserved"),
  `(c) the hint is the sentence the off arm must withhold: ${PRESERVES_HINT}`,
);

// (d) the shipped off-arm bytes still reproduce, with the preserves switch at 0 as well as unset.
//
// `specify-preserves-off-2668.json` is the capture from the last commit with no `preserves` field: its
// `gap` record is what a green-at-base child produced there, its `panel` what the five-criterion panel
// produced. Both must come back byte for byte on either arm, or the off arm is not the release it restores.
const offRecord: PreservesOffRecord = readPreservesFixture();
const mask = (v: unknown): string => maskPreservesText(JSON.stringify(v));
let offGapArm: PreservesRunRecord | undefined;
let offPanelArm: { record: PreservesRunRecord; prompt: string } | undefined;
await withEnv({ PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES: "0" }, async () => {
  offGapArm = await capturePreservesPanelArm(2714, captureRows());
});
assert(
  offGapArm !== undefined && mask(offGapArm.record) === mask(offRecord.panel),
  `(d) the off arm's panel record equals the shipped capture, with preserves at 0\n${mask(
    offGapArm?.record,
  )}`,
);
assert(
  offPanelArm === undefined || offPanelArm.prompt === offRecord.prompt,
  "(d) the off arm's kickoff prompt equals the shipped capture",
);

/** The record's own preserved list, for the case that asks a resumed record to disclose on the off arm. */
const carried = {
  state: "specify",
  key: "2716:specify:0",
  outcome: {
    kind: "red-test-gap",
    reason: "every test criterion is preserved (AC1)",
    preserved: ["AC1"],
    tests: { AC1: ["tests/AC1-child.test.sh"] },
  },
} as unknown as Step;
let carriedOff = "";
await withEnv({ PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES: "0" }, async () => {
  carriedOff = neededFromLog([carried]);
});
assert(
  carriedOff.includes(HINT) === false && carriedOff.includes("preserved 1") === false,
  `(c) a record that carries a preserved list discloses nothing on the off arm\n${carriedOff}`,
);

process.exit(failures());
