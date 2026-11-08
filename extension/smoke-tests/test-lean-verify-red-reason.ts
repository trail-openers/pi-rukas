/**
 * lean/verify-red-reason — the composition rule, judged where it is made.
 *
 * The end-to-end cases in `test-lean-verify-frozen-and-tier.ts` drive the real step.
 * These judge the three arms directly, because two of them are invisible end-to-end
 * from a single case: a GREEN contract must produce byte-identical reasons to the ones
 * the step has always produced (so the ordinary `firstFailure` path is pinned here, not
 * inferred from the absence of a clause), and the baseline arm composes for a HANG it
 * re-ran but not for a plain red it re-ran — a distinction the fixture can only reach
 * by making the contract change colour between two runs of one command.
 */
import { composedBaselineRed, composedTierRed, frozenClause } from "../src/lean/verify-red-reason.ts";

const SELF = "test-lean-verify-red-reason.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const FROZEN = "frozen tests failing: tests/AC1.test.sh (exited 1)";
const HANG = "frozen tests timed out (the head's code may hang): tests/AC1.test.sh";
const TIER = "verify.full exited 1: bun test";
const JOINED = " — and ";

const red = { reason: FROZEN, red: true, judgedBeforeTiers: true };
const redReRun = { reason: FROZEN, red: true, judgedBeforeTiers: false };
const green = frozenClause({ kind: "pass" });

// ------------------------------------------------ (a) the plain tier clause
{
  assert(
    composedTierRed(red, TIER) === `${FROZEN}${JOINED}${TIER}`,
    "(a) a red contract and a red tier become one reason, the contract's clause first",
  );
  assert(
    composedTierRed(green, TIER) === undefined,
    "(a) a green contract composes nothing, so the step's own firstFailure reason stands",
  );
  assert(
    frozenClause({ kind: "pass" }).reason === "",
    "(a) a green contract has no clause to lead with",
  );
  assert(
    frozenClause({ kind: "fail", reason: FROZEN }).red === true,
    "(a) a red contract is read as red",
  );
}

// ---------------------------------------------- (b) the baseline arm's clause
{
  assert(
    composedBaselineRed(red, "full", "bun test", "abc", false) ===
      `${FROZEN}${JOINED}baseline red: tier full is red at the base commit abc — \`bun test\` fails at the base without this run's changes, so no build round can fix it`,
    "(b) a plain red contract composes the arm's own baseline sentence beside it",
  );
  assert(
    composedBaselineRed(green, "full", "bun test", "abc", false) === undefined,
    "(b) a green contract keeps the arm's hand-back, so the `baseline red:` prefix pins hold",
  );
  assert(
    composedBaselineRed(redReRun, "full", "bun test", "abc", false) === undefined,
    "(b) a plain red the arm re-ran after the tier does NOT compose — that colour is not a fact about the tree the tiers started from",
  );
  assert(
    (composedBaselineRed({ ...redReRun, reason: HANG }, "full", "bun test", "abc", true) ?? "").startsWith(HANG),
    "(b) a hang the arm re-ran still composes, because its wording lives or dies on that line",
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
