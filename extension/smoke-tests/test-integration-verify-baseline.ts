#!/usr/bin/env bun
/**
 * #1404 — the failing-test-name parser and the per-name attribution rule the
 * commit-pr consolidated verify parks (or does not) on.
 *
 * verify-loop.sh emits failure names in TWO shapes across TWO modes, and the
 * consumer is the one place they get read back:
 *
 *   - per-failure markers `FAILED: <file>` (normal mode prints them before each
 *     failing test's output, digest mode prints them with the ✗ detail after),
 *     with normal mode appending ` (timed out after Ns)` on a watchdog kill;
 *   - the summary `FAILED: <n> test(s) — a.ts, b.ts`, which the 780-char budget
 *     collapses to `… and <m> more` when the list no longer fits.
 *
 * Names MUST come from the raw stream: `extractAttributedTail` anchors on the
 * LAST `^FAILED: .+$` line and, past its bound, keeps only that line plus the
 * tail — so parsing the bounded tail sees the summary and elides every
 * per-failure marker (the defect this test pins).
 *
 * The attribution rule is a set difference, and its fail-closed cases matter
 * more than its happy path: no names on either side, a collapsed list, or a
 * base run that killed at its bound must all read UNATTRIBUTABLE (park), never
 * "zero change-caused failures, continue".
 */
import {
  type NameRoots,
  attributeFailuresByName,
} from "../src/work-driver-verify-attribution.ts";
import {
  compareNames,
  emptyBaseReason,
  failingTestNames,
  sameFailingTest,
} from "../src/work-driver-verify-names.ts";
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The roots the attribution rule needs: the integration checkout and the
 * probe's throwaway worktree under it. Names are ALWAYS rooted — the rule has
 * no bare-name branch, so the two-set cases below prefix each name with the
 * tree its run executed in and compare by path relative to that root.
 */
const CHANGE_ROOT = "/tmp/cycle-attr/repo";
const PROBE_ROOT = `${CHANGE_ROOT}/.worktrees/baseline-verify-commit-pr`;
const attrRooted = (change: string[], base: string[]) =>
  attributeFailuresByName(
    change.map((n) => `${CHANGE_ROOT}/${n}`),
    base.map((n) => `${PROBE_ROOT}/${n}`),
    { changeRoots: [CHANGE_ROOT], probeRoot: PROBE_ROOT },
  );
const attr = (change: string[], base: string[], roots?: NameRoots) =>
  attributeFailuresByName(change, base, roots ?? { changeRoots: [CHANGE_ROOT], probeRoot: PROBE_ROOT });

// ── 7. per-test attribution: the mixed run parks naming ONLY the new tests.
{
  const a = attrRooted(
    ["tests/test-old.ts", "tests/test-new.ts", "tests/test-also-old.ts"],
    ["tests/test-old.ts", "tests/test-also-old.ts", "tests/test-unrelated-at-base.ts"],
  );
  assert(
    a.unattributable === undefined,
    "a run with names on both sides is attributable, not a park-by-silence",
  );
  assert(
    a.preExisting.length === 2 &&
      a.preExisting.includes(`${CHANGE_ROOT}/tests/test-old.ts`) &&
      a.preExisting.includes(`${CHANGE_ROOT}/tests/test-also-old.ts`),
    `both names that fail at base are pre-existing (got ${JSON.stringify(a.preExisting)})`,
  );
  assert(
    a.changeCaused.length === 1 &&
      a.changeCaused[0] === `${CHANGE_ROOT}/tests/test-new.ts`,
    `only the test that passes at base is change-caused (got ${JSON.stringify(a.changeCaused)})`,
  );
}

// ── 8. all pre-existing → nothing for the change to answer for.
{
  const a = attrRooted(["tests/test-a.ts", "tests/test-b.ts"], [
    "tests/test-a.ts",
    "tests/test-b.ts",
  ]);
  assert(
    a.changeCaused.length === 0 && a.preExisting.length === 2,
    "every failing name at base → zero change-caused (the continue case)",
  );
}

