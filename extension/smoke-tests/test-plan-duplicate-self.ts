#!/usr/bin/env bun
/**
 * #1856 M2 — the planned issue leaves the duplicate-risk child's candidate set.
 *
 * Two self-match vectors fed the HIGH verdict (the issue body's own inventory
 * both name them):
 *
 *   - `MechanicalInventory.related` renders verbatim in the risk prompt as
 *     `#N (state) title`, so the child is handed the issue being planned;
 *   - `assemblePriorContext` pushes those same rows as `issue #N (state)`
 *     prior-context entries, so the "PM has already established" block names it
 *     a second time.
 *
 * Both are filtered for THIS child only (angles, gate and drafted body keep the
 * full inventory — naming the planned issue there is useful, not misleading),
 * and the prompt now states the rule. With no source issue everything is
 * byte-identical to before, which the last block pins exactly.
 */

import type { MechanicalInventory } from "../src/plan-draft.ts";
import {
  isClosedState,
  isSplitChildOf,
  namedIssueRefs,
  namedIssueTokens,
  normaliseIssueState,
  priorContextExcludingSource,
  relatedExcludingSource,
} from "../src/plan-duplicate-self.ts";
import {
  duplicateRiskPrompt,
  parseDuplicateRisk,
  runInvestigation,
} from "../src/plan-investigate.ts";
import { assemblePriorContext } from "../src/plan-prior-context-assembly.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const DESC = "the plan duplicate check names the issue being planned as its own duplicate";

const RELATED = [
  { number: 1856, title: "duplicate check names its own issue", state: "OPEN" },
  { number: 103, title: "landed hybrid default", state: "CLOSED" },
  { number: 7, title: "an unrelated open issue", state: "OPEN" },
];

const inv: MechanicalInventory = { memory: [], related: RELATED, errors: [] };

// ------------------------------------------------- the pure exclusion helpers

{
  const kept = relatedExcludingSource(inv, 1856).map((r) => r.number);
  assert(
    kept.join(",") === "103,7",
    `inventory: the source issue and its split child leave the candidate rows (kept ${kept.join(",")})`,
  );
  assert(
    relatedExcludingSource(inv, undefined) === inv.related,
    "inventory: no source issue → the SAME array, untouched",
  );

  const prior = assemblePriorContext("some operator context", inv).priorContext;
  const sources = priorContextExcludingSource(prior, 1856).map((p) => p.source);
  assert(
    !sources.some((s) => s.startsWith("issue #1856")),
    "prior context: the planned issue is not in the risk child's PM-established block",
  );
  assert(
    sources.some((s) => s === "issue #103 (CLOSED)"),
    "prior context: an unrelated closed issue still reaches the child",
  );
  assert(
    priorContextExcludingSource(prior, 1856).some((p) => p.source === "context param"),
    "prior context: operator lines are never dropped by the exclusion",
  );
  assert(
    priorContextExcludingSource(prior, undefined) === prior,
    "prior context: no source issue → the SAME array, untouched",
  );
  assert(
    assemblePriorContext("ctx", inv).inventoryContext.some(
      (p) => p.source === "issue #1856 (OPEN)",
    ),
    "the FILED-body inventory still lists the planned issue (only the risk child is filtered)",
  );
}

// ------------------------------------------------------- the split-child rule

{
  assert(isSplitChildOf(1856001, 1856) === false, "a bare number is never a split child");
  assert(
    isSplitChildOf(18561, 1856) === false,
    "concatenation (no dash) is not the split-child form",
  );
  const refs = namedIssueRefs("duplicates #1856 and its own child #1856-2, plus #7");
  assert(
    refs.map((r) => r.token).join(",") === "1856,1856-2,7",
    `named issues: #N and #N-k both parse (${refs.map((r) => r.token).join(",")})`,
  );
  assert(
    namedIssueTokens("duplicates #1856 and #7").join(",") === "1856,7",
    "named issues: the numeric ids are what the state lookup consumes",
  );
  assert(
    normaliseIssueState("closed") === "CLOSED" && normaliseIssueState(" OPEN ") === "OPEN",
    "state normalisation: a forge's casing becomes the union's casing",
  );
  assert(
    normaliseIssueState("opened") === "unknown" &&
      normaliseIssueState("") === "unknown" &&
      normaliseIssueState(undefined) === "unknown",
    "state normalisation: anything but OPEN/CLOSED is `unknown`, never a guess",
  );
  // The comparison is exact BECAUSE normalisation happens once (item 3). A raw
  // lower-case string is not evidence an issue's work landed.
  assert(isClosedState("CLOSED"), "CLOSED is closed");
  assert(!isClosedState("OPEN"), "OPEN is not closed");
  assert(!isClosedState("unknown"), "an unknown state satisfies no rule");
}

