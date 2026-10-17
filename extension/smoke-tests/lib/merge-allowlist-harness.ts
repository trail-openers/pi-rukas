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
 * The 30 kB shapes. Each row is a distinct risk the #962 review found: a long
 * accepted merge, a substitution flood, a brace-run flood (the one that WAS
 * quadratic under an unbounded expansion pattern), and a long non-merge the
 * reader never touches as such.
 *
 * #1417 — three things are asserted on each row now, and each one is a
 * separate property that has already drifted once when it was left implicit:
 *
 *   - `kind` — what the row was asserting before the bound existed;
 *   - `code` — WHY it is that kind. A row pinned only by `kind` flips silently
 *     when a bound changes: `refused` for "too long to read" and `refused` for
 *     "outside the grammar" are different decisions, and the #955 failure mode
 *     is precisely a forge command that answered `none` because nobody read it.
 *   - the timing budget, unchanged, which is why these rows exist.
 *
 * The bound now holds merge-bearing commands only, so the rows split cleanly:
 * the merge and the substitution flood spell a merge word and are bounded
 * (`too-large`); the brace flood spells none and answers `none` on its merits
 * while the linear brace pattern runs; the `git commit` names no forge.
 */
const BIG_COMMANDS: Array<
  [string, string, "merge" | "refused" | "none", string | undefined]
> = [
  // Past the bound, so HELD — `kind` alone would pass for the wrong reason,
  // which is why the code is pinned: it must be the bound refusing, not the
  // grammar, and never `none` (the #955 fall-through).
  [
    "30 kB accepted merge",
    `gh pr merge 17 --subject '${"merge ".repeat(5000)}'`,
    "refused",
    "too-large",
  ],
  ["30 kB substitution flood", `gh ${"$(merge ".repeat(5000)}`, "refused", "too-large"],
  // The brace flood spells no merge word, so the bound does not apply and the
  // reader walks the whole 30 kB — which is the quadratic risk this row exists
  // to time. `none` is its honest answer, not an unread pass.
  ["30 kB brace-run flood", `gh {${"a,".repeat(15_000)}`, "none", undefined],
  // No forge word: never bounded, whatever length it reaches.
  ["30 kB non-merge", `git commit -m '${"x".repeat(30_000)}'`, "none", undefined],
];

/**
 * Assert every 30 kB command is read as the kind AND the reason it must be,
 * well inside the hook budget. The bound is asserted per command, so one fast
 * row can no longer hide a regression in another.
 */
export function assertBigCommandsInsideBudget() {
  for (const [label, cmd, kind, code] of BIG_COMMANDS) {
    const t0 = performance.now();
    const m = readMergeCommand(cmd);
    const dt = performance.now() - t0;
    assert(cmd.length >= MIN_BIG_COMMAND_CHARS && m.kind === kind, `perf: ${label} → ${kind}`);
    assert(
      kind === "refused" ? m.kind === "refused" && m.reason === code : m.kind === kind,
      `perf: ${label} → ${kind}${code === undefined ? "" : ` as ${code}`} (${JSON.stringify(m).slice(0, 90)})`,
    );
    assert(
      dt < PERF_BUDGET_MS,
      `perf: ${label} analysed in ${dt.toFixed(1)}ms (< ${PERF_BUDGET_MS}ms; hook budget 30s)`,
    );
  }
}
