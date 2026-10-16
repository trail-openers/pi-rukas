#!/usr/bin/env bun
/**
 * #1125 (round 3) — WHOSE diff the advisory split judges (#1407 review).
 *
 * `test-lens-review-advisory.ts` covers what the split DECIDES; this file covers
 * where its changed lines COME FROM, which is the half a caller can lie about.
 * The rule: only a diff the review computed itself from refs it resolved is
 * trusted as the reviewed range. A caller-pasted string — however tidy — and a
 * delta's own `since..head` are both judged against the git `base...head` read,
 * because a pasted diff can omit the lines a carried finding cites and a split
 * that trusted it would discount a defect the PR really introduced.
 *
 *   1. a supplied diff that parses to nothing falls back to the refs, and an
 *      unreadable range then fails the round closed with the note (4b);
 *   2. with no head there is no range to speak of: nothing is discounted and no
 *      note is emitted (5a-bis);
 *   3. a line-less finding on an untouched file is advisory, and a malformed
 *      `line <= 0` is treated as line-less rather than out of range (5b, 5b-bis);
 *   4. a delta round is judged against the PR's WHOLE range, never the delta's
 *      (5b-ter), and the pasted-diff rule is asserted in BOTH directions with a
 *      control that flips only on provenance (5b-ter-bis);
 *   5. the diff the review ran is the source, not a re-read of the refs
 *      (5b-quater).
 *
 * Same clone, same stub lens, same fixtures as the sibling suite.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { splitAdvisory } from "../src/lens-review-advisory.ts";
import { resolveReportedFindings } from "../src/lens-review-findings.ts";
import type { Finding } from "../src/lens-review-types.ts";
import { CHANGED_LINE_DIFF as DIFF, buildAdvisoryFixture } from "./lib/lens-advisory-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The same clone the verdict suite runs against: `src/a.ts` line 11 is the only
// line the PR changed and no line of `src/other.ts` is, so every case below
// states a line whose placement is known rather than inferred.
const fixture = buildAdvisoryFixture(mkdtempSync(path.join(os.tmpdir(), "lens-split-source-")));
const { root, repo } = fixture;
const HEAD_SHA = fixture.headSha;
const asFinding = (f: Record<string, unknown>): Finding => f as unknown as Finding;
/** The `resolved` shape for a review that read `base...head` from refs it
 * resolved itself — the only shape whose diff text the split trusts. */
const computedRange = (base: string, head: string) => ({
  diffSource: "computed" as const,
  base,
  head,
});
/** ...and for a review handed a string by its caller. */
const callerDiff = { diffSource: "caller" as const };

