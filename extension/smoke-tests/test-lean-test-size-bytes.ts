#!/usr/bin/env bun
/**
 * lean/test-size (2/2) — the byte ceiling and the infra/verdict split.
 *
 * Split from `test-lean-test-size.ts` (AGENTS.md §12 size limit): that file
 * drives the line rule, the per-criterion quota and the run-level seed; this one
 * drives the byte bound and the rule that a stat or read which will not ANSWER
 * is handback material, never a report about work nobody looked at. Same
 * fixtures, same boundary, same `existsAtBase` stub — the seam is between the
 * size rules and the read they cost, not between two behaviours.
 *
 * A line bound alone does not bound a read: 120 lines of 200 characters is
 * 24 KiB, and the boundary would have paid for all of it to discover the file
 * was one line under the cap. The byte ceiling is judged on the `lstat` the
 * boundary already holds, so a file too big to be a test is refused without
 * being read at all — which is also what bounds the read one validation
 * performs: at most `MAX_TEST_FILES_PER_CRITERION` files per criterion, each at
 * most `MAX_TEST_BYTES`.
 *
 * The size rules read the file the way the capture does, so the fixtures here
 * are real files under a real temp `wt`: a test that stubbed the read would pass
 * whether or not production could perform it. `statSize` is driven only for the
 * shapes a real filesystem cannot be asked to produce on command — a stat that
 * throws, or a size no fixture should pay for.
 *
 * One case is deliberate and easy to "fix" away: the oversized fixture is over
 * BOTH bounds (121 lines of 200 characters). A fixture under the line bound and
 * over the byte one cannot be built with `countTestLines`' rules — bytes are
 * always at least as many lines when split hard enough — so this case pins the
 * ORDER (byte judged on the stat, before the line count is ever taken) rather
 * than the byte rule in isolation. `sizeJudgement` refuses on the stat before it
 * reads, so a file the line rule would ALSO refuse still reports bytes, and that
 * is the assertion here. The byte rule in isolation — kept at exactly the bound
 * — is the exact-bound pair below.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { PiSpec } from "../src/lean/spec.ts";
import { validateSubmitRows } from "../src/lean/submit-tests-cap.ts";
import { MAX_TEST_BYTES, MAX_TEST_LINES, countTestLines } from "../src/lean/test-size.ts";

/** The line count alone, for the fixtures that must not be a NUL-bearing file. */
const linesOf = (bytes: Buffer): number => {
  const counted = countTestLines(bytes);
  return "lines" in counted ? counted.lines : -1;
};

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SPEC: PiSpec = {
  problem: "p",
  size: "S",
  criteria: [
    { id: "AC1", text: "retries", verify: "test" },
    { id: "AC2", text: "docs", verify: "manual" },
  ],
};

const noBase = async () => false;

