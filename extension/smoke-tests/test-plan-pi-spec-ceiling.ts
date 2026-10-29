#!/usr/bin/env bun
/**
 * plan-pi-spec — the CEILING half of the #1883 contract: the rendered section stays
 * under `PI_SPEC_SECTION_MAX_CHARS` for ANY input, measured in UTF-16 `.length` (the
 * units the forge cap and the budget reservation count), and the readiness note is
 * itself bounded. The one term that is not one unit per unit is the JSON escape: a
 * quote or a backslash takes two characters. The mapper replaces control characters
 * and lone surrogates (which would take six) before any field is clipped, so the
 * worst case is a field of backslashes. A valid surrogate pair (an emoji) is written
 * raw and costs nothing extra; the assertions below pin each of these facts.
 *
 * Split from `test-plan-pi-spec.ts` by the AGENTS.md 12 file-size cap; the mapper,
 * render, placement and re-filing assertions stay there. Both share
 * `lib/plan-pi-spec-fixture.ts` and each exits on its own counter.
 */
import {
  PI_SPEC_CRITERION_MAX_CHARS,
  PI_SPEC_HEADING,
  PI_SPEC_OMISSION_LINE_MAX_CHARS,
  PI_SPEC_PROBLEM_MAX_CHARS,
  PI_SPEC_SECTION_MAX_CHARS,
  piSpecFromDraft,
  placePiSpecSection,
  renderPiSpecSection,
} from "../src/plan-pi-spec.ts";
import { assert, draftBody, mustSpec, specExit } from "./lib/plan-pi-spec-fixture.ts";

// ------------------------------------------- the ceiling holds for ANY input

{
  // Astral text (emoji) is two UTF-16 units per character: a code-point clip would
  // have doubled the section past the ceiling the budget reserves for it.
  const astral = mustSpec(
    piSpecFromDraft({
      type: "feature",
      title: "🧪".repeat(500),
      body: draftBody(
        Array.from(
          { length: 14 },
          () => `${"🚀".repeat(300)} \`bun run ${"𝕌nicode".repeat(100)}-verify.sh\``,
        ),
      ),
    }),
    "ceiling: astral",
  );
  assert(
    astral.problem.length === PI_SPEC_PROBLEM_MAX_CHARS &&
      astral.criteria.every((c) => c.text.length <= PI_SPEC_CRITERION_MAX_CHARS),
    "ceiling: every field is clipped in UTF-16 units, not code points",
  );
  const astralProblem = "🧪".repeat(500);
  // A naive `.slice` at an odd offset leaves a LONE low surrogate — the exact
  // corruption the clip must prevent, and the one `String.slice` never prevents.
  // "a" + the emoji string is what puts the cut between a pair's two units.
  const straddled = `${"a"}${astralProblem}`.slice(0, 200);
  assert(
    straddled.charCodeAt(199) >= 0xd800 && straddled.charCodeAt(199) <= 0xdbff,
    "ceiling: the fixture does straddle a surrogate pair (a naive slice would orphan one)",
  );
  assert(
    astral.problem.length <= PI_SPEC_PROBLEM_MAX_CHARS &&
      !/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(astral.problem) &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(astral.problem),
    "ceiling: a clip never splits a surrogate pair in the problem field",
  );
  const astralSection = renderPiSpecSection(astral);
  assert(
    astralSection.length <= PI_SPEC_SECTION_MAX_CHARS,
    `ceiling: an astral section stays under the ceiling (${astralSection.length} <= ${PI_SPEC_SECTION_MAX_CHARS})`,
  );
  const astralFiled = placePiSpecSection(draftBody(["a"]), "feature", "t").body;
  assert(
    astralFiled.length <= draftBody(["a"]).length + PI_SPEC_SECTION_MAX_CHARS + 2,
    "ceiling: a placed body stays within its reservation",
  );
}

// ------------------------------------- the JSON escape the ceiling is derived from

{
  // Pinned on what the MAPPER hands the render, since that is the only input the
  // ceiling promises for: a control character or a lone surrogate is replaced
  // before the clip, so it can never reach JSON as a six-character escape. A quote
  // or a backslash does take two, which is the factor the ceiling pays for.
  const problemOf = (title: string): string =>
    renderPiSpecSection(
      mustSpec(
        piSpecFromDraft({ type: "feature", title, body: draftBody(["a"]) }),
        "escape: problem",
      ),
    );
  assert(
    problemOf("a\u0001b").includes('"a b"') && !problemOf("a\u0001b").includes("\\u0001"),
    "escape: a control character is a space in the field, never a six-character escape",
  );
  assert(
    problemOf("a\ud83db").includes('"a�b"') && !problemOf("a\ud83db").includes("\\ud83d"),
    "escape: a lone surrogate is U+FFFD in the field, never a six-character escape",
  );
  assert(
    problemOf("a🚀b").includes('"a🚀b"'),
    "escape: a valid surrogate pair is written raw, so an astral character costs no escape",
  );
  assert(
    problemOf('a"b\\c').includes('"a\\"b\\\\c"'),
    "escape: a quote and a backslash take two characters each, the factor the ceiling pays for",
  );
}

// ------------------------------------------------- the worst case sits under it

{
  // Every unit of every clipped field is a backslash: the one unit JSON writes as
  // two characters, so the most a field can cost. Fourteen bullets, so the cap
  // applies and `size L` is in the note.
  const bs = "\\";
  const worst = mustSpec(
    piSpecFromDraft({
      type: "feature",
      title: bs.repeat(500),
      body: draftBody(Array.from({ length: 14 }, () => `${bs.repeat(300)} \`bun run x\``)),
    }),
    "ceiling: worst",
  );
  const section = renderPiSpecSection(worst);
  assert(
    section.length <= PI_SPEC_SECTION_MAX_CHARS,
    `ceiling: the worst case renders under the ceiling (${section.length} <= ${PI_SPEC_SECTION_MAX_CHARS})`,
  );
  assert(
    section.length >= PI_SPEC_SECTION_MAX_CHARS - 400,
    `ceiling: the worst case comes close to the ceiling, so it is not inflated (${section.length} vs ${PI_SPEC_SECTION_MAX_CHARS})`,
  );
  const placed = placePiSpecSection(
    draftBody(Array.from({ length: 14 }, () => bs.repeat(300))),
    "feature",
    bs.repeat(500),
  );
  assert(
    placed.omitted === undefined,
    `ceiling: the worst case files, and its block reads back (omitted=${placed.omitted})`,
  );
}

// ---------------------------------------------- an omitted filing stays bounded

{
  // A block the placer itself refuses carries the disclosure line, and that line
  // is what the reservation pays for — so bound both together.
  const oversized = placePiSpecSection(
    [
      draftBody(["a"]),
      PI_SPEC_HEADING,
      "",
      "```pi-spec v1",
      `{"problem":"${"x".repeat(9000)}","criteria":[],"size":"L"}`,
      "```",
      "",
    ].join("\n"),
    "feature",
    "t",
  );
  assert(
    oversized.omitted === undefined ||
      oversized.body.length <=
        draftBody(["a"]).length + PI_SPEC_SECTION_MAX_CHARS + 2 + PI_SPEC_OMISSION_LINE_MAX_CHARS,
    `ceiling: an omitted filing stays inside the reservation (omitted=${oversized.omitted})`,
  );
}

console.log(`${specExit() === 0 ? "PASS" : "FAIL"} test-plan-pi-spec-ceiling`);
process.exit(specExit());
