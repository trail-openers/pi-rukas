#!/usr/bin/env bun
/**
 * #1140 (file level) + #1125 decision 1 (line level) — a finding blocks only
 * when its cited line is inside the PR's changed lines. Lens children are
 * injected; the clone (its changed lines known exactly) and the stub lens are
 * in ./lib/lens-advisory-fixtures.ts, so this file is only assertions.
 *   1. an in-range HIGH and a CRITICAL outside the changed lines, neither
 *      re-reported: the verdict is ISSUES_FOUND on the HIGH alone, `bySeverity`
 *      counts no CRITICAL, the ledger entry says hasCritical: false, and the
 *      summary lists the CRITICAL under "Advisory (outside this PR's changed
 *      lines)";
 *   2. the same round again with the code unchanged: both rows stay carried and
 *      advisory — a re-review does not resurrect them into the verdict;
 *   3. the control: a CRITICAL ON the changed line decides the verdict and
 *      sets hasCritical (#1143's invariant, kept at line level);
 *   4. an unreadable changed-line list keeps every finding blocking
 *      (CRITICAL_ISSUES_FOUND) and the note says why; and so does an EMPTY
 *      one — the discount is earned by lines actually read;
 *   5. a finding with no path blocks; a line-less finding blocks only on a
 *      changed file; a malformed `line <= 0` is treated as line-less; a finding
 *      on an untouched line of a CHANGED file is advisory; a DELTA round is
 *      judged against the PR's whole range, not the delta's; the PR residual
 *      disclosure lists the advisory rows; the store rows are unchanged.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADVISORY_HEADING, type RangeList, splitAdvisory } from "../src/lens-review-advisory.ts";
import { rangesFromDiff } from "../src/lens-review-changed-ranges.ts";
import { resolveReportedFindings } from "../src/lens-review-findings.ts";
import { postLensResidualDisclosure } from "../src/lens-review-residuals.ts";
import type { Finding } from "../src/lens-review-types.ts";
import { renderSummary, runLensReview } from "../src/lens-review.ts";
import { readBranchRows } from "../src/review-findings-store.ts";
import type { LedgerEntry } from "../src/review-ledger.ts";
import { validEntries } from "../src/review-ledger.ts";
import { commandOf } from "./lib/argv-shell.ts";
import {
  CHANGED_LINE_DIFF as DIFF,
  type Raw,
  buildAdvisoryFixture,
  renameOnBranch,
} from "./lib/lens-advisory-fixtures.ts";
import {
  latestLensEntry as latestLensEntryOf,
  seedFindings,
  storeFileOf,
  waitForLensRound,
} from "./lib/review-autonomy-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The clone, the skills dir and the stub lens live in the shared fixtures
// (500-line gate): this file holds the assertions. `src/a.ts` line 11 is the
// only line the PR changed; no line of `src/other.ts` is.
const fixture = buildAdvisoryFixture(mkdtempSync(path.join(os.tmpdir(), "lens-advisory-")));
const { root, repo, ledgerFile, sh } = fixture;
const HEAD_SHA = fixture.headSha;
// The round's FRESH findings come from the stub; the CARRIED half is seeded
// into the findings store, so the list `splitAdvisory` receives is exact.
const setReport = fixture.setReport;
const storeFile = storeFileOf(ledgerFile);
const seedStore = (rows: Raw[]) => seedFindings(storeFile, "feat/x", rows);
const common = fixture.common;
/** The `resolved` shape `runLensReview` hands the seam for these options: a
 * caller-pasted diff string (`common.diff`), the shape a `/review` call makes. */
const callerDiff = { diffSource: "caller" as const };
/** Same, for a review that read `base...head` from refs it resolved — the only
 * shape whose diff text the advisory split trusts as the reviewed range. */
