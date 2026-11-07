#!/usr/bin/env bun
/**
 * #2064 / #2042 — the excuse's comparison is O(H+B), and a big tier is graded in well
 * under a second.
 *
 * The comparison asks whether every head line is one of the base's. Done by scanning
 * the base set per head line that is O(H*B) — 500 x 500 comparisons, each one
 * classifying a line and calling `realpath` — which turns a chatty suite's red tier
 * into seconds inside the verify step. Both halves are prepared ONCE per
 * `baselineExcuse` call: the two tree roots are resolved once rather than per
 * candidate, and the base set becomes one `Set`, so each head line does one lookup.
 *
 * A wall-clock bound is the assertion a mutant can actually fail, so the case runs
 * over the LONGEST recognised line class — a TAP description carrying a long path and
 * an assertion tail — where a per-candidate rescan of the base is most expensive, not
 * over short pytest tokens.
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
/** The longest line class the shared classifier recognises: a TAP description. */
const PAD = "d".repeat(120);
/** `n` distinct TAP lines, all under one package dir of `prefix`'s tree. */
function names(prefix: string, n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `not ok ${String(i)} - ${prefix}/pkg/t_${String(i)}.sh - ${PAD} expected 3 got 4`,
  );
}
const HEAD_ROOT = "/tmp/pi-rukas-perf-head/worktree";
const PROBE_ROOT = "/tmp/pi-rukas-perf-head/repo.baseline-lean-verify-9";
const HEAD = names(HEAD_ROOT, COUNT);
const BASE = names(PROBE_ROOT, COUNT);

/** The head/base streams the two runs printed — the same lines their readers see. */
const headStream = HEAD.join("\n");
const baseStream = BASE.join("\n");

const RED: BaseProbe = { status: "red" };

function excuseOf(head: string[], base: string[]) {
  return baselineExcuse({
    tierName: "fast",
    cmd: "prove -r t",
    baseSha: "a".repeat(40),
    probe: RED,
    headStream: head.join("\n"),
    baseStream: base.join("\n"),
    headRoot: HEAD_ROOT,
    probeRoot: PROBE_ROOT,
  });
}

{
  const t0 = performance.now();
  const excuse = excuseOf(HEAD, BASE);
  const ms = performance.now() - t0;
  assert(excuse.kind === "excused", `(500x500) every head line matched a base line (${excuse.kind})`);
  assert(
    ms < 300,
    `(500x500) the whole excuse path finished in well under a second (${ms.toFixed(0)}ms for ${String(HEAD.length)} head x ${String(BASE.length)} base lines of ${String((HEAD[0] ?? "").length)} chars; classify+normalise+compare)`,
  );
}

{
  // The set comparison is not a hash collision dressed as a match: one line the base
  // never printed still refuses the excuse at this scale.
  const oneMore = [...HEAD, `not ok 999 - ${HEAD_ROOT}/pkg/t_solo.sh - ${PAD} boom`];
  const excuse = excuseOf(oneMore, BASE);
  assert(excuse.kind === "refused", "(500x500) one unmatched head line still refuses");
}

// Each tree's own root is stripped once per line, so a base whose lines live under a
// DIFFERENT project-relative path must not match, however the two trees are spelled —
// and the two roots being the same tree is never a match.
{
  const shifted = BASE.map((n) => n.replace("/pkg/", "/other/"));
  const excuse = excuseOf(HEAD, shifted);
  assert(excuse.kind === "refused", "(anchoring) a base under another package dir refuses");
  const sameTree = baselineExcuse({
    tierName: "fast",
    cmd: "prove -r t",
    baseSha: "a".repeat(40),
    probe: RED,
    headStream,
    baseStream,
    headRoot: HEAD_ROOT,
    probeRoot: HEAD_ROOT,
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
