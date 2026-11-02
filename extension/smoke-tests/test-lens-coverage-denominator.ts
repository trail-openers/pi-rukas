/**
 * The pure-accounting half of the lens coverage DENOMINATOR: what the round's
 * expected set is, and what its evidence counts as a claim on a file in it.
 *
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
 * THE THREE-FILE SPLIT, and the seam it follows. `lens-review-coverage.ts`
 * computes and `lens-review-coverage-report.ts` renders, so the three files
 * divide the same way: this one pins the accounting,
 * `test-lens-coverage-report.ts` pins what the report PRINTS from it, and
 * `test-lens-coverage-routing.ts` pins what an unaccounted file DOES to a
 * round's verdict over a real clone. The split was forced, not stylistic: this
 * file sat at 498/500 under the AGENTS.md §12 cap and the left-flank fixtures
 * this branch adds are assertions, not prose — trimming one to make room is the
 * one response the size gate must never produce, so the file was divided along
 * the compute/render seam its own modules already draw. Every assertion message
 * that was here before the split is in exactly one of the two files.
 *
 * The shared fixture lives in `lib/lens-coverage-fixture.ts`.
 */

import {
  TEST_SENTENCE_CLOSINGS,
  TEST_SUMMARY_CITES_BOTH_FILES,
  TEST_SUMMARY_GIT_HEADERS_ONLY,
  TEST_SUMMARY_NAMES_BOTH_FILES,
} from "./lib/lens-recital-probe.ts";
import { TEST_FLANK_ESCAPE_CASES } from "./lib/lens-flank-escape-probe.ts";
import { TEST_LEFT_FLANK_CASES } from "./lib/lens-left-flank-probe.ts";
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
  // FINDING 4 — a path that ENDS A SENTENCE. `.` and `-` are path characters,
  // so the old right flank read "Reviewed src/a.ts." as unaccounted: 2 of the
  // natural ways a lens closes a summary printed a gap that was not there.
  // MUTATION-PROOF: drop the terminator arm from `endsPath` in
  // `lens-review-coverage.ts` and the first two reddens.
  for (const [spelling, prose] of TEST_SENTENCE_CLOSINGS) {
    const out = accountedFiles([row({ summary: prose })], selectedFiles(THREE_FILE_DIFF));
    assert(
      out?.get(spelling) === "summary",
      `canary: a path that ends a SENTENCE still accounts — the right flank admits punctuation (${JSON.stringify(prose)})`,
    );
  }
  // FINDING 3 — git's own header spellings, kept as explicit negatives. Both
  // paths occur in this summary and only inside a header line, so an accounted
  // result is the right flank failing, not a stray mention.
  const headers = accountedFiles(
    [row({ summary: TEST_SUMMARY_GIT_HEADERS_ONLY })],
    selectedFiles(THREE_FILE_DIFF),
  );
  assert(
    headers?.get("src/a.ts") === undefined && headers?.get("src/b.ts") === undefined,
    `canary: git's own headers — +++ b/src/a.ts and the quoted form +++ "b/src/b.ts" — account for NOTHING (got ${JSON.stringify(Array.from(headers ?? []))})`,
  );
  assert(
    TEST_SUMMARY_GIT_HEADERS_ONLY.includes("src/a.ts") &&
      TEST_SUMMARY_GIT_HEADERS_ONLY.includes("src/b.ts"),
    "the header-only summary really does contain both paths, so an unaccounted result is the anchor's verdict and not an empty fixture",
  );
  // The bytes git's OWN headers take when a lens re-emits them without the
  // separating space (`"…\n+src/a.ts"`, `"…\n+++src/a.ts"`) — the exact
  // acceptances the adversarial review measured. They differ from a real
  // citation only in the character before the path, and `+` is a path
  // character, so the LEFT flank is what refuses them. `<src/a.ts>` and
  // `require("src/a.ts")` are NOT in this list on purpose: `<` and `"` are not
  // path characters, so those ARE citations — the left flank is a boundary
  // test, not a punctuation ban.
  for (const [spelling, prose] of [
    ["src/a.ts", "the diff shows:\n+src/a.ts"],
    ["src/a.ts", "the diff shows:\n+++src/a.ts"],
    ["src/a.ts", "@@ -1,2 +1,3 @@\n+src/a.ts"],
    ["src/a.ts", "--- a/src/a.ts"],
    ["src/a.ts", "+++ b/src/a.ts"],
    ["src/a.ts", '+++ "b/src/a.ts"'],
  ] as const) {
    const out = accountedFiles([row({ summary: prose })], selectedFiles(THREE_FILE_DIFF));
    assert(
      out?.get(spelling) === undefined,
      `canary: a path inside git's own header spelling is not a citation (${JSON.stringify(prose)})`,
    );
  }
  // A path followed by MORE path characters is still not a citation, even
  // though the sentence terminator arm exists — `src/b.ts.spec` is a different
  // file, not `src/b.ts` with a full stop on it.
  assert(
    accountedFiles([row({ summary: "See src/b.ts.spec" })], selectedFiles(THREE_FILE_DIFF))?.get(
      "src/b.ts",
    ) === undefined,
    "canary: the terminator arm does not turn a LONGER path into a citation of a shorter one",
  );
  // FINDING — the LEFT flank's `\n` alternative, and the escape class: the two
  // alternatives in `mentionsPath` that every case above leaves unpinned. Their
  // fixtures and mutation proofs live in `lib/lens-flank-escape-probe.ts`.
  // `TEST_LEFT_FLANK_CASES` is the other half of the same matcher: `NOT_PATH`,
  // the LEFT flank, which the file above does not cover and which the earlier
  // table never mutated — so its "0 reds" rows measured one of two constants.
  // One loop over the two lists; the denominator is one file so a red names one
  // flank. Both lists are `[summary, file, expected, why]` tuples, which is what
  // lets one loop judge fixtures from two probe modules.
  for (const [summary, file, expected, why] of [
    ...TEST_FLANK_ESCAPE_CASES,
    ...TEST_LEFT_FLANK_CASES,
  ]) {
    const out = accountedFiles([row({ summary })], new Set([file]));
    assert(out?.get(file) === expected, `canary: ${why} (${JSON.stringify(summary)})`);
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

process.exit(exit);
