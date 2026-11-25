#!/usr/bin/env bun
/**
 * #2619 — a refused baseline excuse names the failures it asks the builder to fix.
 *
 * The step billed a build round on a red whose reason named no failing check, said no build
 * round could fix it while the machine was billing one, and was clipped at the head so a
 * project's warnings buried its FAILED block. Nothing below changes WHEN a tier is refused:
 * the same streams under `baselineExcuse` still come back `refused`. What changed is the
 * sentence that refusal writes.
 *
 * (names)      a refused red lists the head's failing lines this step parsed, bounded by the
 *              one constant, and states how many it left out
 * (unreadable) a head output with no parseable failure line says so in plain words
 * (tail)       the clip keeps head AND tail, so a warnings flood cannot bury the FAILED block
 *              or the run's final tally
 * (unchanged)  the excuse rule and the colour it decides: a head-only failure the base never
 *              printed is refused red (the roster's own refusal, so an arm that excuses everything
 *              cannot grade this green), and a red the excuse itself refuses still reaches the
 *              builder with the contract clause and the head's names in it — the pair a mutant that
 *              ignored the roster's answer or dropped the composition would break
 * (billing)    the reason states what is known and what is not, and no longer says no build
 *              round can fix it
 */
import { BASELINE_RED_NAMES_CAP } from "../src/lean/verify-baseline-arm.ts";
import { baselineRedReadNoNames } from "../src/lean/verify-baseline.ts";
import { buildPrompt } from "../src/lean/build-prompt.ts";
import { RED_REASON_TAIL_CLIP, clipReason } from "../src/lean/verify-deps.ts";
import {
  ROOTS,
  RED_ACCEPTANCE_TEST,
  runVerify,
} from "./lib/lean-verify-fixture.ts";
import { failLinesTier } from "./lib/lean-verify-tiers.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ test-2619-verify-red-names-failures.ts: ${msg}`);
    exit = 1;
  }
}

const NAME_A = "FAILED tests/a_test.py::test_alpha - Assert";
const NAME_B = "FAILED tests/b_test.py::test_beta - Assert";
/** A line only ever a warnings line: the tier prints it, the reason must never list it as a failure. */
const WARNING_LINE = "tests/w_test.py::test_w PytestWarning: something stale";
/** The step's own lead for the list it composed. The tier's COMMAND is quoted verbatim ahead of it
 *  and repeats whatever the tier prints, so every claim about the LIST is made on the text after the
 *  LAST copy of this marker — the step's own clause and the only one the step writes. */
const STEP_LIST_LEAD = "; failing tests: ";
/** The step's list, from its own lead to the end of the reason. */
const stepList = (reason: string): string =>
  reason.slice(reason.lastIndexOf(STEP_LIST_LEAD) + STEP_LIST_LEAD.length);
const warnings = (from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_, i) => `${WARNING_LINE} ${String(from + i)}`);
const flood = (names: string[]): string => [...warnings(0, 260), ...names].join("\n");
/**
 * A red tier whose COMMAND is a warnings flood.
 *
 * The refused reason quotes the tier's command verbatim, so a flood written into the marker is a
 * flood the reason carries — the shape that buries a project's failures under a head-only clip.
 * A bare `failTier` is not used here because it puts the flood INSIDE a `FAILED` line, which the
 * classifier then reads as a test; this half is about what the clip keeps, not what is listed.
 */
const floodTier = (marker: string, names: readonly string[]): string =>
  `sh -c 'echo tier-said-${marker} ${warnings(0, 260).join(" ")} 1>&2; echo "${names.join("; ")}" 1>&2; echo "=== ${String(names.length)} failed, 0 passed ===" 1>&2; exit 1'`;
/** The reason this case drove, or what a throw said — one line, so every arm prints something. */
const why = (r: { outcome?: { kind?: string }; threw?: Error }): string =>
  r.outcome?.kind ?? `threw: ${r.threw?.message}`;

