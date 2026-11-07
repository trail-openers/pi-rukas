#!/usr/bin/env bun
/**
 * #2064 pass 8 — the harness's OWN kill stamp is still a failure word.
 *
 * {@link harnessWordsRemoved} exists to discount the executor's SENTENCES — the `Command failed:`
 * prefix, the `$ `/`+ ` trace markers — so their spelling cannot veto a tier's echo of its own clean
 * command. Pass 7 added a branch that went further: when the stripped text was one of the harness's
 * own full-line forms, the helper returned the empty string, which blanks the harness's own FAILURE
 * WORDS as well as its prefixes. `killed`, `killed by signal SIGTERM` and `Exit code: 1` are all
 * harness forms and all spell failures, so the invariant in {@link judgeableLines} read them as
 * declaring nothing, the harness door then removed the line, and a head-only kill stamp was EXCUSED —
 * the tier graded green over a run nothing judged.
 *
 * The fix is the deletion of that branch. The harness door still excuses the harness's writing, and
 * it does so on the RAW line in {@link judgeableLines}; what the helper may discount is therefore
 * only the prefix, and after it the invariant reads `killed` and `Exit code: N` as failure words.
 *
 * The half the fix does NOT touch, pinned as the control: a line that declares nothing and only
 * carries the executor's prefix (`$ bats t/`) is still exempt, and an identical kill stamp that the
 * BASE printed too still excuses — a kill both runs is not a failure this run authored.
 *
 *   (refuse) head-only `killed`, `killed by signal SIGTERM`, `Exit code: 1`, `$ killed` and
 *     `$ Exit code: 1` each refuse through `baselineExcuse`, which is what a green is graded on;
 *   (refuse) each stays judgeable at the stream door, which is where the exemption is applied;
 *   (excuse) the same stamp present in BOTH streams still excuses.
 */
import { judgeableLines } from "../src/lean/verify-baseline-allow-list.ts";
import { declaresFailure } from "../src/lean/verify-baseline-veto.ts";
import { baselineExcuse } from "../src/lean/verify-baseline-excuse.ts";
import { harnessWordsRemoved } from "../src/lean/verify-baseline-harness.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";

const SELF = "test-AC17d-baseline-excuse-harness-kill-stamp.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const RED: BaseProbe = { status: "red" };
const HEAD_ROOT = "/tmp/pi-rukas-2064-killstamp/worktree";
const PROBE_ROOT = "/tmp/pi-rukas-2064-killstamp/repo.baseline-lean-verify-9";
const TIER_CMD = "sh -c 'the tier'";

function excuseOf(headLines: string[], baseLines: string[]) {
  return baselineExcuse({
    tierName: "fast",
    cmd: TIER_CMD,
    baseSha: "b".repeat(40),
    probe: RED,
    headStream: headLines.join("\n"),
    baseStream: baseLines.join("\n"),
    headRoot: HEAD_ROOT,
    probeRoot: PROBE_ROOT,
  });
}

/** A recognised failure line every case uses as its excusable spine. */
const RED_LINE = "FAILED tests/x_test.py::test_a - AssertionError";

/** The harness's own kill stamps, with and without the executor's trace prefix. */
const KILL_STAMPS = [
  "killed",
  "killed by signal SIGTERM",
  "Exit code: 1",
  "$ killed",
  "$ Exit code: 1",
];

// --------- (refuse) a head-only kill stamp is not the harness's to excuse
for (const line of KILL_STAMPS) {
  assert(
    declaresFailure(harnessWordsRemoved(line)),
    `(veto) "${line}" still declares a failure once the harness prefix is discounted (${JSON.stringify(harnessWordsRemoved(line))})`,
  );
  assert(
    judgeableLines(line).length === 1,
    `(veto) head-only "${line}" stays judgeable at the stream door (${judgeableLines(line).length})`,
  );
  assert(
    excuseOf([RED_LINE, line], [RED_LINE]).kind === "refused",
    `(refuse) head-only "${line}" refuses the excuse (${excuseOf([RED_LINE, line], [RED_LINE]).kind})`,
  );
}

// --------- (excuse) a kill stamp BOTH runs printed is not this run's failure
for (const line of KILL_STAMPS) {
  assert(
    excuseOf([RED_LINE, line], [RED_LINE, line]).kind === "excused",
    `(excuse) "${line}" present in both streams still excuses (${excuseOf([RED_LINE, line], [RED_LINE, line]).kind})`,
  );
}

// --------- (control) a traced command that names no failure keeps its exemption
assert(
  !declaresFailure(harnessWordsRemoved("$ bats t/")),
  `(control) "$ bats t/" declares no failure after the prefix is discounted (${JSON.stringify(harnessWordsRemoved("$ bats t/"))})`,
);
assert(
  judgeableLines("$ bats t/").length === 0,
  `(control) "$ bats t/" is still exempt as a traced command (${judgeableLines("$ bats t/").length})`,
);
assert(
  excuseOf([RED_LINE, "$ bats t/"], [RED_LINE]).kind === "excused",
  `(control) head-only "$ bats t/" still excuses (${excuseOf([RED_LINE, "$ bats t/"], [RED_LINE]).kind})`,
);

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
