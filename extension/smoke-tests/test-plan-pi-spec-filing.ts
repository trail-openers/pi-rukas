#!/usr/bin/env bun
/**
 * plan-pi-spec, filing path — what the DRIVER actually files (#1883).
 *
 * The sibling `test-plan-pi-spec.ts` pins the mapper, the bounds and the render;
 * this one drives `runPlanPipeline` with the shared /plan stubs and asserts on the
 * bytes the forge received, which is the only place these four facts are observable:
 *
 *   - the block sits at the TOP of the FILED body (provenance italic line first,
 *     then the block, then every drafted section, then the provenance marker), so
 *     agent prose below it cannot open a fence that swallows it;
 *   - the block SURVIVES compaction whole — a compacted body's fence still carries
 *     exactly what the renderer wrote, because the section is placed after the
 *     fitter and its width was reserved before drafting ran;
 *   - `problem` is the filed ISSUE TITLE, not drafted prose;
 *   - a body the read-back will not vouch for files WITHOUT the block and WITH one
 *     plain disclosure line, so a filing never presents a block the lean executor
 *     would reject.
 *
 * Split from `test-plan-pi-spec.ts` by the AGENTS.md §12 file-size cap.
 */
import { parsePiSpec, readiness } from "../src/lean/spec.ts";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { finalDraftBody } from "../src/plan-gap-disclosure.ts";
import {
  PI_SPEC_EXAMPLE_INFO,
  PI_SPEC_HEADING,
  PI_SPEC_MAX_CRITERIA,
  PI_SPEC_OMISSION_PREFIX,
  PI_SPEC_PROBLEM_MAX_CHARS,
  PI_SPEC_READINESS_PREFIX,
  piSpecFromDraft,
  placePiSpecSection,
} from "../src/plan-pi-spec.ts";
import { BODY_BUDGET } from "../src/plan-validate.ts";
import { assert, draftBody, specExit } from "./lib/plan-pi-spec-fixture.ts";
import {
  DESC,
  forgeStub,
  installForgeStub,
  installNoPlanCacheStub,
  installOfflineVipuneStub,
  installOverflowDispatch,
  makeDispatchStub,
} from "./plan-test-stubs.ts";

// ------------------------------------ end-to-end through the pipeline: filing

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
  if (parsed.ok) {
    assert(readiness(parsed.spec).length === 0, "pipeline: the filed spec is ready");
    assert(
      parsed.spec.problem === r.title.slice(0, PI_SPEC_PROBLEM_MAX_CHARS),
      "pipeline: the block's problem is the filed ISSUE TITLE",
    );
  }
  const provLine = filed.indexOf("_add a pi-spec block");
  assert(
    provLine === 0 || !filed.startsWith("_"),
    `pipeline: the provenance italic line is the body's FIRST line (got ${JSON.stringify(filed.slice(0, 40))})`,
  );
  // The pipeline's own stubs file no provenance, so the ordering with a
  // provenance line on both sides is pinned on `finalDraftBody` directly.
  assert(
    filed.indexOf(PI_SPEC_HEADING) === 0 &&
      filed.indexOf(PI_SPEC_HEADING) < filed.indexOf("## Acceptance criteria"),
    "pipeline: the block is the FIRST thing filed, above every drafted section",
  );
  assert(
    !filed.includes("<!-- pi-rukas:provenance"),
    "pipeline: with no provenance passed, no marker is filed (the plain body ends at its last section)",
  );
  // The ordering itself, with a provenance line and marker on both sides.
  const wrapped = finalDraftBody(
    draftBody(["a", "b"]),
    [],
    [],
    undefined,
    [],
    { line: "automated run", marker: { run: "plan" } },
    { risk: undefined, sourceIssue: undefined },
    { type: "feature", title: "a title" },
  );
  assert(
    wrapped.startsWith("_automated run_\n\n") &&
      wrapped.indexOf(PI_SPEC_HEADING) === "_automated run_\n\n".length &&
      wrapped.indexOf(PI_SPEC_HEADING) < wrapped.indexOf("## Acceptance criteria") &&
      wrapped.trimEnd().endsWith("<!-- pi-rukas:provenance v1 run=plan -->"),
    "ordering: provenance italic line FIRST, then the block, then the drafted sections, marker LAST",
  );
  assert(
    parsePiSpec(wrapped).ok === true,
    "ordering: the block still parses with provenance on both sides of it",
  );
  assert(
    !filed.includes("<!-- pi-rukas:provenance"),
    "pipeline: no marker is filed when the caller passed no provenance",
  );
  setPlanDispatch(null);
}

