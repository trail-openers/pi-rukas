#!/usr/bin/env bun
/**
 * #574 — contradicted evidence is not automatically load-bearing.
 *
 * A resolver can find a stale peripheral detail while still having a concrete,
 * buildable intent. Those rows must travel as assumptions rather than turning
 * a valid `proceed` into a false park. Claims that make a deliverable
 * impossible to build remain fail-closed.
 */

import { explainPrSteps } from "../src/work-driver-explain-pr-steps.ts";
import { intentCriticalityEnabled } from "../src/work-driver-intent-criticality.ts";
import {
  type NormalisedSpec,
  type SpecEvidence,
  parseNormalisedSpec,
  reconcileVerdict,
  renderAssumptions,
  specIsComplete,
} from "../src/work-driver-intent.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const spec = (over: Partial<NormalisedSpec> = {}): NormalisedSpec => ({
  intent: "Preserve the requested intent while applying the change.",
  deliverables: [
    {
      id: "d1",
      description: "apply the requested change",
      paths: ["extension/src/work-driver-intent.ts"],
    },
  ],
  acceptanceCriteria: ["the requested behavior is preserved"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "proceed",
  rationale: "the requested change is actionable",
  ...over,
});

const contradicted = (
  claim: string,
  source = "extension/src/work-driver-intent.ts:1",
): SpecEvidence => ({
  claim,
  source,
  verdict: "contradicted",
});

// Keep these fixtures on the enabled default even if the invoking shell has an
// escape hatch set. The disabled behavior is tested explicitly below.
const previousCriticality = process.env.PI_ENSEMBLE_INTENT_CRITICALITY;
delete process.env.PI_ENSEMBLE_INTENT_CRITICALITY;
assert(intentCriticalityEnabled(), "criticality filtering is enabled by default");

// --------------------------------------------- the three documented incidents

const incidents: Array<{
  issue: number;
  intent: string;
  claim: string;
  path: string;
}> = [
  {
    issue: 451,
    intent: "Keep fetchAllMergedDiffs deduplication behavior in the merge report.",
    claim: "fetchAllMergedDiffs is already compliant with the requested behavior",
    path: "extension/src/work-driver-merge.ts (existing)",
  },
  {
    issue: 489,
    intent: "Make check_cmd report the verification command's actual starting state.",
    claim: "check_cmd was already successful before this change",
    path: "extension/src/work-driver-verify.ts (modified)",
  },
  {
    issue: 356,
    intent: "Restore the missing docstring for the intent resolver.",
    claim: "the docstring is already fixed in the current branch",
    path: "extension/src/work-driver-intent.ts (new)",
  },
];

for (const incident of incidents) {
  const resolved = reconcileVerdict(
    spec({
      intent: incident.intent,
      deliverables: [
        {
          id: "d1",
          description: "implement the requested behavior",
          paths: [incident.path],
        },
      ],
      evidence: [contradicted(incident.claim, `${incident.path}:1`)],
    }),
  );
  assert(
    resolved.verdict === "proceed-with-assumptions",
    `#${incident.issue}: peripheral contradiction proceeds with assumptions`,
  );
  assert(
    resolved.assumptions.some((a) => a.text.includes(incident.claim)),
    `#${incident.issue}: stale contradiction is attached as an assumption`,
  );
  assert(
    renderAssumptions(resolved).includes(incident.claim),
    `#${incident.issue}: stale detail reaches the review-visible assumptions block`,
  );
}

// #546 boundary: an absence claim tied to a meaningful intent token is
// load-bearing. This covers the marker-shaped boundary without pretending that
// every possible marker wording is equivalent to a missing implementation.
{
  const resolved = reconcileVerdict(
    spec({
      intent: "Preserve marker parsing in dispatch reports.",
      deliverables: [
        {
          id: "markers",
          description: "retain marker parsing",
          paths: ["extension/src/reply-markers.ts (updated)"],
        },
      ],
      evidence: [contradicted("marker parsing is not present in the dispatch reports")],
    }),
  );
  assert(
    resolved.verdict === "park" && resolved.parkReason === "contradicted-by-code",
    "#546 boundary: a missing marker capability tied to the intent still parks",
  );
}

// -------------------------------------------------- criticality distinctions

{
  const alreadyAssumptions = reconcileVerdict(
    spec({
      verdict: "proceed-with-assumptions",
      evidence: [contradicted("the old example value is already checked elsewhere")],
    }),
  );
  assert(
    alreadyAssumptions.verdict === "proceed-with-assumptions",
    "a supporting contradiction preserves an existing proceed-with-assumptions verdict",
  );
}

