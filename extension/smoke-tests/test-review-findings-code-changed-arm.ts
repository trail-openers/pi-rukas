#!/usr/bin/env bun
import type { ChangedRanges } from "../src/review-diff.ts";
import { type ReviewKind, rowFate } from "../src/review-findings-fate.ts";
/**
 * AC1/AC2 at the RULE seam (#2027) — the unit view of the arm the fate rule
 * gained: an untouched, line-bearing row whose CITED LINE a commit of the
 * reviewed delta rewrote resolves as `code-changed-not-reported`, and nothing
 * else does.
 *
 * `deltaRanges` is the delta's hunk-level patch, which `subtractReviewedHunks`
 * built by removing every hunk identical to one the previous round reviewed —
 * so a fix hunk the round considered already reviewed is absent from it while
 * head shows the cited line rewritten. `deltaCommitRanges` is the union of
 * `git diff <since>..<head>` for that same range: independent of hunk
 * subtraction, and the only evidence that separates "the round reviewed this
 * line" from "the round's own hunk list lost it".
 *
 * The asymmetry is the whole criterion, so both directions are asserted here
 * rather than only the resolving one: with the commit ranges absent, or with
 * the cited line outside them, the row carries exactly as before.
 */
import type { StoredFinding } from "../src/review-findings-file.ts";
import type { HeadState } from "../src/review-findings-head.ts";
import { hashText, lineHashAt, snippetHashAt } from "../src/review-findings-match.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FILE = "src/a.ts";
const CITED = 3;
const BEFORE = ["// header", "export const a = 1;", "export const b = 2;", "// trailing"];
/** After the fix: the cited line is rewritten AND moved, so neither hash is at head. */
const AFTER = ["// header", "export const a = 1;", "// trailing", "export const b = 3;"];
const AFTER_HEAD: HeadState = { kind: "lines", lines: AFTER };

/** The line hash exactly as `lineHashAt` would have stored it. */
const hashLine = (line: string) => hashText(line.replace(/\s+/g, " ").trim());

/**
 * The row under judgment. The spread of `over` is why this is written as a
 * builder over an `open` row rather than an object literal annotated
 * `StoredFinding`: that union's arms differ by which fields each forbids, and a
 * spread makes the result a union of the three again. `Status` is a parameter so
 * a test can ask about an `accepted` or `resolved` row — the rule is not open-
 * only, and a builder that could not build one could not test that.
 */
const row = (over: Partial<StoredFinding> = {}): StoredFinding => {
  const base = {
    id: "0badc0de",
    branch: "feat/x",
    path: FILE,
    anchor: "file",
    titleClass: "hand typed json fence",
    title: "Hand-typed json fence",
    severity: "HIGH",
    lens: "SIMPLICITY",
    line: CITED,
    snippetHash: snippetHashAt(BEFORE, CITED),
    lineHash: hashLine(BEFORE[CITED - 1] ?? ""),
    status: "open",
    firstSeen: 1,
    lastSeen: 1,
  } as const;
  return { ...base, ...over } as StoredFinding;
};

/** The hunk-level delta the round reviewed: only an unrelated file survived. */
const HUNK_RANGES: ChangedRanges = new Map([["src/other.ts", [[1, 1]]]]);
/** The same range's per-commit evidence: line 3 of the cited file changed. */
const COMMIT_RANGES: ChangedRanges = new Map([
  [FILE, [[3, 4]]],
  ["src/other.ts", [[1, 1]]],
]);
/** The same range when the cited file was NOT touched by any commit of it. */
const COMMIT_RANGES_ELSEWHERE: ChangedRanges = new Map([["src/other.ts", [[1, 1]]]]);

