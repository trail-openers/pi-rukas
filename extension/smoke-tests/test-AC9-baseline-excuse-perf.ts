#!/usr/bin/env bun
/**
 * #2042 — the excuse's subset test is O(H+B), and a big tier is graded in well
 * under a second.
 *
 * The subset test compares every head name against the base set. Done by scanning
 * the base set per head name that is O(H*B) — 500 x 500 comparisons, each one
 * anchoring a path and calling `realpath` — which turns a chatty suite's red tier
 * into seconds inside the verify step. Both halves are now prepared ONCE per
 * `baselineExcuse` call: the two tree roots are resolved once rather than per
 * candidate, and base identities are indexed by their anchored relative name, so
 * each head name does one map lookup.
 *
 * A wall-clock bound is the assertion a mutant can actually fail: the same
 * fixture under the old shape is measurably slower, so the case is asserted to
 * finish inside a fraction of a second, not merely to be correct.
 */
import {
  baselineProbeWorktreePath,
  type BaseProbe,
} from "../src/lean/verify-baseline.ts";
import { baselineExcuse } from "../src/lean/verify-baseline-excuse.ts";

const SELF = "test-AC9-baseline-excuse-perf.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const COUNT = 500;
/** `n` distinct project-relative pytest identities, all under one package dir. */
function names(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `tests/pkg_${prefix}/test_${prefix}_${String(i)}.py::test_case_${String(i)}`);
}
const HEAD = names("head", COUNT);
const BASE = names("head", COUNT);

/** The head/base streams the two runs printed — the same lines their parsers see. */
const headStream = HEAD.map((n) => `FAILED ${n} - AssertionError`).join("\n");
const baseStream = BASE.map((n) => `FAILED ${n} - AssertionError`).join("\n");

const RED: BaseProbe = { status: "red" };
const roots = {
  headRoot: "/tmp/pi-rukas-perf-head/worktree",
  probeRoot: "/tmp/pi-rukas-perf-head/repo.baseline-lean-verify-9",
};

function excuseOf(head: string[], base: string[]) {
  return baselineExcuse({
    tierName: "fast",
    cmd: "pytest -q",
    baseSha: "a".repeat(40),
    probe: RED,
    headStream: head.map((n) => `FAILED ${n} - AssertionError`).join("\n"),
    baseStream: base.map((n) => `FAILED ${n} - AssertionError`).join("\n"),
    headRoot: roots.headRoot,
    probeRoot: roots.probeRoot,
  });
}

{
  const t0 = performance.now();
  const excuse = excuseOf(HEAD, BASE);
  const ms = performance.now() - t0;
  assert(
    excuse.kind === "excused",
    `(500x500) every head name matched a base name (${excuse.kind})`,
  );
  assert(
    ms < 300,
    `(500x500) the whole excuse path finished in well under a second (${ms.toFixed(0)}ms for ${String(HEAD.length)} head x ${String(BASE.length)} base names; parse+classify+subset)`,
  );
}

{
  // The indexed comparison is not a hash collision dressed as a match: one name
  // the base never printed still refuses the excuse at this scale.
  const oneMore = [...HEAD, "tests/pkg_head/test_solo.py::test_solo"];
  const excuse = excuseOf(oneMore, BASE);
  assert(excuse.kind === "refused", "(500x500) one unmatched head name still refuses");
}

// The anchored index anchors each side's relative name once: a base name whose
// path lives under a DIFFERENT package must not match, however the two trees are
// spelled, and the two roots being the same tree is never a match.
{
  const shifted = BASE.map((n) => n.replace("tests/pkg_head/", "tests/pkg_other/"));
  const excuse = excuseOf(HEAD, shifted);
  assert(excuse.kind === "refused", "(anchoring) a base under another package dir refuses");
  const sameTree = baselineExcuse({
    tierName: "fast",
    cmd: "pytest -q",
    baseSha: "a".repeat(40),
    probe: RED,
    headStream,
    baseStream,
    headRoot: "/tmp/pi-rukas-perf-head/worktree",
    probeRoot: "/tmp/pi-rukas-perf-head/worktree",
  });
  assert(sameTree.kind === "refused", "(anchoring) two spellings of one tree match nothing");
}

{
  // The probe path the caller passes is derived, not invented here: a real
  // `baselineProbeWorktreePath` root is a sibling of the repo.
  const probeRoot = baselineProbeWorktreePath("/tmp/pi-rukas-perf-head/repo", 9);
  assert(
    probeRoot === "/tmp/pi-rukas-perf-head/repo.baseline-lean-verify-9",
    `(roots) the probe root is the sibling tree the probe used (${probeRoot})`,
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
