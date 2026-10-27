#!/usr/bin/env bun
/**
 * #1856 M3 — the duplicate-candidate disclosure at its ONE fixed render site.
 *
 * Split out of test-plan-duplicate-postfilter.ts for the 500-line cap (AGENTS.md
 * §12). The postfilter file pins what the barrier decides; this pins what the
 * operator SEES when it decides, and the two halves of that are different
 * contracts: a verdict can be right and the body that discloses it still wrong.
 *
 * The value of pinning the site rather than the string: `filedBodyOf` /
 * `finalDraftBody` are the only call sites that append this section, and the
 * ordering they produce is what the operator reviewed — provenance line, drafted
 * body, exclusion section, marker last. A second append site that forgot would
 * silently drop the disclosure from a filed issue, and the all-absent case being
 * a byte-identical pass-through is what "behaviour is unchanged without a source
 * issue" actually means for the whole body, not just one section.
 */

import type { MechanicalInventory } from "../src/plan-draft.ts";
import { duplicateExclusionSection } from "../src/plan-duplicate-disclosure.ts";
import { filedBodyOf, finalDraftBody } from "../src/plan-gap-disclosure.ts";
import { runInvestigation } from "../src/plan-investigate.ts";
import { assemblePriorContext } from "../src/plan-prior-context-assembly.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_FORGE = "none";

const DESC = "the plan duplicate check names the issue being planned as its own duplicate";

const RELATED = [
  { number: 1856, title: "duplicate check names its own issue", state: "OPEN" },
  { number: 103, title: "landed hybrid default", state: "CLOSED" },
  { number: 7, title: "an unrelated open issue", state: "OPEN" },
];

const SELF_ONLY_HIGH =
  "DUPLICATE_RISK: high — this is #1856 (OPEN) restated verbatim; #1856 already covers this exact scope";

/** One barrier run with a canned duplicate-risk reply, returning its verdict. */
async function barrier(reply: string, sourceIssue?: number) {
  const dispatch = ((_pi: unknown, spec: { role: string; prompt: string }) => {
    const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({ ...base, role: "explore", text: reply });
    }
    return Promise.resolve({
      ...base,
      role: "explore",
      text: "prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: {
            kind: "acceptance-criterion",
            text: "a self-only HIGH reaches drafting without a human turn",
            angle: "x",
          },
        },
      ],
    });
  }) as never;
  const inv: MechanicalInventory = { memory: [], related: RELATED, errors: [] };
  const res = await runInvestigation(dispatch, {} as never, {
    type: "bug",
    descriptor: DESC,
    repoRoot: process.cwd(),
    inv,
    priorContext: assemblePriorContext(undefined, inv).priorContext,
    codeIdentifiers: [],
    ...(sourceIssue === undefined ? {} : { sourceIssue }),
  });
  return res.duplicateRisk;
}

{
  const risk = await barrier(SELF_ONLY_HIGH, 1856);
  const section = duplicateExclusionSection(risk, 1856);
  assert(
    /## Duplicate check — excluded candidates/.test(section) && section.includes("#1856"),
    "the disclosure names the excluded issue under its own heading",
  );
  assert(
    /downgraded to medium/.test(section),
    "the disclosure says the verdict was downgraded, not merely suppressed",
  );
  assert(
    filedBodyOf("BODY", [], [], undefined, section).includes(
      "## Duplicate check — excluded candidates",
    ),
    "filedBodyOf appends the section",
  );
  assert(
    filedBodyOf("BODY", [], [], undefined) === "BODY",
    "no disclosure → the filed body is byte-identical to today's",
  );
  assert(
    duplicateExclusionSection(risk, undefined) === "" &&
      duplicateExclusionSection(undefined, 1856) === "",
    "no source issue or no verdict → no section at all",
  );

  // The one site that assembles the filed/shown body: the residual, open-point
  // and base-fallback disclosures, the exclusion section, the image links and the
  // provenance wrapper. Order is what the operator reviewed, so it is pinned.
  const assembled = finalDraftBody(
    "BODY",
    [],
    [],
    undefined,
    [],
    { line: "Planned by the driver", marker: { "plan-session": "abc" } },
    { risk, sourceIssue: 1856 },
  );
  assert(
    assembled.startsWith("_Planned by the driver_") &&
      assembled.includes("BODY") &&
      assembled.includes("## Duplicate check — excluded candidates") &&
      assembled.trimEnd().endsWith("<!-- pi-rukas:provenance v1 plan-session=abc -->"),
    "finalDraftBody: provenance line first, body, then the exclusion section, marker last",
  );
  assert(
    assembled.indexOf("BODY") < assembled.indexOf("## Duplicate check"),
    "finalDraftBody: the exclusion section is appended after the drafted body, never before it",
  );
  assert(
    finalDraftBody("BODY", [], [], undefined, [], undefined, {
      risk: undefined,
      sourceIssue: undefined,
    }) === "BODY",
    "finalDraftBody: with nothing to disclose and no provenance, the body passes through byte-identical",
  );
}

console.log(`\n${exit === 0 ? "PASS" : "FAIL"} test-plan-duplicate-disclosure-site`);
process.exit(exit);
