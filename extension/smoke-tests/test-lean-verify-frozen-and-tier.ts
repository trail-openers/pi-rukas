#!/usr/bin/env bun
/**
 * lean/verify — a red frozen contract does not hide the red project tier beside it.
 *
 * The frozen tests run before the project tiers, and the step reports the FIRST
 * failure among them. That order used to be the whole story: with the frozen tests
 * red, the reason named only the contract, and a project tier that was ALSO red at
 * head (a repo-wide suite the change broke) was never reported. The builder fixed
 * the frozen files, the next verify found the tier, and the build attempts were
 * spent on one defect at a time.
 *
 * These cases pin the composed reason, and pin the cost beside it: the composition
 * is a reason change, not extra runs. `full` is the only tier that ever goes red
 * here, and a red tier's own history — its re-run at head, then the probe that asks
 * the base the same command — decides the counters. A flake's history ends at its
 * green re-run and pays no probe; a red contract that the step already judged is
 * never run a second time. The same tier shapes, run with a GREEN contract, are the
 * baseline the numbers are read against, so no case can move them unnoticed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GREEN_TEST,
  PASS_TIER,
  RED_ACCEPTANCE_TEST,
  ROOTS,
  flakeTier,
  pytestFailTier,
  runVerify,
} from "./lib/lean-verify-fixture.ts";
import { failTier } from "./lib/lean-verify-tiers.ts";

const SELF = "test-lean-verify-frozen-and-tier.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

/** What one case spent: the tier's runs at head, the base probe's, the contract's. */
type Cost = { tierRuns?: number; baseTierRuns?: number; frozenRuns?: number };
function cost(r: Cost): string {
  return `${String(r.tierRuns)}/${String(r.baseTierRuns)}/${String(r.frozenRuns)}`;
}

const FROZEN_HEAD = "frozen tests failing";
/** The red tier both halves of pair (a) configure, so both really ask about one command. */
const RED_FULL = failTier("repo-wide");
/**
 * The failure lines the baseline arm's tier prints, in the runner's own form.
 *
 * The arm's precondition is declared as the cases that grew it declare it — the base
 * really ran the tier red and really printed these lines there, and the head stream
 * carries one line the base never printed, so the narrower excuse is refused and the
 * arm's own hand-back is the thing that composes. What stays this case's own is which
 * tier is red (an ordinary red `fast` would end the loop before the arm was reached).
 */
const NAMES = [
  "FAILED tests/x_test.py::test_a - Assert",
  "FAILED tests/x_test.py::test_b - Assert",
];

// --------- (a) frozen red AND a tier red at head: both clauses, at the same cost
{
  const red = await runVerify({
    issue: 601,
    // The run's own contract is red whatever the tree holds; the fixture's naming
    // runner makes that a plain red rather than an `unclear` one.
    frozenText: RED_ACCEPTANCE_TEST,
    alwaysRedFrozen: true,
    config: { fast: PASS_TIER },
    // The second tier is the repo-wide suite the change broke: red at head, green at
    // the base, so nothing excuses it.
    full: RED_FULL,
    headTierRedRuns: 2,
  });
  const reason = red.outcome?.reason ?? "";
  assert(
    red.threw === undefined && red.outcome?.kind === "red",
    `(a) one red for both defects (got ${red.outcome?.kind ?? `threw: ${red.threw?.message}`})`,
  );
  assert(
    reason.startsWith(FROZEN_HEAD),
    `(a) the reason leads with the frozen clause (${reason.slice(0, 110)})`,
  );
  assert(
    reason.includes("verify.full exited 1"),
    `(a) naming which tier broke (${reason.slice(0, 180)})`,
  );
  assert(
    reason.includes("tier-said-repo-wide"),
    `(a) and carrying the tier's own output, which is what the builder acts on (${reason.slice(0, 180)})`,
  );

  // The same tier shapes with the contract GREEN: the cost baseline the pair above
  // must match, run here rather than quoted from another file's case.
  const green = await runVerify({
    issue: 604,
    frozenText: GREEN_TEST,
    config: { fast: PASS_TIER },
    full: RED_FULL,
    headTierRedRuns: 2,
  });
  assert(
    green.outcome?.kind === "red" && !(green.outcome?.reason ?? "").includes(FROZEN_HEAD),
    `(a) the green-contract baseline is the tier's own red (${cost(green)})`,
  );
  assert(
    cost(red) === cost(green) && cost(green) === "4/0/1",
    `(a) composing both clauses costs nothing extra: red ${cost(red)} = green ${cost(green)}, and a red tier is still run at head twice with no base run to skip (${cost(red)})`,
  );
  assert(
    red.frozenRuns === 1,
    `(a) the red contract the step already judged is not run a second time (${String(red.frozenRuns)})`,
  );
}

