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
  attributeFailuresByName,
  emptyBaseReason,
  failingTestNames,
  isAllPassDigestTally,
  sameFailingTest,
} from "../src/work-driver-verify-attribution.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── 1. the per-failure marker shape (both modes print it).
{
  const stream = [
    "some preamble from the typecheck stage",
    "FAILED: extension/smoke-tests/test-a.ts",
    "✓ a passing line",
    "✗ test-a: expected 1 to be 2",
    "FAILED: extension/smoke-tests/test-b.ts",
    "✗ test-b: boom",
    "FAILED: 2 test(s) — extension/smoke-tests/test-a.ts, extension/smoke-tests/test-b.ts",
    "P: 3  F: 2",
  ].join("\n");
  const names = failingTestNames(stream);
  assert(
    names.length === 2 &&
      names.includes("extension/smoke-tests/test-a.ts") &&
      names.includes("extension/smoke-tests/test-b.ts"),
    `per-failure markers + the summary agree on the two failing files (got ${JSON.stringify(names)})`,
  );
}

// ── 2. the summary-only shape (what an already-truncated tail carries).
{
  const names = failingTestNames(
    "FAILED: 3 test(s) — test-a.ts, test-b.ts, test-c.ts\n✗ test-c: the last assertion",
  );
  assert(
    names.length === 3 && names[2] === "test-c.ts",
    `the summary form alone still names every test (got ${JSON.stringify(names)})`,
  );
}

// ── 3. the watchdog suffix names the SAME file as a plain failure.
{
  const normal = failingTestNames("FAILED: smoke-tests/test-slow.ts (timed out after 120s)");
  const base = failingTestNames("FAILED: smoke-tests/test-slow.ts");
  assert(
    normal.length === 1 && normal[0] === "smoke-tests/test-slow.ts",
    `the "(timed out after Ns)" suffix is stripped so the name compares equal (got ${JSON.stringify(normal)})`,
  );
  assert(
    base[0] === normal[0],
    "a hung test at base matches a hung test in the change run by name",
  );
}

// ── 4. the `… and N more` collapse makes the run UNATTRIBUTABLE, not partial.
{
  const collapsed = failingTestNames("FAILED: 9 test(s) — test-a.ts, test-b.ts… and 7 more");
  assert(
    collapsed.length === 0,
    `a collapsed summary returns NO names — the hidden 7 cannot be guessed at (got ${JSON.stringify(collapsed)})`,
  );
  const a = attributeFailuresByName([], collapsed);
  assert(
    a.unattributable !== undefined && a.changeCaused.length === 0 && a.preExisting.length === 0,
    "a collapsed base list with no names to compare is unattributable, not a zero-failure pass",
  );
  const stillParks = attributeFailuresByName(["test-a.ts"], collapsed);
  assert(
    stillParks.changeCaused.length === 1 && stillParks.unattributable === undefined,
    "a collapsed BASE list never excuses a named failing test — it stays change-caused, so the cycle parks",
  );
}

// ── 5. no marker at all (the tsc / biome shape).
{
  assert(
    failingTestNames("src/a.ts(3,1): error TS2304: Cannot find name 'nope'.\n").length === 0,
    "a typecheck failure names no tests — its stream carries no FAILED: marker",
  );
  const a = attributeFailuresByName([], ["test-a.ts"]);
  assert(
    a.unattributable !== undefined && a.preExisting.length === 0,
    "an empty change set is unattributable — NOT read as 'nothing caused by the change'",
  );
}

// ── 6. the 800-char tail bound elides per-failure markers: parse the RAW stream.
{
  // The exact shape extractAttributedTail produces past its bound: the marker
  // line, an elision, then the tail. Everything before the LAST marker is gone.
  const raw = [
    ...Array.from({ length: 20 }, (_, i) => `FAILED: test-${i}.ts`),
    "noise".repeat(400),
    "FAILED: 20 test(s) — test-0.ts, test-1.ts",
  ].join("\n");
  const tail = raw.slice(-300);
  assert(
    failingTestNames(raw).length >= 20,
    "the raw stream names every per-failure marker the run printed",
  );
  const fromTail = failingTestNames(tail);
  assert(
    fromTail.length <= 2,
    `the bounded tail alone sees almost nothing (${fromTail.length}) — which is why the seam parses the raw stream`,
  );
}

