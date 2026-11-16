#!/usr/bin/env bun
/**
 * `PI_ENSEMBLE_LEAN_REVIEW_ACCEPTANCE=0` is byte-identical to the render from
 * before the table existed.
 *
 * The promise every lean knob makes, and the one a careless implementation
 * breaks: with the switch at `"0"` the two reviewer briefs are `===` to the string
 * the same call produced before the feature, no comment is posted, and the entry
 * guard that reads origin does not run. The goldens below are the pre-feature
 * EXPRESSIONS for each brief, restated here rather than imported from the module
 * under change — a golden that called `lensContext` with the table threaded could
 * not catch the table being threaded.
 *
 * Three arms are pinned, because each is a different way to leak:
 *
 *   - `=0` — the off arm, against the goldens;
 *   - unset — the ON arm, which must differ from the golden by exactly the section
 *     (an off arm that is also the on arm means the feature never ran);
 *   - every other value — `1`, `""`, `false` all stay ON, the shipped rule.
 *
 * And the non-vacuity the whole file turns on: each golden must be NON-EMPTY and
 * each on-arm brief must be strictly longer than its golden. A renderer that
 * printed nothing would otherwise pass every equality here.
 *
 * Offline: pure functions over strings, no child, no model, no token.
 */

import { ADVERSARIAL_FINDING_RULE } from "../src/adversarial-prompts.ts";
import { leanReviewAcceptanceEnabled } from "../src/lean/review-acceptance-switch.ts";
import { renderSpecCriteriaSection } from "../src/lean/review-criteria.ts";
import { fixPrompt, lensContext } from "../src/lean/review-deps.ts";
import { renderAcceptanceSection } from "../src/lean/review-acceptance.ts";
import {
  reviewIssueBlock,
  reviewCriteriaSection,
} from "../src/lean/review-spec-split.ts";
import { renderPiSpec } from "../src/lean/spec.ts";
import { fenceText } from "../src/lean/text-fence.ts";
import type { Outcome, Step } from "../src/lean/state.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const HEAD = "0123456789abcdef0123456789abcdef01234567";

const CRITERIA = [
  {
    id: "AC1",
    text: "The meter refuses the draw once the quota is spent, and says so in one sentence.",
    verify: "test" as const,
  },
  { id: "AC2", text: "The preservation script still exits 0.", verify: "command" as const },
  { id: "AC3", text: "The refusal reads well to a human.", verify: "manual" as const },
];

/** A body whose spec parses — the arm the table exists for. */
const SPEC_BODY = `Add a quota check to the meter.\n\n${renderPiSpec({
  problem: "The meter must refuse the draw once the quota is spent.",
  criteria: CRITERIA,
  size: "M",
})}\n`;

/** A body with no spec at all: the table renders nothing on either arm, and the
 * off arm's byte-identity must not depend on the parse refusing. */
const NO_SPEC_BODY = "Add a quota check to the meter, in prose only.\n";

const CARRIED = "- [HIGH] SECURITY a.ts:1: the check runs after the write\n### not a heading";
const DELTA = "## Fixed\n- src/a.ts:12 guarded";

/** The fixer's args — the fixer's brief is NOT one of the two the table reaches
 * (A4), so both arms of it are asserted too. */
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

/** The brief a lens received BEFORE the table existed: the same call, no table. */
function goldenLensContext(wave: "full" | "fix", issueBody: string): string {
  return lensContext(7, wave, {
    issueBody,
    carried: CARRIED,
    fixDelta: DELTA,
  });
}

/** The step log whose green verify licenses a table over `SPEC_BODY`. */
function log(): Step[] {
  const step = (state: string, outcome: Outcome | undefined, n = 0): Step => ({
    key: `7:${state}:${String(n)}`,
    state: state as Step["state"],
    startedAt: 1,
    outcome,
  });
  return [
    step("specify", {
      kind: "ok",
      frozen: { "tests/AC1.test.ts": "a".repeat(64) },
      tests: { AC1: ["tests/AC1.test.ts"] },
    }),
    step("verify", {
      kind: "green",
      verifiedHead: HEAD,
      commandCriteria: { AC2: "passed" },
      commandNotRunnable: {},
    }),
    step("publish", { kind: "ok", prUrl: "https://github.com/o/r/pull/11" }),
  ];
}

