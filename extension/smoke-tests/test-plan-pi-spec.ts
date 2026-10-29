#!/usr/bin/env bun
/**
 * plan-pi-spec — the drafted /plan spec filed as a `pi-spec v1` block (#1883).
 *
 * The design this pins is SMALL and every assertion is one way it could silently
 * fail:
 *
 *   - the MAPPER is the only place a bound exists: `problem` is the TITLE clipped
 *     to 200 chars (never body prose), at most 12 criteria are embedded at 200
 *     chars each, `size` counts the ORIGINAL criteria, there is no `scope`, and
 *     every run of ≥3 backticks/tildes is neutralised in problem, text and
 *     command. A criterion whose backticked span merely STARTS with a runner word
 *     ("the gov file") must stay a `test` criterion, or /work-lean would go
 *     hunting for a command that is prose.
 *   - the section is BOUNDED BY CONSTRUCTION: the worst-case render (12 × 200-char
 *     criteria + a 200-char title) is asserted under `PI_SPEC_SECTION_MAX_CHARS`,
 *     so a widened bound fails here rather than at the forge.
 *   - PLACEMENT: the section sits at the TOP of the filed body — under the
 *     provenance italic line, above every drafted section — so prose below cannot
 *     open a fence that swallows it. The provenance marker stays last.
 *   - READ-BACK: `parsePiSpec(filedBody)` must be ok and deep-equal the embedded
 *     spec; a forced failure files WITHOUT the block and WITH one plain
 *     disclosure line.
 *   - the READINESS NOTE: a spec failing a rule other than `size L` still files,
 *     with the rules on one plain line under the block.
 *   - the EXCLUSIONS: an epic, a spike and a zero-criteria draft get no block AND
 *     no line — their filed bodies are byte-identical to the pre-#1883 render.
 * The last two groups are driven end-to-end through `runPlanPipeline` with the
 * shared /plan stubs; those live in `test-plan-pi-spec-filing.ts` (the file-size
 * cap split them). Both share `lib/plan-pi-spec-fixture.ts`.
 */
import { type PiSpec, parsePiSpec, readiness } from "../src/lean/spec.ts";
import { codeAppendReservation } from "../src/plan-driver-phase3.ts";
import { finalDraftBody } from "../src/plan-gap-disclosure.ts";
import {
  PI_SPEC_CRITERION_MAX_CHARS,
  PI_SPEC_EXAMPLE_INFO,
  PI_SPEC_HEADING,
  PI_SPEC_MAX_CRITERIA,
  PI_SPEC_OMISSION_LINE_MAX_CHARS,
  PI_SPEC_OMISSION_PREFIX,
  PI_SPEC_PROBLEM_MAX_CHARS,
  PI_SPEC_READINESS_PREFIX,
  PI_SPEC_SECTION_MAX_CHARS,
  neutraliseDraftedPiSpecFences,
  neutraliseFenceRuns,
  piSpecFromDraft,
  piSpecReservation,
  placePiSpecSection,
  renderPiSpecSection,
} from "../src/plan-pi-spec.ts";
import { BODY_BUDGET } from "../src/plan-validate.ts";
import { assert, draftBody, specExit } from "./lib/plan-pi-spec-fixture.ts";

// ------------------------------------------------------------------ the mapper

{
  const spec = piSpecFromDraft({
    type: "feature",
    title: "  add   a pi-spec   block  ",
    body: draftBody([
      "the parser rejects a malformed token",
      "the suite passes when `bun test extension/smoke-tests` exits 0",
      "`./scripts/verify.sh` is green",
      "the gov file is mentioned but is not a command",
    ]),
  });
  assert(!!spec && spec.criteria.length === 4, "mapper: one criterion per bullet, in order");
  assert(
    spec?.criteria[0]?.verify === "test" && spec?.criteria[0]?.id === "AC1",
    "mapper: ids are positional AC1.. and the default verify is test",
  );
  assert(
    spec?.criteria[1]?.verify === "command" &&
      spec?.criteria[1]?.command === "bun test extension/smoke-tests",
    "mapper: a backticked runner command becomes a command criterion",
  );
  assert(
    spec?.criteria[2]?.verify === "command" && spec?.criteria[2]?.command === "./scripts/verify.sh",
    "mapper: ./scripts/… counts as a runner",
  );
  assert(
    spec?.criteria[3]?.verify === "test" && spec?.criteria[3]?.command === undefined,
    "mapper: a span that merely starts with runner letters stays a test criterion",
  );
  assert(
    spec?.problem === "add a pi-spec block",
    `mapper: problem is the TITLE, whitespace-collapsed (got ${JSON.stringify(spec?.problem)})`,
  );
  assert(spec?.scope === undefined, "mapper: the block carries NO scope at all");
  assert(!("scope" in (spec ?? {})), "mapper: `scope` is not even a key of the embedded object");
}

