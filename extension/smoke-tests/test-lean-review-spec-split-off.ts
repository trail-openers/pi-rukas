#!/usr/bin/env bun
/**
 * The split's OFF arm is today's render, byte for byte.
 *
 * `PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT=0` promises that every lean review brief —
 * the six lenses' context, the fixer's brief and the adversarial reviewer's
 * prompt — is `===` to the string the same call produced before the split
 * existed. The goldens are the pre-change expressions from
 * `lib/lean-review-spec-split-golden.ts`, taken over the fixture bodies in
 * `lib/lean-review-spec-fixture.ts`; this file is the only place the comparison
 * happens, and it prints each render's length and marker count so an empty
 * golden cannot pass.
 *
 * The off arm is the one a careless implementation breaks: a split that gates the
 * RENDER but not the PARSE leaves the off arm paying a strip it never asked for,
 * and a split that gates the whole block instead of the body loses the lead-in.
 * Both are caught by `===` here and by nothing else.
 *
 * Every case runs under `withEnv`: the reader is read at call time, so a pin that
 * leaked from another file (or an operator's exported `=0`) would otherwise make
 * these assertions measure the wrong arm.
 */

import { fixPrompt, lensContext } from "../src/lean/review-deps.ts";
import { buildAdversarialPrompt, MAX_ISSUE_CHARS } from "../src/adversarial-prompts.ts";
import { renderSpecCriteriaSection } from "../src/lean/review-criteria.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  CRITERIA_BEARING_BODIES,
  FIXER_DECLINE_LEAD_IN,
  goldenAdversarialIssueBlock,
  goldenFixIssueSection,
  goldenLensContext,
  GOLDEN_BODIES,
} from "./lib/lean-review-spec-split-golden.ts";
import {
  CLASSIC_SPEC_BODY,
  OVER_STATEMENT_BODY,
  SPEC_BODY,
  SPEC_CRITERION_IDS,
} from "./lib/lean-review-spec-fixture.ts";

const { assert, failures } = makeAssert();

