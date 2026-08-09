#!/usr/bin/env bun
/**
 * #408 — the parse-brittleness class, at the sites where a no-match produced a
 * *confident wrong answer* rather than an obvious failure.
 *
 * Each block below pairs the corrected behaviour with the exact input that
 * used to break it. Every one of these inputs is a shape an agent really
 * emits — bold markers, a capitalised token, a GitHub closing keyword — which
 * is why the misses were invisible: the fixtures were all written to match the
 * regexes, so none of them could see the defect (the pathology
 * `test-intent-real-replies.ts` documents for #397).
 */

import { readEnumMarker, readMarker } from "../src/reply-markers.ts";
import { type GroupingResult, groupIssues } from "../src/work-driver-grouping.ts";
import { parsePerIssueVerdicts } from "../src/work-driver-plan.ts";

/** `groups` is a Record keyed by group id, not an array. */
const groupCount = (r: GroupingResult) => Object.keys(r.groups).length;

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------- the shared reader

{
  const V = ["APPROVED", "ISSUES_FOUND", "CRITICAL_ISSUES_FOUND"] as const;
  const shapes: Array<[string, string]> = [
    ["VERDICT: APPROVED", "plain"],
    ["**VERDICT:** APPROVED", "bold token"],
    ["**VERDICT: APPROVED**", "bold whole marker"],
    ["verdict: approved", "lower case"],
    ["VERDICT:APPROVED", "no space"],
    ["Some prose.\n\nVERDICT: APPROVED\n", "embedded in a reply"],
    ["### VERDICT\nAPPROVED", "heading form"],
    ["## VERDICT\n\n**APPROVED**", "heading form, bold value"],
  ];
  for (const [text, name] of shapes) {
    assert(readEnumMarker(text, "VERDICT", V) === "APPROVED", `readEnumMarker: ${name}`);
  }
  // The pre-#408 adversarial regex was `/VERDICT:\s*(APPROVED|…)/` — no `i`
  // flag, no emphasis tolerance. These are the ones it silently missed.
  assert(
    !/VERDICT:\s*(APPROVED|ISSUES_FOUND)/.test("**VERDICT:** APPROVED"),
    "canary: the OLD adversarial regex does NOT match '**VERDICT:** APPROVED'",
  );
  assert(
    !/VERDICT:\s*(APPROVED|ISSUES_FOUND)/.test("verdict: approved"),
    "canary: ...nor a lower-cased one",
  );

  assert(
    readEnumMarker("no marker at all", "VERDICT", V) === undefined,
    "absence is reported as absence — the caller decides whether that is safe",
  );
  assert(
    readEnumMarker("VERDICT: MAYBE", "VERDICT", V) === undefined,
    "an out-of-set value is not coerced into one of the allowed ones",
  );
  assert(
    readMarker("ci-status: success", "ci-status", /(success|failure)/) === "success",
    "readMarker handles a hyphenated token",
  );
  assert(
    readMarker("**ci-status:** SUCCESS", "ci-status", /(success|failure)/) === "success",
    "...and the bold, upper-case shape that used to read as a CI FAILURE",
  );
  assert(
    !"**ci-status:** SUCCESS".includes("ci-status: success"),
    "canary: the OLD bare `includes()` does NOT see that reply — a green run burnt a retry",
  );
}

// ---------------------------------------- silence is not permission to build

{
  const defaulted = parsePerIssueVerdicts("the explore agent wrote prose and no marker", [800]);
  assert(
    defaulted[0]?.verdict === "NEEDS_CLARIFICATION" && defaulted[0]?.verdictSource === "default",
    "an unreadable per-issue verdict does NOT become 'build it'",
  );
  assert(
    parsePerIssueVerdicts("VERDICT: NEEDS_WORK", [800])[0]?.verdictSource === "overall",
    "...while a real overall verdict still applies, and is marked as such",
  );
  assert(
    parsePerIssueVerdicts("- #800: NEEDS_WORK — go", [800])[0]?.verdictSource === "per-issue",
    "...and a real per-issue verdict is marked as parsed (not vacuous)",
  );
}

// ------------------------------------------------ grouping: GitHub keywords

{
  // lantern #657 said "closes #650". R1 had no `closes` keyword, so the two
  // issues that were literally the same work were analysed as unrelated.
  const linked = groupIssues([650, 657], {
    650: "The container image does not build.",
    657: "Rework the container build. closes #650",
  });
  assert(
    groupCount(linked) === 1,
    "'closes #N' links two issues into one group — the lantern #657/#650 case",
  );
  assert(
    linked.notes.some((n) => /R1 link/.test(n)),
    "...via R1, and the note says so",
  );

  for (const kw of ["fixes #650", "resolves #650", "part of #650", "duplicate of #650"]) {
    assert(
      groupCount(groupIssues([650, 657], { 650: "x", 657: `Work. ${kw}` })) === 1,
      `'${kw}' links too`,
    );
  }

  // Not vacuous: unrelated issues must still separate.
  assert(
    groupCount(groupIssues([650, 657], { 650: "Fix the CSS.", 657: "Rewrite the docs." })) === 2,
    "unrelated issues still land in separate groups",
  );
  // And a bare number must not link — "#650" appearing in prose is not a claim
  // of dependency, which is why every keyword requires the `#`.
  assert(
    groupCount(
      groupIssues([650, 657], { 650: "x", 657: "See the discussion in 650 for background." }),
    ) === 2,
    "a bare number with no keyword and no # does not link",
  );
}

// ------------------------------------------- grouping: the shared file type

{
  // `.container` was not in R2's extension list, so the ONE file lantern #650
  // and #657 genuinely shared contributed nothing to their overlap score.
  const g = groupIssues([1, 2], {
    1: "Broken in lantern.container:12 and deploy.container:3",
    2: "Same root cause — lantern.container:40, deploy.container:9",
  });
  assert(groupCount(g) === 1, "'.container' files now count toward path overlap");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
