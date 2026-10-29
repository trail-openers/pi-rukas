#!/usr/bin/env bun
/**
 * plan-pi-spec — the EXCLUSIONS (#1883): an epic, a spike and a criteria-less draft
 * get no block AND no omission line, and their filed bodies are byte-identical to
 * the pre-#1883 render. A block for those three would be a claim the draft never
 * made (an epic criteria belong to sub-issues; a spike slot is the Expected
 * deliverable), and a disclosure line where nothing failed is noise that trains the
 * operator to ignore the line where something did.
 *
 * Split from `test-plan-pi-spec.ts` by the AGENTS.md 12 file-size cap.
 */
import { codeAppendReservation } from "../src/plan-driver-phase3.ts";
import { finalDraftBody } from "../src/plan-gap-disclosure.ts";
import {
  PI_SPEC_HEADING,
  PI_SPEC_OMISSION_PREFIX,
  piSpecReservation,
} from "../src/plan-pi-spec.ts";
import { assert, draftBody, specExit } from "./lib/plan-pi-spec-fixture.ts";
// --------------------------------- epic / spike / zero-criteria bodies unchanged

{
  const plain = draftBody(["a", "b", "c"]);
  const before = finalDraftBody(
    plain,
    [],
    [],
    undefined,
    [],
    { line: "automated run", marker: { run: "plan" } },
    { risk: undefined, sourceIssue: undefined },
  );
  for (const excluded of ["epic", "spike"] as const) {
    const filed = finalDraftBody(
      plain,
      [],
      [],
      undefined,
      [],
      { line: "automated run", marker: { run: "plan" } },
      { risk: undefined, sourceIssue: undefined },
      { type: excluded, title: "some title" },
    );
    assert(filed === before, `exclusions: a ${excluded}'s filed body is byte-identical to main's`);
    assert(!filed.includes(PI_SPEC_HEADING), `exclusions: a ${excluded} carries no block`);
    assert(
      !filed.includes(PI_SPEC_OMISSION_PREFIX),
      `exclusions: a ${excluded} carries no omission line either`,
    );
    assert(
      piSpecReservation(excluded) === 0 && codeAppendReservation(undefined, excluded) === 0,
      `exclusions: a ${excluded} reserves nothing, so its body budget is untouched`,
    );
  }
  const noCriteria = finalDraftBody(
    draftBody(["   "]),
    [],
    [],
    undefined,
    [],
    { line: "automated run", marker: { run: "plan" } },
    { risk: undefined, sourceIssue: undefined },
    { type: "feature", title: "some title" },
  );
  const noCriteriaBefore = finalDraftBody(
    draftBody(["   "]),
    [],
    [],
    undefined,
    [],
    { line: "automated run", marker: { run: "plan" } },
    { risk: undefined, sourceIssue: undefined },
  );
  assert(
    noCriteria === noCriteriaBefore,
    "exclusions: a zero-criteria plan's filed body is byte-identical to main's",
  );
  assert(
    !noCriteria.includes(PI_SPEC_HEADING) && !noCriteria.includes(PI_SPEC_OMISSION_PREFIX),
    "exclusions: a zero-criteria plan carries neither a block nor an omission line",
  );
  assert(
    finalDraftBody(
      plain,
      [],
      [],
      undefined,
      [],
      undefined,
      { risk: undefined, sourceIssue: undefined },
      // No piSpec object → no block: an unfilled title field must not file a guess.
      undefined,
    ) ===
      finalDraftBody(plain, [], [], undefined, [], undefined, {
        risk: undefined,
        sourceIssue: undefined,
      }),
    "exclusions: no piSpec means no block, byte-identical",
  );
}

console.log(`${specExit() === 0 ? "PASS" : "FAIL"} test-plan-pi-spec-exclusions`);
process.exit(specExit());
