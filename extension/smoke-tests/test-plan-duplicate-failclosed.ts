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
 * for (the filter reads the child's FULL reply, not the 400-char display slice)
 * and the canonical citation tokens of round 4. Rule 5 — the prior-art test —
 * has its own file, `test-plan-duplicate-rule5.ts` (AGENTS.md §12 size cap).
 *
 * BEFORE-BEHAVIOUR EVIDENCE (observed, not argued): the pre-fix copies of
 * plan-duplicate-self.ts / plan-investigate.ts were saved to a scratch directory
 * OUTSIDE the repo and driven by a probe script there. On the commit under review
 * every `keeps HIGH` row below printed level=medium — the leak, reproduced on the
 * base. Against this tree the same rows are high. No committed test reads a git
 * revision: CI's checkout does not carry a branch commit.
 */

import type { MechanicalInventory } from "../src/plan-draft.ts";
import {
  duplicateExclusionSection,
  EXCLUSION_DISCLOSURE_MAX_ROWS,
} from "../src/plan-duplicate-disclosure.ts";
import {
  citesUnaccountedNumber,
  citesUnaccountedNumberStripped,
  clauseNaming,
  everyClauseNaming,
  namedIssueRefs,
  replyNegates,
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
  // A version of THREE OR MORE parts beside the self token is a legitimate
  // number, not a reference: stripped, and the HIGH still downgrades.
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
  // #1856 review round 2 (HIGH) and round 3 (lens HIGH): the version shape must
  // not swallow an issue written in dotted form. `1855.1` is not a version — no
  // `v`, only two parts — and stripping it read a reply that cited another issue
  // as self-only and filed a plan main halts on. Same for `1855.0`, which looks
  // exactly like the `0.0` of a version string and is not one. Round 3 extends
  // that to the arity that used to read as safe: a PREFIXLESS number is an issue
  // reference just as easily at three parts (`0.14.27`, `1855.1.0`) as at two,
  // and a `v` on its own does not make two parts a version (`v1855.1`).
  for (const dotted of ["1855.1", "1855.0", "1855.1.0", "0.14.27", "v1855.1"]) {
    const risk = await barrier(
      `DUPLICATE_RISK: high — #1856 restates this; ${dotted} covers the same scope`,
      1856,
    );
    assert(
      risk?.level === "high" && risk?.downgradedFrom === undefined,
      `rule 4: a dotted issue-shaped number (${dotted}) keeps the HIGH rather than reading as a version (got ${risk?.level})`,
    );
  }
  // The safe shapes still are safe: a `v`-prefixed version of three parts, an
  // ISO date and a clock time each accompany a self-only HIGH and must not keep
  // it.
  for (const [shape, safe] of [
    ["a v-version", "v0.14.27"],
    ["an ISO date", "2026-10-27"],
    ["a clock time", "12:30"],
  ] as [string, string][]) {
    const risk = await barrier(
      `DUPLICATE_RISK: high — #1856 restates this verbatim (compared ${shape} ${safe})`,
      1856,
    );
    assert(
      risk?.level === "medium" && risk?.downgradedFrom === "high",
      `rule 4: the safe shape ${shape} (${safe}) does not keep a self-only HIGH (got ${risk?.level})`,
    );
  }
}

{
  // The predicate itself, without the barrier: what it strips and what it keeps.
  assert(
    citesUnaccountedNumber("created 2026-10-27 at 14:05 (v0.14.27)", ["1856"]) === false,
    "rule 4: dates, clock times and three-part v-versions are all accounted for",
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
  assert(
    citesUnaccountedNumber("cf. 1855.1 and 1855.0", ["1856"]) === true,
    "rule 4: a two-part dotted number is NOT a version — its digits stay unaccounted for",
  );
  // #1856 round 3 (lens HIGH): the prefixless dotted shape, at every arity, and
  // a two-part `v` number. Each can be an issue reference, so none is stripped.
  for (const dotted of ["0.14.27", "1855.1.0", "v1855.1", "1.2"]) {
    assert(
      citesUnaccountedNumber(`cf. ${dotted} covers the scope`, ["1856"]) === true,
      `rule 4: ${dotted} keeps the HIGH rather than reading as a version`,
    );
  }
  // And the three-part `v` shape really is stripped at every arity from three up
  // — the tightening above must not have disabled version stripping entirely.
  assert(
    citesUnaccountedNumber("as of v0.14.27", ["1856"]) === false &&
      citesUnaccountedNumber("as of v1.2.3.4", ["1856"]) === false,
    "rule 4: a v-prefixed version of three or more parts is still accounted for",
  );
  assert(
    citesUnaccountedNumber("as of v0.14.27 and 2026-10-27T09:12", ["1856"]) === false,
    "rule 4: a v-prefixed version and a dated timestamp together are accounted for",
  );
  // Round 3: the prefixless three-part version in the same fixture is NO LONGER
  // stripped — the shape cannot be told from `1855.1.0`, so it keeps the stop.
  assert(
    citesUnaccountedNumber("as of v0.14.27, 0.12.38-beta and 2026-10-27T09:12", ["1856"]) ===
      true,
    "rule 4: a prefixless three-part version keeps the HIGH (fail closed, not a version)",
  );
  assert(
    citesUnaccountedNumber("#7 and #77 both matter", ["7"]) === true,
    "rule 4: removing a shorter resolved token cannot blank the digits of a longer one",
  );
  assert(
    citesUnaccountedNumber("#12 and #123 are different issues", ["12"]) === true,
    "rule 4: a resolved token's removal stops at a digit boundary (/#N(?!\\d)/), so #123 stays",
  );
  // #1856 review round 3: the citation is removed WHOLE, leading `#` run and all,
  // so `##1856` leaves no stray `#` behind. The anchoring still holds: `##7` does
  // not blank `##77`.
  assert(
    !/#+/.test(citesUnaccountedNumberStripped("this is ##1856 restated", ["1856"])),
    "rule 4: a ##-prefixed citation of a resolved token leaves no stray # behind",
  );
  assert(
    citesUnaccountedNumber("this is ##1856 restated verbatim", ["1856"]) === false,
    "rule 4: the ## form of the resolved token reads as fully accounted for",
  );
  assert(
    citesUnaccountedNumber("##7 and ##77 both matter", ["7"]) === true,
    "rule 4: a ##-prefixed resolved token cannot blank the digits of a longer ## one",
  );
}

{
  // #1856 review round 4 (MEDIUM, security): tokens are CANONICAL, so one issue
  // written two ways is one ref — and the padded spelling is the same citation
  // rule 4 strips, not a stray number that either keeps the HIGH or (on a
  // non-canonical token) a hole in the fail-closed rule.
  assert(
    namedIssueRefs("#1856 (OPEN) restates #01856").map((r) => r.token).join(",") === "1856",
    "canonical tokens: #1856 and #01856 are ONE ref, not two issues",
  );
  assert(
    namedIssueRefs("#7 and #007 and #0007").map((r) => r.token).join(",") === "7",
    "canonical tokens: any number of leading zeros names the same issue",
  );
  assert(
    namedIssueRefs("#0103-2 and #103-02").map((r) => r.token).join(",") === "103-2",
    "canonical tokens: a padded split-child token is the same parent-child pair",
  );
  for (const [text, resolved, want] of [
    ["#1856 (OPEN) restates #01856", ["1856"], false],
    ["#01856 (OPEN) restates #1856", ["1856"], false],
    // The control that makes the two above a test and not an accident: a padded
    // spelling of a DIFFERENT issue is still an unaccounted number.
    ["#1856 (OPEN) restates #01855", ["1856"], true],
    // And padding is only ever a prefix: the digits of a longer id are never
    // blanked by a shorter resolved token, padded spelling or not.
    ["cf. #01238", ["12"], true],
  ] as [string, string[], boolean][]) {
    assert(
      citesUnaccountedNumber(text, resolved) === want,
      `rule 4: ${text} with resolved [${resolved}] is${want ? "" : " not"} an unaccounted number`,
    );
  }
  {
    // End to end: the padded self-citation behaves exactly as the plain one.
    const padded = await barrier(
      "DUPLICATE_RISK: high — #1856 (OPEN) restates #01856 verbatim",
      1856,
    );
    const plain = await barrier(
      "DUPLICATE_RISK: high — #1856 (OPEN) restates #1856 verbatim",
      1856,
    );
    assert(
      padded?.level === "medium" &&
        plain?.level === "medium" &&
        JSON.stringify(padded?.excludedIssues) === JSON.stringify(plain?.excludedIssues),
      `a padded self-citation is handled the same as the plain spelling (${padded?.level} / ${plain?.level})`,
    );
    const other = await barrier(
      "DUPLICATE_RISK: high — #1856 (OPEN) restates #01855 verbatim",
      1856,
    );
    assert(
      other?.level === "high" && other?.downgradedFrom === undefined,
      `a padded citation of ANOTHER issue keeps the HIGH (got ${other?.level})`,
    );
  }
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
    state: "CLOSED" as const,
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
    "a runaway title cannot reach the rendered section",
  );
  assert(
    section.length < 8_000,
    `the bounded section cannot grow the body the fitter reserved for it (${section.length} chars)`,
  );
}

console.log(`\n${exit === 0 ? "PASS" : "FAIL"} test-plan-duplicate-failclosed`);
process.exit(exit);

