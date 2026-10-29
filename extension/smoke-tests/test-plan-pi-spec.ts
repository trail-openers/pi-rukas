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
  PI_SPEC_HEADING,
  PI_SPEC_MAX_CRITERIA,
  PI_SPEC_OMISSION_PREFIX,
  PI_SPEC_PROBLEM_MAX_CHARS,
  PI_SPEC_READINESS_PREFIX,
  PI_SPEC_SECTION_MAX_CHARS,
  appendPiSpecSection,
  neutraliseFenceRuns,
  piSpecFromDraft,
  piSpecReservation,
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
  // The reservation is the section's REAL rendered length plus the separating
  // blank line: an exact identity on the SAME body and title, so a clamp that
  // under-counts cannot be reintroduced quietly.
  const worstBody = draftBody(
    Array.from({ length: 14 }, () => `${"q".repeat(199)} \`bun run smoke-tests/x\``),
  );
  const worstTitle = "z".repeat(500);
  assert(
    piSpecReservation("feature", worstBody, worstTitle) === section.length + 2,
    "bound: the reservation is the REAL rendered length + the separating blank line, with no clamp",
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
  assert(
    tooBig.size === "L" && !renderPiSpecSection(tooBig).includes(PI_SPEC_READINESS_PREFIX),
    "readiness note: size L alone is never reported (that is a split decision, not a body fix)",
  );
}

// ---------------------------------------- the placed body: top, round-trip, order

{
  const plain = draftBody(["a", "b", "c"]);
  const body = appendPiSpecSection(plain, "feature", "add the block");
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
  assert(
    appendPiSpecSection(body, "feature", "add the block") === body,
    "body: a second pass adds no second block and no line (two blocks make the parser refuse the issue)",
  );
}

{
  const snippet = ["```", "const x = 1;", "````"].join("\n");
  const body = appendPiSpecSection(
    draftBody([`the module prints ${snippet} when run`, "and `bun test` is green"]),
    "feature",
    "fenced criterion",
  );
  const parsed = parsePiSpec(body);
  assert(parsed.ok === true, "round-trip: a criterion with a multi-line ``` snippet parses");
  assert(
    parsed.ok === true &&
      parsed.spec.criteria.length === 2 &&
      parsed.spec.criteria[1]?.command === "bun test",
    "round-trip: the fenced criterion does not swallow its neighbour",
  );
  // A bullet that carries a whole fenced CODE BLOCK (its fences on lines of their
  // own) collapses to the block's opening line once every line is flattened — so
  // assert on a criterion that SURVIVES flattening, and on the fenced one's
  // fences: what matters is that the multi-line snippet can neither break the
  // block's own fence nor swallow the criterion after it (both asserted above).
  assert(
    parsed.ok === true &&
      parsed.spec.criteria.every((c) => !/(`{3,}|~{3,})/.test(c.text)) &&
      parsed.spec.criteria.every(
        (c) => c.command === undefined || !/(`{3,}|~{3,})/.test(c.command),
      ),
    "round-trip: no embedded field carries a fence run the reader could reopen",
  );
  assert(
    appendPiSpecSection(draftBody(["prints `const x = 1;` inline"]), "feature", "t").includes(
      "const x = 1;",
    ),
    "round-trip: inline code inside a criterion survives neutralisation verbatim",
  );
}

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
      excluded,
      "some title",
    );
    assert(filed === before, `exclusions: a ${excluded}'s filed body is byte-identical to main's`);
    assert(!filed.includes(PI_SPEC_HEADING), `exclusions: a ${excluded} carries no block`);
    assert(
      !filed.includes(PI_SPEC_OMISSION_PREFIX),
      `exclusions: a ${excluded} carries no omission line either`,
    );
    assert(
      piSpecReservation(excluded, plain, "some title") === 0 &&
        codeAppendReservation(undefined, excluded, plain, "some title") === 0,
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
    "feature",
    "some title",
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
      "feature",
      // No title → no block: an unfilled title field must not file a guess.
      undefined,
    ) ===
      finalDraftBody(plain, [], [], undefined, [], undefined, {
        risk: undefined,
        sourceIssue: undefined,
      }),
    "exclusions: no title means no block, byte-identical",
  );
}

// ----------------------------------------------- the reservation (budget parity)

{
  const withCriteria = draftBody(["a", "b"]);
  assert(
    piSpecReservation("feature", withCriteria, "t") > 0,
    "budget: a drafted spec reserves its rendered width",
  );
  const reserve = codeAppendReservation(undefined, "feature", withCriteria, "t");
  assert(
    withCriteria.length + reserve < BODY_BUDGET,
    "budget: a fitted body plus the reservation stays under the budget",
  );
  // The reservation never UNDER-counts, and never over-counts by more than the
  // separating blank line: it is the rendered section's real length.
  const spec = piSpecFromDraft({ type: "feature", body: withCriteria, title: "t" }) as PiSpec;
  assert(
    reserve === renderPiSpecSection(spec).length + 2,
    "budget: the reservation equals the real rendered section, so the clamp is gone",
  );
}

console.log(`\n${specExit() === 0 ? "PASS" : "FAIL"} test-plan-pi-spec`);
process.exit(specExit());
