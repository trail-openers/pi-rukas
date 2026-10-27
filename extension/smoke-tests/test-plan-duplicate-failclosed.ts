#!/usr/bin/env bun
/**
 * #1856 M3 (review round 2) — the STRUCTURAL fail-closed rules of the
 * duplicate post-filter.
 *
 * Round 1 answered "an issue reference the `#N` extractor cannot read" with a
 * WORD LIST of reference shapes (`issue N`, `PR N`, `/issues/N`, …). It leaked:
 * `GH-12`, `gh-12`, `ticket 12`, `bug 12`, `issue-12`, `issue:12`, `issue12` and
 * `pull 12` each still downgraded a HIGH that main halts on, because none of
 * them was in the list. Round 2 replaces the list with two structural rules and
 * this file pins both, plus the evidence-supply fixes the round-1 lenses asked
 * for (the filter reads the child's FULL reply, not the 400-char display slice).
 *
 * BEFORE-BEHAVIOUR EVIDENCE (observed, not argued): the HEAD copies of
 * plan-duplicate-self.ts / plan-investigate.ts are saved to
 * /tmp/pi-ensemble-developer/r2/ and driven by
 * /tmp/pi-ensemble-developer/r2/probe-head.ts. On 51f2a5f2 every `keeps HIGH`
 * row below printed level=medium — the leak, reproduced on the commit under
 * review. Against this tree the same script prints high for each of them.
 */

import type { MechanicalInventory } from "../src/plan-draft.ts";
import {
  citesUnaccountedNumber,
  clauseNaming,
  duplicateExclusionSection,
  EXCLUSION_DISCLOSURE_MAX_ROWS,
} from "../src/plan-duplicate-self.ts";
import { runInvestigation } from "../src/plan-investigate.ts";

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

async function barrier(
  reply: string,
  sourceIssue?: number,
  related: MechanicalInventory["related"] = RELATED,
) {
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
            text: "the fail-closed rules hold",
            angle: "x",
          },
        },
      ],
    });
  }) as never;
  const localInv: MechanicalInventory = { memory: [], related, errors: [] };
  const res = await runInvestigation(dispatch, {} as never, {
    type: "bug",
    descriptor: DESC,
    repoRoot: process.cwd(),
    inv: localInv,
    priorContext: [],
    codeIdentifiers: [],
    ...(sourceIssue === undefined ? {} : { sourceIssue }),
  });
  return res.duplicateRisk;
}

// ============ rule 4: any number the filter cannot account for keeps the HIGH

{
  // The eight shapes round 1's word list leaked on. Each names ONLY the subject
  // with a `#N` token, so rules 1–2 would happily downgrade — the number in the
  // other reference is the only thing standing between this reply and a filing
  // main refused.
  const LEAKS: [string, string][] = [
    ["`GH-12`", "DUPLICATE_RISK: high — #1856 restates this; GH-12 covers the same scope"],
    ["`gh-12`", "DUPLICATE_RISK: high — #1856 restates this; gh-12 covers the same scope"],
    ["`ticket 12`", "DUPLICATE_RISK: high — #1856 restates this; ticket 12 covers the scope"],
    ["`bug 12`", "DUPLICATE_RISK: high — #1856 restates this; bug 12 covers the same scope"],
    ["`issue-12`", "DUPLICATE_RISK: high — #1856 restates this; issue-12 covers the scope"],
    ["`issue:12`", "DUPLICATE_RISK: high — #1856 restates this; issue:12 covers the scope"],
    ["`issue12`", "DUPLICATE_RISK: high — #1856 restates this; issue12 covers the scope"],
    ["`pull 12`", "DUPLICATE_RISK: high — #1856 restates this; pull 12 covers the scope"],
  ];
  for (const [shape, rationale] of LEAKS) {
    const risk = await barrier(rationale, 1856);
    assert(
      risk?.level === "high" && risk?.downgradedFrom === undefined,
      `rule 4: the unenumerated reference ${shape} keeps the HIGH (got ${risk?.level})`,
    );
  }
}

