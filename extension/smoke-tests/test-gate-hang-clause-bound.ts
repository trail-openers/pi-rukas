#!/usr/bin/env bun
/**
 * Offline smoke: #1427 round 4 — `MAX_WHO_CHARS` is DERIVED, and tested at the
 * adversarial maximum rather than at the measured case.
 *
 * Split out of `test-gate-hang-report.ts` for AGENTS.md §12's 500-line gate;
 * round 4's worst-case block pushed that file over the cap, and a size ratchet
 * that forces the deletion of its own regression test is a ratchet that has
 * started costing more than it saves.
 *
 * Round 3 sized the name-list bound at a flat 480 and reasoned about it in
 * prose. The bound has to survive the WORST clause the module can emit, not the
 * measured one: ten names each at the per-name cap (`MAX_TEST_NAME_CHARS`, which
 * `extractRunningTests` enforces), plus the process count, plus
 * `deepestCommands`' two leaf commands each at `MAX_ARGS_CHARS`, plus the #1324
 * headline — all inside the 800-char tail `boundFailure` keeps, which is a plain
 * `slice(-800)` because a timeout string carries no `FAILED:` marker. If any one
 * of those is wider than the arithmetic assumed, `[verify-timeout]` leaves the
 * window and a killed run is capped as an ordinary code failure rather than the
 * `verify-timeout:develop` the operator can act on.
 *
 * Run:
 *   cd extension && bun run smoke-tests/test-gate-hang-clause-bound.ts
 */

import { extractAttributedTail } from "../src/work-driver-exec-error.ts";
import { GATE_HANG_LABEL, type HangProcess, MAX_ARGS_CHARS, gateHangClause } from "../src/work-driver-gate-hang.ts";
import { verifyHangFailure } from "../src/work-driver-verify-develop-helpers.ts";

let failures = 0;
function expect(cond: boolean, label: string) {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ ${label}`);
    failures += 1;
  }
}

const maxName = "z".repeat(120);
const tenMaxNames = Array.from({ length: 10 }, () => maxName);
const maxArgs = "q".repeat(MAX_ARGS_CHARS);

// Two leaves, both at the maximum length, and nothing in the tree claims either
// as a parent — the shape `deepestCommands` renders in full.
const worstTree: HangProcess[] = [
  { pid: 10, ppid: 1, etime: "99:99:99", args: `parent ${maxArgs}`.slice(0, MAX_ARGS_CHARS) },
  { pid: 11, ppid: 10, etime: "99:99:99", args: maxArgs },
  { pid: 12, ppid: 10, etime: "99:99:99", args: `${maxArgs}b`.slice(0, MAX_ARGS_CHARS) },
];

function main() {
  const worst = gateHangClause({
    runningTests: tenMaxNames,
    cmd: "cargo test",
    cwd: "/wt/a",
    timeoutMs: 1_800_000,
    processes: worstTree,
  });
  // The clause the seam actually emits is built through `verifyHangFailure`, so
  // the number asserted below is the number shipped, not a re-derivation of it.
  const stream = tenMaxNames
    .map((n) => `test ${n} has been running for over 60 seconds`)
    .join("\n");
  const failure = verifyHangFailure("cargo test", "in /wt/a", 1_800_000, {
    output: stream,
    cmd: "cargo test",
    cwd: "/wt/a",
    timeoutMs: 1_800_000,
    tree: { processes: worstTree },
  });

  expect(
    worst.includes("\u2026"),
    "worst case: the name list really is clipped (an unclipped worst case means the bound is not biting)",
  );

  const tail = extractAttributedTail(failure, 800).tail;
  expect(
    tail.includes("[verify-timeout]"),
    `worst case: [verify-timeout] survives the 800-char tail at the adversarial maximum (clause ${worst.length}, failure ${failure.length})`,
  );
  expect(
    tail.includes(GATE_HANG_LABEL),
    "worst case: and the hang clause is still inside the window, not just the marker",
  );
  // Both leaf commands the clause named are inside the window: the operator gets
  // the actionable half of the report even at the maximum width.
  expect(
    tail.split(maxArgs).length - 1 >= 2,
    `worst case: both max-length leaf commands are still in the bounded string (${tail.split(maxArgs).length - 1})`,
  );
  expect(
    tail.includes("3 process(es)"),
    `worst case: the process count survives too (${tail.slice(-160)})`,
  );

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n✓ gate hang clause bound smoke passed");
}

main();