{
  // Compaction must never cut the block. Same overflow fixture as
  // test-plan-provenance's survives-compaction case: 100 items per kind at
  // ~2,950 chars overflow stage 0's 20-per-kind render and fit stage 1's 10. The
  // block is placed AFTER the fitter, so compaction has no way to reach it and
  // the reservation is what keeps the total inside the forge cap.
  //
  // The criteria themselves come from the operator OUTCOME channel, which the
  // drafter renders verbatim: an angle-derived criterion is clipped to 220 chars
  // by the draft, and a bullet over the block's 200-char bound now makes the whole
  // block refuse to file rather than arrive cut — so the long angle items stay what
  // they are (overflow material) and the contract's criteria are stated short.
  const marker = { line: "x".repeat(300), marker: { run: "smoke", actor: "plan" } };
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  forgeStub.existing = null;
  installForgeStub();
  installOverflowDispatch(`the pi-spec block must survive ${"x".repeat(2950)} end`, 100);
  const operatorCriteria = Array.from(
    { length: 14 },
    (_, i) =>
      `operator criterion ${i + 1}: the filed block must carry it whole after compaction ${"y".repeat(40)}`,
  );
  const r = await runPlanPipeline(
    {} as never,
    {
      descriptor: DESC,
      provenance: marker,
      context: `Done when:\n${operatorCriteria.map((s) => `- ${s}`).join("\n")}`,
    },
    process.cwd(),
  );
  const filed = forgeStub.created[0]?.body ?? "";
  assert(
    r.compacted === true,
    `pipeline: the run reached the compaction stage (compacted=${r.compacted}, filed=${r.filed}, ${filed.length} chars)`,
  );
  const parsed = parsePiSpec(filed);
  // Read the JSON out of the FENCE itself, rather than re-mapping the draft:
  // compaction legitimately clips items, so a re-map of the post-compaction body
  // is a different (and meaningless) comparison. What must hold is that the file
  // parses AND that the bytes inside the fence are the bytes the renderer wrote.
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
    !filed.includes(PI_SPEC_OMISSION_PREFIX),
    "pipeline: an un-cuttable criterion is the only reason to omit, so this filing carries no omission line",
  );
  assert(
    parsed.ok === true &&
      parsed.spec.criteria.length >= 10 &&
      (parsed.ok ? parsed.spec.criteria.length : 0) <= PI_SPEC_MAX_CRITERIA,
    `pipeline: the block carries the drafted criteria after compaction, never more than the embed cap (got ${
      parsed.ok ? parsed.spec.criteria.length : 0
    })`,
  );
  assert(
    parsed.ok === true && parsed.spec.size === "L",
    `pipeline: a 100-criterion plan is honestly L even though 12 are embedded (got ${parsed.ok ? parsed.spec.size : "none"})`,
  );
  assert(
    filed.length <= BODY_BUDGET + 4096,
    `pipeline: block + compaction appends stay inside the forge budget (${filed.length})`,
  );
  assert(
    filed.includes(PI_SPEC_READINESS_PREFIX) && filed.includes("split it"),
    "pipeline: an L plan's filed block carries the readiness note, so the operator sees 'split it'",
  );
  assert(
    filed.indexOf(PI_SPEC_HEADING) > 0 &&
      filed.indexOf(PI_SPEC_HEADING) < filed.lastIndexOf("<!-- pi-rukas:provenance v1"),
    "pipeline: the block sits above the drafted sections and below the provenance marker",
  );
  setPlanDispatch(null);
}

// ------------------- a drafted block is an example, never the contract