const computedRange = (base: string, head: string) => ({
  diffSource: "computed" as const,
  base,
  head,
});
// The ledger rows the split's decisions are asserted on, read through the shared
// poll's `until` seam (#984) rather than a raw read of the file: `latestLensEntry`
// and `waitForLensRound` are the autonomy fixtures' ONE implementation (the local
// copies this suite used to carry re-read the file through readers that swallow a
// parse error and return a stale row), with this suite's row selector.
const lensRows = (entries: LedgerEntry[]): LedgerEntry[] =>
  entries.filter((e) => e.kind === "lens");
/** Wait until the branch's lens entry records round `n` (one lens row per
 * branch). The poll returns the entries it accepted; a timeout is a null. */
const waitForRound = (n: number): Promise<LedgerEntry | undefined> =>
  waitForLensRound(ledgerFile, "feat/x", n, lensRows, (file) =>
    validEntries(JSON.parse(readFileSync(file, "utf8")).entries as unknown[]),
  );
/** The branch's latest lens row — the one `hasCritical` is asserted on. */
const latestLensEntry = (): LedgerEntry | undefined =>
  latestLensEntryOf(ledgerFile, "feat/x", lensRows, (file) =>
    validEntries(JSON.parse(readFileSync(file, "utf8")).entries as unknown[]),
  );

