#!/usr/bin/env bun
/**
 * #2228 — the BUILDER's seat gets the issue section, at the prompt-function
 * boundary.
 *
 * `build` fetched the issue body, parsed the `pi-spec` block out of it and
 * dropped the text with the parse, so the one step that WRITES THE CODE worked
 * from `spec.problem` plus the rendered criteria. A requirement stated only in
 * prose — a fixed exception message, a non-obvious "never do X" — reached the
 * oracles (#2177) and never reached the builder, so the contract the frozen
 * tests enforce and the brief the builder reads disagreed by construction.
 *
 * The assertions are made at the PROMPT-FUNCTION boundary for one `spec` object,
 * which is the only place "equal the pre-change prompt" can mean anything. The
 * step-level half (the body threaded from the step's ONE fetch) lives in
 * `test-lean-build-issue-prose-step.ts`; this file is the render, that file is
 * the step.
 *
 * The two switches are PINED rather than trusted to the ambient environment:
 * both readers go to `process.env` at call time, so an operator shell that
 * exported either `=0` would otherwise make the ON-case assertions fail red on
 * an unrelated change. `withEnv` restores exactly what was there, an absent
 * variable included.
 *
 * B8 (the issue's binding resolution): when the body carries nothing the spec
 * does not already state — the `pi-spec` block stripped, trimmed and with its
 * whitespace runs collapsed, equal to `spec.problem` the same way — there is no
 * issue section, because the builder would be handed its own problem line back
 * and told it was the task.
 */
import { buildPrompt } from "../src/lean/build-prompt.ts";
import type { BuildPromptOpts } from "../src/lean/build-prompt.ts";
import {
  LEAN_BUILD_ISSUE_LEAD,
  LEAN_ISSUE_HEADING,
  LEAN_ISSUE_LEAD,
  leanIssueSection,
} from "../src/lean/issue-prose.ts";
import type { PiSpec } from "../src/lean/spec.ts";
import { withEnv } from "./lib/env-scope.ts";
import { CONSTRAINT, INJECT_BODY, ISSUE_BODY, OVER_BODY } from "./lib/ticket-issue-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The contract the builder is held to, same shape as the other prompt files. */
const SPEC: PiSpec = {
  problem: "The retry helper gives up on the first transient failure.",
  size: "S",
  criteria: [
    { id: "AC1", text: "a transient failure is retried", verify: "test" },
    { id: "AC2", text: "the existing suite still passes", verify: "command", command: "tests/x" },
    { id: "AC3", text: "the docs name the new flag", verify: "manual" },
  ],
};

const WT = "/tmp/lean-prompt-contract/.worktrees/lean-2228";
const RUNNER = "sh {file}";
const FROZEN = ["tests/AC1-retry.test.ts", "tests/AC2-bound.test.ts"];

const build = (issueBody?: string) =>
  buildPrompt({
    issue: 2228,
    spec: SPEC,
    frozenPaths: FROZEN,
    worktree: WT,
    attempt: 1,
    testRunner: RUNNER,
    ...(issueBody === undefined ? {} : { issueBody }),
  });

/** Every switch pinned ON — the state the acceptance criteria describe. */
const ON = {
  PI_ENSEMBLE_LEAN_ISSUE_PROSE: undefined,
  PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE: undefined,
};

