#!/usr/bin/env bun
/**
 * The executed acceptance table's CONTENTS, read from a fixture step log.
 *
 * The table is the feature's whole claim — criterion id, criterion text, frozen
 * test paths, and the result the gate reported at the head — so this file drives
 * the renderer over a log a run could actually have written and asserts each cell.
 * The three verdict shapes are the reason the renderer exists and each is pinned
 * separately:
 *
 *   - a `test` criterion reads `pass at <verifiedHead12>`, naming the commit the
 *     gate ran it at;
 *   - a `command` criterion reads the gate's OWN per-criterion record — `pass
 *     (command)` for one it executed and `could-not-run (command): <reason>` for
 *     one it declined — and NEVER the gate's overall verdict, which is about the
 *     frozen tier and not about that file;
 *   - a `manual` criterion says `manual — needs a human`.
 *
 * Plus the two refusals a seat must never have to guess through: a `test`
 * criterion with no frozen test in the log says so rather than reading as a pass,
 * and a run with no decided green `verify` says the head is unnamed rather than
 * leaving the cells unanchored.
 *
 * Each assertion is observed RED on the mutant named beside it: the row count
 * follows the spec's own criteria, the head is clipped to the 12 the reason lines
 * print, and a cell that borrowed the run-level verdict would make the declined
 * `command` row and the uncovered `test` row indistinguishable from a pass.
 *
 * Offline: pure functions over a fixture log, no child, no model, no token.
 */

import {
  LEAN_REVIEW_ACCEPTANCE_HEADING,
  LEAN_REVIEW_ACCEPTANCE_LEAD,
  NO_GREEN_VERIFY_CELL,
  acceptanceRows,
  renderAcceptanceSection,
} from "../src/lean/review-acceptance.ts";
import { renderPiSpec } from "../src/lean/spec.ts";
import type { Outcome, Step } from "../src/lean/state.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/** A full lowercase oid, in the shape `state.ts` insists on for a head. */
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "ffffffffffffffffffffffffffffffffffffffff";

/** One decided step of the log. */
function step(state: string, outcome: Outcome | undefined, n = 0): Step {
  return { key: `7:${state}:${String(n)}`, state: state as Step["state"], startedAt: 1, outcome };
}

/** The green `verify` the run's `publish` must have stood on. */
function greenVerify(over: Partial<NonNullable<Outcome>> = {}): Outcome {
  return { kind: "green", verifiedHead: HEAD, ...over };
}

/** The log a review step reads: specify froze one file per criterion, verify came
 * back green at `HEAD`, publish opened the PR. `specify`'s kind is `ok` because
 * `testsFromLog` reads the map off a decided `specify:ok` / `challenge:new-tests`
 * and nothing else — a fixture whose kind was anything else would be a log in
 * which nothing was ever frozen, and every `test` cell would then read
 * `could-not-run` for want of a file the fixture forgot to record. */
function log(verify: Outcome | undefined, frozen: Record<string, string[]> = {}): Step[] {
  return [
    step("specify", { kind: "ok", frozen: {}, tests: frozen }),
    step("build", { kind: "ok" }),
    verify === undefined ? step("verify", undefined) : step("verify", verify),
    step("publish", { kind: "ok", prUrl: "https://github.com/o/r/pull/11" }),
  ];
}

/** The issue body, rendered by the spec's own writer so the parse under test is
 * the one `publish`'s body uses too. */
function body(
  criteria: { id: string; text: string; verify: "test" | "command" | "manual" }[],
): string {
  return `Add the quota check.\n\n${renderPiSpec({
    problem: "The meter must refuse the draw once the quota is spent.",
    criteria,
    size: "M",
  })}\n`;
}