{
  // A complete spec needs at least one confirmed row (#378), so the fixture
  // carries one; the point under test is that the CONTRADICTED row is the only
  // thing standing between this spec and completeness.
  const supporting = spec({
    intent: "Add a retry ceiling warning.",
    deliverables: [
      {
        id: "retry",
        description: "warn when the retry ceiling is too low",
        paths: ["extension/src/retry-config-check.ts"],
      },
    ],
    evidence: [
      contradicted("the issue's old example value is already checked elsewhere"),
      {
        claim: "the retry ceiling warning is unimplemented",
        source: "extension/src/retry-config-check.ts:1",
        verdict: "confirmed",
      },
    ],
  });
  assert(specIsComplete(supporting), "specIsComplete ignores a supporting contradiction");
}

{
  // The path annotation is deliberately present: criticality must compare a
  // claim with the normalised basename, not the prose annotation.
  const loadBearing = spec({
    intent: "Add the retry ceiling warning.",
    deliverables: [
      {
        id: "retry",
        description: "warn when the retry ceiling is too low",
        paths: ["extension/src/retry-config-check.ts (new)"],
      },
    ],
    evidence: [contradicted("retry-config-check.ts does not exist in the tree")],
  });
  const resolved = reconcileVerdict(loadBearing);
  assert(
    resolved.verdict === "park" && resolved.parkReason === "contradicted-by-code",
    "a load-bearing missing deliverable still parks",
  );
  assert(!specIsComplete(loadBearing), "specIsComplete rejects a load-bearing contradiction");
}

{
  // If the resolver supplied no claim from which criticality can be derived,
  // absence of evidence is not permission to build: fail closed as load-bearing.
  const missingCriticality = spec({
    evidence: [{ claim: "", source: "", verdict: "contradicted" }],
  });
  const resolved = reconcileVerdict(missingCriticality);
  assert(
    resolved.verdict === "park" && resolved.parkReason === "contradicted-by-code",
    "missing criticality defaults to load-bearing and parks fail-closed",
  );
  assert(
    !specIsComplete(missingCriticality),
    "missing criticality also fails the complete-spec predicate",
  );
}

// ------------------------------------------- stale memory is not the issue
//
// orchard #97, cycle cycle-id: the resolver said `proceed` with five
// confirmed file:line rows, and one `contradicted` row whose subject was the
// vipune rows it had just superseded. The intent, deliverables and evidence
// below are that cycle's recorded spec; the row text is verbatim.

const ORCHARD_97_MEMORY_ROW =
  "vipune rows claiming issue 97 already moved the meter into `header.topbar`, and one describing a `test/app_test.sh` that does not exist";

const ORCHARD_97_REPLY = `INTENT-VERDICT: proceed

## Spec

### Intent
Move the live power/token meter out of the doors row and into the sticky header band of the game view, so it reads next to the header line instead of under the stations.

### Deliverables
- markup: move the \`#panel-meter\` anchor out of \`nav.menu\` into \`header.topbar\` [paths: web/index.html]
- guard: add a shell case that pins placement [paths: test/app_test.sh]

### Acceptance criteria
- \`#panel-meter\` is a child of \`header.topbar\`; \`nav.menu\` contains exactly six doors and no \`.meter\`.

### Evidence
- Meter currently sits in the doors row — web/index.html:129 (\`nav.menu\`), :136 — confirmed
- Not already implemented: no PR for #97 in any state — \`gh pr list --state all\` — confirmed
- ${ORCHARD_97_MEMORY_ROW} — contradicted

## Rationale
The issue's premise matches main exactly. Verdict is proceed because nothing is ambiguous enough to block. Several vipune rows described this move as already done — they came from an unmerged cycle on #97. I superseded them.
`;

const asState = (s: NormalisedSpec): WorkState =>
  ({ issue: 97, pipelineState: { normalisedSpec: s }, eventLog: [] }) as unknown as WorkState;

{
  const parsed = parseNormalisedSpec(ORCHARD_97_REPLY);
  assert(
    parsed?.verdict === "proceed" &&
      parsed.evidence.some((e) => e.claim === ORCHARD_97_MEMORY_ROW && e.verdict === "contradicted"),
    "orchard #97: the reply parses as proceed with the memory row contradicted",
  );
  const resolved = reconcileVerdict(parsed as NormalisedSpec);
  assert(
    resolved.verdict === "proceed-with-assumptions" && resolved.parkReason === undefined,
    "orchard #97: a superseded memory row does not overturn the resolver's proceed",
  );
  const carried = resolved.assumptions.find((a) => a.text.includes(ORCHARD_97_MEMORY_ROW));
  assert(
    carried !== undefined && !carried.text.startsWith("issue detail is stale"),
    "orchard #97: the row travels as an assumption that blames the memory, not the issue",
  );
}

