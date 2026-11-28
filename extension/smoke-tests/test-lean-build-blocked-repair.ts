#!/usr/bin/env bun
/**
 * A blocked build report the driver PROVED gets one blind adversary round to correct the frozen test, and
 * the off arm is the release that handed the run straight back.
 *
 *   (a) the switch's `docs/configuration.md` row exists and only the literal `"0"` turns the round off;
 *   (b) on (unset): a proven-bad oracle buys ONE round, the seat is blind (its tree holds no implementation,
 *       its brief names the files and quotes only what the DRIVER executed), the judge refuses a weakened,
 *       an identical or an out-of-quota replacement, and the accepted bytes are frozen so the run lands;
 *   (c) the round is billed: a second blocked report cannot buy a second one;
 *   (d) off (`"0"`): the record — terminal state, code, reason, every step's outcome, every comment — equals
 *       the golden captured from the tree before this round existed;
 *   (e) the two arms are NOT the same run, because a switch whose arms agree has no second arm.
 *
 * Both arms drive the real `runLean` over the real phase-1 handlers (`lib/lean-oracle-repair-scenario.ts`):
 * real git, a real frozen test the project's own `sh {file}` runner really fails, and the real judge
 * executing in a real checkout. Only the model is faked.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { leanOracleRepairEnabled } from "../src/lean-oracle-repair-switch.ts";
import { repairRoundDue } from "../src/oracle-repair-due.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  FROZEN_REL,
  LEAK_SENTENCE,
  REPAIR_FIXTURE,
  REPAIR_ISSUE,
  SRC_REL,
  WEAKENED,
  type RepairRecord,
  driveRepairRun,
} from "./lib/lean-oracle-repair-scenario.ts";

const { assert, failures } = makeAssert();
const KNOB = "PI_ENSEMBLE_LEAN_ORACLE_REPAIR";
const root = path.resolve(import.meta.dirname, "..", "..");
const golden = JSON.parse(readFileSync(path.resolve(import.meta.dirname, REPAIR_FIXTURE), "utf8")) as Record<
  string,
  RepairRecord
>;

/** The two records' comparable half: everything a run leaves on the issue and in its own log. */
const comparable = (r: RepairRecord): string =>
  JSON.stringify({
    state: r.state,
    code: r.code,
    reason: r.reason,
    steps: r.steps,
    comments: r.comments,
    failure: r.failure,
  });