{
  // The title is the ONLY prose the block may carry, and it is clipped.
  const spec = piSpecFromDraft({
    type: "feature",
    title: "t".repeat(3_000),
    body: draftBody(["a"]),
  });
  assert(
    (spec?.problem.length ?? 0) === PI_SPEC_PROBLEM_MAX_CHARS,
    `mapper: problem is the title clipped to ${PI_SPEC_PROBLEM_MAX_CHARS} (got ${spec?.problem.length})`,
  );
  assert(
    !draftBody(["a"])
      .slice(0, 40)
      .includes(spec?.problem ?? "\u0000"),
    "mapper: problem is not the drafted body's opening prose",
  );
}

{
  // At most 12 criteria are embedded, and `size` counts the ORIGINAL set — so a
  // 13-criterion plan is honestly L while carrying twelve rows.
  const thirteen = piSpecFromDraft({
    type: "feature",
    title: "t",
    body: draftBody(Array.from({ length: 13 }, (_, i) => `criterion ${i + 1}`)),
  });
  assert(
    (thirteen?.criteria.length ?? 0) === PI_SPEC_MAX_CRITERIA,
    `mapper: at most ${PI_SPEC_MAX_CRITERIA} criteria are embedded (got ${thirteen?.criteria.length})`,
  );
  assert(thirteen?.size === "L", `mapper: 13 original criteria is L (got ${thirteen?.size})`);
  assert(
    thirteen?.criteria[11]?.id === "AC12" && thirteen?.criteria[11]?.text === "criterion 12",
    "mapper: the embedded set is the FIRST twelve, in order, with positional ids",
  );
  assert(
    piSpecFromDraft({ type: "feature", title: "t", body: draftBody(Array(3).fill("c")) })?.size ===
      "S",
    "mapper: 3 criteria is S",
  );
  assert(
    piSpecFromDraft({ type: "feature", title: "t", body: draftBody(Array(4).fill("c")) })?.size ===
      "M",
    "mapper: 4 criteria is M (S is 3 or fewer)",
  );
  assert(
    piSpecFromDraft({ type: "feature", title: "t", body: draftBody(Array(8).fill("c")) })?.size ===
      "M",
    "mapper: 8 criteria is M",
  );
  assert(
    piSpecFromDraft({ type: "feature", title: "t", body: draftBody(Array(9).fill("c")) })?.size ===
      "L",
    "mapper: 9 criteria is L",
  );
}

{
  const spec = piSpecFromDraft({
    type: "feature",
    title: "t",
    body: draftBody([`criterion ${"x".repeat(3_000)}`]),
  });
  assert(
    (spec?.criteria[0]?.text.length ?? 0) === PI_SPEC_CRITERION_MAX_CHARS,
    `mapper: criterion text is clipped to ${PI_SPEC_CRITERION_MAX_CHARS} (got ${spec?.criteria[0]?.text.length})`,
  );
  // A command past the clip still travels: `command` is read from the RAW bullet,
  // so the criterion never files as an unverifiable `command` with no command.
  const late = piSpecFromDraft({
    type: "feature",
    title: "t",
    body: draftBody([`${"y".repeat(400)} then \`bun test extension/smoke-tests\``]),
  });
  assert(
    late?.criteria[0]?.verify === "command" &&
      late?.criteria[0]?.command === "bun test extension/smoke-tests",
    "mapper: a runner span past the text clip still becomes the criterion's command",
  );
}

// Fence neutralisation at the run lengths that actually fence: 3, 4 and 8.
for (const len of [3, 4, 8]) {
  const run = "`".repeat(len);
  const neutral = neutraliseFenceRuns(`before ${run}mid${run} after`);
  assert(
    !/(`{3,}|~{3,})/.test(neutral) && neutral.includes("before") && neutral.includes("mid"),
    `neutralise: a run of ${len} backticks no longer fences and the text survives`,
  );
  const tildes = neutraliseFenceRuns(`a ${"~".repeat(len)} b`);
  assert(!/(`{3,}|~{3,})/.test(tildes), `neutralise: a run of ${len} tildes no longer fences`);
  assert(
    neutraliseFenceRuns("`` keep `single` ``") === "`` keep `single` ``",
    "neutralise: runs shorter than 3 are left byte-identical (a lone backtick cannot fence)",
  );
  const inSpec = piSpecFromDraft({
    type: "feature",
    title: `title with ${run}fence${run}`,
    body: draftBody([`criterion ${"~".repeat(len)} tail`, "ok `bun test` runs"]),
  });
  assert(
    !/(`{3,}|~{3,})/.test(inSpec?.problem ?? "") &&
      !/(`{3,}|~{3,})/.test(inSpec?.criteria[0]?.text ?? ""),
    `neutralise: runs of ${len} are neutralised in BOTH problem and criterion text`,
  );
}

