#!/usr/bin/env bun
/**
 * #1404 — the failing-test-name PARSER: reading names out of a
 * verify-loop.sh / verify-report.sh stream, in both of its output modes.
 *
 * This is the parsing half of the attribution feature, split out of
 * `test-integration-verify-baseline.ts` for the 500-line cap (AGENTS.md §12)
 * along the seam the source itself has: `work-driver-verify-names.ts` is pure
 * string functions, and the two files here keep that split. What lives here is
 * "what may a `FAILED:` line be believed to say"; the per-name attribution
 * rule, the tree anchoring and the probe seam live in the other file.
 *
 * verify-loop.sh emits failure names in TWO shapes across TWO modes, and this
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
 * Every rule here is fail-closed, so the forged and degenerate shapes are the
 * ones that matter most: a name read from a line a TEST printed would excuse a
 * real regression, and a stream whose count disagrees with its own list is not
 * that stream's verdict.
 */
import {
  digestTallyFailCount,
  emptyBaseReason,
  failingTestNames,
  isContradictoryTally,
  summaryCount,
} from "../src/work-driver-verify-names.ts";

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
  const names = failingTestNames(
    "FAILED: extension/smoke-tests/test-a.ts\nFAILED: extension/smoke-tests/test-b.ts\nFAILED: 2 test(s) — extension/smoke-tests/test-a.ts, extension/smoke-tests/test-b.ts",
  );
  assert(
    names.length === 2 &&
      names.includes("extension/smoke-tests/test-a.ts") &&
      names.includes("extension/smoke-tests/test-b.ts"),
    `per-failure markers + the summary agree on the two failing files (got ${JSON.stringify(names)})`,
  );
}

// ── 2. a summary with NO per-failure markers names nothing. Its count is the
// loop's own, and a list that agrees with it has to be corroborated by the
// markers the loop prints per failure — a bare `FAILED: 3 test(s) — …` line a
// test echoed is indistinguishable from the real one, so reading names from it
// alone would let a forged summary excuse a regression.
{
  const names = failingTestNames("FAILED: 3 test(s) — test-a.ts, test-b.ts, test-c.ts");
  assert(
    names.length === 0,
    `a summary with no per-failure markers to corroborate it is not trusted as names (got ${JSON.stringify(names)})`,
  );
  const withMarkers = failingTestNames(
    "FAILED: test-a.ts\nFAILED: test-b.ts\nFAILED: test-c.ts\nFAILED: 3 test(s) — test-a.ts, test-b.ts, test-c.ts",
  );
  assert(
    withMarkers.length === 3 && withMarkers.includes("test-c.ts"),
    "the same summary WITH its markers names all three — the markers are what makes it trustworthy",
  );
}

// ── 3. the watchdog suffix names the SAME file as a plain failure.
{
  const normal = failingTestNames(
    "FAILED: smoke-tests/test-slow.ts (timed out after 120s)\nFAILED: 1 test(s) — smoke-tests/test-slow.ts",
  );
  const base = failingTestNames(
    "FAILED: smoke-tests/test-slow.ts\nFAILED: 1 test(s) — smoke-tests/test-slow.ts",
  );
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
}

// ── 5. no marker at all (the tsc / biome shape).
{
  const none = failingTestNames("src/foo.ts(12,3): error TS2304: Cannot find name 'x'\n");
  assert(
    none.length === 0,
    "a typecheck failure names no tests — its stream carries no FAILED: marker",
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

// ── 7. the tally is read by POSITION, and never reads as a green base.
{
  // The loop's own tally is the LAST `P:/F:` line. A test that echoed the shape
  // earlier is output, not a verdict — and reading it as one turns a red run
  // green, which is the fail-open shape this seam exists to remove.
  const echoed = [
    "some body of output",
    "P: 9  F: 0",
    "FAILED: extension/smoke-tests/test-a.ts",
    "FAILED: 1 test(s) — extension/smoke-tests/test-a.ts",
    "P: 4  F: 1",
  ].join("\n");
  assert(
    digestTallyFailCount(echoed) === 1,
    "the loop's own tally is the last one printed, not the first echo it saw",
  );
  assert(
    isContradictoryTally(echoed) === false,
    "a red run that printed `P: 9  F: 0` as test OUTPUT is not a contradiction — its real tally is the last line",
  );
  const allPass = "P: 5  F: 0";
  assert(
    digestTallyFailCount(allPass) === 0 && isContradictoryTally(allPass) === false,
    "a genuinely all-pass digest is a clean 0, and is not flagged as contradictory",
  );
  const forged = "FAILED: a.ts\nFAILED: 1 test(s) — a.ts\nP: 5  F: 0";
  assert(
    isContradictoryTally(forged) === true,
    "names beside `F: 0` IS a contradiction — that pairing excuses nothing",
  );
  assert(
    summaryCount("no summary at all") === undefined,
    "a stream with no summary reports no count rather than zero",
  );
  const timedOut = emptyBaseReason(true, "");
  assert(
    /killed at its bound/.test(timedOut),
    `a killed base run says so rather than reading as a clean base (got "${timedOut.slice(0, 90)}")`,
  );
  const noNames = emptyBaseReason(false, "some output with no marker");
  assert(
    /no trustworthy FAILED: summary/.test(noNames),
    `a base failure that named nothing says which evidence is missing (got "${noNames.slice(0, 90)}")`,
  );
}

// ── 8. FAILED: lines a TEST prints are not names. `FAILED:` is an ordinary
// string; a fixture that echoes it is the forgeable shape the parser refuses.
{
  // A test printing a `FAILED:` line naming a file the change never touched:
  // believed, it would excuse a regression (base side) or invent one (change
  // side). It is refused by the count rule — the summary the loop prints
  // disagrees with the names on the stream.
  const forged = [
    "P: 1  F: 1",
    "FAILED: /etc/passwd",
    "console.log('FAILED: 1 test(s) — /etc/passwd')",
    "FAILED: 0 test(s) —",
  ].join("\n");
  assert(
    failingTestNames(forged).length === 0,
    "a stream whose markers do not add up to its own summary names nothing",
  );
  const honest = "FAILED: tests/test-x.ts\nFAILED: 1 test(s) — tests/test-x.ts";
  assert(
    failingTestNames(honest).length === 1,
    "a well-formed stream still parses, so the refusal above is the mismatch doing it",
  );
  const collapsedStill = failingTestNames("FAILED: 9 test(s) — a… and 7 more").length === 0;
  assert(collapsedStill, "the collapse still names nothing");
  // A single summary-shaped line with nothing behind it names nothing, so a
  // test cannot forge a base-side excuse with one printed line. It is the SAME
  // shape as case 2 and must behave the same way.
  const forgedBase = failingTestNames("FAILED: 1 test(s) — forged-by-a-test.ts\nP: 2  F: 1");
  assert(
    forgedBase.length === 0,
    `a lone summary-shaped line is not names, so the base side cannot be forged by a test's own output (got ${JSON.stringify(forgedBase)})`,
  );
}

// ── 9. real digest fixtures from verify-loop.sh, not hand-written shapes.
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
}

console.log(`\nexit ${exit}`);
process.exit(exit);