// ── 7. per-test attribution: the mixed run parks naming ONLY the new tests.
{
  const a = attributeFailuresByName(
    ["test-old.ts", "test-new.ts", "test-also-old.ts"],
    ["test-old.ts", "test-also-old.ts", "test-unrelated-at-base.ts"],
  );
  assert(
    a.unattributable === undefined,
    "a run with names on both sides is attributable, not a park-by-silence",
  );
  assert(
    a.preExisting.length === 2 &&
      a.preExisting.includes("test-old.ts") &&
      a.preExisting.includes("test-also-old.ts"),
    `both names that fail at base are pre-existing (got ${JSON.stringify(a.preExisting)})`,
  );
  assert(
    a.changeCaused.length === 1 && a.changeCaused[0] === "test-new.ts",
    `only the test that passes at base is change-caused (got ${JSON.stringify(a.changeCaused)})`,
  );
}

// ── 8. all pre-existing → nothing for the change to answer for.
{
  const a = attributeFailuresByName(["test-a.ts", "test-b.ts"], ["test-a.ts", "test-b.ts"]);
  assert(
    a.changeCaused.length === 0 && a.preExisting.length === 2,
    "every failing name at base → zero change-caused (the continue case)",
  );
}

// ── 9. a name present ONLY at base does not affect the verdict.
{
  const a = attributeFailuresByName(["test-a.ts"], ["test-a.ts", "test-renamed-away.ts"]);
  assert(
    a.changeCaused.length === 0 && a.preExisting.length === 1,
    "a test the change deleted/renamed (red at base, absent from the change run) is not counted against the change",
  );
}

// ── 10. duplicates in the change run do not double-count.
{
  const a = attributeFailuresByName(["test-a.ts", "test-a.ts"], ["test-a.ts"]);
  assert(
    a.preExisting.length === 1 && a.changeCaused.length === 0,
    "a name printed twice (normal mode's echo) is one test, not two",
  );
}

// ── 10b. the two runs happen in TWO TREES, so one test prints as two different
// absolute paths: the change run resolves against the integration checkout, the
// probe against its throwaway `.worktrees/` tree. Comparing the raw strings is
// the bug this section guards — every pre-existing failure would read as
// change-caused, and the feature would park exactly the cycles it exists to save.
{
  const TREE = "/tmp/cycle-abc/repo";
  const PROBE = `${TREE}/.worktrees/baseline-verify-7`;
  const same = attributeFailuresByName(
    [`${TREE}/tests/test-red.ts`],
    [`${PROBE}/tests/test-red.ts`],
  );
  assert(
    same.changeCaused.length === 0,
    "the same test under two trees is ONE test — the case the feature turns on",
  );
  assert(
    same.preExisting[0] === `${TREE}/tests/test-red.ts`,
    "and it is reported in the change run's own spelling — what an operator greps for",
  );
  assert(
    attributeFailuresByName([`${TREE}/tests/test-new.ts`], [`${PROBE}/tests/test-other.ts`])
      .changeCaused.length === 1,
    "two genuinely different tests across two trees stay change-caused",
  );
  const split = attributeFailuresByName(
    [`${TREE}/tests/test-red.ts`, `${TREE}/tests/test-new.ts`],
    [`${PROBE}/tests/test-red.ts`],
  );
  assert(
    split.preExisting.length === 1 && split.changeCaused.length === 1,
    "one pre-existing and one new across two trees splits correctly",
  );
  assert(
    attributeFailuresByName(["/a/b/x.ts"], ["/c/d/e/x.ts"]).changeCaused.length === 1,
    "a bare basename alone never excuses — same-named files in different dirs are different tests",
  );
  assert(
    sameFailingTest(`${TREE}/tests/t.ts`, `${PROBE}/tests/t.ts`) &&
      !sameFailingTest("/a/x.ts", "/b/c/x.ts"),
    "sameFailingTest agrees with the splitter",
  );
}

