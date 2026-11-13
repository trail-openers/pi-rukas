#!/usr/bin/env bun
/**
 * #2233 — a NEVER CLAIM drop must leave the spec FILEABLE.
 *
 * The post-filter's disclosure used to quote the matched phrase verbatim AND
 * quote the dropped item's own text (which contains the phrase by
 * construction). The driver appends that disclosure to the drafted body
 * BEFORE `validatePhase3Draft`, so the driver's own forbidden-phrase scan
 * judged the driver's own disclosure: any NEVER CLAIM block that dropped at
 * least one item made the spec unfileable (`draft-invalid`), and the halt
 * detail re-quoted the phrase into the operator-visible FILING STATUS. The
 * phrase's whole purpose is to keep text out of the public body, so the
 * disclosure must not re-insert it either.
 *
 * Every block drives the REAL seams — the filter, the renderer that the driver
 * appends, and the scanner that judges it — so the three cannot drift apart,
 * plus one end-to-end run of the pipeline that shows a drop filing.
 */

import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { neverClaimDisclosureSection } from "../src/plan-dropped-artifact.ts";
import { applyNeverClaimFilter } from "../src/plan-never-claim.ts";
import { bodyContainsForbiddenPhrase, validateDraft } from "../src/plan-validate.ts";
import { installNoPlanCacheStub, installOfflineVipuneStub } from "./plan-test-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string, evidence?: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}${evidence ? ` — got: ${evidence}` : ""}`);
    exit = 1;
  }
}

/** The forbidden phrase — distinctive enough that no other word can match it. */
const PHRASE = "internal run identifier zx9q";

function angle(items: { kind: string; text: string }[]) {
  return [
    {
      name: "affected-code",
      ok: true,
      text: "prose",
      toolUses: items.map((i) => ({ ...i, angle: "affected-code" })),
    },
  ];
}

// ------------------------------------- the filter: positional, never the phrase

{
  const res = applyNeverClaimFilter(
    angle([
      {
        kind: "acceptance-criterion",
        text: `the ${PHRASE} is echoed by the reporter`,
      },
      { kind: "reference", text: "extension/src/plan-never-claim.ts" },
    ]),
    ["first phrase", PHRASE],
  );

  assert(res.droppedCount === 1, "the matching item is dropped (one drop)");
  assert(res.disclosure.length === 1, "one disclosure line for one drop");
  const line = res.disclosure[0] ?? "";
  assert(!line.includes(PHRASE), "AC1: the disclosure line never carries the phrase text", line);
  assert(
    line.includes("phrase 2"),
    "AC1: the phrase is named by its POSITION in the operator's block",
    line,
  );
  assert(
    line.includes('angle "affected-code"') &&
      line.includes("[acceptance-criterion]") &&
      line.includes("dropped 1 item(s)"),
    "AC1/suggested: the line names the angle, the item kind and the count",
    line,
  );
  assert(
    res.findings[0].toolUses.length === 1 &&
      res.findings[0].toolUses[0].text === "extension/src/plan-never-claim.ts",
    "the non-matching item survives",
  );
}

{
  // A second phrase index: the numbering is the operator's, not the filtered
  // array's, so a phrase that matched nothing still occupies its own number.
  const res = applyNeverClaimFilter(
    angle([{ kind: "edge-case", text: `a pitfall about the ${PHRASE} path` }]),
    [PHRASE, "another phrase"],
  );
  assert(
    res.droppedCount === 1 &&
      (res.disclosure[0] ?? "").includes("phrase 1") &&
      !(res.disclosure[0] ?? "").includes(PHRASE),
    "the index is the position in the UNFILTERED operator block",
    res.disclosure[0],
  );
}

// ------------------------------- the renderer and the scanner, pinned together

{
  const res = applyNeverClaimFilter(
    angle([
      { kind: "reference", text: `the file carrying the ${PHRASE} value` },
      { kind: "edge-case", text: "a pitfall that survives" },
    ]),
    [PHRASE],
  );
  const section = neverClaimDisclosureSection(res.disclosure);
  assert(section.includes("NEVER CLAIM filter disclosure"), "the renderer still renders it");
  assert(
    bodyContainsForbiddenPhrase(section, [PHRASE]).length === 0,
    "suggested: the rendered blockquote is itself phrase-free (renderer vs scanner at one seam)",
    section,
  );

  // A disclosure line for an item whose text begins with the phrase must not
  // smuggle the phrase in through the dropped-item clause either.
  const leading = applyNeverClaimFilter(
    angle([{ kind: "reference", text: `${PHRASE} appears first in the item` }]),
    [PHRASE],
  );
  assert(
    bodyContainsForbiddenPhrase(neverClaimDisclosureSection(leading.disclosure), [PHRASE])
      .length === 0,
    "a phrase at the head of the dropped item's text still leaves the body phrase-free",
    leading.disclosure[0],
  );
}