// The bug and its fix: a delta whose hunk ranges miss the cited line, whose
// per-commit ranges do not, and whose lenses reported nothing.
{
  const fate = rowFate(row(), AFTER_HEAD, "delta", {
    deltaRanges: HUNK_RANGES,
    deltaCommitRanges: COMMIT_RANGES,
  });
  assert(
    fate.kind === "resolve" && fate.reason === "code-changed-not-reported",
    `a HIGH whose cited line a commit of the delta rewrote resolves as its own reason (got ${JSON.stringify(fate)})`,
  );
}
for (const severity of ["MEDIUM", "LOW"] as const) {
  const fate = rowFate(row({ severity }), AFTER_HEAD, "delta", {
    deltaRanges: HUNK_RANGES,
    deltaCommitRanges: COMMIT_RANGES,
  });
  assert(
    fate.kind === "resolve" && fate.reason === "code-changed-not-reported",
    `the same arm retires a ${severity} row at the same location (got ${JSON.stringify(fate)})`,
  );
}

// The three carries the arm must NOT cross.
{
  const noEvidence = rowFate(row(), AFTER_HEAD, "delta", { deltaRanges: HUNK_RANGES });
  assert(
    noEvidence.kind === "carry",
    `with no per-commit evidence the row carries — absence is not a resolution (got ${JSON.stringify(noEvidence)})`,
  );
  const lineNotChanged = rowFate(row(), AFTER_HEAD, "delta", {
    deltaRanges: HUNK_RANGES,
    deltaCommitRanges: COMMIT_RANGES_ELSEWHERE,
  });
  assert(
    lineNotChanged.kind === "carry",
    `a delta that changed no commit of the cited line carries the row (got ${JSON.stringify(lineNotChanged)})`,
  );
  const incomplete = rowFate(row(), AFTER_HEAD, "incomplete", {
    deltaRanges: HUNK_RANGES,
    deltaCommitRanges: COMMIT_RANGES,
  });
  assert(
    incomplete.kind === "carry",
    `an incomplete round reaches no verdict, so its silence retires nothing (got ${JSON.stringify(incomplete)})`,
  );
  const security = rowFate(row({ lens: "SECURITY" }), AFTER_HEAD, "delta", {
    deltaRanges: HUNK_RANGES,
    deltaCommitRanges: COMMIT_RANGES,
  });
  assert(
    security.kind === "carry",
    `a SECURITY row never retires on a delta's silence (got ${JSON.stringify(security)})`,
  );
  const critical = rowFate(row({ severity: "CRITICAL" }), AFTER_HEAD, "delta", {
    deltaRanges: HUNK_RANGES,
    deltaCommitRanges: COMMIT_RANGES,
  });
  assert(
    critical.kind === "carry",
    `a CRITICAL keeps its full-review-only retirement (got ${JSON.stringify(critical)})`,
  );
  const lineless = rowFate(
    { ...row(), line: undefined, lineHash: undefined, snippetHash: snippetHashAt([], undefined) },
    AFTER_HEAD,
    "delta",
    { deltaRanges: HUNK_RANGES, deltaCommitRanges: COMMIT_RANGES },
  );
  assert(
    lineless.kind === "carry",
    `a line-less row is the file-level rule's, not this arm's (got ${JSON.stringify(lineless)})`,
  );
  const accepted = rowFate(row({ status: "accepted" }), AFTER_HEAD, "delta", {
    deltaRanges: HUNK_RANGES,
    deltaCommitRanges: COMMIT_RANGES,
  });
  assert(
    accepted.kind === "carry",
    `an ACCEPTED row retires on proof about its code, never on this arm (got ${JSON.stringify(accepted)})`,
  );
  const survives = rowFate(row(), { kind: "lines", lines: BEFORE }, "delta", {
    deltaRanges: HUNK_RANGES,
    deltaCommitRanges: new Map([[FILE, [[3, 3]]]]),
  });
  assert(
    survives.kind === "carry",
    `unchanged cited code still carried even when the delta names that line (got ${JSON.stringify(survives)})`,
  );
}

// The pre-existing step-9 arm is untouched: a delta whose OWN ranges cover the
// line still resolves it as `code-gone`, with no per-commit evidence in sight.
for (const review of ["delta", "full"] as ReviewKind[]) {
  const fate = rowFate(row(), AFTER_HEAD, review, {
    deltaRanges: new Map([[FILE, [[CITED, CITED]]]]),
  });
  assert(
    fate.kind === "resolve" && fate.reason === "code-gone",
    `the existing code-gone arm still answers a ${review} round that reviewed the line (got ${JSON.stringify(fate)})`,
  );
}

process.exit(exit);