{
  const withTildeFence = piSpecFromDraft({
    type: "feature",
    title: "t",
    body: draftBody(["~~~ not a fence ~~~"]),
  });
  assert(
    withTildeFence?.criteria[0]?.text === "˜˜˜ not a fence ˜˜˜",
    `mapper: a tilde-fenced bullet is kept, with its fences turned into look-alikes (got ${JSON.stringify(withTildeFence?.criteria[0]?.text)})`,
  );
}

// An epic's criteria belong to its sub-issues and a spike's criteria slot is the
// Expected deliverable, so neither gets a block.
for (const excluded of ["epic", "spike"] as const) {
  assert(
    piSpecFromDraft({ type: excluded, title: "t", body: draftBody(["a"]) }) === undefined,
    `mapper: a ${excluded} gets no spec`,
  );
}
assert(
  piSpecFromDraft({ type: "feature", title: "t", body: draftBody(["   "]) }) === undefined,
  "mapper: zero criteria means no spec (an empty bullet is not a criterion)",
);
assert(
  piSpecFromDraft({ type: "feature", title: "t", body: "## Context\n\n- prose only\n" }) ===
    undefined,
  "mapper: no Acceptance criteria section means no spec",
);

// ------------------------------------- the section is bounded by construction

{
  const worst = piSpecFromDraft({
    type: "feature",
    title: "z".repeat(500),
    body: draftBody(
      Array.from({ length: 14 }, () => `${"q".repeat(199)} \`bun run smoke-tests/x\``),
    ),
  }) as PiSpec;
  assert(
    worst.criteria.length === PI_SPEC_MAX_CRITERIA && worst.size === "L",
    "bound: the worst case embeds the cap and reports L",
  );
  const section = renderPiSpecSection(worst);
  assert(
    section.length < PI_SPEC_SECTION_MAX_CHARS,
    `bound: the WORST-CASE rendered section fits the asserted ceiling (${section.length} < ${PI_SPEC_SECTION_MAX_CHARS})`,
  );
  // The reservation is a CONSTANT: the ceiling the section can ever reach, plus
  // the omission line. No render is measured, so it cannot under-count.
  const worstBody = draftBody(
    Array.from({ length: 14 }, () => `${"q".repeat(199)} \`bun run smoke-tests/x\``),
  );
  const worstTitle = "z".repeat(500);
  assert(
    piSpecReservation("feature") ===
      PI_SPEC_SECTION_MAX_CHARS + 2 + PI_SPEC_OMISSION_LINE_MAX_CHARS,
    "bound: the reservation is the fixed ceiling + the omission line, never a measurement",
  );
  assert(
    piSpecFromDraft({ type: "feature", body: worstBody, title: worstTitle })?.criteria.length ===
      PI_SPEC_MAX_CRITERIA,
    "bound: the worst body still maps to the embedded cap",
  );
  assert(
    section.length < BODY_BUDGET / 4,
    `bound: the block can never eat a quarter of the body budget (${section.length})`,
  );
}

// ------------------------------------------------- render + the readiness note

