#!/usr/bin/env bun
/**
 * The loop's FIX round carries the criteria section too, not just the reviewer.
 *
 * The spec split promises the review step's three seats — the six lenses, the
 * adversarial reviewer and the fixer — ONE rendering: the issue's prose with its
 * `pi-spec v1` block stripped, and the criteria as their own section. The two
 * loop-internal prompt sites (`adversarial.ts`, the reviewer and the fix round)
 * both take `params.reviewCriteria` straight through, and a spread makes an unread
 * parameter invisible: `buildFixPrompt` accepted no `reviewCriteria` field,
 * TypeScript could not reject a key arriving through a spread, and the fixer's
 * brief silently carried no criteria at all — while its own rule about the issue
 * pointed at text the brief had already had stripped out of it. The assertions
 * below run on the string the loop's fix child was ACTUALLY dispatched with.
 *
 * The loop's own fix round only runs when a round routes to a fix, so this drives
 * a non-reportOnly loop (the shape the `adversarial_loop` tool and the /work
 * driver use): round 1's reviewer blocks, the fixer replies, round 2 approves —
 * so exactly one fixer prompt is ever built.
 *
 * Two arms, one per contract the wiring has to hold:
 *   1. **supplied** — a caller that handed the loop a stripped body plus a rendered
 *      section: BOTH children get that section byte for byte, and the block's JSON
 *      appears nowhere outside it. This is the arm the defect broke.
 *   2. **absent** — a caller that handed over a raw body and NO section: neither
 *      child gets one, and both keep the raw block. The loop has no derive arm, so
 *      a caller that never rendered a section cannot be given one; that is what
 *      keeps classic /work and the tool path outside the split (and
 *      `test-adversarial-classic-criteria-not-derived.ts` is the byte-identity
 *      half of the same promise).
 *
 * Byte-identity for callers that thread nothing is
 * `test-adversarial-classic-criteria-not-derived.ts`, driven against the switch-
 * OFF render; the `adversarial_loop` tool's raw-args strip is asserted there too.
 * This file asserts only what those do not: what the loop's OWN fix-round prompt
 * carries when a section IS supplied.
 */

import { mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LEAN_REVIEW_CRITERIA_HEADING,
  renderSpecCriteriaSection,
} from "../src/lean/review-criteria.ts";
import { stripPiSpecBlocks } from "../src/lean/spec.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Every prompt a child was dispatched with, by role, in call order. */
const prompts: { role: string; prompt: string }[] = [];

mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-fix-round-criteria",
  spawnSpecialist: async (spec: { role: string; prompt: string }): Promise<DispatchResult> => {
    prompts.push({ role: spec.role, prompt: spec.prompt });
    // The FIRST reviewer blocks, which is what routes the round to a fixer; the
    // fixer replies and round 2's reviewer approves.
    const reviewersSoFar = prompts.filter((p) => p.role === "adversarial-developer").length;
    const blocked = spec.role === "adversarial-developer" && reviewersSoFar === 1;
    return {
      role: spec.role,
      ok: true,
      text: blocked
        ? "VERDICT: ISSUES_FOUND\n\n### ISSUES\n- a.ts:1 — the draw is not guarded"
        : spec.role === "adversarial-developer"
          ? "VERDICT: APPROVED"
          : "guarded the draw",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    };
  },
}));
const realDeck = await import("../src/dispatch-deck.ts");
mock.module(new URL("../src/dispatch-deck.ts", import.meta.url).href, () => ({
  ...realDeck,
  startEntry: () => {},
  updateEntry: () => {},
  clearBatchEntry: () => {},
  clearEntry: () => {},
  startBatchEntry: () => {},
  updateBatchProgress: () => {},
}));
const realRegistry = await import("../src/async-jobs-registry.ts");
mock.module(new URL("../src/async-jobs-registry.ts", import.meta.url).href, () => ({
  ...realRegistry,
  childHandles: new Map(),
  registerChildHandle: () => {},
  setOrchestratorActiveChild: () => {},
  markOrchestrator: () => {},
}));