// ---- The byte ceiling: refused on the stat, before any read -----------------
{
  const wt = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/pi-lean-test-bytes-`);
  writeFileSync(`${wt}/tests-wide.test.ts`, `${"// ".padEnd(200, "x").trim()}\n`.repeat(121));
  writeFileSync(`${wt}/tests-small.test.ts`, "// small\n");
  try {
    const wideBytes = readFileSync(`${wt}/tests-wide.test.ts`);
    // Over BOTH bounds, so the byte rule — which runs first, on the stat, and
    // never opens the file — is the only thing that can have refused it.
    // A file under the byte bound that the LINE rule would refuse: 200-char
    // lines, 121 of them. It is only refused by the byte rule because the byte
    // rule runs first, on the stat, and that ordering is the whole point of the
    // case — so the fixture is asserted on BOTH bounds, not on one.
    assert(
      linesOf(wideBytes) > MAX_TEST_LINES && wideBytes.length > MAX_TEST_BYTES,
      `the 121-line fixture is over BOTH bounds (${linesOf(wideBytes)} lines > ${MAX_TEST_LINES}, ${wideBytes.length} bytes > ${MAX_TEST_BYTES}), so only the byte rule — which runs first, on the stat — can be what refused it`,
    );
    const reads: string[] = [];
    const byBytes = await validateSubmitRows(
      [{ criterionId: "AC1", testFiles: ["tests-wide.test.ts", "tests-small.test.ts"] }],
      {
        spec: SPEC,
        exists: () => true,
        existsAtBase: noBase,
        wt,
        statSize: (abs) => {
          reads.push(abs);
          return Number(readFileSync(abs).length);
        },
      },
    );
    const wide = byBytes.dropped.find((d) => d.path === "tests-wide.test.ts");
    assert(
      wide?.reason ===
        `tests-wide.test.ts is ${wideBytes.length} bytes; an acceptance test is at most ${MAX_TEST_BYTES} bytes`,
      `a 121-line, 24 KiB file is refused by the BYTE rule and not the line rule, with the byte count and the bound in its reason (got ${wide?.reason})`,
    );
    assert(
      byBytes.kept[0]?.testFiles.includes("tests-small.test.ts") === true,
      `the small file beside it is still kept — the byte rule refuses one file, not the row (kept ${JSON.stringify(byBytes.kept)})`,
    );
    // The oversized file costs no read of its bytes: the seam saw two stats and
    // the reader was never opened on the wide one, because the read is only
    // reached by a file the stat already admitted.
    assert(
      reads.length === 2,
      `both candidates were stat'd and the oversized one left without a read being attempted on it (${JSON.stringify(reads.map((r) => r.split("/").pop()))})`,
    );
    // A file at exactly the bound, and under the line bound, is KEPT: the rule
    // refuses excess, not the bound itself — the same rule the line cap applies
    // to `MAX_TEST_LINES`. `16384 = 160 x 102 + 64`: a file at the byte bound,
    // A file at the byte bound whose 102 160-character lines make it 103 lines
    // (the last segment is unterminated, so it counts as one): well under the
    // line bound, so the only rule that can judge it is the byte one. The
    // literal is spelled out because the assertion is precisely about hitting
    // the constant.
    const exactBytes = Buffer.from(`${"x".repeat(159)}\n`.repeat(102) + "x".repeat(64));
    writeFileSync(`${wt}/tests-exact.test.ts`, exactBytes);
    const keptExact = await validateSubmitRows(
      [{ criterionId: "AC1", testFiles: ["tests-exact.test.ts"] }],
      { spec: SPEC, exists: () => true, existsAtBase: noBase, wt },
    );
    assert(
      exactBytes.length === MAX_TEST_BYTES &&
        linesOf(exactBytes) <= MAX_TEST_LINES &&
        keptExact.kept[0]?.testFiles.includes("tests-exact.test.ts") === true,
      `a file of exactly ${MAX_TEST_BYTES} bytes under the line bound is KEPT — the bound refuses excess, not the bound (size ${exactBytes.length}, lines ${linesOf(exactBytes)})`,
    );
    // One byte more and the same file is refused, on the stat.
    writeFileSync(`${wt}/tests-over.test.ts`, Buffer.from(`${exactBytes.toString()}x`));
    const keptOver = await validateSubmitRows(
      [{ criterionId: "AC1", testFiles: ["tests-over.test.ts"] }],
      { spec: SPEC, exists: () => true, existsAtBase: noBase, wt },
    );
    assert(
      keptOver.kept.length === 0 &&
        keptOver.dropped[0]?.reason ===
          `tests-over.test.ts is ${MAX_TEST_BYTES + 1} bytes; an acceptance test is at most ${MAX_TEST_BYTES} bytes`,
      `one byte past the bound is refused with the byte count in its reason (got ${JSON.stringify(keptOver.dropped.map((d) => d.reason))})`,
    );
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}

// ---- Infra versus verdict: a read that cannot answer is not a drop ----------
//
// The rule the boundary keeps having to be pulled back from: a toolchain that
// could not look must not come back as "the adversary wrote nothing", because
// that is a VERDICT about work nobody judged. EIO / EMFILE / EACCES are the
// real shapes; `statSize` throwing is how a test says so without owning a disk.
{
  const wt = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/pi-lean-test-infra-`);
  writeFileSync(`${wt}/tests-ok.test.ts`, "// fine\n");
  try {
    for (const [name, statSize] of [
      ["a stat that throws", () => throwSomething("EIO: i/o error")],
      [
        "a read that throws",
        (abs: string) => Number(readFileSync(`${abs.replace(/\/tests-/, "/never-")}`).length),
      ],
    ] as const) {
      let threw: unknown;
      try {
        await validateSubmitRows([{ criterionId: "AC1", testFiles: ["tests-ok.test.ts"] }], {
          spec: SPEC,
          exists: () => true,
          existsAtBase: noBase,
          wt,
          statSize,
        });
      } catch (err) {
        threw = err;
      }
      assert(
        threw !== undefined &&
          (threw as Error).name === "SpecifyInfraError" &&
          /could not read tests-ok\.test\.ts/.test((threw as Error).message),
        `${name} is INFRASTRUCTURE — it throws SpecifyInfraError, which specify-run maps to a handback (got ${String(threw)})`,
      );
    }
    // And the drop reasons never carry a raw error message: an unreadable stat
    // that the FILE explains (`readOneDescriptor`'s own `{ why }`) is a drop, in
    // the capture's words, and no absolute path rides along in it.
    const droppedOnly = await validateSubmitRows(
      [{ criterionId: "AC1", testFiles: ["tests-ok.test.ts"] }],
      {
        spec: SPEC,
        exists: () => true,
        existsAtBase: noBase,
        wt,
        statSize: () => 42,
      },
    );
    assert(
      droppedOnly.kept[0]?.testFiles.length === 1 &&
        droppedOnly.dropped.every((d) => !d.reason.includes("Error") && !d.reason.includes(wt)),
      `a kept file produces no drop at all, and no drop reason carries an error message or the worktree path (got ${JSON.stringify(droppedOnly.dropped.map((d) => d.reason))})`,
    );
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}

function throwSomething(why: string): never {
  throw new Error(why);
}

console.log(
  exit === 0 ? "\nAcceptance-test byte bound and infra split are pinned." : "\nFAILED: byte bound",
);
process.exit(exit);
