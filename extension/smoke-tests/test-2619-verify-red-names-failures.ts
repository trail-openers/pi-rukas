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
 * (unchanged)  the excuse rule and the colour it decides: a warnings-flooded head the base
 *              does not print is still refused red, with no disclosure and no certified head
 * (billing)    the reason states what is known and what is not, and no longer says no build
 *              round can fix it
 */
import { BASELINE_RED_NAMES_CAP } from "../src/lean/verify-baseline-arm.ts";
import { RED_REASON_TAIL_CLIP, clipReason } from "../src/lean/verify-deps.ts";
import {
  ROOTS,
  RED_ACCEPTANCE_TEST,
  pytestFailTier,
  runVerify,
} from "./lib/lean-verify-fixture.ts";
import { failLinesTier } from "./lib/lean-verify-tiers.ts";

import { PROBE_WARNING_LINE as WARNING_LINE } from "./tmp-probe-2619.ts";

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
const warnings = (from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_, i) => `${WARNING_LINE} ${String(from + i)}`);
const flood = (names: string[]): string => [...warnings(0, 260), ...names].join("\n");
/**
 * A pytest run whose warnings summary fills the head of its own command.
 *
 * `pytestFailTier` interpolates what it prints into the tier's command string, and the refused
 * reason quotes that command verbatim — so the warning text reaches the reason through the quoted
 * command rather than through the names list, which is where a warnings flood buries the failures
 * under the old head-only clip.
 /**
 * A red tier whose COMMAND is a warnings flood.
 *
 * The refused reason quotes the tier's command verbatim, so a flood written into the marker is a
 * flood the reason carries — the shape that buries a project's failures under a head-only clip.
 * `pytestFailTier` is not used here because it puts the flood INSIDE a `FAILED` line, which the
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
  // The two claims that matter are about the LIST the reason prints, so they are made on the
  // text after the step's own `failing tests:` lead — the tier's command is quoted verbatim ahead
  // of it, and it contains the same words because the tier is what prints them.
  const listed = reason.slice(reason.indexOf("failing tests:") + "failing tests:".length);
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
    { length: BASELINE_RED_NAMES_CAP + 5 },
    (_, i) => `FAILED tests/${String(i)}_test.py::t - Assert`,
  );
  // The head run printed only the first 20 names, the base printed all 25 and the tier really
  // prints all 25, so the refusal is owed to the 5 lines only the head printed — and the list the
  // reason carries is this step's OWN parse of those head bytes. A reason built from the tier's
  // command instead would name all 25; one that read nothing would name none.
  const r = await runVerify({
    issue: 2620,
    implement: true,
    config: { fast: pytestFailTier("capped", many) },
    headTierRedRuns: 2,
    baseRedContract: true,
    headTierOutput: many.join("\n"),
    // The base printed every head line EXCEPT the last: that one head-only line is the refusal,
    // and it is a line the classifier cannot read, so the reason has to carry the 24 it could.
    baseTierOutput: many.slice(0, many.length - 1).join("\n"),
  } as never);
  const all = r.outcome?.reason ?? "";
  // Counted on the list the step composed, past its own `failing tests:` lead: the quoted tier
  // command ahead of that lead repeats every name because the tier is what prints them.
  const list = all.slice(all.indexOf("failing tests:") + "failing tests:".length);
  const listed = many.filter((n) => list.includes(n));
  assert(
    r.outcome?.kind === "red",
    `(names) a head line the base never printed excuses nothing (got ${why(r)})`,
  );
  assert(
    listed.length === BASELINE_RED_NAMES_CAP,
    `(names) exactly the named constant's worth of names is listed (${String(listed.length)} of ${String(many.length)}, cap ${String(BASELINE_RED_NAMES_CAP)})`,
  );
  assert(
    list.includes(`omitted ${String(many.length - BASELINE_RED_NAMES_CAP)}`),
    `(names) the reason states how many it left out (${list.slice(-160)})`,
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
  assert(reason.includes(NAME_A), "(tail) the FAILED line survives into the builder's reason");
  assert(
    reason.includes("1 failed, 0 passed"),
    `(tail) and so does the run's final tally (${reason.slice(-80)})`,
  );
}

// --------------------------------------------------------------- (unchanged)
{
  // The rule this issue must not touch: a head flooded with warnings the base never printed
  // excuses nothing. Same colour, same refusal, no disclosure, no certified head.
  const r = await runVerify({
    issue: 2624,
    implement: true,
    config: { fast: floodTier("flooded", [NAME_A]) },
    headTierRedRuns: 2,
    baseRedContract: true,
    headTierOutput: flood([NAME_A]),
    baseTierOutput: flood([]),
  } as never);
  assert(
    r.outcome?.kind === "red",
    `(unchanged) a warnings-flooded head the base does not print is still refused (${why(r)})`,
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
