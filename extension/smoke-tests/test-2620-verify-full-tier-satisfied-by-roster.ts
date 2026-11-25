#!/usr/bin/env bun
/**
 * #2620 — one verify step runs the project's whole suite ONCE when the roster already ran it.
 *
 * With the project roster on and a `verify.full` tier configured, a green head paid for the same
 * suite twice: the roster's head run, then the full tier over the same tree. The two commands are one
 * command — the roster renders the project's `verify.test` runner into argv (its `{file}` word gone,
 * its report flag and the tree added), and the tier carries the same words as a shell string — so the
 * second one buys a verdict the first already produced.
 *
 * What the cases below pin, in the order the ACs state them:
 *
 *   AC1 — a GREEN roster head and a full tier whose words are the roster's argv less its own two
 *         additions: the tier is not executed again, and the step is still green.
 *   AC2 — the step's record says `fullSatisfied`, and the reason carries the same fact as a clause a
 *         reader can tell from a passed tier; the clause survives the reason clip and the PR body clip.
 *   AC3 — every other arm is untouched: a different full tier, a red roster head, an unreadable
 *         roster report, and the roster switched off all run the tier exactly as they do today.
 *
 * The counter that makes AC1 observable is `suiteTierRuns`: the exec stub bumps it for a head run of the
 * case's own tier command, so "0" is the evidence that the tier was not run rather than an absence of
 * measurement — and `tierRuns` stays at 1 for the fast tier, so a green cannot be an absence of tiers.
 */
import { rmSync } from "node:fs";
import type { ProjectRosterRecord } from "../src/lean/state-outcome-maps.ts";
import { outcomeProblem } from "../src/lean/state-outcome.ts";
import { publishBody } from "../src/lean/publish-body.ts";
import { RED_REASON_CLIP } from "../src/lean/verify-deps.ts";
import { deriveSuiteTemplate } from "../src/lean/verify-roster-command.ts";
import { withEnv } from "./lib/env-scope.ts";
import { FROZEN_FILE } from "./lib/lean-verify-frozen.ts";
import { ROOTS, runVerify } from "./lib/lean-verify-fixture.ts";
import { PASS_TIER } from "./lib/lean-verify-tiers.ts";

const SELF = "test-2620-verify-full-tier-satisfied-by-roster.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const FILE = "tests/test-suite.sh";
const NAME = "tests/test-suite.sh::passes";
/**
 * The project's own runner, and the two spellings of the case this ticket is about: a `verify.full`
 * tier whose words ARE the roster's suite command, and one that is not. The gate derives the roster's
 * command from `verify.test` itself, so the fixture configures the tier as the project would — the
 * runner's words — and the roster is left to the gate's own derivation.
 */
const RUNNER = "sh .lean-roster-suite.sh";
/** The same runner with one flag more: the tier the roster does not cover. */
const OTHER_TIER = `${RUNNER} --q`;
/** A green roster's declared verdicts: the head run ran this and failed nothing. */
const GREEN_ROSTER = { files: [FILE], headPassed: [NAME], basePassed: [NAME] };
/** A roster whose head failed the one test. */
const RED_ROSTER = { files: [FILE], basePassed: [NAME], headPassed: [], headFailed: [NAME] };

/** The note the disclosure is allowed to be written as, and nothing else. */
function hasNote(text: string | undefined): boolean {
  return (text ?? "").includes("verify.full was not run again");
}

/**
 * The project's config for the case. `test` is the ordinary per-file runner — the frozen contract runs
 * through it — and the ROSTER's suite command is what the gate DERIVES from it, so the case never has to
 * write the roster's template at all: it configures the project's runner and the tier, and the gate's own
 * derivation is what the skip is judged against.
 */
const CONFIG = { fast: PASS_TIER, test: "sh {file}" } as const;

