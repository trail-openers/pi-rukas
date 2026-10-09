#!/usr/bin/env bun
/**
 * #1069 — the offline suite must never touch the REAL per-clone review ledger.
 *
 * The review ledger lives under the git COMMON dir (`review-ledger-path.ts`),
 * and a worktree's common dir resolves to the MAIN clone's .git. Any test
 * that drives a lens or adversarial entry point without its own isolation
 * (the `PI_ENSEMBLE_REVIEW_LEDGER_FILE` override, a temp-repo cwd, or a
 * mocked `appendLedgerEntry`) therefore writes rows into the real per-clone
 * ledger when it runs in a worktree of this clone — the #1069 symptom was a
 * merge refused because the branch's latest lens entry said
 * passed=false/REVIEW_INCOMPLETE although the hand-run review reported
 * APPROVED (a suite run had overwritten the genuine entry).
 *
 * Three checks:
 *   1. the suite env: when the gate (verify-loop.sh) has set
 *      PI_ENSEMBLE_REVIEW_LEDGER_FILE, it names an ABSOLUTE file OUTSIDE
 *      any .git directory (the merge-guard-helpers.ts canary, in env form).
 *   2. a static scan of smoke-tests/*.ts: every file that CALLS a ledger
 *      writer seam (runLensReview / finishLensReview / writeLensLedgerEntry /
 *      appendLedgerEntry / writeAdversarialLedgerEntry / runAdversarialLoop)
 *      must carry one of the known isolation markers, or it is named as a
 *      failure.
 *   3. the scan is proved in both directions (AGENTS.md §12): a deliberately
 *      unisolated fixture IS named, an isolated one is not, the tree is clean,
 *      and the gate still carries the export.
 *
 * The scan is name-based, so an aliased import of a writer seam would evade
 * it; runtime isolation is the primary mechanism.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The seams that end in a real ledger write when driven without isolation:
// the two review entry points (their finish/ledger-write paths), the low
// level writer, and the two explicit writer functions.
const LEADER_SEAMS = [
  "runLensReview(",
  "finishLensReview(",
  "writeLensLedgerEntry(",
  "appendLedgerEntry(",
  "writeAdversarialLedgerEntry(",
  "runAdversarialLoop(",
] as const;

/** True when the line does NOT contain an actual call to a seam. A call is
 * the seam name followed (modulo whitespace) by `(` OUTSIDE a string
 * literal; lines that merely NAME a seam — marker arrays (the token inside
 * quotes, as in test-live-suffix-convention.ts), imports, const destructures
 * from an import, type positions, object-literal values — are not calls.
 * Comments are never calls. */
