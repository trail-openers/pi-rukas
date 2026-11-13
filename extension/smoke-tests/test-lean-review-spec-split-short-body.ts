#!/usr/bin/env bun
/**
 * The adversarial seat is a review seat too, on a body that reaches NO bound.
 *
 * Binding S2 says the lean seat hands the loop the stripped prose as `issueBody`
 * and the rendered criteria as their own field. The long-statement case in
 * `test-lean-review-spec-split-on.ts` cannot tell whether that hold: over the cap
 * the block is cut before its tail criteria arrive, so a seat that was handed the
 * RAW body there still prints no tail JSON — its absence is a fact about the bound,
 * not about the strip. `SHORT_SPEC_BODY` is under the cap, so nothing is cut and
 * every criterion's JSON sits verbatim in the block: if the seat reads the raw
 * body, the block's JSON is in its prompt, and if it reads the stripped prose the
 * JSON appears nowhere outside the criteria section. One fact, one body.
 *
 * All three seats are asserted on the same body — the reviewer's prompt, the
 * step's fixer's brief and every lens context — because the split promised the
 * review step's seats one rendering, and only the reviewer's is assembled below
 * the seam that sets it.
 *
 * Lives apart from the ON-arm file because both drive a real temp repo and a
 * mocked spawn, and the two cases must not share one module's spawn mock.
 */

import {
  LEAN_REVIEW_CRITERIA_HEADING,
  renderSpecCriteriaSection,
} from "../src/lean/review-criteria.ts";
import { fixPrompt, lensContext } from "../src/lean/review-deps.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { runReviewStepCapturingAll } from "./lib/lean-review-adversarial-capture.ts";
import { SHORT_CRITERION_IDS, SHORT_SPEC_BODY } from "./lib/lean-review-spec-fixture.ts";
import { rawBlockPayload } from "./lib/lean-review-spec-split-golden.ts";

const { assert, failures } = makeAssert();

/** A criterion id the child can only have read from the criteria section: the
 * renderer's own bullet shape, id and verify kind together. */
function criterionLine(id: string): RegExp {
  return new RegExp(`\\*\\*${id}\\*\\* \\[(test|command|manual)\\]`);
}

/** What a brief must carry, and carry in ONE place. The block's JSON — the info
 * string and the payload keys `rawBlockPayload` reads off the raw render itself —
 * must be absent EVERYWHERE but the criteria section, and the section must be
 * BYTE-IDENTICAL to the pure renderer's. Together those say the seat saw one issue
 * block and one criteria list: stripped prose in its issue block, the block's JSON
 * nowhere but the section, and the section carrying no stray copy of anything.
 * "no JSON anywhere" alone would go red on the CORRECT render too — the section is
 * itself made of criterion rows — so the assertion is about the LOCATION. */
function judge(seat: string, brief: string, payload: string[], goldenCriteria: string): void {
  // The section's own span: from its heading to the end of what the split printed
  // for this body, taken as the render of THAT body so the bounds are not hand-typed.
  const at = brief.indexOf(LEAN_REVIEW_CRITERIA_HEADING);
  const section = at === -1 ? "" : brief.slice(at, at + goldenCriteria.length);
  const outside = at === -1 ? brief : brief.replace(section, "");
  const leaked = payload.filter((needle) => outside.includes(needle));
  assert(
    !outside.includes("pi-spec v1") && leaked.length === 0,
    `${seat}: no spec block outside the criteria section — the info string and ${JSON.stringify(payload)} are the raw body speaking${leaked.length === 0 ? "" : ` (leaked: ${JSON.stringify(leaked)})`}`,
  );
  assert(
    section !== "" && section === goldenCriteria,
    `${seat}: prints the pure renderer's criteria section, byte for byte`,
  );
  for (const id of SHORT_CRITERION_IDS) {
    assert(
      criterionLine(id).test(section),
      `${seat}: carries ${id} as a rendered criterion row, inside the section`,
    );
  }
}

/** A fixer's args with nothing variable in them but the body. */
function fixerArgs(issueBody: string): Record<string, unknown> {
  return {
    issue: 7,
    wave: "full",
    gate: "six-lens review (ISSUES_FOUND)",
    findings: "- [HIGH] SECURITY a.ts:1: reword the exception",
    worktree: "/repo/.worktrees/lean-7-fix-l-1-0-1793451347919",
    repoRoot: "/repo",
    branch: "lean/issue-7",
    base: "deadbeef",
    head: "cafebabe",
    frozenPaths: ["tests/AC1.test.ts"],
    budget: { opts: {}, fired: () => undefined },
    stop: {},
    issueBody,
  };
}

await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: undefined }, async () => {
  const payload = rawBlockPayload(SHORT_SPEC_BODY);
  const goldenCriteria = renderSpecCriteriaSection(SHORT_SPEC_BODY);
  // Non-vacuity, first: a seat that strips nothing MUST print the block's JSON
  // here, and the section everything is compared against must be a real list. If
  // either fails the assertions below are vacuous — they would pass on a body
  // whose block was never printable, or on a seat that printed no criteria.
  assert(
    payload.length >= 3 && SHORT_SPEC_BODY.length < 6000,
    `fixture: the short body reaches no bound and its raw render carries ${String(payload.length)} block keys to look for (${String(SHORT_SPEC_BODY.length)} chars)`,
  );
  assert(
    goldenCriteria.startsWith(LEAN_REVIEW_CRITERIA_HEADING) &&
      criterionLine(SHORT_CRITERION_IDS[0] ?? "").test(goldenCriteria) &&
      SHORT_SPEC_BODY.includes('"criteria"'),
    "fixture: the criteria section is a rendered list, and the raw body really carries the block's JSON",
  );

  // ── the reviewer, the step's fixer and every lens, as they were DISPATCHED ──
  const captured = await runReviewStepCapturingAll(SHORT_SPEC_BODY);
  assert(
    captured.adversarialBriefs.length >= 1 &&
      captured.fixBriefs.length === 1 &&
      captured.contexts.length >= 1,
    `the step dispatched a reviewer, a fixer and a lens pass (reviewer ${String(captured.adversarialBriefs.length)}, fixer ${String(captured.fixBriefs.length)}, lenses ${String(captured.contexts.length)}, verdict ${captured.verdict})`,
  );
  captured.adversarialBriefs.forEach((brief, i) =>
    judge(`adversarial brief ${String(i)}`, brief, payload, goldenCriteria),
  );
  captured.fixBriefs.forEach((brief, i) =>
    judge(`step fixer ${String(i)}`, brief, payload, goldenCriteria),
  );
  captured.contexts.forEach((brief, i) =>
    judge(`lens context ${String(i)}`, brief, payload, goldenCriteria),
  );

  // ── the two pure print sites, on the same bytes ────────────────────────────
  judge(
    "lensContext",
    lensContext(7, "full", { issueBody: SHORT_SPEC_BODY }),
    payload,
    goldenCriteria,
  );
  judge("fixPrompt", fixPrompt(fixerArgs(SHORT_SPEC_BODY) as never), payload, goldenCriteria);
});

console.log(
  `\n${failures() === 0 ? "short-body seats green" : "short-body seats RED"} (${String(failures())} failing)`,
);
process.exit(failures());
