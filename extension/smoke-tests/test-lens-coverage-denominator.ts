#!/usr/bin/env bun
/**
 * The six-lens review has a coverage DENOMINATOR: the files the round was
 * supposed to examine are recorded BEFORE the children run, and a selected file
 * that no evidence accounts for makes the round REVIEW_INCOMPLETE instead of
 * silently readable as APPROVED.
 *
 * The witness this closes is the one `lensProducedEvidence` cannot see. That
 * question — "did anything come back?" — is untouched here and stays separately
 * readable: a lens that stalled in orientation and emitted nothing is still
 * caught there. What nothing caught was the lens that came back COMPLETE: a
 * well-formed finding, or the closing summary the prompt requires, about one
 * file, on a diff that changed two. Measured in the field: a child at 20 M
 * tokens / 111 turns before its first edit, and a lens child at 20.1 M tokens
 * across 132 turns on a two-file smoke-test delta. Neither was detected by the
 * harness; both were noticed by an external slow-run notice.
 *
 * THIS FILE pins the pure accounting: what the denominator is, and what counts
 * as evidence for a file in it. What an unaccounted file DOES to a round's
 * verdict — the end-to-end gate over a real clone — is pinned in
 * `test-lens-coverage-routing.ts`. The shared fixture lives in
 * `lib/lens-coverage-fixture.ts`.
 */

import { unaccountedSection } from "../src/lens-review-coverage-report.ts";
import {
  accountedFiles,
  coverageDiffOf,
  expectedFilesOf,
  selectedFiles,
  unaccountedFiles,
} from "../src/lens-review-coverage.ts";
import {
  EMPTY_ACCOUNTABILITY as EMPTY,
  THREE_FILE_DIFF,
  finding,
  row,
} from "./lib/lens-coverage-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ─────────────────────────────── pure accounting ───────────────────────────

{
  const expected = selectedFiles(THREE_FILE_DIFF);
  assert(
    expected.size === 3 && expected.has("src/a.ts") && expected.has("src/c.ts"),
    "selectedFiles: the denominator is the diff's own file set, from the shared changed-line parser",
  );
  assert(
    selectedFiles("").size === 0,
    "selectedFiles: an empty diff yields no denominator (and is never a failure)",
  );
}

{
  const expected = selectedFiles(THREE_FILE_DIFF);
  const covered = accountedFiles(
    [row({ findings: [finding("src/a.ts")] }), row({ summary: "src/b.ts is fine as written." })],
    expected,
  );
  assert(covered !== undefined, "accountedFiles: a computable denominator yields an answer");
  assert(covered?.get("src/a.ts") === "finding", "a finding citing the file accounts for it");
  assert(
    covered?.get("src/b.ts") === "summary",
    "a closing summary naming the file accounts for it",
  );
  assert(
    unaccountedFiles(expected, covered ?? EMPTY).join(",") === "src/c.ts",
    "canary: the file NO evidence mentions is the unaccounted one — before this gate it was invisible",
  );
}

{
  // `expectedFilesOf` is the caller's whole question in one call: a diff it
  // cannot defend comes back undefined rather than as a half-built set.
  assert(
    expectedFilesOf({ kind: "ok", diffSource: "caller", diff: THREE_FILE_DIFF }) === undefined,
    "expectedFilesOf: a caller-pasted diff earns no denominator",
  );
  const set = expectedFilesOf({ kind: "ok", diffSource: "computed", diff: THREE_FILE_DIFF });
  assert(set?.size === 3, "expectedFilesOf: a computed diff yields the three-file set");
  // The canary that matters: a Set of paths, NOT the diff string. A denominator
  // assembled from a string spreads into CHARACTERS, and every file then reads
  // as covered by a letter — the shape this gate shipped with before its own
  // test caught it.
  assert(
    set !== undefined && Array.from(set).every((f) => f.includes("/")),
    `canary: the denominator holds PATHS, not the diff's characters (got ${JSON.stringify(Array.from(set ?? []).slice(0, 6))})`,
  );
}