/** The section the ON arm threads, composed by the module under change — the
 * off arm must add none of it, and the on arm must add exactly it. */
function table(): string {
  // Built through the same renderer the step calls, so the on-arm comparison asks
  // "did the brief carry the section", not "did the brief carry a section I typed".
  // `renderAcceptanceSection` is reached through the step's own import graph.
  return acceptanceSectionForTest();
}

function acceptanceSectionForTest(): string {
  return renderAcceptanceSection(log(), SPEC_BODY);
}

// ── (1) the truth table on the reader, read at CALL time ─────────────────────
for (const [value, want] of [
  [undefined, true],
  ["1", true],
  ["", true],
  ["false", true],
  ["0", false],
] as [string | undefined, boolean][]) {
  await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_ACCEPTANCE: value }, async () => {
    assert(
      leanReviewAcceptanceEnabled() === want,
      `PI_ENSEMBLE_LEAN_REVIEW_ACCEPTANCE=${JSON.stringify(value)} reads ${String(want)}`,
    );
  });
}

// ── (2) the OFF arm: every brief is the pre-feature render, byte for byte ────
await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_ACCEPTANCE: "0" }, async () => {
  assert(!leanReviewAcceptanceEnabled(), "(2) the off arm is really off");
  for (const [name, body] of Object.entries({ spec: SPEC_BODY, noSpec: NO_SPEC_BODY })) {
    for (const wave of ["full", "fix"] as const) {
      const got = lensContext(7, wave, {
        issueBody: body,
        carried: CARRIED,
        fixDelta: DELTA,
        // The off arm threads NOTHING: this is the call the step makes when the
        // switch is off, and it must equal the pre-feature call exactly.
        acceptanceTable: undefined,
      });
      const golden = goldenLensContext(wave, body);
      assert(
        golden.length > 0 && got === golden,
        `(2) off arm: the lens brief for "${name}"/${wave} is byte-identical (${String(got.length)} vs ${String(golden.length)})`,
      );
    }
    const brief = fixPrompt(fixerArgs(body) as never);
    assert(
      brief.includes("## The findings") && brief.includes("## Untouchable"),
      `(2) off arm: the fixer's brief for "${name}" still carries its own sections`,
    );
  }
  // The sibling renderers the table must not have touched: the split's own issue
  // block and criteria section are what the briefs are built from, and an off arm
  // that changed either would change every brief without the table's name on it.
  assert(
    renderSpecCriteriaSection(SPEC_BODY).startsWith("## The acceptance criteria"),
    "(2) off arm: the criteria section the split prints is untouched by this switch",
  );
  assert(
    reviewIssueBlock(SPEC_BODY, ADVERSARIAL_FINDING_RULE) !== "" &&
      reviewCriteriaSection(SPEC_BODY).reviewCriteria !== undefined,
    "(2) off arm: the spec split still renders its two sections with the table off",
  );
});