try {
  // when those resolve, the range still decides (a pasted string that parses to
  // nothing is not evidence that nothing changed), and when they do not, the
  // round fails closed with the note. Both cases pass `diffComputed: true` so
  // the junk string IS the supplied source — which is precisely what the split
  // must not accept as evidence that nothing changed.
  const junk = await splitAdvisory({
    reported: [asFinding({ lens: "SECURITY", severity: "HIGH", path: "src/a.ts", line: 11 })],
    cwd: repo,
    base: "main",
    head: HEAD_SHA,
    diff: "this is not a unified diff at all\n",
    diffComputed: true,
  });
  assert(
    junk.blocking.length === 1 && !junk.fields.advisory && !junk.fields.memoryNote,
    "a junk diff falls back to the range, which keeps the changed-line finding blocking",
  );
  const junkBadRef = await splitAdvisory({
    reported: [asFinding({ lens: "SECURITY", severity: "HIGH", path: "src/a.ts", line: 11 })],
    cwd: repo,
    base: "no-such-ref",
    head: HEAD_SHA,
    diff: "this is not a unified diff at all\n",
    diffComputed: true,
  });
  assert(
    junkBadRef.blocking.length === 1 &&
      /changed lines could not be read/.test(junkBadRef.fields.memoryNote ?? ""),
    "a junk diff with an unreadable range fails closed with a note",
  );

  // 5a-bis. No range to speak of (a run whose head never resolved): the split
  // discounts NOTHING and says nothing — the discount is earned by a range that
  // was read, never assumed. The same out-of-range finding that 5b calls
  // advisory here blocks.
  const noRange = await splitAdvisory({
    reported: [asFinding({ lens: "SIMPLICITY", severity: "MEDIUM", path: "src/a.ts", line: 3 })],
    cwd: repo,
    base: "main",
    head: undefined,
    diff: DIFF,
    diffComputed: true,
  });
  assert(
    noRange.blocking.length === 1 && !noRange.fields.advisory && !noRange.fields.memoryNote,
    "with no readable range nothing is discounted and no note is emitted",
  );

  // 5b. A line-bearing finding is placed by its line alone, never by its file:
  // a changed file contributes its changed LINES, so a finding on an untouched
  // line of that file is advisory.
  const untouchedLine = await splitAdvisory({
    reported: [asFinding({ lens: "SIMPLICITY", severity: "MEDIUM", path: "src/a.ts", line: 3 })],
    cwd: repo,
    base: "main",
    head: HEAD_SHA,
  });
  assert(
    untouchedLine.blocking.length === 0 && untouchedLine.fields.advisory?.length === 1,
    "a finding on an untouched line of a CHANGED file is advisory",
  );

  // 5b-bis. A `line` of 0 or less is MALFORMED, not out of range: treating it
  // as line-less asks the file rule, so it blocks on a changed file instead of
  // matching no span and being silently discounted.
  const badLine = await splitAdvisory({
    reported: [
      asFinding({ lens: "SECURITY", severity: "HIGH", path: "src/a.ts", line: 0 }),
      asFinding({ lens: "SECURITY", severity: "HIGH", path: "src/a.ts", line: -3 }),
    ],
    cwd: repo,
    base: "main",
    head: HEAD_SHA,
  });
  assert(
    badLine.blocking.length === 2 && !badLine.fields.advisory,
    "a malformed line (<= 0) is treated as line-less and blocks when its file changed",
  );
  const badLineUntouched = await splitAdvisory({
    reported: [asFinding({ lens: "SECURITY", severity: "HIGH", path: "src/other.ts", line: 0 })],
    cwd: repo,
    base: "main",
    head: HEAD_SHA,
  });
  assert(
    badLineUntouched.blocking.length === 0 && badLineUntouched.fields.advisory?.length === 1,
    "…and on an untouched file the same malformed line is advisory, as a line-less finding is",
  );

  // 5b-ter. A delta round is judged against the PR's WHOLE range, never the
  // delta's own: the diff it was handed covers only src/other.ts, yet the
  // carried finding on the branch-changed line 11 of src/a.ts still blocks —
  // a delta of one file must not disarm a finding the branch introduced
  // (#1125 decision 5 scopes what a delta RESOLVES, not what blocks). The
  // `diffComputed` flag is what says who produced that diff; a delta's own
  // range never matches the split's `base...head`, so it is never the source.
  const DELTA_DIFF =
    "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -10,1 +10,2 @@\n // other 10\n+// delta change";
  // The delta's own diff is NOT the reviewed range, so it is not passed at all:
  // `resolveReportedFindings` withholds a diff whose range is not the split's
  // `base...head` (a delta's base is its `since`, never the PR's base), which is
  // why the case below has no `diff` — the split reads the range itself.
  const deltaRound = await splitAdvisory({
    reported: [
      asFinding({ lens: "SECURITY", severity: "MEDIUM", path: "src/a.ts", line: 11 }),
      asFinding({ lens: "SECURITY", severity: "MEDIUM", path: "src/a.ts", line: 3 }),
    ],
    cwd: repo,
    base: "main",
    head: HEAD_SHA,
  });
  assert(
    deltaRound.blocking.length === 1 &&
      deltaRound.blocking[0]?.line === 11 &&
      deltaRound.fields.advisory?.[0]?.line === 3,
    "on a delta round a carried MEDIUM on a branch-changed line outside the delta still blocks",
  );
  // The same diff WITHOUT the flag is the shape the split trusts: judged as the
  // reviewed range, and the finding whose line it does not mention is advisory.
  const fullRound = await splitAdvisory({
    reported: [asFinding({ lens: "SECURITY", severity: "MEDIUM", path: "src/a.ts", line: 11 })],
    cwd: repo,
    base: "main",
    head: HEAD_SHA,
    diff: DELTA_DIFF,
    diffComputed: true,
  });
  assert(
    fullRound.blocking.length === 0 && fullRound.fields.advisory?.length === 1,
    "a round whose diff IS the reviewed range judges that diff, not a re-read of the refs",
  );

  // 5b-ter-bis. THE PASTED-DIFF RULE, both directions (#1125 round-3 HIGH).
  // A diff string a caller pasted is never evidence of what the PR changed: it
  // can omit the lines a carried finding cites, and a split that trusted it
  // would discount a finding the PR really introduced. So a caller-supplied diff
  // — however well-formed — is judged against the `base...head` read instead.
  // (a) The pasted diff omits line 11 of src/a.ts, the line the branch really
  // changed and the line the carried MEDIUM cites. Judged against the string it
  // would be advisory; judged against the range it blocks. No `diffComputed`,
  // which is exactly the caller-pasted shape.
  const pastedOmitsCarried = await splitAdvisory({
    reported: [asFinding({ lens: "SECURITY", severity: "MEDIUM", path: "src/a.ts", line: 11 })],
    cwd: repo,
    base: "main",
    head: HEAD_SHA,
    // A tidy, parseable diff of a DIFFERENT file: the pasted-diff shape.
    diff: DELTA_DIFF,
  });
  // The same string WITHOUT the caller provenance would be trusted — the control
  // that shows the flag is what does the work, not the diff's contents.
  const sameDiffTrusted = await splitAdvisory({
    reported: [asFinding({ lens: "SECURITY", severity: "MEDIUM", path: "src/a.ts", line: 11 })],
    cwd: repo,
    base: "main",
    head: HEAD_SHA,
    diff: DELTA_DIFF,
    diffComputed: true,
  });
  assert(
    sameDiffTrusted.blocking.length === 0 && sameDiffTrusted.fields.advisory?.length === 1,
    "control: the same diff string, when the review computed it, does discount that finding",
  );
  assert(
    pastedOmitsCarried.blocking.length === 1 && !pastedOmitsCarried.fields.advisory,
    "a pasted diff that omits a carried in-range MEDIUM's lines still blocks it",
  );
  // (b) The same pasted string through the SEAM, with the review's own `since`
  // delta: the seam must not read a caller diff as the range either, so the
  // branch-line MEDIUM still blocks.
  const pastedWithSince = await resolveReportedFindings({
    deduped: [asFinding({ lens: "SECURITY", severity: "MEDIUM", path: "src/a.ts", line: 11 })],
    lensResults: [],
    delta: { since: HEAD_SHA, head: HEAD_SHA },
    cwd: repo,
    base: "main",
    branchResolved: "feat/x",
    headSha: HEAD_SHA,
    diff: DELTA_DIFF,
    resolved: callerDiff,
  });
  assert(
    pastedWithSince.reported.length === 1 && !pastedWithSince.fields.advisory,
    "a pasted diff plus a `since` delta: the branch-line MEDIUM still blocks",
  );
  // (c) And the seam's positive half, in both directions, at the seam that
  // decides the verdict. `resolved` is what `resolveReviewDiff` would hand up for
  // a review whose own computed diff is `common.diff` (the fixture's
  // CHANGED_LINE_DIFF — `main...head`, whose only changed line is src/a.ts:11),
  // so `computedRange` names exactly that range. A finding on line 11 is IN the
  // diff the review read and blocks; a finding on line 3 of the same file is not
  // and is advisory. Both halves of the rule, through the seam.
  const seamRound = {
    lensResults: [],
    delta: undefined,
    cwd: repo,
    base: "main",
    // No branch to key a memory round on, so these cases test only the split's
    // choice of source — which is what the provenance decides.
    branchResolved: undefined,
    headSha: HEAD_SHA,
    diff: DIFF,
  } as const;
  const seamInDiff = await resolveReportedFindings({
    ...seamRound,
    deduped: [asFinding({ lens: "SECURITY", severity: "MEDIUM", path: "src/a.ts", line: 11 })],
    resolved: computedRange("main", HEAD_SHA),
  });
  assert(
    seamInDiff.reported.length === 1 && !seamInDiff.fields.advisory,
    "a computed full-range review keeps a finding the diff contains blocking",
  );
  const seamOutOfDiff = await resolveReportedFindings({
    ...seamRound,
    deduped: [asFinding({ lens: "SECURITY", severity: "MEDIUM", path: "src/a.ts", line: 3 })],
    resolved: computedRange("main", HEAD_SHA),
  });
  assert(
    seamOutOfDiff.reported.length === 0 && seamOutOfDiff.fields.advisory?.length === 1,
    "…and makes a finding the same diff does not contain advisory",
  );
  // The provenance is the only variable: the identical round, with the diff
  // labelled as caller-supplied, ignores the text and reads the range — where the
  // range says line 3 of the changed file is NOT a changed line, so the outcome
  // matches, and line 11 still blocks. What differs is WHICH read decided, and
  // the case below is the one where a pasted string would have lied.
  const seamPasted = await resolveReportedFindings({
    ...seamRound,
    deduped: [asFinding({ lens: "SECURITY", severity: "MEDIUM", path: "src/a.ts", line: 11 })],
    resolved: callerDiff,
  });
  assert(
    seamPasted.reported.length === 1 && !seamPasted.fields.advisory,
    "the same round with a pasted diff still blocks the in-range finding, on the git range",
  );

  // 5b-quater. The diff the review RAN is the source, not a re-read of refs:
  // this diff names a line the branch does not change, and the split trusts the
  // diff (that is what the lenses reviewed) rather than the git range.
  const reviewedDiff =
    "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1,1 +1,2 @@\n // other 1\n+// reviewed";
  const fromReviewed = await splitAdvisory({
    reported: [
      asFinding({ lens: "SECURITY", severity: "HIGH", path: "src/other.ts", line: 2 }),
      asFinding({ lens: "SECURITY", severity: "HIGH", path: "src/other.ts", line: 9 }),
    ],
    cwd: repo,
    base: "main",
    head: HEAD_SHA,
    // Trusted because the review computed it from refs (`diffComputed`), which is
    // what distinguishes this case from the pasted ones above.
    diff: reviewedDiff,
    diffComputed: true,
  });
  assert(
    fromReviewed.blocking.length === 1 && fromReviewed.blocking[0]?.line === 2,
    "the changed lines come from the diff the review ran, not from a re-read of the refs",
  );
} finally {
  // Both env vars the fixture set go back as they were found (unset stays
  // unset), so a later test in this process does not inherit this clone's
  // ledger path and skills dir.
  fixture.restore();
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
