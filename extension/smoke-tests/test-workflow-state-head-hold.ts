/**
 * #1533 — the state-file shape of a cycle the merged step holds, and what the
 * validators do with it.
 *
 * The merged step parks a cycle it will not merge, and the park's only record
 * is the hold record on the pipeline state. Three things have to hold and are
 * checked here rather than in a prose review:
 *
 *  1. the two commit OIDs a head refusal carries are VALIDATED at read, because
 *     a recovery command is built from them — a hand-edited state file must not
 *     put a non-OID into the head flag the operator is told to paste;
 *  2. an OLD state file (no such fields) still validates, or every pre-#1533
 *     cycle would be reported corrupt;
 *  3. the head refusal is distinguishable from a CI refusal, because the
 *     operator's next action is different: green CI plus "the head was not the
 *     reviewed one" is not a checks problem.
 *
 * The forge-side pin (the flag on the command, the refused pin classified
 * before the other errors) is covered by test-work-driver-merged-mechanized.ts
 * and the forge argv tests; the verification itself by
 * test-work-driver-merged-head.ts.
 */

import { mergeHoldHeadFindings } from "../src/workflow-state-schema-merge-hold.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { explainMergeHold } from "../src/work-driver-merge-authority.ts";
import { setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

function state(hold: Record<string, unknown> | undefined): WorkState {
  const s = initialState(7, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "merged",
      prNumber: 42,
      ...(hold === undefined ? {} : { mergeHold: hold }),
    },
  } as WorkState;
}

// ── the validator's own contract ───────────────────────────────────────────

{
  assert(
    mergeHoldHeadFindings(undefined).length === 0,
    "absent hold record: no findings (a cycle held on CI records none of these)",
  );
  assert(
    mergeHoldHeadFindings({ authorityGranted: true, authoritySource: "operator" }).length === 0,
    "pre-#1533 hold record: an old entry with none of the new fields validates",
  );
  const good = mergeHoldHeadFindings({
    reviewedHead: OID_A,
    headAtMerge: OID_B,
    headCheckReason: "the head was not the reviewed one",
  });
  assert(good.length === 0, `well-formed head fields validate (${JSON.stringify(good)})`);
}

{
  // The finding's wording is itself part of the contract this loop asserts on: it
  // must name the FIELD and say what shape it wanted. Written as one substring
  // (not `A && B`, which would match any finding naming either) so a reword that
  // drops the field name is caught rather than passing on an unrelated sentence.
  const SHA_WANT = "mergeHold.reviewedHead is not a full 40-char commit SHA";
  const bad: Array<[string, unknown]> = [
    ["abbreviated OID", OID_A.slice(0, 12)],
    ["non-hex", "z".repeat(40)],
    ["a branch name", "feature/issue-1533"],
    ["a shell injection", `${OID_A} --force`],
    ["a number", 12345],
  ];
  for (const [label, value] of bad) {
    const findings = mergeHoldHeadFindings({ reviewedHead: value });
    assert(
      findings.some((f) => f.includes(SHA_WANT)),
      `refusal ${label}: rejected (${JSON.stringify(findings)})`,
    );
  }
  assert(
    mergeHoldHeadFindings({ headAtMerge: "nope" }).some((f) =>
      f.includes("mergeHold.headAtMerge is not a full 40-char commit SHA"),
    ),
    "refusal: headAtMerge is held to the same shape",
  );
  assert(
    mergeHoldHeadFindings({ headCheckReason: 7 }).some((f) =>
      f.includes("mergeHold.headCheckReason"),
    ),
    "refusal: the reason must be a string",
  );
  assert(
    mergeHoldHeadFindings(7).length > 0,
    "refusal: a non-object hold record is reported once, not crashed on",
  );
}

// ── the state file as a whole ──────────────────────────────────────────────

{
  const corrupt = validateDiscriminants(state({ reviewedHead: "not-an-oid" }));
  assert(
    corrupt.length > 0 && corrupt.some((f) => f.includes("reviewedHead")),
    `the state validator flags a corrupt head OID (${JSON.stringify(corrupt).slice(0, 200)})`,
  );
  const clean = validateDiscriminants(
    state({ reviewedHead: OID_A, headAtMerge: OID_B, headCheckReason: "moved" }),
  );
  assert(
    clean.length === 0,
    `the state validator accepts a head-held cycle (${JSON.stringify(clean).slice(0, 200)})`,
  );
  const legacy = validateDiscriminants(
    state({ authorityGranted: false, authoritySource: "none" }),
  );
  assert(
    legacy.length === 0,
    `the state validator leaves a pre-#1533 hold alone (${JSON.stringify(legacy).slice(0, 200)})`,
  );
}

// ── the operator can tell the two refusals apart ───────────────────────────

{
  const granted = { granted: true, source: "operator" as const };
  const ciText = explainMergeHold(
    granted,
    { ok: false, reason: "required checks failing: CI", failing: ["CI"], inconclusive: [] },
    42,
  );
  assert(ciText.includes("required checks failing: CI"), "explain: a CI refusal names the checks");
  const held = state({
    authorityGranted: true,
    authoritySource: "operator",
    reviewedHead: OID_A,
    headAtMerge: OID_B,
    headCheckReason: "the head was not the reviewed one: reviewed abc12345",
  });
  const rec = (held.pipelineState as { mergeHold?: Record<string, unknown> }).mergeHold;
  assert(
    rec?.reviewedHead === OID_A && rec?.headAtMerge === OID_B,
    "the park keeps BOTH SHAs it compared, not just one",
  );
  assert(
    typeof rec?.headCheckReason === "string" && rec.headCheckReason.includes("not the reviewed one"),
    "the park keeps the reason in the operator's words",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