{
  const spec = piSpecFromDraft({
    type: "feature",
    title: "t",
    body: draftBody(["a", "b"]),
  }) as PiSpec;
  const section = renderPiSpecSection(spec);
  assert(
    section.startsWith(`${PI_SPEC_HEADING}\n\n\`\`\`pi-spec v1\n`),
    "render: the section carries the heading and the exact info string",
  );
  assert(
    !section.includes(PI_SPEC_READINESS_PREFIX),
    "render: a ready spec carries no readiness line",
  );
  // A duplicate id is the rule a DRAFTED spec can really fail: the mapper
  // numbers ids positionally, so a hand-edited issue is the carrier, and the
  // operator must still be told.
  const broken: PiSpec = {
    problem: "p",
    criteria: [
      { id: "AC2", text: "duplicated id", verify: "test" },
      { id: "AC2", text: "duplicated id again", verify: "test" },
    ],
    size: "S",
  };
  const withNote = renderPiSpecSection(broken);
  assert(
    withNote.includes(PI_SPEC_READINESS_PREFIX) &&
      (withNote.split(PI_SPEC_READINESS_PREFIX)[1]?.trim().length ?? 0) > 0,
    "render: a failed rule is disclosed on one plain line under the block",
  );
  assert(!withNote.includes("\n## "), "render: the readiness note is a plain line, not a heading");
  const tooBig = piSpecFromDraft({
    type: "feature",
    title: "t",
    body: draftBody(Array(14).fill("c")),
  }) as PiSpec;
  // `size L` IS in the note: the operator is the one who decides to split, and
  // silence on the one rule that says "this is too big for one run" hid the fix.
  const tooBigNote = renderPiSpecSection(tooBig);
  assert(
    tooBig.size === "L" &&
      tooBigNote.includes(PI_SPEC_READINESS_PREFIX) &&
      tooBigNote.includes("split it"),
    "readiness note: size L is reported — the operator sees 'split it'",
  );
  // The note itself is bounded: three rules, each clipped, so the section's width
  // never becomes a function of how broken the spec is.
  const veryBroken: PiSpec = {
    problem: "p",
    criteria: [
      { id: "AC2", text: "a", verify: "command" as const },
      { id: "AC2", text: "b", verify: "command" as const },
      { id: "AC2", text: "c", verify: "command" as const },
      { id: "AC2", text: "d", verify: "command" as const },
    ],
    size: "L",
  };
  const brokenNote = renderPiSpecSection(veryBroken);
  const noteLine =
    brokenNote.split(PI_SPEC_READINESS_PREFIX)[1]?.trim().split("\n")[0]?.trim() ?? "";
  assert(
    noteLine.split(";").length <= 3 &&
      noteLine.length <= 3 * 120 + 2 * 2 &&
      brokenNote.length <= PI_SPEC_SECTION_MAX_CHARS,
    `render: the note carries at most 3 clipped rules (${noteLine.split(";").length})`,
  );
}

// ---------------------------------------- the placed body: top, round-trip, order

{
  const plain = draftBody(["a", "b", "c"]);
  const body = placePiSpecSection(plain, "feature", "add the block").body;
  const parsed = parsePiSpec(body);
  assert(parsed.ok === true, "body: the filed body carries a parseable block");
  if (parsed.ok) {
    assert(readiness(parsed.spec).length === 0, "body: the filed spec passes readiness");
    assert(
      JSON.stringify(parsed.spec) ===
        JSON.stringify(piSpecFromDraft({ type: "feature", body: plain, title: "add the block" })),
      "body: what the mapper built is exactly what the parser reads back",
    );
  }
  assert(
    body.startsWith(`${PI_SPEC_HEADING}\n`),
    "placement: the section is the FIRST thing in the body",
  );
  assert(
    body.indexOf(PI_SPEC_HEADING) < body.indexOf("## Acceptance criteria") &&
      body.indexOf(PI_SPEC_HEADING) < body.indexOf("## Out of scope"),
    "placement: the block sits ABOVE every drafted section, so prose below cannot fence it",
  );
  // A body that already carries a `pi-spec v1` block — OURS or someone else's —
  // is re-placed, not adopted: the info string of the block that was there is
  // renamed first, so the FILED body (what `finalDraftBody` hands the forge) has
  // exactly one block and it is the one we rendered.
  // A body that already carries a `pi-spec v1` block has that block's HEADING left
  // where the draft put it (it is prose) and its FENCE renamed to an example, so the
  // FILED body carries exactly one block a reader can parse — ours.
  const refiled = finalDraftBody(
    body,
    [],
    [],
    undefined,
    [],
    undefined,
    { risk: undefined, sourceIssue: undefined },
    { type: "feature", title: "add the block" },
  );
  const refiledParsed = parsePiSpec(refiled);
  const openingFences = refiled
    .split("\n")
    .filter((l) => /^ {0,3}(`{3,}|~{3,})\s*pi-spec v1\s*$/.test(l)).length;
  assert(
    refiledParsed.ok === true &&
      refiled.includes(PI_SPEC_EXAMPLE_INFO) &&
      openingFences === 1 &&
      JSON.stringify(refiledParsed.spec) ===
        JSON.stringify(
          piSpecFromDraft({ type: "feature", body: refiled, title: "add the block" }),
        ) &&
      body.length > plain.length,
    `body: re-filing a body that already carries a block leaves exactly one OPENING fence — ours (${openingFences})`,
  );
}
console.log(`${specExit() === 0 ? "PASS" : "FAIL"} test-plan-pi-spec`);
process.exit(specExit());