{
  // The same rule applied to a number that is not shaped like a reference at
  // all: the filter does not know what `41` refers to, so it cannot call the
  // HIGH self-only.
  const risk = await barrier("DUPLICATE_RISK: high — #1856 restates this, see line 41", 1856);
  assert(
    risk?.level === "high",
    `rule 4: a stray digit run (line 41) keeps the HIGH (got ${risk?.level})`,
  );
}

{
  // The FIELD CASE that motivated the whole filter, restated generically: the
  // only numbers are the subject's own id and an ISO date, both of which the
  // rule accounts for, so it still downgrades. This is the case a rule that was
  // merely "conservative" would have broken.
  const risk = await barrier(
    "DUPLICATE_RISK: high — #869 (OPEN, created 2026-10-27) already covers this exact scope verbatim",
    869,
    [
      { number: 869, title: "self", state: "OPEN" },
      { number: 103, title: "landed", state: "CLOSED" },
    ],
  );
  assert(
    risk?.level === "medium" &&
      (risk?.excludedIssues ?? []).map((e) => e.number).join(",") === "869",
    `the field case still downgrades once the ISO date is accounted for (got ${risk?.level})`,
  );
}

{
  // A version string beside the self token is a legitimate number, not a
  // reference: stripped, and the HIGH still downgrades.
  const risk = await barrier(
    "DUPLICATE_RISK: high — reverses the landed decision in #103 (as of v0.14.27)",
    1856,
  );
  assert(
    risk?.level === "medium" &&
      (risk?.excludedIssues ?? []).some((e) => e.number === 103 && e.reason.includes("prior art")),
    `a version string alongside the token still downgrades (got ${risk?.level})`,
  );
}

{
  // The predicate itself, without the barrier: what it strips and what it keeps.
  assert(
    citesUnaccountedNumber("created 2026-10-27 at 14:05 (v0.14.27)", ["1856"]) === false,
    "rule 4: dates, clock times and version strings are all accounted for",
  );
  assert(
    citesUnaccountedNumber("this is #1856 restated verbatim", ["1856"]) === false,
    "rule 4: a rationale whose only number is the resolved token is clean",
  );
  assert(
    citesUnaccountedNumber("this is #1856 and #7 restated", ["1856"]) === true,
    "rule 4: an unresolved token's digits are NOT accounted for",
  );
  assert(
    citesUnaccountedNumber("2026-10-2 and 12:9 are not dates", ["1856"]) === true,
    "rule 4: a near-date that is not one leaves a digit run and keeps the stop",
  );
}

// ============ rule 5: the prior-art word must live in the CLOSED issue's clause

{
  const risk = await barrier(
    "DUPLICATE_RISK: high — #1856 is prior art; #103 is unlanded duplicate work",
    1856,
  );
  assert(
    risk?.level === "high" && risk?.downgradedFrom === undefined,
    `rule 5: a prior-art word in the SUBJECT's clause does not discharge the CLOSED issue (semicolon) (got ${risk?.level})`,
  );
}

{
  const risk = await barrier(
    "DUPLICATE_RISK: high — #1856 is prior art, #103 is unlanded duplicate work",
    1856,
  );
  assert(
    risk?.level === "high" && risk?.downgradedFrom === undefined,
    `rule 5: the comma form keeps the HIGH too (got ${risk?.level})`,
  );
}

{
  const risk = await barrier("DUPLICATE_RISK: high — reverses the landed decision in #103", 1856);
  assert(
    risk?.level === "medium",
    `rule 5: the prior-art word in the CLOSED issue's own clause still downgrades (got ${risk?.level})`,
  );
}

{
  // The clause the rule reads, exposed: it stops at the boundary on both sides,
  // so the operator can see the exact words the suppression rests on.
  assert(
    clauseNaming("high — #1856 is prior art; #103 is unlanded duplicate work", "103") ===
      "#103 is unlanded duplicate work",
    "rule 5: clauseNaming returns the CLOSED issue's own clause, boundaries included out",
  );
  assert(
    clauseNaming("high — reverses the landed decision in #103", "103").includes("reverses"),
    "rule 5: the verb preceding the token is inside its clause",
  );
}