const { runAdversarialLoop } = await import("../src/adversarial.ts");

const DIFF = "diff --git a/a.ts b/a.ts\n+export const draw = () => 1;\n";

/** A body whose block is short enough to survive every bound, so a seat handed the
 * RAW bytes prints each criterion's JSON verbatim — which is what makes "the JSON
 * appears nowhere outside the section" a fact about the strip and not about a clip. */
const SPEC_BODY = `Add a quota check to the meter.

The check runs before any state is written.

\`\`\`pi-spec v1
${JSON.stringify(
  {
    problem: "The meter must refuse the draw once the quota is spent.",
    criteria: [
      { id: "AC1", text: "The meter refuses the draw once the quota is spent.", verify: "test" },
      { id: "AC2", text: "The refusal names the quota that was exceeded.", verify: "manual" },
    ],
    size: "S",
  },
  null,
  2,
)}
\`\`\`
`;

/** The criteria section the renderer produces for that body — the bytes both
 * children must receive. Read off `renderSpecCriteriaSection` itself, never
 * hand-typed: a hand-typed copy makes every assertion below a check on this file's
 * spelling of the lead-in, and it goes RED on the correct render (observed). */
const CRITERIA = renderSpecCriteriaSection(SPEC_BODY);

/** A child's brief with the criteria section removed, so a later assertion about
 * the block's JSON is about the rest of the brief and not about the section — which
 * is itself made of criterion rows and would match every key. */
function withoutCriteria(brief: string): string {
  return brief.split(CRITERIA).join("");
}

const repoDir = mkdtempSync(path.join(os.tmpdir(), "adv-fix-round-criteria-"));

/** Drive one loop and return its reviewer and fixer prompts. */
async function drive(
  branch: string,
  extra: Record<string, unknown>,
): Promise<{ reviewers: string[]; fixers: string[]; outcome: string }> {
  prompts.length = 0;
  const result = await runAdversarialLoop(
    { diff: DIFF, context: "lean review", workCwd: repoDir, branch, ...extra } as never,
    new AbortController().signal,
    `job-${branch}`,
  );
  return {
    reviewers: prompts.filter((p) => p.role === "adversarial-developer").map((p) => p.prompt),
    fixers: prompts.filter((p) => p.role === "developer").map((p) => p.prompt),
    outcome: String(result.loopOutcome),
  };
}

/** The shape every arm owes, whatever it decides about criteria. */
function judgeCommon(arm: string, reviewer: string, fixer: string): void {
  for (const [seat, brief] of [
    ["reviewer", reviewer],
    ["fixer", fixer],
  ] as const) {
    assert(
      brief.includes("diff --git a/a.ts b/a.ts") && brief.length > 200,
      `${arm} ${seat}: the captured brief is a real prompt with the diff in it (${String(brief.length)} chars)`,
    );
  }
  assert(
    fixer.includes("1 — the draw is not guarded"),
    `${arm}: the fixer carries this round's finding`,
  );
  assert(
    fixer.includes("Do not apply a finding that contradicts a requirement"),
    `${arm}: the fixer is still told not to violate the issue`,
  );
  assert(
    reviewer.includes("judge it against THIS"),
    `${arm}: the reviewer is still told to judge against the issue`,
  );
}

function judgeWithCriteria(arm: string, seat: string, brief: string): void {
  assert(brief.includes(CRITERIA), `${arm} ${seat}: carries the criteria section byte for byte`);
  assert(
    brief.includes("- **AC1** [test]") && brief.includes("- **AC2** [manual]"),
    `${arm} ${seat}: carries each criterion as a rendered row`,
  );
  assert(
    brief.includes("quota check to the meter"),
    `${arm} ${seat}: still carries the issue's own prose`,
  );
}