// ------------------- validateDraft: a phrase-free body + disclosure still files

{
  const forbidden = [PHRASE];
  const body = [
    "## Context & motivation",
    "",
    "Descriptor: make the NEVER CLAIM disclosure phrase-free",
    "",
    "## Prior context inventory",
    "",
    "- [context param] NEVER CLAIM:",
    `- [context param] - ${PHRASE}`,
    "",
    "## Acceptance criteria",
    "",
    "- the tool registers",
  ].join("\n");
  const res = applyNeverClaimFilter(
    angle([{ kind: "reference", text: `reads the ${PHRASE} from the environment` }]),
    forbidden,
  );
  const withDisclosure = `${body}${neverClaimDisclosureSection(res.disclosure)}`;

  assert(res.droppedCount === 1, "AC2 precondition: one item was dropped");
  assert(
    bodyContainsForbiddenPhrase(withDisclosure, forbidden).length === 0,
    "AC2: the body + disclosure is phrase-free outside the inventory",
    neverClaimDisclosureSection(res.disclosure),
  );
  assert(
    validateDraft("feature", withDisclosure, 0, {
      operatorOmitted: [],
      forbiddenPhrases: forbidden,
    }).ok,
    "AC2: with a drop and a phrase-free remainder the draft validates",
  );

  // AC3: the scanner still rejects a body that carries the phrase outside the
  // inventory — the fix is not an exemption.
  const leaked = withDisclosure.replace("- the tool registers", `- the ${PHRASE} is listed`);
  const v = validateDraft("feature", leaked, 0, {
    operatorOmitted: [],
    forbiddenPhrases: forbidden,
  });
  assert(
    !v.ok && v.problems.some((p) => p.includes(PHRASE)),
    "AC3: a genuine occurrence outside the inventory still invalidates the draft",
    v.problems[0] ?? "no problem",
  );
  assert(
    !v.problems.some((p) => p.includes("NEVER CLAIM filter disclosure")),
    "AC3: the rejection is the leaked bullet, not the disclosure block",
  );
}

// ------------------------------------------- the pipeline, end to end (AC2/AC4)

{
  const originalForge = process.env.PI_ENSEMBLE_FORGE;
  process.env.PI_ENSEMBLE_FORGE = "none";
  installOfflineVipuneStub();
  installNoPlanCacheStub();

  const context = [
    "OPERATOR NOTES:",
    "- the driver must disclose a drop without quoting anything",
    "",
    "NEVER CLAIM:",
    `- ${PHRASE}`,
  ].join("\n");

  setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
    const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
    if (spec.role === "adversarial-developer") {
      return Promise.resolve({ ...base, role: spec.role, text: "VERDICT: READY" });
    }
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({ ...base, role: "explore", text: "DUPLICATE_RISK: none" });
    }
    // ONE angle item carries the forbidden phrase; the rest of the body is
    // phrase-free. If EVERY item carried the phrase the angle would read as
    // failed (structured-first) and the run would halt before drafting, which
    // would assert nothing about fileability.
    return Promise.resolve({
      ...base,
      role: "explore",
      text: "prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: {
            kind: "acceptance-criterion",
            text: `the ${PHRASE} is never claimed in the filed body`,
            angle: "x",
          },
        },
        {
          name: "report_plan_item",
          arguments: {
            kind: "acceptance-criterion",
            text: "a run with a NEVER CLAIM drop still files its spec",
            angle: "x",
          },
        },
        {
          name: "report_plan_item",
          arguments: { kind: "reference", text: "extension/src/plan-never-claim.ts", angle: "x" },
        },
      ],
    });
  }) as never);

  const r = await runPlanPipeline(
    { registerTool: () => {} } as never,
    {
      descriptor: "make the NEVER CLAIM disclosure phrase-free and positional",
      context,
      dryRun: true,
    },
    process.cwd(),
  );
  setPlanDispatch(null);
  // Restored via the harness helper rather than `delete`, which biome's
  // noDelete rule rejects: the stub's own state, not an inherited default.
  process.env.PI_ENSEMBLE_FORGE = originalForge;

  const body = String(r.spec ?? "");
  assert(
    r.filingFailure === undefined,
    `AC2: the run reports no filing failure (got ${r.filingFailure?.reason ?? "none"}${r.filingFailure?.detail ? `: ${r.filingFailure.detail}` : ""})`,
  );
  assert(!body.includes(PHRASE), "AC4: the phrase text is absent from the whole drafted body");
  assert(
    body.includes("NEVER CLAIM filter disclosure"),
    "the drop is still disclosed — never silent",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
