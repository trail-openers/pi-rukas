#!/usr/bin/env bun
/**
 * #1856 review rounds 2–4 — rule 5 of the duplicate post-filter: when a CLOSED
 * issue counts as the child's own prior art, and when it does not.
 *
 * Split from `test-plan-duplicate-failclosed.ts` along its rule seam (AGENTS.md
 * §12 size cap); the two files share one `barrier` shape on purpose — rule 4 is
 * about numbers the filter cannot place, rule 5 is about the words it can.
 *
 * Affirmation is judged PER CLAUSE: the prior-art word must sit in the clause
 * naming the CLOSED issue, and EVERY mention must carry one. Negation is judged
 * over the WHOLE reply (#1856 round 4): one negator token anywhere and no CLOSED
 * issue is excluded, because a denial and an affirmation about the same closed
 * issue are routinely two different sentences and a clause-scoped negation reads
 * the second one as somebody else's business.
 */

import type { MechanicalInventory } from "../src/plan-draft.ts";
import { duplicateExclusionSection } from "../src/plan-duplicate-disclosure.ts";
import {
  clauseNaming,
  everyClauseNaming,
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
  // #1856 review round 3 (adversarial): `clauseNaming` read the FIRST mention
  // only, so the reply below — an affirmation, then a denial of prior art for
  // the SAME closed issue — satisfied rule 5 and excluded #103. Every mention
  // is now judged.
  const risk = await barrier(
    "DUPLICATE_RISK: high — #1856 restates this. #103 is prior art for this. #103 is not landed, it is unlanded duplicate work",
    1856,
  );
  assert(
    risk?.level === "high" && risk?.downgradedFrom === undefined,
    `rule 5: a later denial of prior art for the CLOSED issue overrides an earlier affirmation (got ${risk?.level})`,
  );
}

{
  // The single-clause affirmation still excludes: the round-3 tightening must
  // not become a blanket refusal to honour prior art.
  const risk = await barrier(
    "DUPLICATE_RISK: high — #1856 restates this. #103 is prior art for this",
    1856,
  );
  assert(
    risk?.level === "medium" &&
      (risk?.excludedIssues ?? []).some((e) => e.number === 103 && e.reason.includes("prior art")),
    `rule 5: one affirming clause and no denial still excludes the CLOSED issue (got ${risk?.level})`,
  );
}

{
  // #1856 review round 4 (adversarial + lens, HIGH): rule 5's negation is
  // REPLY-WIDE, not per clause and not inside a word window. A denial of prior
  // art and its affirmation are routinely two sentences about the same issue, and
  // `unlanded` in a clause that never repeats the prior-art word said "not
  // landed" just as loudly as `not landed` did. One negator token anywhere and
  // NO CLOSED issue is excluded: every row below keeps the HIGH.
  const NEGS: [string, string][] = [
    [
      "a negator beside the prior-art word",
      "DUPLICATE_RISK: high — #103 is prior art, it is not landed",
    ],
    [
      "a negator in its own sentence plus `unlanded`",
      "DUPLICATE_RISK: high — #103 is prior art. It is not landed. It is unlanded duplicate work",
    ],
    [
      "the subject named alongside the denial",
      "DUPLICATE_RISK: high — #1856 restates this. #103 is prior art, it is not landed, it is unlanded duplicate work",
    ],
    // `nothing` is a negator token even where it is the object of the verb: the
    // rule does not try to tell a denial apart from an incidental use.
    [
      "a negator with no prior-art word in its clause",
      "DUPLICATE_RISK: high — #103 reverses nothing",
    ],
  ];
  for (const [shape, rationale] of NEGS) {
    const risk = await barrier(rationale, 1856);
    assert(
      risk?.level === "high" &&
        risk?.downgradedFrom === undefined &&
        risk?.excludedIssues === undefined,
      `rule 5 reply-wide negation (${shape}) excludes no CLOSED issue and keeps the HIGH (got ${risk?.level})`,
    );
  }
}

{
  // The negator is judged over the WHOLE reply, so it also stops an exclusion
  // whose CLOSED issue is #103 while the subject #1856 still excludes normally
  // when no closed issue is at stake: the rule 1 subject path is unchanged by
  // the reply-wide rule.
  const risk = await barrier(
    "DUPLICATE_RISK: high — #1856 restates this verbatim; there is no other open issue",
    1856,
  );
  assert(
    risk?.level === "medium" &&
      (risk?.excludedIssues ?? []).map((e) => e.number).join(",") === "1856",
    `rule 1 is unaffected by the reply-wide negator: a subject-only HIGH still downgrades (got ${risk?.level})`,
  );
}

{
  // The negator set, pinned at the token level: every spelling the rule names,
  // case-insensitively as a whole word — and NOT a substring (`no` inside `notable`,
  // `none` inside `nonempty`) — so the rule cannot be widened into a blanket
  // refusal to ever honour prior art.
  for (const neg of [
    "not",
    "NOT",
    "never",
    "no",
    "nothing",
    "none",
    "without",
    "unlanded",
    "isn't",
    "wasn't",
    "doesn't",
    "didn't",
    "hasn't",
    "aren't",
    "couldn't",
  ]) {
    assert(
      replyNegates(`the closed issue #103 is prior art, ${neg} otherwise`) === true,
      `rule 5: the negator token /${neg}/ fires reply-wide`,
    );
  }
  assert(
    replyNegates("#103 is prior art for this notable nonempty work") === false,
    "rule 5: a negator substring inside a longer word does not fire",
  );
}

{
  // The disclosure quotes a clause carrying a prior-art WORD rather than
  // asserting a fixed claim about the child's words, and it keeps the clause
  // whole inside the row's clip. Round 4 requires EVERY mention of a CLOSED
  // issue to affirm, so both clauses below carry a word; which one the row prints
  // is not load-bearing (round-3's "first vs. later mention" distinction died
  // with the per-clause negation window), so this pins the copy the operator
  // actually reads.
  const risk = await barrier(
    "DUPLICATE_RISK: high — #103 is prior art for the older scope. #103 reverses the landed decision it settled",
    1856,
  );
  const section = duplicateExclusionSection(risk, 1856);
  assert(
    risk?.level === "medium" &&
      /prior art or a reversal target — "[^"]*"/.test(section) &&
      (/prior art for the older scope/.test(section) ||
        /reverses the landed decision/.test(section)),
    `rule 5: the disclosure quotes one of the clauses that affirmed prior art (section ${JSON.stringify(section)})`,
  );
}

{
  // The `#7` vs `#71` anchoring: a mention of one token must never be read as a
  // mention of a shorter one that is a prefix of it.
  assert(
    everyClauseNaming("#7 matters, see #71 for the parent", "7").join("|") === "#7 matters",
    "rule 5: #71 is not a second mention of #7",
  );
  assert(
    everyClauseNaming("#7-2 is the unlanded half, #7 is the parent", "7").join("|") ===
      "#7 is the parent",
    "rule 5: a #7-2 split-child token is not a mention of #7",
  );
  assert(
    everyClauseNaming("#71 covers it", "7").length === 0,
    "rule 5: a token that never occurs on its own yields no clause at all",
  );
  assert(
    everyClauseNaming("#103 is prior art. #103 is not landed", "103").join("|") ===
      "#103 is prior art|#103 is not landed",
    "rule 5: everyClauseNaming returns EVERY mention's clause, in order",
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

console.log(`\n${exit === 0 ? "PASS" : "FAIL"} test-plan-duplicate-rule5`);
process.exit(exit);