// The fixture has to be a body the split has something to do with: a block that
// parses and renders rows, and prose that survives the strip with its own words
// intact. Without these the assertions below would pass on a body needing no split.
assert(
  CRITERIA.startsWith(LEAN_REVIEW_CRITERIA_HEADING) &&
    CRITERIA.includes("- **AC1** [test]") &&
    CRITERIA.includes("- **AC2** [manual]"),
  "fixture: the renderer produces the section these briefs are compared against",
);
assert(
  SPEC_BODY.includes('"problem"') &&
    !stripPiSpecBlocks(SPEC_BODY).includes("pi-spec v1") &&
    stripPiSpecBlocks(SPEC_BODY).includes("quota check to the meter"),
  "fixture: the raw body carries the block's JSON; the strip removes the block and keeps the prose",
);

try {
  // ── 1. SUPPLIED: stripped body + rendered section reach BOTH seats ─────────
  {
    const { reviewers, fixers, outcome } = await drive("feature/adv-criteria-supplied", {
      issueBody: stripPiSpecBlocks(SPEC_BODY),
      reviewCriteria: CRITERIA,
    });
    assert(
      reviewers.length === 2 && fixers.length === 1,
      `supplied: one reviewer, a fixer and a re-review (reviewer ${String(reviewers.length)}, fixer ${String(fixers.length)}, ${outcome})`,
    );
    const reviewer = reviewers[0] ?? "";
    const fixer = fixers[0] ?? "";
    judgeCommon("supplied", reviewer, fixer);
    judgeWithCriteria("supplied", "reviewer", reviewer);
    judgeWithCriteria("supplied", "fixer", fixer);
    // The block's JSON appears in neither brief outside the section: the prose the
    // loop printed had been stripped, and no second copy of the block rode along.
    for (const [seat, brief] of [
      ["reviewer", reviewer],
      ["fixer", fixer],
    ] as const) {
      const rest = withoutCriteria(brief);
      assert(
        !rest.includes('"problem"') && !rest.includes("pi-spec v1"),
        `supplied ${seat}: no raw spec JSON outside the criteria section`,
      );
    }
    // The re-review carries it too: a fix round that lost the section would let
    // round 2 grade the fix against nothing but the prose.
    judgeWithCriteria("supplied re-review", "reviewer", reviewers[1] ?? "");
  }

  // ── 2. ABSENT: no section supplied → neither seat gets one, block stays raw ──
  // The loop renders nothing of its own. A caller that handed it a raw body and no
  // section must see that body printed as-is, with no criteria section added: this
  // is classic /work and the tool path, and the arm that fails the moment anyone
  // puts a derive back into the loop's criteria wiring.
  {
    const { reviewers, fixers, outcome } = await drive("feature/adv-criteria-absent", {
      issueBody: SPEC_BODY,
    });
    assert(
      reviewers.length === 2 && fixers.length === 1,
      `absent: one reviewer, a fixer and a re-review (reviewer ${String(reviewers.length)}, fixer ${String(fixers.length)}, ${outcome})`,
    );
    const reviewer = reviewers[0] ?? "";
    const fixer = fixers[0] ?? "";
    judgeCommon("absent", reviewer, fixer);
    for (const [seat, brief] of [
      ["reviewer", reviewer],
      ["fixer", fixer],
    ] as const) {
      assert(
        !brief.includes(LEAN_REVIEW_CRITERIA_HEADING),
        `absent: the ${seat} gets no criteria section the caller did not supply`,
      );
      assert(
        brief.includes('"problem"') && brief.includes("pi-spec v1"),
        `absent: and the ${seat} still reads the raw block — so the absence above is the loop printing no section, not a bound that cut it`,
      );
    }
    // Non-vacuity against arm 1: same body, same loop, the only difference is the
    // key. An implementation that rendered a section from the body regardless would
    // pass arm 1 and fail here.
    assert(
      CRITERIA.length > 0 && !reviewer.includes(CRITERIA) && !fixer.includes(CRITERIA),
      "absent: the section arm 1 supplied is exactly what these two briefs do NOT contain",
    );
  }
} finally {
  rmSync(repoDir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