// ── 9. a name present ONLY at base does not affect the verdict.
{
  const a = attrRooted(["tests/test-a.ts"], ["tests/test-a.ts", "tests/test-renamed-away.ts"]);
  assert(
    a.changeCaused.length === 0 && a.preExisting.length === 1,
    "a test the change deleted/renamed (red at base, absent from the change run) is not counted against the change",
  );
}

// ── 10. duplicates in the change run do not double-count.
{
  const a = attrRooted(["tests/test-a.ts", "tests/test-a.ts"], ["tests/test-a.ts"]);
  assert(
    a.preExisting.length === 1 && a.changeCaused.length === 0,
    "a name printed twice (normal mode's echo) is one test, not two",
  );
}

// ── 10a. a BARE name is unattributable. There is no bare-name branch any
// more: a name with no root prefix records nothing about which tree printed it,
// and two runs agreeing on `test-a.ts` is a coincidence a forger can arrange on
// purpose (the report file is the only thing that makes a name trustworthy, and
// the root is what makes it comparable).
{
  const barePair = attributeFailuresByName(
    ["test-a.ts"],
    ["test-a.ts"],
    { changeRoots: ["/repo"], probeRoot: "/repo/.worktrees/baseline-verify-cp" },
  );
  assert(
    barePair.unattributable !== undefined &&
      barePair.preExisting.length === 0 &&
      barePair.changeCaused.length === 0,
    `two identical BARE names are unattributable, not a match (got ${JSON.stringify(barePair)})`,
  );
}