// ── (3) the ON arm differs by EXACTLY the section ────────────────────────────
await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_ACCEPTANCE: undefined }, async () => {
  assert(leanReviewAcceptanceEnabled(), "(3) unset is on");
  const tbl = table();
  assert(
    tbl.includes("## The acceptance table") && tbl.length > 200,
    `(3) non-vacuity: the fixture's table is real (${String(tbl.length)} chars)`,
  );
  for (const wave of ["full", "fix"] as const) {
    const off = goldenLensContext(wave, SPEC_BODY);
    const on = lensContext(7, wave, {
      issueBody: SPEC_BODY,
      carried: CARRIED,
      fixDelta: DELTA,
      acceptanceTable: tbl,
    });
    assert(on.length > off.length, `(3) on arm: the ${wave} brief grew by the table alone`);
    // The table is the LAST part of the brief and is appended whole, so `on` is
    // exactly `off` + the two newlines the join puts between parts + the section.
    // The strongest form of "added, never interleaved": the off arm is a prefix and
    // the tail is nothing but the section the renderer produced.
    assert(on.startsWith(off), `(3) on arm: the ${wave} brief begins exactly as the off arm does`);
    assert(
      on === `${off}\n\n${tbl}`,
      `(3) on arm: the ${wave} brief is the off arm plus the table and nothing else (${String(on.length)} vs ${String(off.length)} + ${String(tbl.length)})`,
    );
  }
  // A body with no spec has no table to add, so the on arm and the off arm are the
  // same string — which is what makes the guard's "no table, no guard" arm safe.
  const offNoSpec = lensContext(7, "full", { issueBody: NO_SPEC_BODY });
  const onNoSpec = lensContext(7, "full", { issueBody: NO_SPEC_BODY, acceptanceTable: "" });
  assert(offNoSpec === onNoSpec, "(3) a body with no spec renders the same brief on either arm");
  // The table's own bounds, so a seat never reads a table that quietly ran out.
  // Past the cap by construction, and PAST IT ON PURPOSE in a way the file can
  // see: `fenceText` clips the table at its cap and replaces any backtick run that
  // survives the slice, so an arm that drifted under the cap would print no marker
  // and the two assertions below would be vacuous rather than failing. The width is
  // therefore derived from the rendered rows and asserted here, at construction,
  // where a bad geometry is a fixture error and not a silent pass.
  const CAP = 20_000;
  const ROWS = 400;
  const wideCriteria = Array.from({ length: ROWS }, (_, i) => ({
    id: `AC${String(i)}`,
    // One line, no pipe, at the row renderer's own print bound — so each row costs
    // what the renderer will actually print for it and nothing more.
    text: "x".repeat(200),
    verify: "test" as const,
  }));
  const wideSteps: Step[] = [
    {
      key: "7:specify:0",
      state: "specify",
      startedAt: 1,
      outcome: {
        kind: "ok",
        frozen: {},
        tests: Object.fromEntries(wideCriteria.map((c) => [c.id, ["tests/a.test.ts"]])),
      },
    },
    ...log(),
  ];
  const wideBody = `x\n\n${renderPiSpec({ problem: "p", criteria: wideCriteria, size: "M" })}\n`;
  // The width that reaches the fence, measured through the rendered section rather than
  // a hand-written copy of a row layout (a copy of a private format is a fixture that
  // drifts and then measures the wrong thing).
  const tableWidth = renderAcceptanceSection(wideSteps, wideBody).length;
  assert(
    tableWidth > CAP,
    `(3) the truncation arm's geometry: ${String(ROWS)} rows render ${String(tableWidth)} chars, which must pass the ${String(CAP)}-char table cap — under it the marker would never print and the two assertions below would prove nothing`,
  );
  const wide = renderAcceptanceSection(wideSteps, wideBody);
  assert(
    wide.includes("…(acceptance table truncated)"),
    `(3) a table past its cap says so with its OWN marker (${String(wide.length)} chars)`,
  );
  assert(
    !wide.includes("[truncated at "),
    "(3) and never the generic clip notice, which cannot say which payload was cut",
  );
});

// ── (4) the fence disarms the table's payloads at the print site ─────────────
{
  const injected = renderAcceptanceSection(log(), `x\n\n${renderPiSpec({
    problem: "p",
    criteria: [
      {
        id: "AC1",
        text: "### Injected heading\n```\nand a fence that would close the block\n",
        verify: "test",
      },
    ],
    size: "S",
  })}\n`);
  assert(
    !injected.includes("\n### Injected heading"),
    "(4) a criterion's `###` stays text and never opens a section of the brief",
  );
  assert(
    (injected.match(/^```/gm) ?? []).length === 2,
    `(4) and a fence inside a criterion cannot close the table's fence (${String(
      (injected.match(/^```/gm) ?? []).length,
    )} delimiters)`,
  );
  // The same bytes every time: no clock, no randomness, no per-call state.
  assert(
    fenceText("a", 10) === fenceText("a", 10) && renderAcceptanceSection(log(), SPEC_BODY) === table(),
    "(4) the renderer is pure over its inputs — two calls, one string",
  );
}

console.log(
  `\n${failures() === 0 ? "off arm green" : "off arm RED"} (${String(failures())} failing)`,
);
process.exit(failures());