// ── (1) the three verdict shapes, in one table ───────────────────────────────
{
  const criteria = [
    { id: "AC1", text: "The meter refuses the draw.", verify: "test" as const },
    {
      id: "AC2",
      text: "The preservation script still exits 0.",
      verify: "command" as const,
      command: "tests/preserve.ts",
    },
    { id: "AC3", text: "The wording reads well to a human.", verify: "manual" as const },
  ];
  const steps = log(
    greenVerify({
      commandCriteria: { AC2: "passed" },
      commandNotRunnable: {},
    }),
    { AC1: ["tests/AC1.test.ts"] },
  );
  const rows = acceptanceRows(steps, { criteria });
  assert(rows.length === 3, `(1) one row per criterion the spec carries (${String(rows.length)})`);
  assert(
    rows[0]?.result === `pass at ${HEAD.slice(0, 12)}`,
    `(1a) a test criterion reads pass AT the certified head, not merely "green" (${JSON.stringify(rows[0]?.result)}) — the mutant: a cell that printed the gate's verdict would name no commit`,
  );
  assert(
    rows[0]?.tests.join() === "tests/AC1.test.ts",
    `(1b) the frozen test the log records for that criterion is printed (${JSON.stringify(rows[0]?.tests)})`,
  );
  assert(
    rows[1]?.result === `pass (command) at ${HEAD.slice(0, 12)}`,
    `(1c) a command criterion reads the gate's own per-criterion record (${JSON.stringify(rows[1]?.result)})`,
  );
  assert(
    rows[2]?.result === "manual — needs a human",
    `(1d) a manual criterion says it needs a human (${JSON.stringify(rows[2]?.result)})`,
  );
  assert(
    rows[0]?.text === "The meter refuses the draw.",
    `(1e) the criterion's own text is the spec's, verbatim (${JSON.stringify(rows[0]?.text)})`,
  );

  const section = renderAcceptanceSection(steps, body(criteria));
  assert(
    section.startsWith(LEAN_REVIEW_ACCEPTANCE_HEADING),
    "(2) the section opens with its own heading, in a seat's brief and in the comment alike",
  );
  assert(section.includes(LEAN_REVIEW_ACCEPTANCE_LEAD), "(2) and the lead says what the table is");
  for (const needle of [
    "AC1",
    "AC2",
    "AC3",
    "tests/AC1.test.ts",
    "manual — needs a human",
    `pass at ${HEAD.slice(0, 12)}`,
    `pass (command) at ${HEAD.slice(0, 12)}`,
  ])
    assert(
      section.includes(needle),
      `(2) the rendered section carries ${JSON.stringify(needle)} — a seat that cannot see it cannot judge against it`,
    );
  assert(
    section.includes("```text") && section.trimEnd().endsWith("```"),
    "(2) the table rides behind the fence that disarms it, so a heading inside a criterion stays text",
  );
  assert(
    section.includes(`Verified head: \`${HEAD.slice(0, 12)}\``),
    "(2) and every `pass at …` cell is anchored to the head the gate named",
  );
}

// ── (3) the two refusals a seat must not have to guess through ───────────────
{
  const criteria = [
    { id: "AC1", text: "The meter refuses the draw.", verify: "test" as const },
    { id: "AC2", text: "The preservation script holds.", verify: "command" as const },
  ];
  // A declined command criterion, and a test criterion the log records no frozen
  // file for (the shape `specify` refuses with `uncovered`, so it should be
  // unreachable — and stated rather than assumed for exactly that reason).
  const rows = acceptanceRows(
    log(greenVerify({ commandNotRunnable: { AC2: "the file is absent at base" } })),
    { criteria },
  );
  assert(
    rows[0]?.result === "could-not-run — the step log records no frozen test for this criterion",
    `(3a) a test criterion with no frozen test is NOT a pass (${JSON.stringify(rows[0]?.result)}) — the mutant: ` +
      "`tests[c.id] ?? []` read as a pass and every uncovered criterion disappeared into the green`",
  );
  assert(
    rows[1]?.result === "could-not-run (command): the file is absent at base",
    `(3b) a declined command criterion carries the gate's own reason (${JSON.stringify(rows[1]?.result)}) — the mutant: printing the run-level verdict here would read "pass" for a file nobody ran`,
  );
}