// ── 10b. the two runs happen in TWO TREES, so one test prints as two different
// absolute paths: the change run resolves against the integration checkout, the
// probe against its throwaway `.worktrees/` tree. The comparison is ANCHORED —
// each name is stripped against the root it lives under and the remainders must
// be EQUAL. Round 1 compared shared trailing segments, which excused unrelated
// files, so the whole section is written against the anchored rule.
{
  const TREE = "/tmp/cycle-abc/repo";
  const PROBE = `${TREE}/.worktrees/baseline-verify-7`;
  const roots: NameRoots = { changeRoots: [TREE], probeRoot: PROBE };
  const same = attr([`${TREE}/tests/test-red.ts`], [`${PROBE}/tests/test-red.ts`], roots);
  assert(
    same.changeCaused.length === 0,
    "the same test under two trees is ONE test — the case the feature turns on",
  );
  assert(
    same.preExisting[0] === `${TREE}/tests/test-red.ts`,
    "and it is reported in the change run's own spelling — what an operator greps for",
  );
  assert(
    attr([`${TREE}/tests/test-new.ts`], [`${PROBE}/tests/test-other.ts`], roots).changeCaused
      .length === 1,
    "two genuinely different tests across two trees stay change-caused",
  );
  const split = attr(
    [`${TREE}/tests/test-red.ts`, `${TREE}/tests/test-new.ts`],
    [`${PROBE}/tests/test-red.ts`],
    roots,
  );
  assert(
    split.preExisting.length === 1 && split.changeCaused.length === 1,
    "one pre-existing and one new across two trees splits correctly",
  );
  // THE adversarial case: the shared-tail rule excused this. `tests/test-x.ts`
  // and `p/q/r/s/tests/test-x.ts` are different files whose tails coincide, and
  // a coincidence in a rule that can only ever EXCUSE is a pushed red gate.
  // Anchored to the two known roots they are NOT equal, so the change run's
  // name is change-caused and the cycle parks.
  // THE adversarial case, restated for the bare-name refusal: these two are
  // different files whose tails coincide (`tests/test-x.ts` under one root,
  // `p/q/r/s/tests/test-x.ts` under the other). Under the old shared-tail rule
  // the coincidence EXCUSED, which is a pushed red gate. With no bare-name
  // branch neither name can be placed at all, so the run is unattributable —
  // park, which is at least as safe as `different` and does not depend on
  // guessing.
  const deep = attr(["tests/test-x.ts"], ["p/q/r/s/tests/test-x.ts"], {
    changeRoots: ["/base/repo"],
    probeRoot: "/base/repo/.worktrees/baseline-verify-cp",
  });
  assert(
    deep.unattributable !== undefined &&
      deep.preExisting.length === 0 &&
      deep.changeCaused.length === 0,
    `a same-basename test from a DIFFERENT tree excuses nothing — unplaceable names park rather than match (got ${JSON.stringify(deep)})`,
  );
  // The anchored form of the same claim, with both names placed: the shared
  // tail does not make them one test.
  const deepAnchored = attr(
    ["/base/repo/tests/test-x.ts"],
    ["/base/repo/.worktrees/baseline-verify-cp/p/q/r/s/tests/test-x.ts"],
    {
      changeRoots: ["/base/repo"],
      probeRoot: "/base/repo/.worktrees/baseline-verify-cp",
    },
  );
  assert(
    deepAnchored.changeCaused.length === 1 && deepAnchored.preExisting.length === 0,
    `a same-basename test from a DIFFERENT directory is not an excuse — it stays change-caused and the cycle parks (got ${JSON.stringify(deepAnchored)})`,
  );
  assert(
    !sameFailingTest("tests/test-x.ts", "p/q/r/s/tests/test-x.ts"),
    "sameFailingTest refuses the same-basename/different-tree pair outright",
  );
  // A name outside BOTH roots cannot be placed, so nothing about it is known:
  // unattributable (park), never "different" (which would be a guess) and never
  // "same" (which would be a push).
  const stray = attr(["/somewhere/else/test-x.ts"], [`${PROBE}/tests/test-x.ts`], roots);
  assert(
    stray.unattributable !== undefined &&
      stray.preExisting.length === 0 &&
      stray.changeCaused.length === 0,
    `a name outside both trees is unattributable, not guessed at either way (got ${JSON.stringify(stray)})`,
  );
  assert(
    compareNames(`${TREE}/tests/a.ts`, `${PROBE}/tests/a.ts`, roots) === "same" &&
      compareNames(`${TREE}/tests/a.ts`, `${PROBE}/tests/b.ts`, roots) === "different" &&
      compareNames("outside.ts", "outside.ts", roots) === "unknown" &&
      compareNames("a/x.ts", "b/x.ts", roots) === "unknown",
    "compareNames answers same / different / unknown, and unknown is reachable",
  );
  assert(
    compareNames("/a/x.ts", "/b/c/x.ts", { changeRoots: ["/a"], probeRoot: "/b" }) === "different",
    "a bare basename alone never excuses — same-named files in different dirs are different tests",
  );
  assert(
    !sameFailingTest("tests/t.ts", "tests/t.ts") && !sameFailingTest("a/t.ts", "b/c/t.ts"),
    "sameFailingTest excuses nothing without roots — a bare-name match is exactly what this seam refused",
  );
  // The degenerate configuration: one tree for both runs makes relative-path
  // equality prove nothing, so it must excuse nothing.
  assert(
    compareNames(`${TREE}/tests/a.ts`, `${TREE}/tests/a.ts`, {
      changeRoots: [TREE],
      probeRoot: TREE,
    }) === "unknown",
    "both runs in ONE tree is unknown — relative equality there proves nothing",
  );
  // A tree reached through a symlink must still anchor its own names: on macOS
  // `/var/…` and `/private/var/…` are one directory in two spellings, and a
  // gate script that resolves `$0` prints one while the caller holds the other.
  // Reading them as different trees would make every real name unplaceable.
  {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const pp = await import("node:path");
    const base = fs.mkdtempSync(pp.join(os.tmpdir(), "pi-1404-link-"));
    const real = pp.join(base, "real", "repo");
    fs.mkdirSync(pp.join(real, "tests"), { recursive: true });
    const link = pp.join(base, "link");
    fs.symlinkSync(pp.join(base, "real"), link);
    const linked = `${link}/repo`;
    const cmp = compareNames(`${real}/tests/a.ts`, `${linked}/tests/a.ts`, {
      changeRoots: [real, linked],
      probeRoot: `${real}/.worktrees/baseline-verify-cp`,
    });
    fs.rmSync(base, { recursive: true, force: true });
    assert(
      cmp === "same",
      `the same tree under two spellings (a symlinked root) is ONE tree, not an unplaceable name (got "${cmp}")`,
    );
  }
}