function isNotACall(line: string): boolean {
  const t = line.trim();
  if (/^(\/\/|\/\*|\*|#!|;)/.test(t)) return true; // comment (incl. doc lines)
  // Strip string literals so a seam named as DATA cannot read as a call;
  // the real call survives because its `(` is code, not a literal.
  const outsideQuotes = t
    .replace(/"[^"\\]*(?:\\.[^"\\])*"/g, "S")
    .replace(/'[^'\\]*(?:\\.[^'\\])*'/g, "S");
  for (const seam of LEADER_SEAMS) {
    const token = seam.slice(0, -1); // the name without its trailing `(`
    const re = new RegExp(token + "\\s*\\(");
    if (re.test(outsideQuotes)) return false; // a real call on this line
  }
  return true;
}

/** The #1069 isolation markers a calling file may carry. Any ONE of these is
 * sufficient; the scan fails a file only when it has a call and none. */
const ISOLATION_MARKERS = [
  // The env override — set by the file itself when run individually
  // (test-review-tools-refrange.ts, merge-guard-helpers.ts,
  // test-auto-delta-base.ts, test-lens-retry-note.ts, ...).
  "PI_ENSEMBLE_REVIEW_LEDGER_FILE",
  // The shared helper module self-isolates on import (lib/
  // review-ledger-test-helpers.ts, #1069) — importing it isolates the file.
  "review-ledger-test-helpers",
  // A mocked writer seam (test-lens-kill-ledger.ts mocks appendLedgerEntry).
  "mock.module",
  // A temp git repo as the write cwd: the writer keys its file on the
  // common dir of the CWD it is given, and these files pass their scratch
  // repo's path — the write lands in the temp dir, never the real ledger.
  "mkdtempSync",
];

/** The scan's own file is exempt: it holds the seam list as data, not calls. */
const EXEMPT_FILES = new Set<string>(["test-ledger-isolation.ts"]);

const SMOKE_TESTS = import.meta.dirname;

// --- 1. the suite env ------------------------------------------------------
{
  const override = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  if (override === undefined || override.trim() === "") {
    console.log(
      "✓ suite env: PI_ENSEMBLE_REVIEW_LEDGER_FILE unset (standalone run — gate's export not in effect; env check skipped)",
    );
  } else {
    const abs = path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
    assert(
      abs.length > 0 && !/([/\\])\.git([/\\]|$)/.test(abs),
      `suite env: the gate's ledger override (${abs}) is NOT inside a .git directory`,
    );
    assert(
      path.isAbsolute(override),
      "suite env: the gate's ledger override is an absolute path",
    );
  }
}

// --- 2. the static scan -----------------------------------------------------

function scanDir(dir: string): string[] {
  const offenders: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith("test-") || !name.endsWith(".ts")) continue;
    if (name.endsWith("-live.ts")) continue; // live tests are out of the offline gate's scope
    if (EXEMPT_FILES.has(name)) continue;
    const file = path.join(dir, name);
    const text = readFileSync(file, "utf8");
    let calls = 0;
    let marker = false;
    for (const line of text.split("\n")) {
      if (ISOLATION_MARKERS.some((m) => line.includes(m))) marker = true;
      if (!LEADER_SEAMS.some((seam) => line.includes(seam))) continue;
      if (isNotACall(line)) continue;
      calls++;
    }
    if (calls > 0 && !marker) offenders.push(name);
  }
  return offenders;
}

const offenders = scanDir(SMOKE_TESTS);
assert(
  offenders.length === 0,
  offenders.length === 0
    ? "static scan: every test that calls a ledger writer seam carries an isolation marker"
    : `static scan: NO isolation marker in: ${offenders.join(", ")} — these drive a real ledger write into the per-clone .git when run in a worktree (#1069)`,
);

// The scan must actually bite: a deliberately unisolated fixture calling a
// seam must be named; an isolated one (env override) must not.
{
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "ledger-iso-scan-"));
  try {
    writeFileSync(
      path.join(fixtureDir, "test-unisolated-fixture.ts"),
      "const r = await runLensReview({ diff: \"d\" } as never);\nvoid r;\n",
    );
    writeFileSync(
      path.join(fixtureDir, "test-isolated-fixture.ts"),
      "process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = \"/tmp/x.json\";\nconst r = await runLensReview({ diff: \"d\" } as never);\nvoid r;\n",
    );
    const found = scanDir(fixtureDir);
    assert(
      found.includes("test-unisolated-fixture.ts"),
      "static scan (canary): a deliberately unisolated file IS named",
    );
    assert(
      !found.includes("test-isolated-fixture.ts"),
      "static scan (canary): an isolated file (env override) is NOT flagged",
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

// The gate must NOT set the env var globally (tests that use temp repos are
// already isolated; a global export would break the ledger tests' round
// counter). Tests that use the real repo's cwd set it themselves.
{
  const gate = path.join(SMOKE_TESTS, "lib", "verify-loop.sh");
  assert(existsSync(gate), "gate: verify-loop.sh exists");
  const gateText = readFileSync(gate, "utf8");
  assert(
    !gateText.includes("export PI_ENSEMBLE_REVIEW_LEDGER_FILE="),
    "gate: verify-loop.sh does NOT export PI_ENSEMBLE_REVIEW_LEDGER_FILE globally",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