// ── (4) no green verify: the table says so rather than speaking unanchored ───
{
  const criteria = [
    { id: "AC1", text: "The meter refuses.", verify: "test" as const },
    { id: "AC2", text: "The script still exits 0.", verify: "command" as const },
    { id: "AC3", text: "The wording reads well.", verify: "manual" as const },
  ];
  // No decided `verify` at all: the log's undecided tail is the engine's replay
  // marker, so it says nothing, and there is no head for a cell to name — and a
  // `pass` that names no head is exactly the claim A1 refuses to license.
  const rows = acceptanceRows(log(undefined, { AC1: ["tests/AC1.test.ts"] }), {
    criteria,
  });
  assert(
    rows[0]?.result === NO_GREEN_VERIFY_CELL,
    `(4a) with no decided green verify a test criterion is NOT a bare "pass" — with no head to name there is no executed evidence to report (${JSON.stringify(rows[0]?.result)}) — the mutant: an invented head, the head of a RED verify, or a "pass" that cites no commit at all`,
  );
  assert(
    rows[1]?.result === NO_GREEN_VERIFY_CELL,
    `(4a2) and so is a command criterion — the green record is the only one that could have answered it (${JSON.stringify(rows[1]?.result)})`,
  );
  assert(
    rows[2]?.result === "manual — needs a human",
    `(4a3) while a manual row keeps the gate's standing answer whatever the log holds (${JSON.stringify(rows[2]?.result)})`,
  );
  const section = renderAcceptanceSection(
    log(undefined, { AC1: ["tests/AC1.test.ts"] }),
    body(criteria),
  );
  assert(
    section.includes("Verified head: none"),
    `(4b) and the section says no green verify named a head (${JSON.stringify(
      section.split("\n").find((l) => l.startsWith("Verified head")) ?? "",
    )})`,
  );
  // The log a run actually walks after a CI fix round: `verify:0 green@HEAD`,
  // `publish` ok, `ci` red, then `verify:1 red@OTHER` — `machine.ts` routes a red
  // `ci` back through `verify` and `review` re-enters with the WHOLE log, so the
  // newest DECIDED verify is red while an older green still sits in the log. No row
  // may read `pass` there, and `anyGreenVerify` is what lets the anchor say "a later
  // gate came back red" rather than "no gate ever ran".
  const red = [
    ...log(greenVerify(), { AC1: ["tests/AC1.test.ts"] }),
    step("ci", { kind: "red", reason: "the suite failed on the merge queue" }),
    step("verify", { kind: "red", verifiedHead: OTHER, reason: "the frozen contract failed" }, 1),
  ];
  const redRows = acceptanceRows(red, { criteria });
  assert(
    !redRows[0]!.result.includes(OTHER.slice(0, 12)) && redRows[0]!.result === NO_GREEN_VERIFY_CELL,
    `(4c) a RED verify's head is never the table's head, and its rows are not passes (${JSON.stringify(redRows[0]?.result)})`,
  );
  assert(
    !redRows[0]!.result.includes(HEAD.slice(0, 12)),
    `(4c2) nor is an EARLIER green's head once a newer verify came back red over it — the newest decided gate is the only one a row may cite (${JSON.stringify(redRows[0]?.result)})`,
  );
  const redSection = renderAcceptanceSection(red, body(criteria));
  const redAnchor = redSection.split("\n").find((l) => l.startsWith("Verified head")) ?? "";
  assert(
    redAnchor.includes("came back RED") &&
      !redAnchor.includes("no decided green `verify` step"),
    `(4d) a log whose newest verify is RED says so, rather than the wording a run that never verified gets (${JSON.stringify(redAnchor)}) — the mutant: one anchor line for both facts, which cannot tell a red gate from no gate`,
  );
  // The two absences the anchor distinguishes are the only two a real log can hold:
  // `state-outcome.ts` refuses a `verify` whose `verifiedHead` is not a full sha, so a
  // decided green ALWAYS names one — the arms are "a newer verify came back red" and
  // "no decided green verify at all", never "a green that forgot to name a head".
  assert(
    acceptanceRows(log(undefined, { AC1: ["tests/AC1.test.ts"] }), { criteria })[0]?.result ===
      NO_GREEN_VERIFY_CELL,
    `(4e) the no-gate-at-all log reads the same refusal as the red one — neither has executed evidence to cite (${JSON.stringify(
      acceptanceRows(log(undefined, { AC1: ["tests/AC1.test.ts"] }), { criteria })[0]?.result,
    )})`,
  );
  // And the anchor wording does not leak between them: the no-gate log must not claim a
  // gate came back red, which would send an operator looking for a verdict that never was.
  const noGateAnchor =
    renderAcceptanceSection(log(undefined, { AC1: ["tests/AC1.test.ts"] }), body(criteria))
      .split("\n")
      .find((l) => l.startsWith("Verified head")) ?? "";
  assert(
    noGateAnchor.includes("no decided green `verify` step") && !noGateAnchor.includes("RED"),
    `(4e) and the no-gate wording says no gate ran, not that one failed (${JSON.stringify(noGateAnchor)})`,
  );
}

// ── (5) a spec that is not there renders no table ────────────────────────────
{
  const steps = log(greenVerify());
  assert(
    renderAcceptanceSection(steps, undefined) === "" &&
      renderAcceptanceSection(steps, "") === "" &&
      renderAcceptanceSection(steps, "just prose, no block") === "",
    "(5) no body, a blank body and a body with no parsable block all render NO table — a table invented from prose would be a contract nothing enforces",
  );
  assert(
    renderAcceptanceSection(steps, body([])) === "",
    "(5) and a spec whose criteria list is empty renders none either",
  );
}

// ── (6) untrusted text cannot become structure ───────────────────────────────
{
  const criteria = [
    {
      id: "AC1",
      text: "### Heading\nand a ``` fence that would close the block the prompt opened.",
      verify: "test" as const,
    },
  ];
  const section = renderAcceptanceSection(log(greenVerify({ commandCriteria: {} })), body(criteria));
  assert(
    !section.includes("\n### Heading"),
    "(6) a criterion's own `###` stays inside the fence and never opens a section",
  );
  const fences = (section.match(/^```/gm) ?? []).length;
  assert(
    fences === 2,
    `(6) and a backtick fence inside the criterion cannot close the table's fence (${String(fences)} fence delimiters in the section, ${String(section.length)} chars)`,
  );
}

console.log(
  `\n${failures() === 0 ? "table green" : "table RED"} (${String(failures())} failing)`,
);
process.exit(failures());