// ── 13. the seam itself, against a scripted exec: the two fail-OPEN guards.
//
// `attributeAgainstBase` is where "any doubt parks" has to be true, so the
// guards are tested by driving the whole function rather than its parts. Both
// of these used to be absent, and both erred in the direction that excuses.
{
  const { attributeAgainstBase } = await import("../src/work-driver-verify-attribution.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pp = await import("node:path");
  const { createVerifyReportDir, createVerifyReportFile } = await import(
    "../src/work-driver-verify-report-path.ts"
  );
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const REPO = "/repo";
  const PROBE = `${REPO}/.worktrees/baseline-verify-commit-pr`;
  /** The names the CHANGE run's report carries (its own spelling). */
  const CHANGE_NAMES = [`${REPO}/tests/test-red.ts`];
  /**
   * Scripted exec. Git/worktree plumbing succeeds; the gate run fails the way
   * `execFile` fails a non-zero child — a thrown error carrying `stdout` — so
   * the probe actually reads a red base rather than a green one. The stream it
   * carries is the loop's normal summary shape, which is what `probed` and the
   * tally cross-check read; the NAMES never come from it.
   */
  const scripted =
    (gate: { stdout: string; code: number }) =>
    async (cmd: string): Promise<{ stdout: string; stderr?: string }> => {
      if (cmd.startsWith("git ") || cmd.startsWith("mkdir") || cmd.includes("worktree")) {
        return { stdout: "" };
      }
      const err = new Error(`Command failed with exit code ${gate.code}`) as Error & {
        stdout: string;
        stderr: string;
        code: number;
      };
      err.stdout = gate.stdout;
      err.stderr = "";
      err.code = gate.code;
      throw err;
    };
  const baseStream = (names: string[], count: number): string =>
    [
      ...names.map((n) => `FAILED: ${n}`),
      `FAILED: ${count} test(s) — ${names.join(", ")}`,
      `P: 3  F: ${count}`,
    ].join("\n");
  // The driver's private report dir, and a writer for a scripted report body.
  const reportDir = createVerifyReportDir("pi-1404-seam-");
  const writeReport = (path: string, names: string[]): void => {
    fs.writeFileSync(path, names.length === 0 ? `FAILED-TESTS: 0\n` : `${names.join("\n")}\nFAILED-TESTS: ${names.length}\n`);
  };
  const newReport = (label: string): string => createVerifyReportFile(reportDir, label);
  const changeReport = newReport("change");
  writeReport(changeReport, CHANGE_NAMES);
  const opts = (verifyCmd: string, probeReport: string) => ({
    repoRoot: REPO,
    baseSha: SHA,
    verifyCmd,
    changeRoots: ["/wt-a"],
    timeoutMs: 5000,
    reportDir,
    changeReportFile: changeReport,
    probeReportFile: probeReport,
    probeEnv: { VERIFY_REPORT_FILE: probeReport },
  });

  // (a) The base run exits non-zero while its tally says NOTHING failed. The
  // two pieces of evidence disagree, so nothing may be excused on the
  // optimistic one — `F: 0` plus a report that names a test is not a red base,
  // it is a forgery or a broken harness.
  const probeA = newReport("base-a");
  writeReport(probeA, [`${PROBE}/tests/test-red.ts`]);
  const contradictory = await attributeAgainstBase(
    scripted({
      stdout: `${baseStream([`${PROBE}/tests/test-red.ts`], 1)}\nP: 4  F: 0`,
      code: 1,
    }),
    opts("sh gate.sh", probeA),
    "",
  );
  assert(
    contradictory === undefined,
    `#1404: a base whose tally says zero failures while its report names failures is a contradiction — it excuses nothing and the cycle parks (got ${JSON.stringify(contradictory)})`,
  );

  // (b) The base run exited non-zero but printed NO summary at all (a killed
  // shell, a non-loop gate). "It failed" is not evidence that THIS test failed,
  // and a silent non-zero exit must never read as a valid red verdict.
  const probeB = newReport("base-b");
  writeReport(probeB, [`${PROBE}/tests/test-red.ts`]);
  const unprobed = await attributeAgainstBase(
    scripted({ stdout: "some tool complained, no markers here", code: 1 }),
    opts("sh gate.sh", probeB),
    "",
  );
  assert(
    unprobed === undefined,
    `#1404: a base run that never reported its own verdict is unprobed — its exit code alone excuses nothing (got ${JSON.stringify(unprobed)})`,
  );

  // (c) Control: a base red on a DIFFERENT test does not excuse the change's.
  const probeC = newReport("base-c");
  writeReport(probeC, [`${PROBE}/tests/test-other.ts`]);
  const clear = await attributeAgainstBase(
    scripted({
      stdout: baseStream([`${PROBE}/tests/test-other.ts`], 1),
      code: 1,
    }),
    opts("sh gate.sh", probeC),
    "",
  );
  assert(
    clear !== undefined &&
      clear.preExistingFailures.length === 0 &&
      clear.changeCausedFailures.length === 1,
    `#1404 (control): a base red on a DIFFERENT test leaves the change's failure blamed, so the park is the change's own doing (got ${JSON.stringify(clear)})`,
  );

  // (d) Control: the coherent case still excuses, which is what makes (a)/(b)
  // the contradiction and the silence doing the work rather than a broken seam.
  const probeD = newReport("base-d");
  writeReport(probeD, [`${PROBE}/tests/test-red.ts`]);
  const agreed = await attributeAgainstBase(
    scripted({
      stdout: baseStream([`${PROBE}/tests/test-red.ts`], 1),
      code: 1,
    }),
    opts("sh gate.sh", probeD),
    "",
  );
  assert(
    agreed !== undefined &&
      agreed.preExistingFailures.length === 1 &&
      agreed.changeCausedFailures.length === 0,
    `#1404 (control): a coherent base red on the SAME test excuses it, so the seam works and (a)/(b) fail closed on their own merits (got ${JSON.stringify(agreed)})`,
  );

  // (e) THE forgery this round exists to close: the base run is GREEN — its
  // stream carries no failure at all — but the stream prints the whole triad a
  // test can print, and the base's REPORT FILE is ABSENT (nothing ever wrote
  // it). Under the old stream-parsing seam the triad alone named the test and
  // excused the change. Now the names have nowhere to come from: park.
  const probeE = newReport("base-e");
  const forged = await attributeAgainstBase(
    scripted({
      stdout: `${baseStream([`${PROBE}/tests/test-red.ts`], 1)}`,
      code: 1,
    }),
    { ...opts("sh gate.sh", probeE), reportDir: "/somewhere/else" },
    "",
  );
  assert(
    forged === undefined,
    `#1404: a report path outside the driver's private dir is never read — no report, no names, no excuse (got ${JSON.stringify(forged)})`,
  );

  // (f) The same run but with the path inside the dir and the file left EMPTY
  // (created by the driver, never written by a loop that reached no report
  // half): still unattributable, never "zero failures at base".
  const probeF = newReport("base-f");
  const empty = await attributeAgainstBase(
    scripted({
      stdout: baseStream([`${PROBE}/tests/test-red.ts`], 1),
      code: 1,
    }),
    opts("sh gate.sh", probeF),
    "",
  );
  assert(
    empty === undefined,
    `#1404: an empty report file is unattributable, not "the base named nothing so nothing is excused by it" (got ${JSON.stringify(empty)})`,
  );

  fs.rmSync(reportDir, { recursive: true, force: true });
}

// ── 14. the report READER — the forger's every move, refused. Lives in its
// own file (test-verify-report-file.ts) so this file stays under the size cap;
// both run in the offline loop, and this one keeps the attribution-rule cases.

console.log(`\nexit ${exit}`);
process.exit(exit);