// ---------------------------------------------------------------- AC1 + AC2
{
  // A green roster head, and a full tier that IS the roster's suite. One execution of the project's
  // whole suite, the tier's counter at zero, and a green that says which of its tiers it did not run.
  const r = await runVerify({
    issue: 2640,
    implement: true,
    config: { ...CONFIG },
    full: RUNNER,
    suiteTier: RUNNER,
    roster: GREEN_ROSTER,
  });
  assert(
    r.outcome?.kind === "green",
    `(ac1) roster-equal full tier still grades green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message?.slice(0, 120)}`})`,
  );
  assert(
    r.rosterHeadRuns === 1,
    `(ac1) the roster ran the suite at head exactly once (${String(r.rosterHeadRuns)})`,
  );
  assert(
    r.suiteTierRuns === 0,
    `(ac1) the full tier was NOT executed again (${String(r.suiteTierRuns)} executions of the tier's own command)`,
  );
  assert(
    r.tierRuns === 1,
    `(ac1) and the fast tier still ran, so a green is not an absence of tiers (${String(r.tierRuns)})`,
  );
  const roster = r.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(
    roster?.fullSatisfied === true,
    `(ac2) the step's record names the full tier as satisfied by the roster run (${JSON.stringify(roster?.fullSatisfied)})`,
  );
  assert(
    hasNote(r.outcome?.reason),
    `(ac2) the reason carries the same fact as a plain note (${(r.outcome?.reason ?? "").slice(0, 160)})`,
  );
  assert(
    (r.outcome?.reason ?? "").startsWith("verify.full was not run again"),
    `(ac2) the note LEADS the reason, so neither clip can cut it away (${(r.outcome?.reason ?? "").slice(0, 60)})`,
  );
}

// ------------------------------------------------- AC2: the note survives both clips
{
  // The record's own reason is clipped to RED_REASON_CLIP and build's re-entry pastes that; the PR
  // body clips the same text again at 2 000. A clause at the END of a long reason would be the first
  // thing to disappear, so the claim to test is that it survives, not that it was composed.
  const reason = `verify.full was not run again — the roster's head run covered it${" filler".repeat(RED_REASON_CLIP)}`;
  assert(reason.length > RED_REASON_CLIP, "(ac2) the reason asked about really is past the record's bound");
  const body = publishBody({
    issue: 2640,
    spec: { problem: "x", criteria: [{ id: "AC1", text: "t", verify: "test" }], size: "S" },
    tests: {},
    verifyKind: "green",
    verifiedHead: "0".repeat(40),
    baseSha: "1".repeat(40),
    version: "test",
    models: {},
    draft: false,
    verifyReason: reason,
  });
  assert(
    hasNote(body),
    "(ac2) the note survives the PR body's 2 000-character clip of a long reason",
  );
}