// ── 11. the all-pass digest tally is recognised, and never reads as a green base.
{
  assert(
    isAllPassDigestTally("P: 12  F: 0"),
    "the digest's all-pass tally line is recognised exactly as verify-report.sh emits it",
  );
  assert(
    !isAllPassDigestTally("P: 11  F: 1"),
    "a tally with any failure is not the all-pass shape",
  );
  assert(
    !isAllPassDigestTally("total P: 12  F: 0 passed"),
    "a line that merely CONTAINS the tally is not it — only the emitted line matches",
  );
  const reason = emptyBaseReason(false, "P: 12  F: 0");
  assert(
    /F: 0/.test(reason) && /contradict/i.test(reason),
    `an exit-non-zero-with-F:0 base names the contradiction (got "${reason.slice(0, 120)}")`,
  );
  const timedOut = emptyBaseReason(true, "");
  assert(
    /killed at its bound/.test(timedOut),
    `a killed base run says so rather than reading as a clean base (got "${timedOut.slice(0, 90)}")`,
  );
  const noNames = emptyBaseReason(false, "some output with no marker");
  assert(
    /no FAILED: marker/.test(noNames),
    `a base failure that named nothing says which evidence is missing (got "${noNames.slice(0, 90)}")`,
  );
}

// ── 12. real digest fixtures from verify-loop.sh, not hand-written shapes.
{
  const { spawnSync } = await import("node:child_process");
  const path = await import("node:path");
  const FIXTURES = path.join(import.meta.dirname, "fixtures", "verify-loop");
  const loop = path.join(import.meta.dirname, "lib", "verify-loop.sh");
  const files = ["fixture-1.ts", "fixture-2.ts", "fixture-3.ts"];
  const run = spawnSync("bash", [loop, ...files.map((f) => path.join(FIXTURES, f))], {
    encoding: "utf8",
  });
  assert(run.status === 1, `the real loop exits 1 on a failing fixture set (got ${run.status})`);
  const names = failingTestNames(`${run.stdout}\n${run.stderr}`);
  assert(
    names.length === 2 &&
      names.some((n) => n.endsWith("fixture-1.ts")) &&
      names.some((n) => n.endsWith("fixture-3.ts")),
    `normal mode names exactly the two failing fixtures (got ${JSON.stringify(names.map((n) => n.split("/").pop()))})`,
  );
  const dig = spawnSync("bash", [loop, "--digest", ...files.map((f) => path.join(FIXTURES, f))], {
    encoding: "utf8",
  });
  assert(dig.status === 1, `digest mode exits 1 on the same set (got ${dig.status})`);
  const digNames = failingTestNames(`${dig.stdout}\n${dig.stderr}`);
  assert(
    digNames.length === 2 &&
      digNames.every((n) => n === digNames[0] || n !== digNames[0]) &&
      digNames.filter((n) => n.endsWith("fixture-1.ts")).length === 1 &&
      digNames.filter((n) => n.endsWith("fixture-3.ts")).length === 1,
    `digest mode names the same two fixtures — both modes feed the same parser (got ${JSON.stringify(digNames.map((n) => n.split("/").pop()))})`,
  );
  const allPass = spawnSync(
    "bash",
    [loop, "--digest", path.join(FIXTURES, "allpass-a.ts"), path.join(FIXTURES, "allpass-b.ts")],
    { encoding: "utf8" },
  );
  assert(
    allPass.status === 0 && failingTestNames(allPass.stdout).length === 0,
    "an all-pass digest names no failures (and its tally is the only line)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