// ---- (b) the baseline arm with a plain frozen red: frozen clause, then baseline
{
  // One tier is enough to make the point and keeps the pair honest: `firstFailure`
  // reports the FIRST red, so a red `fast` would have hidden the `full` this case is
  // about. The command is red at head twice AND at the base, and the base really ran
  // it red with the SAME lines the head printed — the arm's precondition, not a stub —
  // while the head stream carries one line the base never printed, so the narrower
  // excuse is refused and the arm's own hand-back is what composes.
  const ARM = pytestFailTier("base-already", NAMES);
  const HEAD_STREAM = `${NAMES.join("\n")}\nFAILED tests/new_test.py::test_mine - Assert`;
  const red = await runVerify({
    issue: 602,
    frozenText: RED_ACCEPTANCE_TEST,
    alwaysRedFrozen: true,
    // The base carries its own failing copy of the run's gate, so the probe sees a
    // red base: the arm that used to answer with `baseline red:` alone.
    baseRedContract: true,
    config: { fast: ARM },
    headTierRedRuns: 2,
    headTierOutput: HEAD_STREAM,
    baseTierOutput: NAMES.join("\n"),
  });
  const reason = red.outcome?.reason ?? "";
  assert(
    red.threw === undefined && red.outcome?.kind === "red",
    `(b) still one red (got ${red.outcome?.kind ?? `threw: ${red.threw?.message}`})`,
  );
  assert(
    reason.startsWith(FROZEN_HEAD),
    `(b) the frozen clause still comes first (${reason.slice(0, 110)})`,
  );
  assert(
    reason.includes("baseline red:") && reason.includes("tier fast"),
    `(b) and the baseline verdict is still stated, naming the tier (${reason.slice(0, 230)})`,
  );

  const green = await runVerify({
    issue: 605,
    // The same tier shape and the same two trees as the red half, with only the
    // contract's colour between them: GREEN on the step's first pass, so the arm
    // re-asks it after the tier ran and its clause is NOT composed. That the two
    // `frozenRuns` differ (1 vs 2) is the arm's long-standing second look, not the
    // composition running anything; the tier counters are identical either way.
    frozenText: GREEN_TEST,
    baseRedContract: true,
    config: { fast: ARM },
    headTierRedRuns: 2,
    headTierOutput: HEAD_STREAM,
    baseTierOutput: NAMES.join("\n"),
  });
  assert(
    (green.outcome?.reason ?? "").startsWith("baseline red:") &&
      !(green.outcome?.reason ?? "").includes(FROZEN_HEAD),
    `(b) a contract the arm had to re-judge keeps the arm's own wording, prefix and all (${(green.outcome?.reason ?? "").slice(0, 60)})`,
  );
  assert(
    red.tierRuns === green.tierRuns && red.baseTierRuns === green.baseTierRuns,
    `(b) and the arm pays the same at the tiers either way: red ${cost(red)} vs green ${cost(green)} — two runs at head, one at the base, and the contract only ever re-run when it was GREEN the first time (${cost(red)} vs ${cost(green)})`,
  );
  assert(
    red.frozenRuns === 1 && green.frozenRuns === 2,
    `(b) a red contract the step already judged is not run again, a green one is re-asked by the arm as it always was (${String(red.frozenRuns)} vs ${String(green.frozenRuns)})`,
  );
}

// ------------------------ (c) a flaky tier beside a red contract: no tier clause
{
  // The scratch dir the flake's marker file lives in, off the harness's temp root like
  // every other fixture dir here — a literal `/tmp` makes the case depend on that one
  // filesystem having room and on that one path being writable.
  const flakyScratch = mkdtempSync(join(tmpdir(), "lean-flake-"));
  const flaky = (n: number): string => flakeTier("flake", join(flakyScratch, `n${String(n)}`));
  const red = await runVerify({
    issue: 603,
    frozenText: RED_ACCEPTANCE_TEST,
    alwaysRedFrozen: true,
    config: { fast: PASS_TIER },
    full: flaky(1),
    // Red on its first run, green on the step's re-run — a real second spawn.
    headTierRedRuns: 1,
  });
  const reason = red.outcome?.reason ?? "";
  assert(
    red.threw === undefined && red.outcome?.kind === "red",
    `(c) the run is still red on its contract (got ${red.outcome?.kind ?? `threw: ${red.threw?.message}`})`,
  );
  assert(
    reason.startsWith(FROZEN_HEAD) && !reason.includes("tier-said-flake"),
    `(c) a tier that went green on its re-run adds no clause (${reason.slice(0, 180)})`,
  );

  const green = await runVerify({
    issue: 606,
    frozenText: GREEN_TEST,
    config: { fast: PASS_TIER },
    full: flaky(2),
    headTierRedRuns: 1,
  });
  assert(
    green.outcome?.kind === "green" && (green.outcome?.reason ?? "").includes("flake"),
    `(c) the green-contract baseline really did see the flake it excused (${cost(green)})`,
  );
  assert(
    cost(red) === cost(green) && cost(green) === "3/0/1",
    `(c) and the flake costs the same either way — its two runs, no base probe, one look at the contract: red ${cost(red)} = green ${cost(green)}`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