// ------------------------------------------------------------------- (names)
{
  // The head stream the step reads is the tier's OWN output, so it is long enough to need
  // clipping; the tier command itself prints the names, which is what puts them on the record.
  const r = await runVerify({
    issue: 2619,
    implement: true,
    config: { fast: floodTier("named", [NAME_A, NAME_B]) },
    headTierRedRuns: 2,
    baseRedContract: true,
    headTierOutput: flood([NAME_A, NAME_B]),
    baseTierOutput: "Command failed: the base ran the tier\nunrelated base output\n",
  } as never);
  const reason = r.outcome?.reason ?? "";
  assert(r.outcome?.kind === "red", `(names) the refused excuse is still a red (got ${why(r)})`);
  assert(reason.startsWith("baseline red:"), `(names) the reason keeps the baseline lead (${reason.slice(0, 60)})`);
  assert(
    reason.includes(NAME_A) && reason.includes(NAME_B),
    `(names) both failing lines this step parsed are in the reason (${reason.slice(0, 400)})`,
  );
  // The two claims that matter are about the LIST the reason prints, so they are made on the text
  // after the step's own lead — the tier's command is quoted verbatim ahead of it, and it contains
  // the same words because the tier is what prints them.
  const listed = stepList(reason);
  assert(!listed.includes(WARNING_LINE), "(names) a warnings line is not listed as a failing test");
  assert(!listed.includes("0 passed"), "(names) the run's tally is not listed as a failing test");
  assert(
    r.outcome?.preexistingFailures === undefined,
    `(names) a refusal discloses nothing (${JSON.stringify(r.outcome?.preexistingFailures)})`,
  );
}

// ------------------------------------------------------------- (names: bounded)
{
  const many = Array.from(
    { length: 25 },
    (_, i) => `FAILED tests/${String(i)}_test.py::t - Assert`,
  );
  // The head's stream is what the step reads and lists, and the base printed every head line
  // EXCEPT the last — that one head-only line is the refusal, and the reason has to carry the 20 of
  // the 24 readable lines the cap admits.
  //
  // The tier's COMMAND stays free of these names (`failLinesTier` passes them as positional args,
  // never interpolated into the quoted word). Were the command allowed to quote them, every name
  // would reach the reason through that quote as well, and a cap assertion counting from the FIRST
  // `failing tests:` would be satisfied by the project's own command — green whatever the step
  // listed. Counting from the step's own lead (its LAST clause, the only one it writes) is what
  // makes the assertion measure the step's list.
  const r = await runVerify({
    issue: 2620,
    implement: true,
    config: { fast: failLinesTier("capped", many) },
    headTierRedRuns: 2,
    baseRedContract: true,
    headTierOutput: many.join("\n"),
    baseTierOutput: many.slice(0, many.length - 1).join("\n"),
  } as never);
  const all = r.outcome?.reason ?? "";
  // Counted on the list the step composed, past its OWN lead (the last copy of it).
  const list = stepList(all);
  const listed = many.filter((n) => list.includes(n));
  assert(
    r.outcome?.kind === "red",
    `(names) a head line the base never printed excuses nothing (got ${why(r)})`,
  );
  // The refusal's own cause, pinned: the head printed a failing line the base did NOT (the last of
  // the 25), which is why the excuse is refused here at all — had the base printed it too this run
  // would be an excuse and a green, and the cap would be measured on nothing.
  assert(
    r.outcome?.preexistingFailures === undefined,
    `(names) the head-only last line is what refuses this excuse — nothing was disclosed (${JSON.stringify(r.outcome?.preexistingFailures)})`,
  );
  // The step wrote its own count clause: a reason whose list came from anywhere else carries none,
  // and the counting below would be over text this step never composed.
  assert(
    all.endsWith(`; omitted ${String(many.length - BASELINE_RED_NAMES_CAP)} more`),
    `(names) the reason ENDS with the step's own count clause (${all.slice(-70)})`,
  );
  assert(
    listed.length === BASELINE_RED_NAMES_CAP,
    `(names) exactly the named constant's worth of names is listed (${String(listed.length)} of ${String(many.length)}, cap ${String(BASELINE_RED_NAMES_CAP)})`,
  );
  assert(
    !many.slice(BASELINE_RED_NAMES_CAP).some((n) => list.includes(n)),
    `(names) the names past the cap are NOT listed (${many.slice(BASELINE_RED_NAMES_CAP).map((n) => n.slice(12, 26)).join(", ")})`,
  );
  assert(
    list.endsWith(`omitted ${String(many.length - BASELINE_RED_NAMES_CAP)} more`),
    `(names) the reason states how many it left out (${list.slice(-160)})`,
  );
  // The count is the step's own clause, not an item of the list: every item is a failing line.
  assert(
    !list.split(", ").some((item) => item.startsWith("omitted ")),
    `(names) the omitted-count is its own clause, not a listed test (${list.slice(-90)})`,
  );
}

