#!/usr/bin/env bun
/**
 * plan-pi-spec — the over-long-criterion guard (#1883, hardened for #2045).
 *
 * Split from `test-plan-pi-spec.ts` by the AGENTS.md §12 file-size cap. These are
 * the assertions on WHAT the guard decides and WHAT it discloses:
 *
 *   - it decides over the SAME form the mapper bounds — `neutraliseFenceRuns` +
 *     `oneLine` of the bullet, no clip — so the reported length is the length the
 *     bound was measured against, never the raw bullet's;
 *   - it checks EVERY bullet, including those past the 12 the block embeds, so a
 *     13th over-long criterion refuses the whole block;
 *   - it names EVERY offender, so a drafter told about one is not refused again
 *     for the next; past what the reason line can carry it lists as many as fit
 *     and says how many are unlisted.
 */
import {
  PI_SPEC_HEADING,
  PI_SPEC_OMISSION_PREFIX,
  PI_SPEC_OMISSION_REASON_MAX_CHARS,
  neutraliseFenceRuns,
  placePiSpecSection,
} from "../src/plan-pi-spec.ts";
import { oneLine } from "../src/plan-pi-spec-text.ts";
import { assert, draftBody, specExit } from "./lib/plan-pi-spec-fixture.ts";

const form = (bullet: string): string => neutraliseFenceRuns(oneLine(bullet));

{
  // A short first criterion proves nothing about the rest: the guard walks the
  // whole bullet list, so it names AC2 and stays silent on the bullet that fit.
  const long = `criterion ${"x".repeat(243)}`;
  const shortFirst = placePiSpecSection(draftBody(["a short one", long]), "feature", "t");
  assert(
    shortFirst.spec === undefined &&
      (shortFirst.omitted ?? "").includes("AC2") &&
      !(shortFirst.omitted ?? "").includes("AC1"),
    `over-long criteria: a short AC1 does not hide an over-long AC2, and only AC2 is named (got ${JSON.stringify(shortFirst.omitted)})`,
  );
}

{
  // Every offender is named in one line: a drafter told about AC1 alone fixes it
  // and is refused again for AC3.
  const one = `criterion ${"x".repeat(243)}`;
  const two = `another ${"y".repeat(301)}`;
  const placed = placePiSpecSection(draftBody([one, "mid", two]), "feature", "t");
  assert(
    placed.spec === undefined &&
      (placed.omitted ?? "").includes("AC1") &&
      (placed.omitted ?? "").includes("AC3") &&
      (placed.omitted ?? "").includes(`(${form(one).length} chars)`) &&
      (placed.omitted ?? "").includes(`(${form(two).length} chars)`),
    `over-long criteria: every offender is named with the length the bound applies to (got ${JSON.stringify(placed.omitted)})`,
  );
}

{
  // Coverage past the embedded cap: the 13th bullet is not in the block, so a
  // guard that only walked the embedded criteria would file a block over a
  // contract the drafter never made.
  const long = `criterion ${"x".repeat(243)}`;
  const thirteen = placePiSpecSection(
    draftBody([...Array.from({ length: 12 }, (_, i) => `criterion ${i + 1}`), long]),
    "feature",
    "t",
  );
  assert(
    thirteen.spec === undefined &&
      !thirteen.body.includes(PI_SPEC_HEADING) &&
      thirteen.body.includes(PI_SPEC_OMISSION_PREFIX) &&
      (thirteen.omitted ?? "").includes("AC13"),
    `over-long criteria: an over-long 13th bullet omits the block too and names AC13 (got ${JSON.stringify(thirteen.omitted)})`,
  );
}

{
  // The reported length is the collapsed form's, never the raw bullet's: the
  // bound is applied after `oneLine`, so a bullet padded with internal runs is
  // shorter there than the raw line reads.
  const padded = `criterion   with    lots\t\tof   padding\t${"z".repeat(210)}`;
  const placed = placePiSpecSection(draftBody([padded]), "feature", "t");
  const collapsed = form(padded).length;
  assert(
    collapsed < padded.length &&
      placed.spec === undefined &&
      (placed.omitted ?? "").includes(`(${collapsed} chars)`),
    `over-long criteria: the reported length is the one-line-collapsed form the mapper bounds (${collapsed} < raw ${padded.length}; got ${JSON.stringify(placed.omitted)})`,
  );
}

{
  // Many offenders: the reason line stays inside the clip, names as many as fit,
  // and says how many it could not list — a truncated list would read as the
  // whole set of offenders.
  const ten = Array.from({ length: 10 }, (_, i) => `criterion ${i + 1} ${"w".repeat(240)}`);
  const placed = placePiSpecSection(draftBody(ten), "feature", "t");
  const reason = placed.omitted ?? "";
  const named = (reason.match(/AC\d+ \(\d+ chars\)/g) ?? []).length;
  assert(
    placed.spec === undefined &&
      reason.length <= PI_SPEC_OMISSION_REASON_MAX_CHARS &&
      named >= 2 &&
      named < ten.length &&
      /and \d+ more/.test(reason),
    `over-long criteria: the reason is bounded, names what fits and admits the rest (${named} of ${ten.length} named, ${reason.length} chars; got ${JSON.stringify(reason)})`,
  );
}

console.log(`${specExit() === 0 ? "PASS" : "FAIL"} test-plan-pi-spec-overlong`);
process.exit(specExit());