await withEnv(ON, async () => {
  const prompt = build(ISSUE_BODY);

  assert(
    prompt.includes(LEAN_ISSUE_HEADING) && prompt.includes(CONSTRAINT),
    `the build brief carries the fenced issue section with the body's own requirement (${LEAN_ISSUE_HEADING}: ${prompt.includes(LEAN_ISSUE_HEADING)}, constraint: ${prompt.includes(CONSTRAINT)})`,
  );
  assert(
    prompt.includes(LEAN_BUILD_ISSUE_LEAD),
    "the builder's section carries the builder's own lead, not the oracle's",
  );
  assert(
    !prompt.includes(LEAN_ISSUE_LEAD),
    "the oracle lead's authority sentence does not appear in the builder's brief",
  );
  assert(
    prompt.indexOf("## The problem") < prompt.indexOf(LEAN_ISSUE_HEADING) &&
      prompt.indexOf(LEAN_ISSUE_HEADING) < prompt.indexOf("## The acceptance criteria"),
    "the section sits after the problem and before the criteria",
  );
  assert(prompt.includes("```text"), "the body is printed through the fence renderer, never raw");
  assert(
    !prompt.includes("pi-spec v1") && !prompt.includes('"verify": "test"'),
    "the spec block itself never appears in the issue section — the criteria are printed below it",
  );
  assert(
    !prompt.includes("undefined"),
    "no \"undefined\" reaches the brief from the issue section",
  );

  // The off arm is the pre-change render byte for byte: same spec, same options,
  // no body — that is what the builder's brief looked like before #2228 threaded
  // the body through the step (B3).
  const bare = build();
  await withEnv({ PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE: "0" }, async () => {
    const off = build(ISSUE_BODY);
    assert(
      off === bare,
      "PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE=0 renders byte-identically to a brief built with no body",
    );
    assert(
      !off.includes(LEAN_ISSUE_HEADING) && !off.includes(CONSTRAINT),
      "the off render carries no section heading at all, not an empty one",
    );
  });
  // The shared switch gates the shared renderer, so it gates this seat too (B2).
  await withEnv({ PI_ENSEMBLE_LEAN_ISSUE_PROSE: "0" }, async () => {
    const off = build(ISSUE_BODY);
    assert(
      off === bare,
      "PI_ENSEMBLE_LEAN_ISSUE_PROSE=0 also renders byte-identically — one renderer, both switches",
    );
  });
  assert(
    leanIssueSection(ISSUE_BODY, LEAN_BUILD_ISSUE_LEAD).includes(LEAN_BUILD_ISSUE_LEAD),
    "the one renderer takes the builder's lead as a parameter",
  );
  assert(
    leanIssueSection(ISSUE_BODY).startsWith(`${LEAN_ISSUE_HEADING}\n\n${LEAN_ISSUE_LEAD}\n\n`),
    "and with no lead argument the renderer still says the oracle's piece, so specify and challenge are byte-unchanged",
  );

  // An injected heading or fence stays inside the fence.
  const injected = build(INJECT_BODY);
  {
    const outside = injected
      .split("```text\n")
      .slice(1)
      .map((part) => part.split("```")[0] ?? "");
    const outsideLines = new Set(outside.flatMap((block) => block.split("\n")));
    const headingsOutside = injected
      .split("\n")
      .filter((line) => /^#{1,6} /.test(line) && !outsideLines.has(line));
    assert(
      headingsOutside.every((line) => !line.includes("INJECT")) &&
        injected.includes("INJECT") &&
        injected.includes("not a fence"),
      `the injected heading and fence are IN the brief as text and open no section outside the fence (${headingsOutside.filter((l) => l.includes("INJECT")).join(" | ") || "no heading outside the fence"})`,
    );
  }

  // The body is bounded BEFORE the fence, so an over-cap issue carries exactly
  // the body bound's marker and never the fence renderer's own clip notice.
  const over = build(OVER_BODY);
  assert(
    (over.match(/\u2026\(issue truncated\)/g) ?? []).length === 1,
    `an over-cap issue prints exactly one truncation marker (saw ${(over.match(/\u2026\(issue truncated\)/g) ?? []).length})`,
  );
  assert(
    !over.includes("[truncated at "),
    "the fence's own clip marker never appears — the body bound is the one in force",
  );
  assert(!over.includes(CONSTRAINT), "the cap really did cut — OVER_BODY's tail is gone");

  // Absent, blank or spec-only bodies render no section.
  for (const empty of [undefined, "", "   \n  ", "```pi-spec v1\n{}\n```"]) {
    const p = build(empty === undefined ? undefined : empty);
    assert(
      !p.includes(LEAN_ISSUE_HEADING) && !p.includes("undefined"),
      `a ${JSON.stringify(empty)} body renders no section (${LEAN_ISSUE_HEADING} absent)`,
    );
  }

  // B8 — a body whose prose IS the problem line adds nothing, so it says nothing.
  const restated = build([
    "```pi-spec v1",
    JSON.stringify({ ...SPEC, criteria: [{ id: "AC1", text: "x", verify: "test" }] }, null, 2),
    "```",
    "",
    `   ${SPEC.problem}   `,
  ].join("\n"));
  assert(
    restated === bare,
    "a body that only restates the problem line (whitespace collapsed) renders no section at all",
  );
  const nearMiss = build([
    "```pi-spec v1",
    JSON.stringify({ ...SPEC, criteria: [{ id: "AC1", text: "x", verify: "test" }] }, null, 2),
    "```",
    "",
    `${SPEC.problem} — and keeps its exception message.`,
  ].join("\n"));
  assert(
    nearMiss.includes(LEAN_ISSUE_HEADING),
    "and a body differing from the problem line by one clause is NOT collapsed away",
  );
});

process.exit(exit);