// -------------------------------------------------------------- (unreadable)
{
  // No line the classifier can read, and no frozen clause either: the reason says so plainly
  // rather than leaving the builder to hunt through the text for a failure it cannot find.
  const r = await runVerify({
    issue: 2621,
    implement: true,
    config: { fast: failLinesTier("plain", ["some output with no failure shape at all"]) },
    headTierRedRuns: 2,
    baseRedContract: true,
    headTierOutput: "some output with no failure shape at all\n",
    baseTierOutput: "Command failed: the base ran the tier\nnothing here either\n",
  } as never);
  const reason = r.outcome?.reason ?? "";
  assert(r.outcome?.kind === "red", `(unreadable) still a red (got ${why(r)})`);
  assert(
    reason.includes("no failing test could be read from this output"),
    `(unreadable) the reason says so in plain words (${reason.slice(0, 260)})`,
  );
  // End to end: the clause is the step's own, so the reader that decides the builder's instruction —
  // the same predicate `buildPrompt` asks — says yes here. A clause that only LOOKED like the step's
  // (project bytes, or a clipped-away list) gets the builder no such sentence.
  assert(
    baselineRedReadNoNames(reason),
    `(unreadable) and the prompt's own test recognises it (${reason.slice(-70)})`,
  );
  const prompt = buildPrompt({
    issue: 2621,
    spec: {
      problem: "The retry helper gives up on the first transient failure.",
      size: "S",
      criteria: [{ id: "AC1", text: "retries a transient failure twice", verify: "test" }],
    },
    frozenPaths: ["tests/AC1-retry.test.sh"],
    worktree: "/tmp/wt",
    attempt: 1,
    reentry: reason,
  });
  assert(
    /nothing to fix/i.test(prompt),
    "(unreadable) and the builder is told there is nothing to fix from that text",
  );
}

// --------------------------------------------------------------- (frozen arm)
{
  // The arm's OTHER refusal site: the frozen contract is red, so the reason carries the
  // frozen clause beside the baseline sentence. The names still have to be there.
  const r = await runVerify({
    issue: 2622,
    implement: true,
    config: { fast: floodTier("frozen", [NAME_A]) },
    headTierRedRuns: 2,
    baseRedContract: true,
    headTierOutput: flood([NAME_A]),
    baseTierOutput: "Command failed: the base ran the tier\nunrelated base output\n",
    frozenText: RED_ACCEPTANCE_TEST,
  } as never);
  const reason = r.outcome?.reason ?? "";
  assert(r.outcome?.kind === "red", `(frozen) still a red (got ${why(r)})`);
  assert(
    reason.startsWith("frozen tests failing:"),
    `(frozen) the contract's clause still leads (${reason.slice(0, 70)})`,
  );
  assert(reason.includes(NAME_A), `(frozen) and the head's failing line is still named (${reason.slice(0, 300)})`);
}

// -------------------------------------------------------------------- (tail)
{
  // The refused reason quotes the tier's command, and the command here IS a 15 KiB warnings flood:
  // the old head-only clip cut at 4 KiB and left the FAILED block and the tally out of the prompt.
  const long = floodTier("tail", [NAME_A]);
  const clipped = clipReason(long);
  assert(
    long.length > RED_REASON_TAIL_CLIP,
    `(tail) the fixture is long enough to need clipping at all (${String(long.length)} > ${String(RED_REASON_TAIL_CLIP)})`,
  );
  assert(clipped.includes(NAME_A), "(tail) the FAILED line survives a warnings flood");
  assert(
    clipped.includes("1 failed, 0 passed"),
    `(tail) the run's final tally survives too (${clipped.slice(-80)})`,
  );
  assert(
    clipped.length >= RED_REASON_TAIL_CLIP,
    `(tail) the clip keeps a tail's worth of bytes, not a token of one (${String(clipped.length)})`,
  );
  assert(clipped.includes("…"), "(tail) an elision marker separates the two halves");
  assert(
    clipped.includes(warnings(0, 1)[0] ?? "") && !clipped.includes(warnings(150, 151)[0] ?? ""),
    "(tail) the head of the flood is kept beside its tail, and the middle is what was cut",
  );

  // And the same flood through the step: the reason it hands the builder is clipped, and both ends
  // of the project's output are still readable in it.
  const r = await runVerify({
    issue: 2623,
    implement: true,
    config: { fast: long },
    headTierRedRuns: 2,
    baseRedContract: true,
    headTierOutput: "",
    baseTierOutput: "",
  } as never);
  const reason = r.outcome?.reason ?? "";
  assert(r.outcome?.kind === "red", `(tail) still a red (got ${why(r)})`);
  assert(reason.includes("…"), "(tail) the reason reaching the prompt was clipped");
  // Stated plainly rather than assumed: in this shape the step's OWN parse read no line from either
  // run (the flood lives in the quoted command, and a warnings line is not a failure line), so the
  // reason closes with the step's "nothing could be read" clause — and the name and tally above are
  // what survived the clip. Whether the clause is the step's own is a question of POSITION, which
  // `buildPrompt` asks through one predicate; the (unreadable) block pins the pair both ways.
  assert(reason.includes(NAME_A), "(tail) the FAILED line survives into the builder's reason");
  assert(
    reason.includes("1 failed, 0 passed"),
    `(tail) and so does the run's final tally (${reason.slice(-80)})`,
  );
}

