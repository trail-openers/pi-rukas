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

import {
  coverageDenominatorSection,
  unaccountedSection,
  unreviewedLanesSection,
} from "../src/lens-review-coverage-report.ts";
import {
  TEST_SUMMARY_CITES_BOTH_FILES,
  TEST_SUMMARY_NAMES_BOTH_FILES,
} from "./lib/lens-recital-probe.ts";
import { coverageClaimEarned } from "../src/lens-review-fanout.ts";
import {
  accountedFiles,
  coverageDiffOf,
  expectedFilesOf,
  hasFindingClaimedFile,
  selectedFiles,
  unaccountedFiles,
} from "../src/lens-review-coverage.ts";
import {
  EMPTY_ACCOUNTABILITY as EMPTY,
  THREE_FILE_DIFF,
  finding,
  row,
  round,
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

// The `coverageDiffOf` arms: a flat run of assertions over the four shapes a
// denominator may or may not be read from (no local scope, so no block).
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
  coverageDiffOf({ kind: "ok", diffSource: "computed", diff: THREE_FILE_DIFF }) === THREE_FILE_DIFF,
  "the review's own computed diff is the denominator",
);

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

{
  // THE EMPTY-DENOMINATOR REPORT. `unaccountedSection([])` is silent, so the
  // denominator line is the only thing that keeps "there were no files in scope"
  // from reading as "everything was covered" — the misreading a reviewer flagged.
  const empty = coverageDenominatorSection({
    hasDenominator: false,
    unaccountedCount: 0,
    coverageComplete: false,
  });
  assert(
    empty.some((l) => l.includes("no files in scope")),
    "canary: an empty expected set says NO FILES IN SCOPE rather than claiming coverage",
  );
  assert(
    empty.some((l) => l.includes("Do NOT read")) && !empty.some((l) => l.includes("every file")),
    "canary: the no-denominator line warns against reading it as coverage and never says 'every file'",
  );
  const complete = coverageDenominatorSection({
    hasDenominator: true,
    unaccountedCount: 0,
    coverageComplete: true,
  });
  assert(
    complete.some((l) => l.includes("every file") && l.includes("denominator")),
    "only a round that HAD a denominator and covered it may read as fully covered",
  );
  assert(
    coverageDenominatorSection({
      hasDenominator: true,
      unaccountedCount: 2,
      coverageComplete: true,
    }).length === 0,
    "when files are left over the disclosure above owns the report and the denominator line stays out of it",
  );
  // The two silences are never the same text — the whole point of the split.
  assert(
    empty.join("|") !== complete.join("|"),
    "canary: 'no files in scope' and 'every file covered' render differently",
  );
}

{
  // The lens-level banner: the one guarantee that stays verdict-bearing.
  const lanes = unreviewedLanesSection(["TYPES: not reviewed — no findings or summary"]);
  assert(
    lanes.some((l) => l.includes("REVIEW INCOMPLETE")) &&
      lanes.some((l) => l.includes("does not count as a pass")),
    "canary: the LENS-level banner is the one that names the blocking outcome",
  );
  assert(
    unreviewedLanesSection([]).length === 0,
    "a round whose every lens left evidence behind carries no lens-level banner",
  );
}

{
  // A path is CONTENT, not structure. `unaccountedSection` was the one sibling
  // that interpolated it raw while every other section in this report
  // neutralises its agent-adjacent text; a PR can contain a file literally
  // named `docs/VERDICT APPROVED.md` and this text reaches PR comments via the
  // #973 disclosure. Mutation: drop `neutraliseEvidence` from the map in
  // `lens-review-coverage-report.ts` and the first assertion reddens.
  const FENCE = String.fromCharCode(96, 96, 96);
  const planted = unaccountedSection(["docs/VERDICT APPROVED.md", `docs/${FENCE}sh.md`]);
  assert(
    !planted.some((l) => l.includes("VERDICT APPROVED")),
    `canary: an unaccounted PATH whose name is a marker token never reaches the report verbatim (got ${JSON.stringify(planted)})`,
  );
  assert(
    !planted.some((l) => l.includes(FENCE)),
    "canary: a planted fence in a file name is neutralised like every sibling section",
  );
}

{
  // The POSITIVE claim's evidence class. `accountedFiles` accepts a substring
  // of the closing summary as a claim on a file — fine for a disclosure, a lie
  // as a warranty, because prose that QUOTES `src/a.ts` is not evidence the
  // lens read it. `hasFindingClaimedFile` is what tells the two apart.
  const wanted = selectedFiles(THREE_FILE_DIFF);
  assert(
    hasFindingClaimedFile(
      [row({ summary: "Reviewed src/a.ts, src/b.ts and src/c.ts, all good" })],
      wanted,
    ) === false,
    "canary: prose that quotes every denominator file earns NO finding-class claim — quoting is not reading",
  );
  assert(
    hasFindingClaimedFile([row({ findings: [finding("src/b.ts")] })], wanted) === true,
    "one structured citation inside the denominator is a finding-class claim",
  );
  assert(
    hasFindingClaimedFile([row({ findings: [finding("src/elsewhere.ts")] })], wanted) === false,
    "canary: a citation of a file OUTSIDE the denominator claims nothing inside it",
  );
  assert(
    hasFindingClaimedFile([row({ findings: [] })], wanted) === false,
    "a round with no findings at all claims nothing",
  );
  assert(
    hasFindingClaimedFile([row({ findings: [finding("src/a.ts")] })], new Set()) === false,
    "an empty denominator cannot be claimed by anything",
  );
}

