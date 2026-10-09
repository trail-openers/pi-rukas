#!/usr/bin/env bun
/**
 * Issue #1028 — CI-log digest recipe for `gh run view <run-id> --log-failed`.
 *
 * A deterministic failure digest for CI logs: strips the
 * `job<TAB>step<TAB>timestamp<TAB>` line prefix, keeps ✗ / FAILED: /
 * ##[error] / error lines plus their following indented detail lines,
 * and drops every other line — including ✓ lines that happen to contain
 * the word "error" (the anchor must be at line start, not a substring match).
 *
 * The recipe is exercised against a committed recorded fixture
 * (fixtures/ci-log/run-log-failed.txt) that mimics the output shape of
 * `gh run view <run-id> --log-failed`.
 *
 * Cases:
 *   1. ✗ lines survive the digest (both the test-gamma and test-delta failures).
 *   2. ##[error] lines survive (both the smoke-test failure and the exit-code line).
 *   3. error: lines survive (the `error: expected 200, got 404` line).
 *   4. Indented detail lines following a kept marker survive.
 *   5. ✓ lines are DROPPED — including ✓ lines that contain the word "error".
 *   6. The `job<TAB>step<TAB>timestamp<TAB>` prefix is stripped from every line.
 *   7. Non-marker, non-detail lines are dropped (setup, install, etc.).
 *   8. The indented-detail attribution stops at the first non-indented line.
 *   9. The bash recipe output matches the TypeScript reference implementation.
 *   10. The digest is compact (well under the 728 B measured in the epic).
 *   11. All 5 failure markers are present (✗ × 2, ##[error] × 2, error: × 1).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.join(__dirname, "fixtures", "ci-log", "run-log-failed.txt");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --- The CI-log digest recipe ---
//
// A small bash script that reads a CI log (from a file arg) and prints the
// digest. The filter is anchored: each keep pattern matches at the start of
// the stripped content (after the job/step/timestamp prefix). A ✓ line that
// contains "error" mid-text is dropped because the pattern is a line-start
// match, not a substring search.
//
// The recipe trims leading whitespace from the stripped content for marker
// detection, then prints the original (untrimmed) line. This handles the 2-space
// indent that CI logs add after the timestamp prefix while keeping the anchor
// at the start of the logical line (after leading whitespace).
//
// Indented detail lines are only kept if they are NOT markers themselves AND
// do NOT start with ✓ (a check-mark line is never a detail line, even if
// indented). This prevents ✓ lines from leaking into the digest as "detail".
//
// The recipe is written to a temp file and executed via `bash <file>` to
// avoid template-literal escaping issues with bash parameter expansions.

const DIGEST_SCRIPT_SOURCE = [
  "TAB=$(printf '\\t')",
  "set -u",
  'input=""',
  'if [ "$#" -ge 1 ]; then',
  '  input="$(cat "$1")"',
  "else",
  '  input="$(cat)"',
  "fi",
  "state=idle",
  "while IFS= read -r raw || [ -n \"$raw\" ]; do",
  '  content="$raw"',
  '  content="${content#*${TAB}}"',
  '  content="${content#*${TAB}}"',
  '  content="${content#*${TAB}}"',
  '  trimmed="${content#"${content%%[![:space:]]*}"}"',
  "  is_marker=0",
  '  case "$trimmed" in',
  '    "✗ "*) is_marker=1 ;;',
  '    "##[error]"*) is_marker=1 ;;',
  '    "FAILED:"*) is_marker=1 ;;',
  '    "error:"*) is_marker=1 ;;',
  "  esac",
  '  if [ "$is_marker" -eq 1 ]; then',
  '    echo "$content"',
  "    state=detail",
  "  else",
  '    if [ "$state" = "detail" ]; then',
  '      case "$content" in',
  '        " "*)',
  '          case "$trimmed" in',
  '            "✗ "*) : ;;',
  '            "✓ "*) : ;;',
  '            "##[error]"*) : ;;',
  '            "FAILED:"*) : ;;',
  '            "error:"*) : ;;',
  '            *) echo "$content";;',
  "          esac",
  "        ;;",
  '        "${TAB}"*)',
  '          case "$trimmed" in',
  '            "✗ "*) : ;;',
  '            "✓ "*) : ;;',
  '            "##[error]"*) : ;;',
  '            "FAILED:"*) : ;;',
  '            "error:"*) : ;;',
  '            *) echo "$content";;',
  "          esac",
  "        ;;",
  "        *) state=idle;;",
  "      esac",
  "    else",
  "      state=idle",
  "    fi",
  "  fi",
  'done <<< "$input"',
].join("\n");

function runDigest(fixturePath: string): { status: number; stdout: string } {
  const scratchDir = mkdtempSync(path.join(tmpdir(), "ci-log-digest-"));
  const scriptPath = path.join(scratchDir, "digest.sh");
  try {
    writeFileSync(scriptPath, DIGEST_SCRIPT_SOURCE, "utf-8");
    const result = spawnSync("bash", [scriptPath, fixturePath], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
    });
    return { status: result.status ?? -1, stdout: result.stdout };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
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

// Compute expected output by applying the same filter logic in TypeScript.
// This is the reference implementation the bash recipe must match.
// The marker check trims leading whitespace then checks if the trimmed
// content starts with a marker pattern. The original (untrimmed) line is
// printed. Indented detail lines are only kept if NOT markers themselves
// and do NOT start with ✓.
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
  const trimmed = l.trimStart();
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
  `case 10: bash recipe output matches the reference implementation exactly (${digestLines.length} lines)`,
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

console.log(exit === 0 ? "\nAll CI-log digest checks passed." : "\nFAILED");
process.exit(exit);
