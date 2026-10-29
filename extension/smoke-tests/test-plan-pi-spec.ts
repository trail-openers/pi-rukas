#!/usr/bin/env bun
/**
 * plan-pi-spec — the drafted /plan spec filed as a `pi-spec v1` block (#1883).
 *
 * Five things are pinned, each a distinct way the feature could silently fail:
 *
 *   - the MAPPER: test vs command criteria, the S/M/L thresholds, scope present
 *     or absent, the 1,000-char problem clip. A criterion whose backticked span
 *     merely STARTS with a runner word ("the gov file") must stay a `test`
 *     criterion, or /work-lean would go hunting for a command that is prose.
 *   - the ROUND TRIP through the real parser: a body the driver files must
 *     parse AND pass `readiness`, or the issue is not lean-consumable.
 *   - the EXCLUSIONS: an epic and a spike get no block, and a draft with zero
 *     acceptance criteria gets no block (the fallback bullet is not a criterion).
 *   - the READINESS DISCLOSURE: a spec that fails a rule other than `size L`
 *     still files, with the failed rules on one plain line under the block.
 *   - the BUDGET: the block is reserved like the provenance marker, so a body
 *     the fitter COMPACTED still carries the whole block — compaction cuts
 *     sections, never the block.
 *
 * The last two are driven end-to-end through `runPlanPipeline` with the shared
 * /plan stubs, so they pin the filing path and not just the pure helpers.
 */
import { type PiSpec, parsePiSpec, readiness } from "../src/lean/spec.ts";
import { codeAppendReservation } from "../src/plan-driver-phase3.ts";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { finalDraftBody } from "../src/plan-gap-disclosure.ts";
import {
  PI_SPEC_HEADING,
  PI_SPEC_READINESS_PREFIX,
  appendPiSpecSection,
  piSpecFromDraft,
  piSpecReservation,
  renderPiSpecSection,
} from "../src/plan-pi-spec.ts";
import { BODY_BUDGET } from "../src/plan-validate.ts";
import {
  DESC,
  forgeStub,
  installForgeStub,
  installNoPlanCacheStub,
  installOfflineVipuneStub,
  installOverflowDispatch,
  makeDispatchStub,
} from "./plan-test-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A drafted body carrying exactly these acceptance-criteria bullets. */
function draftBody(
  criteria: string[],
  opts: { testSurface?: string[]; outOfScope?: string[] } = {},
): string {
  const bullets = (items: string[], fallback: string): string =>
    items.length > 0 ? items.map((s) => `- ${s}`).join("\n") : `- ${fallback}`;
  return [
    "## Context & motivation",
    "",
    "Descriptor: d",
    "",
    "## Acceptance criteria",
    "",
    bullets(criteria, "(fallback)"),
    "",
    "## References",
    "",
    "- references/plan.md",
    "",
    "## Test surface",
    "",
    bullets(opts.testSurface ?? [], "none reported"),
    "",
    "## Edge cases & pitfalls",
    "",
    "- none",
    "",
    "## Open Questions",
    "",
    "- (none)",
    "",
    "## Out of scope",
    "",
    bullets(opts.outOfScope ?? [], "everything not named in the sections above"),
    "",
  ].join("\n");
}

/** An angle stub whose criteria are long, so the drafted body approaches the budget. */
function makeBigCriteriaStub(criteria: string[]) {
  const toolUses = criteria.map((text, i) => ({
    name: "report_plan_item",
    arguments: { kind: "acceptance-criterion", text, angle: `a${i}` },
  }));
  return ((_pi: unknown, spec: { role: string; prompt: string }) => {
    if (spec.role === "adversarial-developer") {
      return Promise.resolve({
        role: spec.role,
        ok: true,
        text: "VERDICT: READY",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      });
    }
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        role: "explore",
        ok: true,
        text: "DUPLICATE_RISK: none - no overlapping open work",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      });
    }
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "prose",
      toolUses,
      ms: 1,
      exitCode: 0,
    });
  }) as never;
}

// ------------------------------------------------------------------ the mapper

