#!/usr/bin/env bun
/**
 * #2064 round 7 — a green over a new failure is the one outcome this feature must never produce.
 *
 * Every line whose text carries a failure word anywhere is compared with ONLY its pass counts
 * allowed to move. The four pairs below are the false greens the previous rule excused.
 */
import { failureLineFold } from "../src/lean/verify-baseline-counters.ts";
import { baselineExcuse } from "../src/lean/verify-baseline-excuse.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";

const SELF = "test-AC17b-baseline-excuse-pass-only.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const RED: BaseProbe = { status: "red" };
function excuseOf(headLines: string[], baseLines: string[]) {
  return baselineExcuse({
    tierName: "fast",
    cmd: "sh -c 'the tier'",
    baseSha: "b".repeat(40),
    probe: RED,
    headStream: headLines.join("\n"),
    baseStream: baseLines.join("\n"),
    headRoot: "/tmp/pi-rukas-2064-passonly/worktree",
    probeRoot: "/tmp/pi-rukas-2064-passonly/repo.baseline-lean-verify-9",
  });
}

const RED_LINE = "FAILED tests/x_test.py::test_a - AssertionError";

const MUST_REFUSE: [string, string, string][] = [
  ["tests/x_test.py: 1 items failed", "tests/x_test.py: 2 items failed", "the JUnit-style `N items failed` row gained a failed check"],
  ["tests: 1 failed", "tests: 2 failed", "a `tests:` label whose failed count moved"],
  ["Tests run: 3, Failures: 1", "Tests run: 3, Failures: 2", "the Surefire failure count moved"],
  ["Tests run: 3, Failures: 1", "Tests run: 5, Failures: 1", "the JUnit moved run total, refused by design (the accepted cost)"],
];

for (const [head, base, why] of MUST_REFUSE) {
  assert(
    failureLineFold(head) !== failureLineFold(base),
    `(refuse) ${why} keeps its digits (${failureLineFold(head)} / ${failureLineFold(base)})`,
  );
  assert(
    excuseOf([RED_LINE, head], [RED_LINE, base]).kind === "refused",
    `(refuse) ${why} refuses the excuse (${excuseOf([RED_LINE, head], [RED_LINE, base]).kind})`,
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
