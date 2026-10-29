#!/usr/bin/env bun
/**
 * plan-pi-spec — the CEILING half of the #1883 contract: the rendered section
 * stays under `PI_SPEC_SECTION_MAX_CHARS` for ANY input, measured in UTF-16
 * `.length` (the units the forge cap and the budget reservation count), and the
 * readiness note is itself bounded. Astral text is the case that broke the earlier
 * bound: `renderPiSpec` escapes a surrogate pair as two `\uD83D\uDE80` literals,
 * sixteen UTF-16 units for one clipped character, so a bound of 2x a field let an
 * emoji-heavy section over-run the reservation by half.
 *
 * Split from `test-plan-pi-spec.ts` by the AGENTS.md 12 file-size cap; the mapper,
 * render, placement and re-filing assertions stay there. Both share
 * `lib/plan-pi-spec-fixture.ts` and each exits on its own counter.
 */
import { piSpecFromDraft, placePiSpecSection, renderPiSpecSection } from "../src/plan-pi-spec.ts";
import {
  PI_SPEC_CRITERION_MAX_CHARS,
  PI_SPEC_HEADING,
  PI_SPEC_OMISSION_LINE_MAX_CHARS,
  PI_SPEC_PROBLEM_MAX_CHARS,
  PI_SPEC_SECTION_MAX_CHARS,
} from "../src/plan-pi-spec.ts";
import { assert, draftBody, specExit } from "./lib/plan-pi-spec-fixture.ts";
// ------------------------------------------- the ceiling holds for ANY input

{
  // Astral text (emoji) is two UTF-16 units per character: a code-point clip would
  // have doubled the section past the ceiling the budget reserves for it.
  const astral = piSpecFromDraft({
    type: "feature",
    title: "🧪".repeat(500),
    body: draftBody(
      Array.from(
        { length: 14 },
        () => `${"🚀".repeat(300)} \`bun run ${"𝕌nicode".repeat(100)}-verify.sh\``,
      ),
    ),
  }) as PiSpec;
  assert(
    astral.problem.length === PI_SPEC_PROBLEM_MAX_CHARS &&
      astral.criteria.every(
        (c) =>
          c.text.length <= PI_SPEC_CRITERION_MAX_CHARS &&
          (c.command === undefined || c.command.length <= PI_SPEC_CRITERION_MAX_CHARS),
      ),
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
  // The escape factor the ceiling is derived from, pinned on the render itself:
  // `renderPiSpec` escapes a surrogate pair as `\ud83e\uddea` — sixteen UTF-16
  // units for a field that clips to four astral characters. A bound of 2× the
  // field width would let astral text over-run it by half, which is exactly the
  // ceiling breach this derived number exists to prevent.
  assert(
    renderPiSpecSection({
      problem: "\ud83e\uddea\ud83e\uddea\ud83e\uddea\ud83e\uddea",
      criteria: [],
      size: "M",
    }).length >= 16,
    "ceiling: an astral field renders far wider than it clips, which is what 4× pays for",
  );
  const astralFiled = placePiSpecSection(draftBody(["a"]), "feature", "t").body;
  assert(
    astralFiled.length <= draftBody(["a"]).length + PI_SPEC_SECTION_MAX_CHARS + 2,
    "ceiling: a placed body stays within its reservation",
  );
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