/** A fixer's args with nothing variable in them but the body. */
function fixerArgs(issueBody: string | undefined): Record<string, unknown> {
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

/** The part of the fixer's brief the split governs: from the prompt's first
 * newline to the findings heading — the issue block and the decline section that
 * follows it. */
function fixIssueSection(brief: string): string {
  return brief.slice(brief.indexOf("\n"), brief.indexOf("\n## The findings"));
}

/** The reviewer's issue block, read out of its prompt the way the prompt prints
 * it: everything between the role line and the verdict menu. */
function adversarialIssueSection(prompt: string): string {
  const start = prompt.indexOf("\n\nWhat this change was asked to do");
  const end = prompt.indexOf("\n\nDiff:");
  return start === -1 ? "" : prompt.slice(start, end);
}

// ── classic /work is outside the switch ──────────────────────────────────────
// The loop's prompt builder is shared with the /work driver and the
// `adversarial_loop` tool, neither of which renders a criteria section. An absent
// field and an empty one must both produce the pre-split prompt, byte for byte —
// otherwise the split reached a prompt its own caller never asked to change.
{
  const plain = buildAdversarialPrompt({
    diff: "d",
    context: "c",
    round: 1,
    maxRounds: 3,
    issueBody: CLASSIC_SPEC_BODY,
  });
  const empty = buildAdversarialPrompt({
    diff: "d",
    context: "c",
    round: 1,
    maxRounds: 3,
    issueBody: CLASSIC_SPEC_BODY,
    reviewCriteria: "",
  });
  // The block's fence delimiters are neutralised by the disarm (`fenceText` swaps a
  // 3+ backtick run for same-width look-alikes), so the raw block is asserted by
  // what is INSIDE it: the info string and the criteria's JSON form, and the
  // ABSENCE of the rendered bullet the split would have printed.
  assert(
    plain === empty && plain.includes("pi-spec v1") && plain.includes('"AC8"'),
    "classic /work: an absent and an empty criteria field render the same prompt, and it still carries the raw spec block",
  );
  assert(
    !plain.includes("**AC8**") && !plain.includes("The acceptance criteria (pi-spec v1)"),
    "classic /work: its reviewer reads no rendered criteria and no criteria section",
  );
}

await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: "0" }, async () => {
  for (const [name, body] of Object.entries(GOLDEN_BODIES)) {
    const lens = lensContext(7, "full", { issueBody: body });
    const lensGolden = goldenLensContext(body);
    assert(
      lensGolden.length > 0 && lens === lensGolden,
      `off arm: the lens brief for "${name}" is byte-identical to the pre-split render (${String(lens.length)} chars vs ${String(lensGolden.length)})`,
    );

    const brief = fixPrompt(fixerArgs(body) as never);
    const fixGolden = goldenFixIssueSection(body);
    assert(
      fixGolden.length > 0 && fixIssueSection(brief) === fixGolden,
      `off arm: the fixer brief's issue section for "${name}" is byte-identical (${String(fixIssueSection(brief).length)} chars vs ${String(fixGolden.length)})`,
    );

    const reviewer = buildAdversarialPrompt({
      diff: "diff --git a/a.ts b/a.ts\n+x",
      context: "lean review",
      round: 1,
      maxRounds: 3,
      issueBody: body,
    });
    const advGolden = goldenAdversarialIssueBlock(body);
    assert(
      adversarialIssueSection(reviewer) === advGolden,
      `off arm: the adversarial reviewer's issue block for "${name}" is byte-identical (${String(adversarialIssueSection(reviewer).length)} chars vs ${String(advGolden.length)})`,
    );

    // The no-block bodies carry no spec at all, so there is no cut to compare —
    // and an unterminated fence is kept verbatim by the strip, so its off-arm
    // render is the raw body either way. Those arms are the ON arm's business.
    // Only the bodies whose statement alone passes the cap put the block and the
    // prose in competition; a body over the cap merely because of a long block
    // (`mediumSpec`) is the ON arm's case, where the strip is the whole point.
    if (!CRITERIA_BEARING_BODIES.includes(name as never)) continue;
    if (body !== OVER_STATEMENT_BODY) continue;
    // Non-vacuity, from the side the split cannot help: with the switch off the
    // seat gets the RAW body under one bound, so the block's opening fence line
    // is present only when the cut left it in — and the tail criteria are present
    // only when the cut left THEM in. Both facts are what `=0` exists to preserve,
    // and both are what the ON arm is asserted to change.
    const offCut = body.trim().slice(0, MAX_ISSUE_CHARS);
    assert(
      offCut.includes("pi-spec v1") === lens.includes("```pi-spec v1"),
      `off arm: "${name}" shows the raw block iff the bound left its fence line in — no strip is performed`,
    );
    assert(
      offCut.includes('"AC6"') === lens.includes("**AC6**"),
      `off arm: "${name}"'s tail criteria reach the child only inside the bounded block, never as a rendered row`,
    );
    assert(
      SPEC_CRITERION_IDS.some((id) => !offCut.includes(`"${id}"`)),
      `off arm: "${name}" is long enough that the bound DOES cut tail criteria — the defect the switch is off to preserve`,
    );
    assert(
      renderSpecCriteriaSection(body).length > 0,
      `off arm: the split renderer WOULD have produced a criteria section for "${name}" — the off arm simply never calls it`,
    );
    const markers = (lens.match(/…\(issue truncated\)/g) ?? []).length;
    assert(
      markers === 1 && !/\[truncated at /.test(lens),
      `off arm: "${name}" carries exactly one truncation marker in the lens brief (saw ${String(markers)}) — the single bound, on body and block together`,
    );
  }
});

console.log(`\n${failures() === 0 ? "off arm green" : "off arm RED"} (${String(failures())} failing)`);
process.exit(failures());