// ------------------------------------------------ AC3: a full tier that is NOT the roster's
{
  // One extra flag and the two commands are two commands. The tier runs, as it does today, and no
  // disclosure is written — a reader must be able to tell a tier that ran from one that was skipped.
  const r = await runVerify({
    issue: 2641,
    implement: true,
    config: { ...CONFIG },
    full: OTHER_TIER,
    suiteTier: OTHER_TIER,
    roster: GREEN_ROSTER,
  });
  assert(
    r.outcome?.kind === "green",
    `(ac3) a different full tier still grades green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message?.slice(0, 120)}`})`,
  );
  assert(
    r.suiteTierRuns === 1 && r.rosterHeadRuns === 1,
    `(ac3) the tier's own run and the roster's run of the SAME script are counted apart (${String(r.suiteTierRuns)} tier, ${String(r.rosterHeadRuns)} roster head)`,
  );
  const roster = r.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(
    !Object.hasOwn(roster ?? {}, "fullSatisfied"),
    `(ac3) no disclosure on a tier that ran (${JSON.stringify(roster?.fullSatisfied)})`,
  );
  assert(!hasNote(r.outcome?.reason), "(ac3) and the reason says nothing about a skipped tier");
}

// ------------------------------------------------ AC3: a roster red, and no report at all
{
  // A roster whose head failed a test is a red step; nothing is skipped and the tiers below it are
  // never reached. A roster whose head wrote no report hands back. Both arms are today's.
  const red = await runVerify({
    issue: 2642,
    implement: true,
    config: { ...CONFIG },
    full: RUNNER,
    suiteTier: RUNNER,
    roster: RED_ROSTER,
  });
  assert(
    red.outcome?.kind === "red",
    `(ac3) a roster red is still red (got ${red.outcome?.kind ?? `threw: ${red.threw?.message?.slice(0, 100)}`})`,
  );
  // The numbers a red roster pays TODAY, pinned before the change and unchanged by it: the roster's own
  // red is what grades the step, and the skip claims nothing for a run that failed a test.
  assert(
    red.suiteTierRuns === 1 && red.tierRuns === 2,
    `(ac3) and the tier ran exactly as it does today for a red roster (${String(red.suiteTierRuns)} suite tier, ${String(red.tierRuns)} tier)`,
  );
  assert(
    red.rosterHeadRuns === 1 && red.rosterBaseRuns === 1,
    `(ac3) both roster legs ran for the comparison (${String(red.rosterHeadRuns)}, ${String(red.rosterBaseRuns)})`,
  );
  assert(
    !Object.hasOwn(red.outcome?.projectRoster ?? {}, "fullSatisfied"),
    "(ac3) and a red roster claims no satisfied tier",
  );
  assert(
    (red.outcome?.reason ?? "").length > 0 && !hasNote(red.outcome?.reason),
    "(ac3) and its reason says nothing about a tier the roster covered",
  );

  const unreadable = await runVerify({
    issue: 2643,
    implement: true,
    config: { ...CONFIG },
    full: RUNNER,
    suiteTier: RUNNER,
    roster: { files: [FILE], headPassed: ["__NO_REPORT__"], basePassed: [NAME] },
  });
  assert(
    unreadable.threw !== undefined && /roster/i.test(unreadable.threw.message),
    `(ac3) a roster whose report cannot be read still hands back (got ${unreadable.outcome?.kind ?? `threw: ${unreadable.threw?.message?.slice(0, 100)}`})`,
  );
  assert(
    unreadable.suiteTierRuns === 0,
    `(ac3) and it hands back before the tier, as it did today (${String(unreadable.suiteTierRuns)})`,
  );
}

// ------------------------------------------------ AC3: the roster switched off
{
  // Off is today's behaviour: the tier runs, and no roster-side claim of any kind is written. The
  // tier configured here is one the roster WOULD have satisfied, so the lever is the only difference
  // between this case and the AC1 case above.
  let off!: Awaited<ReturnType<typeof runVerify>>;
  await withEnv({ PI_ENSEMBLE_LEAN_PROJECT_ROSTER: "0" }, async () => {
    off = await runVerify({
      issue: 2644,
      implement: true,
      config: { ...CONFIG },
      full: RUNNER,
      suiteTier: RUNNER,
      roster: GREEN_ROSTER,
    });
  });
  assert(
    off.outcome?.kind === "green",
    `(ac3) with the roster off the case is green (got ${off.outcome?.kind ?? `threw: ${off.threw?.message?.slice(0, 100)}`})`,
  );
  assert(
    off.suiteTierRuns === 1,
    `(ac3) with the roster off the full tier ran (${String(off.suiteTierRuns)})`,
  );
  assert(off.rosterHeadRuns === 0, `(ac3) and no roster ran (${String(off.rosterHeadRuns)})`);
  assert(
    !Object.hasOwn(off.outcome ?? {}, "projectRoster"),
    "(ac3) and the off arm writes no roster record",
  );
}

// --------------------------------- the disclosure is a fact about ONE step, not a carried one
{
  // Only `verify` owns the claim, and it may be made only by a head run that failed nothing.
  const roster = {
    baseSha: "1".repeat(40),
    files: [FILE],
    passed: [NAME],
    failed: [],
    baseFailed: [],
    total: 1,
    baseTotal: 1,
    fullSatisfied: true,
  } as const;
  assert(
    outcomeProblem({ kind: "green", projectRoster: roster }, "verify") === undefined,
    "(record) a green verify may carry the disclosure",
  );
  assert(
    outcomeProblem({ kind: "green", projectRoster: roster }, "ci") !== undefined,
    "(record) no other step may carry it",
  );
  assert(
    outcomeProblem({ kind: "green", projectRoster: { ...roster, failed: [NAME] } }, "verify") !==
      undefined,
    "(record) and a roster that failed a test may not claim a satisfied tier",
  );
}

// ------------------------------------ the derivation the whole rule rests on
{
  // The skip compares a tier's words against the roster's argv less the two words the roster appends.
  // If the derivation of that argv drifts, the comparison silently stops matching anything — so the
  // one derivation the gate itself uses is pinned here against the tier this case configures.
  const derived = deriveSuiteTemplate(`${RUNNER} {file}`);
  assert(
    derived === `${RUNNER} --junitxml={report} {dir}`,
    `(derivation) the suite template is the runner's own words plus the report pair (${derived})`,
  );
  assert(
    !derived.includes(FROZEN_FILE),
    "(derivation) and no single test file survives in it — it is the WHOLE suite",
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