{
  // The same row with the source the prompt now asks for, and no memory
  // wording in the claim at all.
  const resolved = reconcileVerdict(
    spec({
      intent: "Move the meter into header.topbar.",
      deliverables: [{ id: "guard", description: "pin placement", paths: ["test/app_test.sh"] }],
      evidence: [
        contradicted("the meter already moved; test/app_test.sh does not exist", "memory"),
      ],
    }),
  );
  assert(
    resolved.verdict === "proceed-with-assumptions",
    "a contradicted row sourced `memory` is not load-bearing",
  );
}

{
  // The narrowness guard: a claim ABOUT memory code is still a code reading.
  const resolved = reconcileVerdict(
    spec({
      intent: "Thread includeCandidates through vipune search.",
      deliverables: [
        { id: "seam", description: "add the flag", paths: ["extension/src/vipune.ts"] },
      ],
      evidence: [contradicted("vipune.ts does not exist in the tree", "extension/src/vipune.ts")],
    }),
  );
  assert(
    resolved.verdict === "park" && resolved.parkReason === "contradicted-by-code",
    "a missing deliverable that merely concerns memory still parks",
  );
}

{
  // A memory row beside a real contradiction: the park stands, and the
  // handoff does not present the memory row as a finding about the code.
  const resolved = reconcileVerdict(
    spec({
      intent: "Move the meter into header.topbar.",
      deliverables: [{ id: "markup", description: "move it", paths: ["web/index.html"] }],
      evidence: [
        contradicted(ORCHARD_97_MEMORY_ROW, ""),
        contradicted("index.html does not exist in the tree", "web"),
      ],
    }),
  );
  assert(resolved.verdict === "park", "a real contradiction still parks beside a memory row");
  const text = explainPrSteps("intent-park", asState(resolved));
  const [codePart = "", memoryPart = ""] = text.split("Stale memory rows");
  assert(
    codePart.includes("index.html does not exist") && !codePart.includes("vipune rows claiming"),
    "the handoff's contradicting evidence lists the code reading only",
  );
  assert(
    memoryPart.includes(ORCHARD_97_MEMORY_ROW) && memoryPart.includes("not a reading of the code"),
    "the handoff names the memory row as stale memory, apart from the evidence",
  );
}

// -------------------------------------------------------------- escape hatch

{
  // A deliverable basename with a regex metacharacter ([bar].ts) used to escape
  // into an unmatched "]" and throw SyntaxError out of the explore step, crashing
  // the whole cycle. Pathological basenames must not throw and must still
  // classify as load-bearing when the claim references the deliverable.
  const pathological = spec({
    intent: "Add a guard for the bracket-tagged config.",
    deliverables: [{ id: "cfg", description: "add the guard", paths: ["foo/[bar].ts"] }],
    evidence: [contradicted("[bar].ts does not exist in the tree", "foo/")],
  });
  let thrown = false;
  let verdict: string | undefined;
  let parkReason: string | undefined;
  try {
    const resolved = reconcileVerdict(pathological);
    verdict = resolved.verdict;
    parkReason = resolved.parkReason;
  } catch {
    thrown = true;
  }
  assert(!thrown, "a metacharacter basename in a deliverable path does not throw");
  assert(
    !thrown && verdict === "park" && parkReason === "contradicted-by-code",
    "a metacharacter basename still classifies as load-bearing (parks)",
  );
}

{
  process.env.PI_ENSEMBLE_INTENT_CRITICALITY = "0";
  try {
    assert(!intentCriticalityEnabled(), "PI_ENSEMBLE_INTENT_CRITICALITY=0 disables filtering");
    const resolved = reconcileVerdict(
      spec({
        intent: "Add a retry ceiling warning.",
        deliverables: [
          {
            id: "retry",
            description: "warn when the retry ceiling is too low",
            paths: ["extension/src/retry-config-check.ts"],
          },
        ],
        evidence: [contradicted("the issue's old example value is already checked elsewhere")],
      }),
    );
    assert(
      resolved.verdict === "park" && resolved.parkReason === "contradicted-by-code",
      "the escape hatch restores unconditional contradiction parking",
    );
  } finally {
    if (previousCriticality === undefined) delete process.env.PI_ENSEMBLE_INTENT_CRITICALITY;
    else process.env.PI_ENSEMBLE_INTENT_CRITICALITY = previousCriticality;
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