// ----------------------------------------------------- (unchanged: roster refuses)
{
  // The rule this issue must not touch, stated in the strongest shape available to the harness: the
  // project's own suite reports a test the BASE roster PASSED and the HEAD roster FAILED, so the run
  // carries a roster verdict that ranks over the tier excuse however the two tier streams line up.
  // The tier's streams are then paired — every head line the base also printed — so the ONLY refusal
  // left standing is this one. An arm that excused every red it is handed, or that read the roster's
  // answer as permission to excuse, turns the first assertion red; and `preexistingFailures ===
  // undefined` fails under the same mutant with no help from the colour.
  const PROJECT_FILE = "tests/test-a.sh";
  const PROJECT_NAME = "tests.test_a::test_alpha";
  const r = await runVerify({
    issue: 2624,
    implement: true,
    config: { fast: failLinesTier("refused", [NAME_A]) },
    headTierRedRuns: 2,
    baseRedContract: true,
    headTierOutput: flood([NAME_A]),
    // The base really printed the head's failing line: the refusal below cannot be blamed on a
    // head-only line, which is what the (names) block above already measures.
    baseTierOutput: flood([NAME_A]),
    roster: {
      files: [PROJECT_FILE],
      basePassed: [PROJECT_NAME],
      baseFailed: [],
      headPassed: [],
      headFailed: [PROJECT_NAME],
    },
  } as never);
  const reason = r.outcome?.reason ?? "";
  assert(
    r.outcome?.kind === "red",
    `(unchanged) a failure the roster saw pass at base is refused, not excused (${why(r)})`,
  );
  assert(
    reason.startsWith("project tests that passed at the base commit now fail:"),
    `(unchanged) and the refusal is the roster's own verdict, not a fallback colour (${reason.slice(0, 80)})`,
  );
  assert(
    reason.includes(PROJECT_NAME),
    `(unchanged) and it names the test the roster says this run broke (${reason.slice(0, 200)})`,
  );
  assert(
    r.outcome?.preexistingFailures === undefined,
    `(unchanged) nothing is disclosed as pre-existing (${JSON.stringify(r.outcome?.preexistingFailures)})`,
  );
  assert(r.outcome?.verifiedHead === undefined, "(unchanged) and no head is certified");
}

// ------------------------------------------- (unchanged: excuse refuses, prompt keeps both)
{
  // The arm's other refusal, the one #2619 changed the wording of: the line rule says a head line
  // the base never printed is the run's own, and the reason must still reach the builder with BOTH
  // the contract's clause and the head's failing line. A mutant that excused everything, or that
  // dropped the composition beside the frozen clause, fails one of these — which is the pair a
  // colour-only assertion could not see.
  const r = await runVerify({
    issue: 2625,
    implement: true,
    config: { fast: floodTier("flooded", [NAME_A]) },
    headTierRedRuns: 2,
    baseRedContract: true,
    headTierOutput: flood([NAME_A]),
    baseTierOutput: flood([]),
    frozenText: RED_ACCEPTANCE_TEST,
  } as never);
  const reason = r.outcome?.reason ?? "";
  assert(
    r.outcome?.kind === "red",
    `(unchanged) a warnings-flooded head the base does not print is still refused (${why(r)})`,
  );
  assert(
    reason.startsWith("frozen tests failing:"),
    `(unchanged) the contract's clause leads (${reason.slice(0, 60)})`,
  );
  assert(
    reason.includes("baseline red:"),
    `(unchanged) the baseline verdict is told beside it, not instead of it (${reason.slice(0, 200)})`,
  );
  assert(
    stepList(reason).includes(NAME_A),
    `(unchanged) and the head's failing line is still listed (${stepList(reason).slice(0, 160)})`,
  );
  assert(
    r.outcome?.preexistingFailures === undefined,
    "(unchanged) and nothing is disclosed as pre-existing",
  );
  assert(r.outcome?.verifiedHead === undefined, "(unchanged) and no head is certified");
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
