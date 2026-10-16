#!/usr/bin/env bun
/**
 * merge-allowlist-harness — the ONE place the allowlist suite builds a
 * 30 kB command and asserts the hook budget on it (#962 review).
 *
 * A 30 kB command is one `readMergeCommand` call; two tests asking for it is
 * two. The first split of this suite left the perf block duplicated verbatim
 * in `test-merge-guard-allowlist.ts` and its sibling test file, and the
 * duplicated pair drifted on its own (a bound that lives twice is only
 * enforced once). `readMergeCommand` is pure, so calling it here costs
 * microseconds and no fixture.
 */

import { readMergeCommand } from "../../src/merge-allowlist.ts";
import { assert } from "../merge-guard-helpers.ts";

/** The smallest command length the perf block will accept as "big enough". */
const MIN_BIG_COMMAND_CHARS = 30_000;

/** Per-call budget (ms). The hook itself has a 30s budget; analysis is two
 * orders of magnitude inside it, and this asserts it stays that way. */
const PERF_BUDGET_MS = 50;

/**
 * The 30 kB shapes. Each row is a distinct quadratic risk the #962 review
 * found: a long accepted merge, a substitution flood, a brace-run flood (the
 * one that WAS quadratic under an unbounded expansion pattern), and a long
 * non-merge the reader never touches as such.
 */
const BIG_COMMANDS: Array<[string, string, "merge" | "refused" | "none"]> = [
  ["30 kB accepted merge", `gh pr merge 17 --subject '${"merge ".repeat(5000)}'`, "merge"],
  ["30 kB substitution flood", `gh ${"$(merge ".repeat(5000)}`, "refused"],
  ["30 kB brace-run flood", `gh {${"a,".repeat(15_000)}`, "none"],
  ["30 kB non-merge", `git commit -m '${"x".repeat(30_000)}'`, "none"],
];

/**
 * Assert every 30 kB command is read as the kind it must be, well inside the
 * hook budget. The bound is asserted per command, so one fast row can no
 * longer hide a regression in another.
 */
export function assertBigCommandsInsideBudget() {
  for (const [label, cmd, kind] of BIG_COMMANDS) {
    const t0 = performance.now();
    const m = readMergeCommand(cmd);
    const dt = performance.now() - t0;
    assert(cmd.length >= MIN_BIG_COMMAND_CHARS && m.kind === kind, `perf: ${label} → ${kind}`);
    assert(
      dt < PERF_BUDGET_MS,
      `perf: ${label} analysed in ${dt.toFixed(1)}ms (< ${PERF_BUDGET_MS}ms; hook budget 30s)`,
    );
  }
}
