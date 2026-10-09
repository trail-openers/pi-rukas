#!/usr/bin/env bun
/**
 * Issue #1028 — CI-log digest recipe for `gh run view <run-id> --log-failed`.
 *
 * Exercises the standalone digest recipe (lib/ci-log-digest.sh) against a
 * committed recorded fixture (fixtures/ci-log/run-log-failed.txt) that mimics
 * the output shape of `gh run view <run-id> --log-failed`.
 *
 * The recipe strips the `job<TAB>step<TAB>timestamp<TAB>` line prefix, keeps
 * ✗ / FAILED: / ##[error] / error: lines plus their following indented detail
 * lines, and drops every other line — including ✓ lines that happen to contain
 * the word "error" (the anchor is a line-start match, not a substring search).
 *
 * The TS reference below mirrors the recipe's filter exactly (same
 * line-start marker anchor; same "indented" = first char is space-or-tab
 * test) and case 10 asserts byte-equality between the two implementations,
 * so a future edit to the script is forced to mirror the reference (or vice
 * versa) or the suite fails.
 *
 * Cases:
 *   1. Recipe exits 0.
 *   2. ✗ lines survive (both test-gamma and test-delta failures).
 *   3. ##[error] lines survive (smoke-test failure + exit-code line).
 *   4. error: lines survive (`error: expected 200, got 404`).
 *   5. Indented detail lines following a kept marker survive.
 *   6. NO ✓ lines appear — including ✓ lines containing "error" (anchor).
 *   7. The ✓ ... "error" ... trap lines are ABSENT.
 *   8. The job\tstep\ttimestamp prefix is stripped from every line.
 *   9. Non-marker, non-detail lines are dropped (setup, install, etc.).
 *   10. The script output matches the TS reference implementation exactly.
 *   11. The digest is compact (< 728 B, the epic's measured ceiling).
 *   12. All 5 failure markers are present (✗×2, ##[error]×2, error:×1).
 *   13. Unreadable input: a nonexistent path is exit 2 with the stderr
 *       message and NO stdout — distinct from "no failures" (which exits 0
 *       with empty stdout).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.join(__dirname, "fixtures", "ci-log", "run-log-failed.txt");
const DIGEST_SCRIPT = path.join(__dirname, "lib", "ci-log-digest.sh");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function runDigest(fixturePath: string): { status: number; stdout: string } {
  const result = spawnSync("bash", [DIGEST_SCRIPT, fixturePath], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "" };
}

// Read the fixture and compute the expected kept/dropped lines.
const fixtureContent = readFileSync(FIXTURE, "utf-8");
const fixtureLines = fixtureContent.trim().split("\n");

// Helper: strip the job\tstep\ttimestamp\t prefix to get the content.
function stripPrefix(line: string): string {
  let c = line;
  const i1 = c.indexOf("\t");
  if (i1 !== -1) c = c.slice(i1 + 1);
  const i2 = c.indexOf("\t");
  if (i2 !== -1) c = c.slice(i2 + 1);
  const i3 = c.indexOf("\t");
  if (i3 !== -1) c = c.slice(i3 + 1);
  return c;
}

// TypeScript reference mirroring lib/ci-log-digest.sh. Shared contract with
// the script: "indented" means a line whose first character is a space or a
// tab (leading whitespace of any length of either kind) — the same
// two-character test the bash globs `" "*` and `"${TAB}"*` use. The marker
// check trims leading whitespace, then matches at the start of the content
// (line-start anchor, not substring). Indented detail lines are kept only
// when they are NOT markers themselves and do NOT start with ✓ (a check-mark
// line is never detail, even when indented).
function isMarkerLine(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    trimmed.startsWith("✗ ") ||
    trimmed.startsWith("##[error]") ||
    trimmed.startsWith("FAILED:") ||
    trimmed.startsWith("error:")
  );
}

function isCheckMarkLine(content: string): boolean {
  return content.trimStart().startsWith("✓ ");
}

function computeExpected(lines: string[]): string[] {
  const out: string[] = [];
  let state: "idle" | "detail" = "idle";
  for (const raw of lines) {
    const content = stripPrefix(raw);
    if (isMarkerLine(content)) {
      out.push(content);
      state = "detail";
    } else {
      if (state === "detail") {
        if (content.startsWith(" ") || content.startsWith("\t")) {
          // Indented line: keep only if NOT a marker and NOT a ✓ line
          if (!isMarkerLine(content) && !isCheckMarkLine(content)) {
            out.push(content);
          }
        } else {
          state = "idle";
        }
      }
    }
  }
  return out;
}

const expectedLines = computeExpected(fixtureLines);
const { status, stdout } = runDigest(FIXTURE);
const digestLines = stdout.replace(/^\n+|\n+$/g, "").split("\n");

// --- Case 1: exit code is 0 (recipe completed successfully) ---
assert(status === 0, `case 1: digest recipe exits 0 (got ${status})`);

// --- Case 2: ✗ lines survive ---
const xMarkLines = digestLines.filter((l) => l.includes("✗"));
assert(
  xMarkLines.length === 2,
  `case 2: both ✗ lines survive the digest (got ${xMarkLines.length})`,
);
assert(
  digestLines.some((l) => l.includes("test-gamma.ts: 3 failed")),
  "case 2: the test-gamma ✗ line is present",
);
assert(
  digestLines.some((l) => l.includes("test-delta.ts: 1 failed")),
  "case 2: the test-delta ✗ line is present",
);

// --- Case 3: ##[error] lines survive ---
const errorTagLines = digestLines.filter((l) => l.includes("##[error]"));
assert(
  errorTagLines.length === 2,
  `case 3: both ##[error] lines survive (got ${errorTagLines.length})`,
);
assert(
  errorTagLines.some((l) => l.includes("smoke test run failed")),
  "case 3: the smoke-test-failure ##[error] line is present",
);
assert(
  errorTagLines.some((l) => l.includes("exit code 1")),
  "case 3: the exit-code ##[error] line is present",
);

// --- Case 4: error: lines survive ---
const errorColonLines = digestLines.filter((l) => l.trimStart().startsWith("error:"));
assert(
  errorColonLines.length >= 1,
  `case 4: error: lines survive (got ${errorColonLines.length})`,
);
assert(
  digestLines.some((l) => l.includes("expected 200, got 404")),
  "case 4: the 'error: expected 200, got 404' line is present",
);

// --- Case 5: indented detail lines survive ---
const detailLines = digestLines.filter((l) => {
  return l.startsWith("  ") && !isMarkerLine(l) && !isCheckMarkLine(l);
});
assert(
  detailLines.length >= 3,
  `case 5: indented detail lines survive (got ${detailLines.length})`,
);
assert(
  detailLines.some((l) => l.includes("checkAlpha")),
  "case 5: the 'at checkAlpha' detail line is present",
);
assert(
  detailLines.some((l) => l.includes("checkBeta")),
  "case 5: the 'at checkBeta' detail line is present",
);
assert(
  detailLines.some((l) => l.includes("fetchAndCompare")),
  "case 5: the 'at fetchAndCompare' detail line is present",
);

// --- Case 6: ✓ lines are DROPPED ---
const checkMarkLines = digestLines.filter((l) => l.includes("✓"));
assert(
  checkMarkLines.length === 0,
  `case 6: NO ✓ lines appear in the digest (got ${checkMarkLines.length})`,
);

// --- Case 7: ✓ lines containing "error" are DROPPED (the anchor holds) ---
assert(
  !digestLines.some((l) => l.includes("error handling: assertion passed")),
  "case 7: the '✓ error handling: assertion passed' line is ABSENT (anchor holds)",
);
assert(
  !digestLines.some((l) => l.includes("no error handling: assertion passed")),
  "case 7: the '✓ no error handling: assertion passed' line is ABSENT (anchor holds)",
);

// --- Case 8: job\tstep\ttimestamp prefix is stripped ---
const hasPrefix = digestLines.some(
  (l) => l.includes("\t") || /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(l),
);
assert(!hasPrefix, "case 8: the job/step/timestamp prefix is stripped from every line");

// --- Case 9: non-marker, non-detail lines are dropped ---
const noiseLines = [
  "Setting up runner",
  "Running in /home/runner",
  "Git checkout completed",
  "Installing dependencies",
  "bun install completed",
  "Running typecheck",
  "Running lint",
  "Running smoke tests",
];
const droppedNoise = noiseLines.filter((n) => digestLines.some((l) => l.includes(n)));
assert(
  droppedNoise.length === 0,
  `case 9: non-marker, non-detail lines are dropped (found: ${droppedNoise.join(", ") || "none"})`,
);

// --- Case 10: the digest matches the reference implementation exactly ---
const expected = expectedLines.join("\n");
const actual = stdout.replace(/^\n+|\n+$/g, "");
assert(
  actual === expected,
  `case 10: script output matches the reference implementation exactly (${digestLines.length} lines)`,
);

// --- Case 11: the digest is compact ---
assert(
  stdout.length < 728,
  `case 11: the digest is compact (${stdout.length} bytes < 728 B)`,
);

// --- Case 12: the digest catches all 5 failure markers ---
const markerCount = xMarkLines.length + errorTagLines.length + errorColonLines.length;
assert(
  markerCount === 5,
  `case 12: all 5 failure markers are present (✗×${xMarkLines.length}, ##[error]×${errorTagLines.length}, error:×${errorColonLines.length})`,
);

// --- Case 13: unreadable input → exit 2 + stderr message, no stdout ---
// A missing/unreadable input must be distinguishable from "no failures"
// (which exits 0 with empty stdout): the script exits 2 with an explicit
// stderr message and prints nothing.
{
  const missing = path.join(__dirname, "does-not-exist-ci-log-1028.txt");
  const r = spawnSync("bash", [DIGEST_SCRIPT, missing], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
  });
  assert(r.status === 2, `case 13: nonexistent input path exits 2 (got ${r.status})`);
  assert(
    (r.stderr ?? "").includes("ci-log-digest: cannot read input: "),
    `case 13: stderr names the input (got: ${JSON.stringify(r.stderr ?? "")})`,
  );
  assert(
    (r.stdout ?? "").trim() === "",
    `case 13: no stdout on unreadable input (got: ${JSON.stringify(r.stdout ?? "")})`,
  );
}

console.log(exit === 0 ? "\nAll CI-log digest checks passed." : "\nFAILED");
process.exit(exit);