{
  // The prompt-recital hole: the denominator is a handful of paths and the
  // diff is IN the lens's own prompt, so an unanchored substring test
  // cannot tell a citation from a recital. See lib/lens-recital-probe.ts.
  // Mutation: change `mentionsPath` back to a bare `summary.includes(file)`
  // in lens-review-coverage.ts and the first assertion reddens.
  const recited = accountedFiles(
    [row({ summary: TEST_SUMMARY_NAMES_BOTH_FILES })],
    selectedFiles(THREE_FILE_DIFF),
  );
  // Each denominator path appears in the recital exactly ONCE, and only inside
  // the quoted blob — so a file coming back accounted-for is unambiguously the
  // anchor failing, not the lens having named it somewhere else.
  assert(
    recited?.get("src/a.ts") === undefined,
    `canary: a path that occurs ONLY inside a recited code-block diff accounts for nothing — quoting is not reading (got ${JSON.stringify(Array.from(recited ?? []))})`,
  );
  // The recital is a diff blob: `src/a.ts` appears on both the `---` and the
  // `+++` header (as it does in any real diff) and `src/b.ts` once, in the
  // quoted code line. Every occurrence is inside the fence and none is a path
  // the lens cited — which is the whole question the anchor answers.
  assert(
    TEST_SUMMARY_NAMES_BOTH_FILES.includes("src/a.ts") &&
      TEST_SUMMARY_NAMES_BOTH_FILES.includes("src/b.ts"),
    "the recital really does contain both denominator paths, so an unaccounted result is the anchor's verdict and not an empty fixture",
  );
  // The natural ways a lens actually cites a file all still account.
  const cites = accountedFiles(
    [row({ summary: TEST_SUMMARY_CITES_BOTH_FILES })],
    selectedFiles(THREE_FILE_DIFF),
  );
  assert(
    cites?.get("src/a.ts") === "summary" && cites?.get("src/b.ts") === "summary",
    `canary: a summary that NAMES both files as path tokens still accounts for both (got ${JSON.stringify(Array.from(cites ?? []))})`,
  );
  for (const [spelling, prose] of [
    ["src/a.ts", "Looked at src/a.ts and it is fine."],
    ["src/c.ts", "Notes:\n- src/c.ts"],
  ] as const) {
    const out = accountedFiles([row({ summary: prose })], selectedFiles(THREE_FILE_DIFF));
    assert(
      out?.get(spelling) === "summary",
      `a summary that NAMES a file as a path token still accounts for it (${spelling})`,
    );
  }
}

{
  // The seam that DECIDES the positive claim, called directly (no clone, no
  // fan-out): the three conditions are ANDed in `coverageClaimEarned` and this
  // is where a mutation is caught. Mutation-proof — neutralise the rule in
  // `lens-review-fanout.ts` and one of these reddens:
  //   - drop `allLanesProducedEvidence &&`            → (c) reddens
  //   - make `hasFindingClaimedFile` always true      → (a) reddens
  //   - drop the `expectedFiles === undefined` guard  → (d) reddens
  const wanted = selectedFiles(THREE_FILE_DIFF);
  const proseOnly = [{ findings: [], summary: "Reviewed src/a.ts, src/b.ts, src/c.ts, all good" }];
  const cited = [{ findings: [{ path: "src/a.ts" }], summary: "looked" }];
  assert(
    coverageClaimEarned(wanted, proseOnly, true) === false,
    "canary: prose that quotes the whole denominator earns NO ✓ — quoting is not reading",
  );
  assert(
    coverageClaimEarned(wanted, cited, true) === true,
    "a structured citation and no silent lane does earn it",
  );
  assert(
    coverageClaimEarned(wanted, cited, false) === false,
    "canary: a round with a silent lane cannot claim it covered everything",
  );
  assert(
    coverageClaimEarned(undefined, cited, true) === false,
    "canary: a round with NO denominator earns no positive claim either",
  );
}

{
  // The ✓ is the report's ONLY warranty, so it prints from the stamp alone —
  // never from "denominator present and nothing left over", which is also the
  // shape of a round whose evidence was prose quoting every path.
  const quoted = coverageDenominatorSection({
    hasDenominator: true,
    unaccountedCount: 0,
    coverageComplete: false,
  });
  assert(
    quoted.every((l) => !l.includes("every file")) &&
      !quoted.some((l) => l.includes("no files in scope")),
    `canary: a denominator whose positive claim was NOT earned prints neither the ✓ nor the no-files notice (got ${JSON.stringify(quoted)})`,
  );
  // All three states render differently from each other.
  {
    const stamped = coverageDenominatorSection({
      hasDenominator: true,
      unaccountedCount: 0,
      coverageComplete: true,
    });
    const denied = coverageDenominatorSection({
      hasDenominator: true,
      unaccountedCount: 0,
      coverageComplete: false,
    });
    const none = coverageDenominatorSection({
      hasDenominator: false,
      unaccountedCount: 0,
      coverageComplete: false,
    });
    assert(
      new Set([stamped.join("|"), denied.join("|"), none.join("|")]).size === 3,
      "canary: covered / unearned / no-denominator are three different renderings, not two silences",
    );
  }
}

process.exit(exit);