try {
  // A finding literal, for the shapes no lens produces (no path, no line, a
  // malformed line, a delta's own hunk): exactly what `splitAdvisory` accepts.
  const asFinding = (f: Record<string, unknown>): Finding => f as unknown as Finding;
  // 1. An in-range HIGH (carried by the store) and a CRITICAL on a file the PR
  // never touches (the #1133 phantom-row shape). The split is what is under
  // test: the CRITICAL is advisory, so it neither decides the verdict nor sets
  // `hasCritical`.
  seedStore([{ severity: "CRITICAL", path: "src/other.ts", line: 5, title: "phantom critical" }]);
  // The in-range HIGH is a fresh finding from the lens, so the store cannot
  // carry it — fresh findings never pass through the advisory split at all.
  setReport([{ severity: "HIGH", path: "src/a.ts", line: 11, title: "in-range problem" }]);
  const r1 = await runLensReview({ ...common, base: "main" });
  assert(
    r1.verdict === "ISSUES_FOUND",
    `round 1: the in-range HIGH decides the verdict, the out-of-range CRITICAL does not (got ${r1.verdict})`,
  );
  assert(
    r1.findings.length === 1 && r1.findings[0]?.path === "src/a.ts",
    "round 1: only the in-range finding is counted in the reported findings",
  );
  assert(
    r1.advisory?.length === 1 && r1.advisory[0]?.path === "src/other.ts",
    "round 1: the finding outside the changed lines is listed as advisory",
  );
  assert(r1.bySeverity.CRITICAL === 0, "round 1: the advisory CRITICAL is not counted");
  await waitForRound(1);
  assert(
    latestLensEntry()?.hasCritical === false,
    "round 1: the ledger entry records hasCritical: false",
  );
  const text = renderSummary(r1, 4);
  assert(
    text.includes(ADVISORY_HEADING) && text.includes("phantom critical"),
    "round 1: the summary lists the advisory row under its heading",
  );
  const rowsAfter = await readBranchRows(repo, "feat/x");
  assert(
    rowsAfter.length === 2 && rowsAfter.every((r) => r.status === "open"),
    "the store rows are unchanged (no deletion, no status change)",
  );

  // 2. The next round sees the same code: the lens re-reports the in-range HIGH
  // and the store carries the out-of-range CRITICAL forward (its cited code is
  // unchanged, so #1130's rule does not resolve it). The verdict is unchanged —
  // an out-of-range finding never re-enters it, round after round.
  seedStore([{ severity: "CRITICAL", path: "src/other.ts", line: 5, title: "phantom critical" }]);
  const r2 = await runLensReview({ ...common, base: "main" });
  assert(
    r2.verdict === "ISSUES_FOUND" && r2.findings.length === 1,
    `round 2: the carried rows do not re-enter the verdict (got ${r2.verdict})`,
  );
  assert(
    r2.advisory?.length === 1 && r2.advisory[0]?.path === "src/other.ts",
    "round 2: the out-of-range row is still carried and still advisory",
  );
  assert(r2.bySeverity.CRITICAL === 0, "round 2: the advisory CRITICAL is not counted");

  // 3. The control: a CRITICAL ON a changed line still blocks and still sets
  // hasCritical — the advisory tier never swallows a finding whose code the PR
  // actually touched (#1143's invariant, held at line level).
  seedStore([{ severity: "CRITICAL", path: "src/a.ts", line: 11, title: "changed-line critical" }]);
  await waitForRound(2);
  const rControl = await runLensReview({ ...common, base: "main" });
  assert(
    rControl.verdict === "CRITICAL_ISSUES_FOUND",
    `control: the in-range CRITICAL decides the verdict (got ${rControl.verdict})`,
  );
  assert(
    rControl.findings.some((f) => f.title === "changed-line critical"),
    "control: the in-range finding is a reported (blocking) finding",
  );
  await waitForRound(3);
  assert(
    latestLensEntry()?.hasCritical === true,
    "control: an in-range CRITICAL sets hasCritical on the ledger entry",
  );

  // 4. An unreadable changed-line list keeps every finding blocking (fail
  // closed), and the note names the range it could not read. Driven through the
  // injected read so the assertion is about the split's own contract (every
  // finding blocks + the note) and not about what one git invocation happens to
  // say on stderr.
  const unreadable = async (): Promise<RangeList> => ({
    ok: false as const,
    reason: "git diff failed: no such branch",
  });
  const closed = await splitAdvisory({
    reported: [asFinding({ lens: "SECURITY", severity: "HIGH", path: "src/a.ts", line: 11 })],
    cwd: repo,
    base: "no-such-ref",
    head: HEAD_SHA,
    rangeRead: unreadable,
  });
  assert(
    closed.blocking.length === 1 &&
      /changed lines could not be read/.test(closed.fields.memoryNote ?? ""),
    "an unreadable range blocks everything and says why",
  );
  // The diff the lenses saw parses to nothing here, so the split falls back to
  // the refs the review resolved — and the reason names that range, so the
  // operator can see WHICH read failed.
  assert(
    /no-such-ref/.test(closed.fields.memoryNote ?? ""),
    "…and the reason names the range it could not read",
  );
  // 4a. The same shape through the REAL review, at the seam that decides the
  // verdict. The round's finding comes from the LENS, not the store; `full: true`
  // keeps the automatic delta (#973) from narrowing it. `base` names a ref that
  // does not exist, so the range cannot be read and everything blocks. The note
  // assertion is NOT duplicated here at the split's seam (a third round would
  // only re-run the read 4 already pins): what this round proves is that the
  // fail-closed behaviour reaches the VERDICT, which case 4 cannot show.
  setReport([{ severity: "CRITICAL", path: "src/a.ts", line: 11, title: "range unreadable" }]);
  seedStore([]);
  const r4 = await runLensReview({
    ...common,
    full: true,
    base: "no-such-ref",
  });
  setReport([]);
  assert(
    r4.verdict === "CRITICAL_ISSUES_FOUND" && !r4.advisory,
    "an unreadable changed-line list keeps every finding blocking (today's behaviour)",
  );
  assert(
    r4.findings.length === 1 && r4.findings[0]?.title === "range unreadable",
    "…and the finding that blocked is the round's own, not a carried row",
  );

  // (4b: the supplied-diff cases live in test-lens-review-split-source.ts)
  // 5a. A finding with no path stays blocking; a line-less finding blocks only
  // on a changed file; and nothing reported means no git read and no note.
  const split = await splitAdvisory({
    reported: [
      asFinding({ lens: "SECURITY", severity: "CRITICAL", path: "", title: "no path" }),
      asFinding({ lens: "SECURITY", severity: "LOW", path: "src/a.ts", title: "file-level" }),
      asFinding({
        lens: "ARCHITECTURE",
        severity: "LOW",
        path: "src/other.ts",
        title: "file-level untouched",
      }),
    ],
    cwd: repo,
    base: "main",
    head: HEAD_SHA,
  });
  assert(
    split.blocking.length === 2 && split.fields.advisory?.length === 1,
    "a finding with no path blocks, and a line-less finding on a changed file blocks",
  );
  assert(
    split.fields.advisory?.[0]?.path === "src/other.ts",
    "a line-less finding on a file the PR does not change is advisory",
  );
  const none = await splitAdvisory({
    reported: [],
    cwd: repo,
    base: "no-such-ref",
    diff: DIFF,
    diffComputed: true,
  });
  assert(
    none.blocking.length === 0 && !none.fields.memoryNote,
    "no reported findings → no git read and no note",
  );

  // (5a-bis..5b-quater: the split's own-source cases live in test-lens-review-split-source.ts)
  // 5c. (the unreadable-range cases are 4/4a/4b above)
  //
  // 5c-bis. The same rule at the seam that decides the verdict: a REAL delta
  // review (`since..head`, one file) whose store carries a MEDIUM on the line
  // the BRANCH changed, outside that delta. It blocks — the round's ranges are
  // the PR's `base...head`, not the delta's.
  seedStore([{ severity: "MEDIUM", path: "src/a.ts", line: 11, title: "branch-line medium" }]);
  const deltaHead = sh("git rev-parse HEAD");
  writeFileSync(path.join(repo, "src", "b.ts"), "export const z = 1;\n");
  sh("git add -A");
  sh("git commit -qm delta-round");
  const deltaSha = sh("git rev-parse HEAD");
  const rDelta = await runLensReview({
    ...common,
    diff: undefined,
    head: deltaSha,
    since: deltaHead,
    base: "main",
  });
  assert(
    rDelta.verdict === "ISSUES_FOUND" &&
      rDelta.findings.some((f) => f.title === "branch-line medium") &&
      !rDelta.advisory,
    `a delta round keeps a carried MEDIUM on a branch-changed line blocking (verdict ${rDelta.verdict})`,
  );
  setReport([]);

  // 5c-ter. RENAME AGREEMENT (#1125 round 3): the two sources of changed lines —
  // the diff the review computed and the `base...head` git read — must answer the
  // same way about a rename, or which one the split used would decide whether a
  // finding on renamed content blocks. Both are `git diff` runs with no rename
  // collapsing (`--no-renames` on the range read; the review's own computed read
  // passes no rename flag and git's default splits a rename into delete + add),
  // so a pure rename contributes NO changed lines on the new side on both paths.
  // Asserted against real git output on each side, not a pasted rename diff: a
  // fixture string would pin the fixture, not git.
  const renamedDiff = renameOnBranch(fixture, "src/other.ts", "src/renamed.ts");
  assert(
    /^rename from src\/other\.ts$/m.test(renamedDiff) &&
      /^rename to src\/renamed\.ts$/m.test(renamedDiff),
    "rename setup: git really paired the change into a rename",
  );
  const renamedFindings = (): Finding[] => [
    asFinding({ lens: "SECURITY", severity: "MEDIUM", path: "src/renamed.ts", line: 3 }),
  ];
  // (a) The diff-computed path, judged from git's own rename diff.
  const renameFromDiff = await splitAdvisory({
    reported: renamedFindings(),
    cwd: repo,
    base: "main",
    head: HEAD_SHA,
    diff: renamedDiff,
    diffComputed: true,
  });
  // (b) The git range read, on the same commit.
  const renameFromGit = await splitAdvisory({
    reported: renamedFindings(),
    cwd: repo,
    base: "main",
    head: HEAD_SHA,
  });
  assert(
    renameFromDiff.blocking.length === 0 && renameFromGit.blocking.length === 0,
    "a finding on renamed content is advisory on BOTH paths — the two reads agree",
  );
  assert(
    renameFromDiff.fields.advisory?.length === 1 &&
      renameFromGit.fields.advisory?.length === 1 &&
      !renameFromDiff.fields.memoryNote &&
      !renameFromGit.fields.memoryNote,
    "…and both list it as advisory rather than failing closed on an unreadable range",
  );

  const emptyList = await rangesFromDiff("", "main...head");
  assert(
    emptyList.ok === false && /yielded no changed lines/.test((emptyList as { ok: false }).reason),
    "an empty diff is a failed read, not 'nothing changed'",
  );
  const noSections = await rangesFromDiff("total nonsense\n", "main...head");
  assert(
    noSections.ok === false &&
      /yielded no changed lines/.test((noSections as { ok: false }).reason),
    "a non-empty diff with no file sections is a failed read too",
  );

  // 5c-bis. The notes COMPOSE: a round that both failed to record AND could not
  // read its changed lines says so on both counts — `??` used to drop one.
  const both = await resolveReportedFindings({
    deduped: [asFinding({ lens: "SECURITY", severity: "HIGH", path: "src/a.ts", line: 11 })],
    lensResults: [],
    delta: undefined,
    cwd: repo,
    base: "no-such-ref",
    // A head that is not a full SHA: the memory refuses the round (its own
    // note) and the range read cannot resolve it either (the advisory note).
    branchResolved: "feat/x",
    // A head that is not a full SHA: the memory refuses the round (its own
    // note) and the range read cannot use it either (the advisory note). The
    // diff is supplied, so the split judges the diff it was handed — and the
    // diff it was handed is empty of file sections.
    headSha: "not-a-sha",
    diff: "",
    // A caller-pasted diff (there is none here — the empty string is what a
    // review with no range of its own hands), so the split goes to the range read
    // and `no-such-ref` makes it fail closed.
    resolved: callerDiff,
  });
  assert(
    /findings memory unavailable/.test(both.fields.memoryNote ?? "") &&
      /changed lines could not be read/.test(both.fields.memoryNote ?? ""),
    "when both notes fire the summary carries both, joined — not one",
  );

  // 4b. The PR residual disclosure lists the advisory rows.
  process.env.PI_ENSEMBLE_FORGE = "github";
  let body = "";
  const execFn = async (cmd0: string, o?: { argv?: string[] }): Promise<{ stdout: string }> => {
    const cmd = commandOf(cmd0, o);
    if (cmd.includes("pr list --state open --head feat/x")) {
      return { stdout: JSON.stringify([{ number: 12 }]) };
    }
    if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
      return { stdout: JSON.stringify({ headRefName: "feat/x", baseRefName: "main" }) };
    }
    if (cmd.includes("pr comment")) {
      const file = /--body-file\s+'?([^'\s]+)'?/.exec(cmd)?.[1] ?? "";
      body = readFileSync(file, "utf8");
      return { stdout: "" };
    }
    if (cmd.includes("symbolic-ref")) return { stdout: "origin/main\n" };
    if (cmd.includes("git merge-base")) return { stdout: "mb0000\n" };
    if (cmd.includes("patch-id")) return { stdout: "p42 0000" };
    if (cmd.includes("git remote")) return { stdout: "origin\n" };
    if (cmd.includes("git config --get remote")) return { stdout: "git@github.com:o/r.git\n" };
    return { stdout: "" };
  };
  await postLensResidualDisclosure({ summary: r2, branch: "feat/x", cwd: repo, execFn });
  assert(
    body.includes(ADVISORY_HEADING) && body.includes("src/other.ts:5"),
    "the PR residual disclosure lists the advisory row under its heading",
  );
  assert(body.includes("pi-rukas:lens-residuals"), "the disclosure marker is unchanged");
} finally {
  // Both env vars the fixture set go back as they were found (unset stays
  // unset), so a later test in this process does not inherit this clone's
  // ledger path and skills dir.
  fixture.restore();
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