{
  const spec = piSpecFromDraft({
    type: "feature",
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
    spec?.scope === undefined,
    "mapper: no test-surface bullets and only the default out-of-scope bullet declare no scope",
  );
}

{
  const spec = piSpecFromDraft({
    type: "feature",
    body: draftBody(["a", "b", "c"], {
      testSurface: ["extension/smoke-tests/test-plan-pi-spec.ts"],
      outOfScope: ["extension/src/lean/spec.ts"],
    }),
  });
  assert(
    JSON.stringify(spec?.scope) ===
      JSON.stringify({
        paths: ["extension/smoke-tests/test-plan-pi-spec.ts"],
        out: ["extension/src/lean/spec.ts"],
      }),
    "mapper: declared paths become scope.paths and the fence becomes scope.out",
  );
  assert(spec?.size === "S", `mapper: 3 criteria is S (got ${spec?.size})`);
  assert(
    piSpecFromDraft({ type: "feature", body: draftBody(Array(8).fill("c")) })?.size === "M",
    "mapper: 8 criteria is M",
  );
  assert(
    piSpecFromDraft({ type: "feature", body: draftBody(Array(9).fill("c")) })?.size === "L",
    "mapper: 9 criteria is L",
  );
}

{
  const long = "x".repeat(3_000);
  const spec = piSpecFromDraft({ type: "feature", body: draftBody([`criterion ${long}`]) });
  assert(
    (spec?.problem.length ?? 0) === 1_000,
    `mapper: problem is clipped to 1,000 chars (got ${spec?.problem.length})`,
  );
}

// An epic's criteria belong to its sub-issues and a spike's criteria slot is the
// Expected deliverable, so neither gets a block.
for (const excluded of ["epic", "spike"] as const) {
  assert(
    piSpecFromDraft({ type: excluded, body: draftBody(["a"]) }) === undefined,
    `mapper: a ${excluded} gets no spec`,
  );
  assert(
    piSpecFromDraft({ type: "feature", body: draftBody([]) }) === undefined,
    "mapper: zero criteria means no spec (the fallback bullet is not a criterion)",
  );
}

// ------------------------------------------------- render + the readiness line

{
  const spec = piSpecFromDraft({ type: "feature", body: draftBody(["a", "b"]) }) as PiSpec;
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
  // numbers ids positionally, so a criterion whose text matches another is the
  // one fault the filed block can carry, and it must reach the operator.
  const broken: PiSpec = {
    ...spec,
    criteria: [
      { id: "AC2", text: "duplicated id", verify: "test" },
      { id: "AC2", text: "duplicated id again", verify: "test" },
    ],
  };
  const withNote = renderPiSpecSection(broken);
  assert(
    withNote.includes(PI_SPEC_READINESS_PREFIX) &&
      (withNote.split(PI_SPEC_READINESS_PREFIX)[1]?.trim().length ?? 0) > 0,
    "render: a failed rule is disclosed on one plain line under the block",
  );
  const tooBig = piSpecFromDraft({
    type: "feature",
    body: draftBody(Array(9).fill("c")),
  }) as PiSpec;
  assert(
    tooBig.size === "L" && !renderPiSpecSection(tooBig).includes(PI_SPEC_READINESS_PREFIX),
    "render: size L alone is not reported as a failed rule",
  );
}

// --------------------------------------------------- the appended body round-trips

{
  const plain = draftBody(["a", "b", "c"]);
  const body = appendPiSpecSection(plain, "feature");
  const parsed = parsePiSpec(body);
  assert(parsed.ok === true, "body: the filed body carries a parseable block");
  if (parsed.ok) {
    assert(readiness(parsed.spec).length === 0, "body: the filed spec passes readiness");
    assert(
      JSON.stringify(parsed.spec) ===
        JSON.stringify(piSpecFromDraft({ type: "feature", body: plain })),
      "body: what the mapper built is byte-identical to what the parser reads back",
    );
  }
  assert(
    body.indexOf(PI_SPEC_HEADING) > body.indexOf("## Out of scope"),
    "body: the block sits at the END of the body, after the last drafted section",
  );
  assert(
    appendPiSpecSection(body, "feature") === body,
    "body: appending twice produces no second block (two blocks make the parser refuse the issue)",
  );
  assert(appendPiSpecSection(plain, "epic") === plain, "body: an epic gets no block");
  assert(appendPiSpecSection(plain, "spike") === plain, "body: a spike gets no block");
  assert(
    appendPiSpecSection(draftBody([]), "feature") === draftBody([]),
    "body: zero criteria gets no block",
  );
  // The filing site itself: the block is inside the wrapped body, before the
  // provenance marker's last line.
  const wrapped = finalDraftBody(
    plain,
    [],
    [],
    undefined,
    [],
    { line: "automated run", marker: { run: "plan" } },
    { risk: undefined, sourceIssue: undefined },
    "feature",
  );
  assert(
    wrapped.includes(PI_SPEC_HEADING) && wrapped.indexOf(PI_SPEC_HEADING) < wrapped.length - 40,
    "filing site: finalDraftBody appends the block before the provenance marker wraps the body",
  );
  const noType = finalDraftBody(
    plain,
    [],
    [],
    undefined,
    [],
    { line: "automated run", marker: { run: "plan" } },
    { risk: undefined, sourceIssue: undefined },
  );
  const epic = finalDraftBody(
    plain,
    [],
    [],
    undefined,
    [],
    { line: "automated run", marker: { run: "plan" } },
    { risk: undefined, sourceIssue: undefined },
    "epic",
  );
  assert(
    epic === noType && !epic.includes(PI_SPEC_HEADING),
    "filing site: an epic's filed body is byte-identical to the pre-#1883 body",
  );
}

// --------------------------------------------- the reservation (budget parity with the marker)

{
  const withCriteria = draftBody(["a", "b"]);
  assert(
    piSpecReservation("feature", withCriteria) > 0,
    "budget: a drafted spec reserves its rendered width",
  );
  assert(
    piSpecReservation("epic", withCriteria) === 0 &&
      piSpecReservation("spike", withCriteria) === 0 &&
      piSpecReservation("feature", draftBody([])) === 0,
    "budget: an epic, a spike and a criteria-less draft reserve nothing (their bodies stay byte-identical to pre-#1883)",
  );
  // The fitter's contract: the drafted body is fitted against BODY_BUDGET minus
  // the reservation, so the block appended afterwards cannot push the file over
  // the forge cap.
  const reserve = codeAppendReservation(undefined, "feature", withCriteria);
  assert(
    withCriteria.length + reserve < BODY_BUDGET,
    "budget: a fitted body plus the reservation stays under the budget",
  );
}

// ------------------------------------ end-to-end through the pipeline: filing + compaction

installForgeStub();
installOfflineVipuneStub();
installNoPlanCacheStub();

{
  forgeStub.created.length = 0;
  setPlanDispatch(
    makeDispatchStub(
      "GAP: HIGH clarify the boundary — proposed resolution: add a criterion\nVERDICT: READY",
    ),
  );
  const r = await runPlanPipeline(
    {} as never,
    { descriptor: "add a pi-spec block to the plan driver in extension/src", type: "feature" },
    process.cwd(),
  );
  const filed = forgeStub.created[0]?.body ?? "";
  assert(r.filed === true, `pipeline: filed (got filed=${r.filed})`);
  const parsed = parsePiSpec(filed);
  assert(parsed.ok === true, "pipeline: the FILED body carries a pi-spec v1 block");
  if (parsed.ok) assert(readiness(parsed.spec).length === 0, "pipeline: the filed spec is ready");
  const marker = filed.lastIndexOf("<!-- pi-rukas:provenance v1 -->");
  assert(
    marker === -1 || filed.indexOf(PI_SPEC_HEADING) < marker,
    "pipeline: the block sits before the provenance marker, never after it",
  );
  setPlanDispatch(null);
}

{
  // Compaction must never cut the block. Same overflow fixture as
  // test-plan-provenance's survives-compaction case: 100 items per kind at
  // ~2,950 chars overflow stage 0's 20-per-kind render and fit stage 1's 10. The
  // block is appended AFTER the fitter, so compaction has no way to reach it and
  // the reservation is what keeps the total inside the forge cap.
  const marker = { line: "x".repeat(300), marker: { run: "smoke", actor: "plan" } };
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  forgeStub.existing = null;
  installForgeStub();
  installOverflowDispatch(`the pi-spec block must survive ${"x".repeat(2950)} end`, 100);
  const r = await runPlanPipeline(
    {} as never,
    { descriptor: DESC, provenance: marker },
    process.cwd(),
  );
  const filed = forgeStub.created[0]?.body ?? "";
  assert(
    r.compacted === true,
    `pipeline: the run reached the compaction stage (compacted=${r.compacted}, filed=${r.filed}, ${filed.length} chars)`,
  );
  const parsed = parsePiSpec(filed);
  // The block survives compaction WHOLE, not merely parseably: its criteria must
  // be exactly what the mapper derives from the same filed body. `size L` is not
  // a failure of this assertion — the fixture deliberately carries >8 criteria
  // (that is what overflows stage 0) and L is the mapper's honest answer, which
  // the block's own disclosure forgives and `readiness` reports to a reader.
  // The whole-block guarantee: the JSON inside the fenced block the FILED body
  // carries is deep-equal to a PiSpec the renderer could have written — so
  // compaction cut sections, never the contract. Read from the fence itself, not
  // from a re-mapping of the draft: compaction legitimately clips items, so a
  // re-mapping of the post-compaction body is a different (and meaningless)
  // comparison.
  const fence = /```pi-spec v1\n([\s\S]*?)\n```/.exec(filed)?.[1] ?? "";
  let embedded: unknown = null;
  try {
    embedded = JSON.parse(fence);
  } catch {
    embedded = null;
  }
  assert(
    parsed.ok === true &&
      JSON.stringify(parsed.ok ? parsed.spec : null) === JSON.stringify(embedded),
    "pipeline: the block in the filed body parses and deep-equals the PiSpec the renderer embedded",
  );
  assert(
    parsed.ok === true && (parsed.ok ? parsed.spec.criteria.length : 0) >= 8,
    `pipeline: the block carries a full set of criteria after compaction (got ${
      parsed.ok ? parsed.spec.criteria.length : 0
    })`,
  );
  assert(
    filed.length <= BODY_BUDGET + 4096,
    `pipeline: block + compaction appends stay inside the forge budget (${filed.length})`,
  );
  assert(
    !filed.includes(PI_SPEC_READINESS_PREFIX),
    "pipeline: a filed block reports no failed readiness rule",
  );
  assert(
    filed.indexOf(PI_SPEC_HEADING) < filed.lastIndexOf("<!-- pi-rukas:provenance v1"),
    "pipeline: the block sits above the provenance marker after compaction",
  );
  setPlanDispatch(null);
}

process.exit(exit);