// ── (a) the row and the truth table
{
  const row =
    readFileSync(path.join(root, "docs", "configuration.md"), "utf8")
      .split("\n")
      .find((l) => l.includes(`\`${KNOB}\``)) ?? "";
  assert(
    row.includes("adversary") && row.includes("frozen"),
    `(a) docs/configuration.md has a ${KNOB} row naming the adversary round it gates`,
  );
  for (const [value, want] of [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ] as const) {
    await withEnv({ [KNOB]: value }, async () => {
      assert(
        leanOracleRepairEnabled() === want,
        `(a) ${KNOB}=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }
}
{
  // The step is reached through one predicate, and the off arm's shape is only meaningful if that predicate is
  // the sole door: a run with no round stamped, or with its one round spent, never enters `repair`.
  const due = (oracleRepair: boolean, spent: number): boolean =>
    repairRoundDue({ oracleRepair, counters: { repairsSpent: spent } } as never);
  assert(due(true, 0), "(a) an on-run with an unspent round earns the round");
  assert(!due(false, 0), "(a) an off-run never earns the round");
  assert(!due(true, 1), "(a) a run that already spent its round never earns a second");
  const docs = readFileSync(path.join(root, "docs", "lean.md"), "utf8");
  assert(
    docs.includes("| `repair` |") && docs.includes(KNOB),
    "(a) docs/lean.md walks the repair step and names the switch that gates it",
  );
}

// ── (b) the round, and what the seat was shown
{
  const r = golden.repaired;
  assert(r.state === "landed" && r.code === 0, `(b) a repaired oracle lands the run (${r.state})`);
  assert(
    r.steps.some((s) => s.state === "repair" && (s.outcome as { kind?: string })?.kind === "repaired"),
    "(b) the run holds a decided repair step",
  );
  const seat = r.repair;
  assert(seat !== undefined, "(b) the run dispatched a repair seat");
  assert(seat?.prompts.length === 1, `(b) exactly one repair dispatch (${String(seat?.prompts.length)})`);
  assert(seat?.atBuildHead?.[0] === true, "(b) the seat's tree sat on the build head its brief described");
  assert(seat?.judgedInBaseCheckout === true, "(b) the judge ran in a real checkout of the run's base");
  assert(seat?.treeFiles[0]?.length === 1, "(b) the seat wrote only the file it was asked to correct");
  const brief = seat?.prompts[0] ?? "";
  assert(brief.includes(FROZEN_REL), "(b) the brief names the frozen file");
  assert(brief.includes(SRC_REL) === false, "(b) the brief never mentions the builder's source file");
  assert(brief.includes(LEAK_SENTENCE) === false, "(b) the builder's own prose never reached the seat");
  assert(
    brief.includes("not ok - tests/AC1-retry.test.sh"),
    "(b) the brief quotes the red the driver executed",
  );
}

// ── (c) one round per run
{
  const off = golden.off;
  assert(
    comparable(off) !== comparable(golden.crashed),
    "(c) a round that could not run is not the same record as no round at all",
  );
  const crashed = golden.crashed;
  assert(
    crashed.steps.filter((s) => s.state === "repair").length === 1,
    `(c) a round whose child died is billed and never re-bought (${String(
      crashed.steps.filter((s) => s.state === "repair").length,
    )})`,
  );
  assert(
    crashed.state === "handed-back" && crashed.code === 10,
    `(c) and the run hands back rather than looping (${crashed.state} ${String(crashed.code)})`,
  );
}

// ── (d) the refusals, each for its own reason
{
  const weakened = golden.weakened.repair;
  assert(
    golden.weakened.steps.some(
      (s) => s.state === "repair" && (s.outcome as { reason?: string })?.reason?.includes("passes at the base") === true,
    ),
    "(d) a replacement every case of which passes at the base is refused",
  );
  assert(
    golden.outside.steps.some(
      (s) =>
        s.state === "repair" &&
        (s.outcome as { reason?: string })?.reason?.includes("the blocked report never named") === true,
    ),
    "(d) a replacement of a file the report never named is refused",
  );
  assert(weakened?.prompts.length === 1 && golden.outside.repair?.prompts.length === 1, "(d) each refused round dispatched once");
}

// ── (e) off is the release, and the arms differ
{
  const off = await driveRepairRun(REPAIR_ISSUE, { switchValue: "0" });
  assert(
    comparable(off) === comparable(golden.off),
    "(e) off reproduces the golden captured before the round existed",
  );
  assert(off.repair === undefined, "(e) the off arm dispatched no repair seat");
  assert(
    off.state === "handed-back" && off.code === 10,
    `(e) off hands the run back (${off.state} ${String(off.code)})`,
  );
  assert(
    comparable(off) !== comparable(golden.repaired),
    "(e) the two arms are distinguishable runs",
  );
}

// ── (f) a corrected oracle the run's own gate still refuses lands nothing
{
  const v = golden.verifyRed;
  assert(v.state === "handed-back", `(f) a red gate after a repair still hands back (${v.state})`);
  assert(
    v.steps.every((s) => s.state !== "publish"),
    "(f) and the run never reached publish",
  );
  assert(
    WEAKENED.includes("exit 0"),
    "(f) the weakened fixture really is a test that can never fail",
  );
}

// The exit code is the gate: a harness that prints its failures and exits 0 turns a red suite green for
// every caller, the verify loop included.
// The exit code is the gate: a harness that prints its failures and exits 0 turns a red suite green for every
// caller, the verify loop included.
if (failures() > 0) {
  process.exitCode = 1;
} else {
  console.log("lean build blocked repair: OK");
}