// ------------------------------------------------------------ the prompt line

{
  const noSrc = duplicateRiskPrompt("bug", DESC, inv);
  assert(
    noSrc.includes("#1856 (OPEN)"),
    "no source issue: the scan still lists every related issue (the pre-#1856 shape)",
  );
  assert(
    !/SUBJECT of this plan/.test(noSrc),
    "no source issue: the subject line is absent from the prompt",
  );

  const riskInv = { ...inv, related: relatedExcludingSource(inv, 1856) };
  const withSrc = duplicateRiskPrompt(
    "bug",
    DESC,
    riskInv,
    priorContextExcludingSource(assemblePriorContext(undefined, inv).priorContext, 1856),
    undefined,
    1856,
  );
  assert(
    !withSrc.includes("#1856 (OPEN)") &&
      withSrc.includes("#103 (CLOSED)") &&
      withSrc.includes("#7 (OPEN)"),
    "with a source issue: the subject leaves the scan rows and the others stay",
  );
  assert(
    withSrc.includes("#103 (CLOSED)") && withSrc.includes("#7 (OPEN)"),
    "with a source issue: the other candidates are still offered",
  );
  assert(
    /EXISTING issue #1856/.test(withSrc) &&
      /SUBJECT of this plan, never its duplicate/.test(withSrc),
    "with a source issue: the prompt states the subject is never its own duplicate",
  );
  assert(
    /high means DUPLICATE: an OPEN issue/.test(withSrc) &&
      /REVERSAL target, not a duplicate/.test(withSrc),
    "with a source issue: the existing charter sentences are untouched",
  );
}

// --------------------- the child's own view, through the barrier it runs in

interface Seen {
  role: string;
  prompt: string;
}

async function barrierPrompts(sourceIssue?: number): Promise<[string]> {
  const seen: Seen[] = [];
  const dispatch = ((_pi: unknown, spec: { role: string; prompt: string }) => {
    seen.push(spec);
    const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        ...base,
        role: "explore",
        text: "DUPLICATE_RISK: none — no overlap",
      });
    }
    return Promise.resolve({
      ...base,
      role: "explore",
      text: "prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: { kind: "acceptance-criterion", text: "the exclusion holds", angle: "x" },
        },
      ],
    });
  }) as never;
  const prior = assemblePriorContext(undefined, inv).priorContext;
  await runInvestigation(dispatch, {} as never, {
    type: "bug",
    descriptor: DESC,
    repoRoot: process.cwd(),
    inv,
    priorContext: prior,
    codeIdentifiers: [],
    ...(sourceIssue === undefined ? {} : { sourceIssue }),
  });
  const dup = seen.filter((s) => s.prompt.includes("DUPLICATE RISK CHECK")).map((s) => s.prompt);
  const [risk] = dup;
  if (risk === undefined || dup.length !== 1) {
    throw new Error(`expected exactly one duplicate-risk dispatch, saw ${dup.length}`);
  }
  return [risk];
}

{
  // One call each: the helper throws unless exactly one duplicate-risk dispatch
  // ran, so a barrier that stopped dispatching it fails loudly, not as an
  // undefined-vs-string comparison.
  const [withoutSource] = await barrierPrompts();
  const [withSource] = await barrierPrompts(1856);
  assert(
    withoutSource.includes("#1856 (OPEN)") && withoutSource.includes("#103 (CLOSED)"),
    "the barrier without a source issue hands the child the full scan (today's behaviour)",
  );
  assert(
    !withSource.includes("#1856 (OPEN)") && withSource.includes("#103 (CLOSED)"),
    "the barrier with a source issue removes the subject from the child's view",
  );

  // Byte-identity: a no-source barrier prompt must equal the pre-#1856 prompt
  // EXACTLY — computed from the same inputs, so any drift in the sentence order,
  // the scan rendering or the prior-context block fails here, not in the field.
  const baseline = duplicateRiskPrompt(
    "bug",
    DESC,
    inv,
    assemblePriorContext(undefined, inv).priorContext,
    undefined,
    undefined,
  );
  assert(
    withoutSource === baseline,
    "BYTE-IDENTICAL: the no-source barrier prompt equals duplicateRiskPrompt with no source issue",
  );
  assert(
    withSource.startsWith(baseline) === false &&
      withSource.includes("SUBJECT of this plan") === true,
    "the source-issue prompt is the same prompt plus the subject sentence (and is not the baseline)",
  );
}

// ---------------------------------------- an absent marker is never a verdict

{
  const noMarker = parseDuplicateRisk("I checked the issues and could not decide.");
  assert(
    noMarker.level === "medium" && noMarker.downgradedFrom === undefined,
    "an absent marker keeps the medium proceed-without-verdict path, never a downgrade",
  );
}

process.exit(exit);