{
  // The shape a corrective re-draft, a hand-edited issue, or an angle item that
  // QUOTES the block format produces. The old code called this "the body already
  // carries a block" and filed the example as the contract; the rule now is that
  // a drafted `pi-spec v1` fence is an EXAMPLE and ours is always the block.
  const stale = [
    "## Acceptance criteria",
    "",
    "- a",
    "- b",
    "",
    "## Spec (pi-spec v1)",
    "",
    "```pi-spec v1",
    '{ "problem": "an older spec someone pasted in", "criteria": [], "size": "S" }',
    "```",
    "",
  ].join("\n");
  const filed = finalDraftBody(
    stale,
    [],
    [],
    undefined,
    [],
    { line: "automated run", marker: { run: "plan" } },
    { risk: undefined, sourceIssue: undefined },
    { type: "feature", title: "a title" },
  );
  const filedOpenings = filed
    .split("\n")
    .filter((l) => /^ {0,3}(`{3,}|~{3,})\s*pi-spec v1\s*$/.test(l)).length;
  const filedBack = parsePiSpec(filed);
  assert(
    filedOpenings === 1 && filedBack.ok === true && filedBack.spec.problem === "a title",
    `example: exactly one OPENING pi-spec fence in a filed body, and it parses as ours (${filedOpenings})`,
  );
  const back = parsePiSpec(filed);
  assert(
    back.ok === true && back.spec.problem === "a title" && back.spec.criteria.length === 2,
    "example: OUR spec is what parses — the drafted example never becomes the contract",
  );
  assert(
    filed.includes(`${PI_SPEC_EXAMPLE_INFO}`) &&
      !filed.includes("an older spec someone pasted in") === false,
    "example: the pasted JSON is still in the body as prose, just not as a contract",
  );
  assert(
    filed.trimEnd().endsWith("-->") && filed.startsWith("_automated run_\n\n"),
    "example: provenance line first and marker last, block or no block",
  );

  // A tilde example is the case that used to win silently: same rename, same file.
  const tildeBody = draftBody(["the suite is green", "`bun test` exits 0"]);
  const tildeSpec = piSpecFromDraft({ type: "feature", body: tildeBody, title: "our title" });
  const tilde = placePiSpecSection(
    `${tildeBody}\n\n~~~pi-spec v1\n{ "problem": "quoted", "criteria": [], "size": "S" }\n~~~\n`,
    "feature",
    "our title",
  );
  const tildeBack = parsePiSpec(tilde.body);
  assert(
    tilde.omitted === undefined &&
      tildeBack.ok === true &&
      JSON.stringify(tildeBack.spec) === JSON.stringify(tildeSpec),
    "example: a tilde pi-spec v1 example files OUR block and the read-back equals the mapped spec",
  );
  const tildeOpenings = tilde.body
    .split("\n")
    .filter((l) => /^ {0,3}(`{3,}|~{3,})\s*pi-spec v1\s*$/.test(l)).length;
  assert(
    tilde.body.includes(PI_SPEC_EXAMPLE_INFO) && tildeOpenings === 1,
    `example: the tilde example's info string is renamed before ours is placed (${tildeOpenings})`,
  );

  // The omission line itself: a body the mapper cannot contract at all (an empty
  // title, so no `problem`) files with no block and one plain disclosure line.
  const noTitle = finalDraftBody(
    draftBody(["a", "b"]),
    [],
    [],
    undefined,
    [],
    { line: "automated run", marker: { run: "plan" } },
    { risk: undefined, sourceIssue: undefined },
    { type: "feature", title: "   " },
  );
  assert(
    !noTitle.includes(PI_SPEC_HEADING),
    "read-back: a filing with nothing to contract gets no block",
  );
  assert(
    noTitle.includes(PI_SPEC_OMISSION_PREFIX) &&
      (noTitle.split(PI_SPEC_OMISSION_PREFIX)[1]?.trim().length ?? 0) > 0,
    "read-back: the omission is stated on one plain line that names the reason",
  );
  assert(
    parsePiSpec(noTitle).ok === false,
    "read-back: the omitted body carries no block a reader could half-trust",
  );
  assert(
    noTitle.trimEnd().endsWith("-->") && noTitle.startsWith("_automated run_\n\n"),
    "read-back: the provenance lines bracket an omitted filing exactly as they bracket a normal one",
  );
  // The placer only returns the body with the disclosure line on it when the read-
  // back FAILED; "nothing to contract" is the byte-identical case. The no-provenance
  // disclosure of an empty title is `finalDraftBody`'s job (asserted above on
  // `noTitle`), which is why this asserts the placer's own contract instead.
  const noTitlePlain = placePiSpecSection(draftBody(["a", "b"]), "feature", "  ");
  assert(
    noTitlePlain.spec === undefined &&
      noTitlePlain.omitted === "no issue title to state the problem" &&
      !noTitlePlain.body.includes(PI_SPEC_HEADING),
    "read-back: the no-provenance placer reports the omission it could not contract",
  );
}

// ------------------- an over-long criterion files no block and says so

{
  // The filed-body half of the rule: a 220-character criterion is over the block's
  // 200-char bound, so the filing carries NO block and one plain line naming the
  // criterion — lean then refuses the issue as not ready instead of building and
  // testing against half a sentence.
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  forgeStub.existing = null;
  installForgeStub();
  setPlanDispatch(
    makeDispatchStub(
      "GAP: HIGH clarify the boundary — proposed resolution: add a criterion\nVERDICT: READY",
    ),
  );
  const longCriterion = `the block must carry this criterion whole, with every clause of it kept intact, ${"z".repeat(140)}`;
  const r = await runPlanPipeline(
    {} as never,
    {
      descriptor: "add a pi-spec block that never cuts a criterion",
      type: "feature",
      // The operator OUTCOME channel is the drafter's verbatim AC source: an
      // angle-derived criterion is clipped to 220 chars on the way in, which would
      // make this fixture about the drafter's clip rather than the block's bound.
      context: `Done when:\n- ${longCriterion}`,
    },
    process.cwd(),
  );
  const filed = forgeStub.created[0]?.body ?? "";
  const acSection = filed.split("## Acceptance criteria")[1]?.split("## ")[0] ?? "";
  assert(
    r.filed === true && acSection.includes(`- ${longCriterion}`),
    "omission: the filed prose carries the over-long criterion in full",
  );
  assert(
    !filed.includes(PI_SPEC_HEADING) &&
      parsePiSpec(filed).ok === false &&
      filed.includes(PI_SPEC_OMISSION_PREFIX) &&
      filed.includes("criteria AC1 ("),
    `omission: no block is filed and the body says why (${JSON.stringify(
      filed.split(PI_SPEC_OMISSION_PREFIX)[1]?.trim().slice(0, 60),
    )})`,
  );
  assert(
    !filed.includes("```pi-spec v1"),
    "omission: the filed body carries no fence at all, so there is no half-text to trust",
  );
  setPlanDispatch(null);
}

console.log(`\n${specExit() === 0 ? "PASS" : "FAIL"} test-plan-pi-spec-filing`);
process.exit(specExit());
