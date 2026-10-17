#!/usr/bin/env bun
/**
 * #1398 round 2 — `pipelineState.prDraft` is validated on the resume path, the
 * same #533 rule that covers `commitPrRoot` and `dirtyRootExemptBaseline`: the
 * untyped cast in `readState` is the only runtime gate, so a partial or
 * hand-edited draft record must not reach a mark point.
 *
 * Why this field earns it: `markDraftPrReady` reads `status` to decide whether
 * the PR may merge and `findingsPosted` to decide whether a disclosure licenses
 * that ready. A `status` outside the three known values reads as "not a draft";
 * a findings row without its `patchId` can never be compared against the patch
 * being marked ready. Either fault turns a hold into a merge — the one
 * irreversible act in the cycle — so the validator, not the reader, is the gate.
 */

import { prDraftFindings } from "../src/workflow-state-schema-pr-draft.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const base = () => initialState(1398, 1000) as unknown as Record<string, unknown>;
const withDraft = (v: unknown) => {
  const s = base();
  (s.pipelineState as Record<string, unknown>).prDraft = v;
  return s;
};

// Absent validates — every state file from before #1292, and every cycle whose
// PR was never opened as a draft, must still resume.
assert(
  validateDiscriminants(base()).length === 0,
  "an absent prDraft validates clean (a pre-#1292 state file still resumes)",
);
assert(prDraftFindings(undefined).length === 0, "…and the predicate itself says [] for absent");

// The three real statuses validate, with every optional field present.
for (const status of ["draft", "ready", "ready-failed"]) {
  assert(
    validateDiscriminants(
      withDraft({
        status,
        attempts: 2,
        draftAttempts: 1,
        holdReason: "why",
        error: "the forge could not be reached (network or outage)",
        findingsPosted: [{ patchId: "abc", at: 1, round: 1, prNumber: 42 }],
      }),
    ).length === 0,
    `a full prDraft with status "${status}" validates clean`,
  );
}
assert(
  validateDiscriminants(withDraft({ status: "draft" })).length === 0,
  "a minimal { status: 'draft' } validates (every other field is optional)",
);
assert(
  validateDiscriminants(withDraft({ status: "draft", findingsPosted: [] })).length === 0,
  "an empty findingsPosted validates — it is a real answer: nothing was disclosed",
);

// Anything else is refused, naming the field.
{
  const cases: [unknown, string, boolean?][] = [
    ["draft", "is not an object"],
    [[], "is not an object"],
    [null, "is not an object"],
    [{ status: "merged" }, "prDraft.status has unknown value"],
    [{ status: "" }, "prDraft.status has unknown value"],
    // #1398 round 3 — an ABSENT status is legal: `recordLensResidualsPosted`
    // writes the disclosure rows on a cycle that never opened its PR as a draft,
    // and synthesising `status: "draft"` there made the driver claim a hold it
    // never took. An empty object is therefore a VALID record (it asserts only
    // "no disclosure rows yet"); what must still fail is a status that exists
    // and says nothing recognisable.
    [{}, "prDraft.status has unknown value", true],
    [{ status: "ready", attempts: "3" }, "prDraft.attempts is not a finite number"],
    [{ status: "ready", attempts: Number.NaN }, "prDraft.attempts is not a finite number"],
    [
      { status: "ready", attempts: Number.POSITIVE_INFINITY },
      "prDraft.attempts is not a finite number",
    ],
    // #1398: the draft direction's own counter is bounded too, so a non-number
    // there would make `drafted >= MAX` false forever — an unbounded re-arm loop.
    [{ status: "draft", draftAttempts: "1" }, "prDraft.draftAttempts is not a finite number"],
    [{ status: "draft", findingsPosted: {} }, "findingsPosted is not an array"],
    [{ status: "draft", findingsPosted: "abc" }, "findingsPosted is not an array"],
    [{ status: "draft", findingsPosted: [null] }, "findingsPosted[0] is not an object"],
    [{ status: "draft", findingsPosted: [{ at: 1 }] }, "findingsPosted[0].patchId is missing"],
    [
      { status: "draft", findingsPosted: [{ patchId: 7, at: 1, round: 1 }] },
      "findingsPosted[0].patchId is missing",
    ],
  ];
  for (const [value, expect, legal] of cases) {
    const findings = validateDiscriminants(withDraft(value));
    if (legal) {
      assert(
        findings.length === 0,
        `a prDraft of ${JSON.stringify(value)} is ACCEPTED with no finding — an absent status is a disclosure-only record (#1398 round 3), not a corrupt one (got ${JSON.stringify(findings)})`,
      );
      continue;
    }
    assert(
      findings.length === 1 && findings[0].includes("prDraft") && findings[0].includes(expect),
      `a prDraft of ${JSON.stringify(value)} is refused with one finding naming the field and "${expect}" (got ${JSON.stringify(findings)})`,
    );
  }
}

// Each bad row of a multi-row list is its own finding — a single corrupt row
// does not hide behind the good ones, and the driver halts rather than resuming.
assert(
  validateDiscriminants(
    withDraft({
      status: "draft",
      findingsPosted: [{ patchId: "ok" }, { at: 1 }, { patchId: 5 }],
    }),
  ).length === 2,
  "two bad rows are two findings — the resume halts on the record rather than reading a partial disclosure list",
);

// A corrupt record is a hard stop, not a warning: `refuseInvalidState` treats a
// non-empty result as a halt, which is what keeps a fabricated `status: "ready"`
// from licensing a merge.
{
  const findings = validateDiscriminants(withDraft({ status: "ready" }));
  assert(findings.length === 0, "a genuine ready validates (the field is not suspected by shape)");
  assert(
    validateDiscriminants(withDraft({ status: "READY" })).length === 1,
    "a case-shifted status is refused — the vocabulary is exact, so a hand edit cannot smuggle a ready",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