{
  // The denominator is the diff's, not a caller's: an empty expected set means
  // "nothing to check", and a non-empty one is honoured exactly.
  const out = accountedFiles([row({ findings: [finding("src/a.ts")] })], new Set(["src/a.ts"]));
  assert(
    out !== undefined && out.size === 1 && !out.has("src/b.ts"),
    "accountedFiles: only files in the denominator can be claimed, and only by evidence",
  );
}

{
  const out = accountedFiles([row({ summary: "all good" })], new Set());
  assert(out === undefined, "canary: an empty denominator yields UNDEFINED, not an empty pass");
}

{
  // A basename is not a file: `a.ts` in prose must not account for `src/a.ts`.
  const out = accountedFiles([row({ summary: "a.ts looks fine" })], selectedFiles(THREE_FILE_DIFF));
  assert(
    out?.get("src/a.ts") === undefined,
    "canary: a summary naming only the basename does not account for the path",
  );
}

{
  const out = accountedFiles(
    [row({ findings: [finding("./src/a.ts")] })],
    selectedFiles(THREE_FILE_DIFF),
  );
  assert(
    out?.get("src/a.ts") === "finding",
    "a finding cited as ./src/a.ts accounts for the diff's src/a.ts (same normalisation as extractFindings)",
  );
}

{
  const out = accountedFiles(
    [row({ findings: [finding("src/a.ts")] }), row({ summary: "src/a.ts noted" })],
    selectedFiles(THREE_FILE_DIFF),
  );
  assert(out?.get("src/a.ts") === "finding", "a finding's claim is never demoted to a summary's");
}

{
  assert(
    coverageDiffOf({ kind: "ok", diffSource: "caller", diff: THREE_FILE_DIFF }) === undefined,
    "canary: a caller-pasted diff is not a denominator — pasted text is not evidence of what the PR changed",
  );
  assert(
    coverageDiffOf({ kind: "blocked", diff: THREE_FILE_DIFF }) === undefined,
    "a blocked round has no denominator",
  );
  assert(
    coverageDiffOf({ kind: "ok", diffSource: "computed", diff: "  " }) === undefined,
    "a blank computed diff is not a denominator either",
  );
  assert(
    coverageDiffOf({ kind: "ok", diffSource: "computed", diff: THREE_FILE_DIFF }) ===
      THREE_FILE_DIFF,
    "the review's own computed diff is the denominator",
  );
}

{
  assert(
    unaccountedSection([]).length === 0,
    "a fully covered round contributes no coverage section",
  );
  const banner = unaccountedSection(["src/c.ts"]);
  assert(
    banner.some((l) => l.includes("src/c.ts")) &&
      banner.some((l) => l.includes("COVERAGE")) &&
      // DISCLOSURE wording, per the PM ruling that settles this section's
      // semantics: file-level coverage is derivable only from findings, and a
      // clean round has none, so naming an unaccounted file tells the operator
      // to read it — it does NOT decide the round. The blocking guarantee lives
      // at the LENS level (`unreviewedLanesSection` / a silent lens reads as
      // REVIEW_INCOMPLETE), pinned end-to-end in
      // `test-lens-coverage-routing.ts`; this banner must not claim a verdict
      // the caller may not have set.
      banner.some((l) => l.includes("no lens named it")) &&
      banner.some((l) => l.includes("read these lanes before accepting")),
    "the disclosure names the file and says what the operator does about it, without asserting a verdict",
  );
  assert(
    !banner.some((l) => l.includes("REVIEW INCOMPLETE")) &&
      !banner.some((l) => l.includes("does not count as a pass")),
    "canary: the file-level disclosure never reads as a blocking verdict — that is the lens-level banner's job",
  );
  const ordered = unaccountedSection(["src/c.ts", "src/a.ts"]);
  const listed = ordered.filter((l) => l.startsWith("  - "));
  assert(
    listed.join("|") === "  - src/a.ts|  - src/c.ts",
    `canary: the listed order is sorted, not insertion order (got ${JSON.stringify(listed)})`,
  );
  assert(
    ordered.filter((l) => l.startsWith("  - ")).length === 2,
    "canary: exactly one line per unaccounted file (a dropped file would read as coverage)",
  );
}

process.exit(exit);