{
  // The disclosure QUOTES the clause it matched rather than asserting a fixed
  // claim about the child's words.
  const risk = await barrier("DUPLICATE_RISK: high — reverses the landed decision in #103", 1856);
  const section = duplicateExclusionSection(risk, 1856);
  assert(
    section.includes("reverses the landed decision in #103"),
    "the prior-art disclosure quotes the clause the rule matched",
  );
  assert(
    section.includes("#103 (CLOSED)"),
    "the prior-art disclosure still names the issue and its state",
  );
}

// ============ evidence supply: the filter reads the whole reply, not 400 chars

{
  // Lens round 1 H1: `parseDuplicateRisk` slices the rationale to 400 chars for
  // display. An OPEN duplicate named past that cut was invisible to the filter
  // and the HIGH downgraded. Padding pushes `#7` beyond the window; the filter
  // must still see it and halt.
  const pad = "The candidate set was compared line by line against every row. ".repeat(9);
  const reply = `DUPLICATE_RISK: high — #1856 restates this descriptor verbatim. ${pad}#7 is an open duplicate of the same scope`;
  assert(
    reply.indexOf("#7") > 400,
    `the fixture really places #7 past the 400-char display slice (at ${reply.indexOf("#7")})`,
  );
  const risk = await barrier(reply, 1856);
  assert(
    risk?.level === "high" && risk?.downgradedFrom === undefined,
    `H1: an OPEN duplicate named beyond char 400 keeps the HIGH (ref at ${reply.indexOf("#7")}, got ${risk?.level})`,
  );
}

{
  // And the symmetric proof that the cut is what the fix reads: the SAME short
  // reply with the duplicate inside the window still halts, so the case above
  // fails on the position, not on some unrelated property of a long reply.
  const risk = await barrier(
    "DUPLICATE_RISK: high — #1856 restates this; #7 is an open duplicate",
    1856,
  );
  assert(risk?.level === "high", "H1 control: the same duplicate inside the window still halts");
}

// ============ H2: an issue with no inventory row can never be prior art

{
  const risk = await barrier(
    "DUPLICATE_RISK: high — reverses the landed decision in #404, which is prior art",
    1856,
  );
  assert(
    risk?.level === "high" && risk?.downgradedFrom === undefined,
    `H2: a named issue the inventory never carried has no known state, so prior art cannot apply (got ${risk?.level})`,
  );
}

// ============ the disclosure stays bounded

{
  const many = Array.from({ length: EXCLUSION_DISCLOSURE_MAX_ROWS + 4 }, (_, i) => ({
    number: 200 + i,
    state: "CLOSED",
    title: "t".repeat(500),
    reason: "a CLOSED issue the risk check itself called prior art",
  }));
  const section = duplicateExclusionSection(
    { level: "medium", rationale: "", downgradedFrom: "high", excludedIssues: many },
    1856,
  );
  const bullets = section.split("\n").filter((l) => l.startsWith("- "));
  assert(
    bullets.length === EXCLUSION_DISCLOSURE_MAX_ROWS + 1,
    `the section itemises at most ${EXCLUSION_DISCLOSURE_MAX_ROWS} rows plus one summary line (got ${bullets.length})`,
  );
  assert(
    /and 4 more excluded candidate/.test(section),
    "the rows past the cap are counted, not silently dropped",
  );
  assert(
    !section.includes(`${"t".repeat(500)}`),
    "a runaway title is clipped by the shared disclosure truncation",
  );
  assert(
    section.length < 8_000,
    `the bounded section cannot grow the body the fitter reserved for it (${section.length} chars)`,
  );
}

console.log(`\n${exit === 0 ? "PASS" : "FAIL"} test-plan-duplicate-failclosed`);
process.exit(exit);
