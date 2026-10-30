#!/usr/bin/env bun
/**
 * lean/test-size (2/2) — the byte ceiling and the infra/verdict split.
 *
 * Split from `test-lean-test-size.ts` (AGENTS.md §12 size limit): that file
 * drives the line rule, the per-criterion quota and the run-level seed; this
 * one drives the byte bound and the rule that a stat or read which will not
 * ANSWER is handback material, never a report about work nobody looked at.
 * Same fixtures, same boundary, same `existsAtBase` stub — the seam is between
 * the size rules and the read they cost, not between two behaviours.
 *
 * A line bound alone does not bound a read: a file can sit under the line cap
 * and still be far too many bytes, and the boundary would have paid to read all
 * of it to discover that. The byte ceiling is judged on the `lstat`
 * the boundary already holds, so a file too big to be a test is refused without
 * being read at all — which is what bounds the read ONE VALIDATION performs:
 * at most `MAX_TEST_FILES_PER_CRITERION` files per criterion, each at most
 * `MAX_TEST_BYTES`. It is a bound per validation, not per run: the capture
 * re-checks the bytes it actually holds against the same constant, and case
 * (7) below drives the file that grew in between.
 *
 * The size rules read the file the way the capture does, so the fixtures here
 * are real files under a real temp `wt`: a test that stubbed the read would
 * pass whether or not production could perform it. `statSize` is driven only
 * for the shapes a real filesystem cannot be asked to produce on command — a
 * disk fault carrying a given errno, or a size no fixture should pay for. Every
 * read-side failure is driven for REAL: an unresolvable name and a 000-mode
 * file, so the errno is the operating system's rather than a fixture's.
 *
 * One case is deliberate and easy to "fix" away: the oversized fixture is over
 * BOTH bounds — `MAX_TEST_LINES` + 1 lines of 200 characters, asserted on both
 * (see `WIDE_OVER_BOUND_BYTES`). A fixture under the line bound and over the
 * byte one cannot be built with `countTestLines`' rules — bytes are always at
 * least as many lines when split hard enough — so this case pins the ORDER
 * (byte judged on the stat, before the line count is ever taken) rather than
 * the byte rule in isolation. `sizeJudgement` refuses on the stat before it
 * reads, so a file the line rule would ALSO refuse still reports bytes, and
 * that is the assertion here. The byte rule in isolation — kept at exactly the
 * bound — is the exact-bound pair below.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { PiSpec } from "../src/lean/spec.ts";
import { SpecifyInfraError, runTestPipeline } from "../src/lean/specify-run.ts";
import { validateSubmitRows } from "../src/lean/submit-tests-cap.ts";
import { MAX_TEST_BYTES, MAX_TEST_LINES, countTestLines } from "../src/lean/test-size.ts";
import type { ExecFn } from "../src/worktree.ts";

/**
 * The over-both-bounds fixture, built from the two constants so it cannot drift
 * when either moves: `MAX_TEST_LINES` + 1 lines of the widest comment line the
 * fixtures use. Shared by the byte-rule case (which pins the ORDER of the two
 * rules) and the grow case (which pins the re-check at capture); its bounds are
 * asserted once, right below, before either consumer runs.
 */
const WIDE_OVER_BOUND_BYTES = Buffer.from(
  `${"// ".padEnd(200, "x").trim()}\n`.repeat(MAX_TEST_LINES + 1),
);

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The line count alone, for the fixtures that must not be a NUL-bearing file. */
const linesOf = (bytes: Buffer): number => {
  const counted = countTestLines(bytes);
  return "lines" in counted ? counted.lines : -1;
};

// The fixture both consumers below rest on, asserted on BOTH bounds rather than
// assumed: the claim that only the byte rule could have refused it (it runs
// first, on the stat, and never opens the file) is worthless if a later edit to
// a constant quietly moves this file under one of the bounds.
assert(
  WIDE_OVER_BOUND_BYTES.length > MAX_TEST_BYTES &&
    linesOf(WIDE_OVER_BOUND_BYTES) > MAX_TEST_LINES,
  `the shared over-bound fixture really exceeds BOTH bounds (${linesOf(WIDE_OVER_BOUND_BYTES)} lines > ${MAX_TEST_LINES}, ${WIDE_OVER_BOUND_BYTES.length} bytes > ${MAX_TEST_BYTES}), so only the byte rule — which runs first, on the stat — can be what refused it`,
);

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
  writeFileSync(`${wt}/tests-wide.test.ts`, WIDE_OVER_BOUND_BYTES);
  writeFileSync(`${wt}/tests-small.test.ts`, "// small\n");
  try {
    const wideBytes = readFileSync(`${wt}/tests-wide.test.ts`);
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
      `a file over BOTH bounds is refused by the BYTE rule and not the line rule, with the byte count and the bound in its reason (got ${wide?.reason})`,
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
    // to `MAX_TEST_LINES`.
    //
    // Built FROM both constants rather than as a literal, because the two
    // bounds interact and a hard-coded shape rots the moment either moves: a
    // fixture of 160-character lines can already sit past the line cap, and the
    // case would then be refused by the LINE rule while claiming to pin the byte
    // one. `w` is the widest terminated line whose `MAX_TEST_LINES` copies still
    // fit the byte cap, and the file is `MAX_TEST_LINES - 1` of them plus one
    // unterminated `w`-character segment: `w × MAX_TEST_LINES` bytes on exactly
    // `MAX_TEST_LINES` lines (AT the line bound, never past it), padded up to the
    // byte constant by a final short segment. The one-byte overrun below extends
    // that segment, so the file stays at the line bound and is refused for one
    // byte over, rather than the line rule arriving late.
    const width = Math.floor(MAX_TEST_BYTES / MAX_TEST_LINES);
    // The two parts of the fixture, named so the arithmetic is checkable rather
    // than implied by the expression below: what the terminated lines account
    // for, and the short unterminated segment that pads up to the bound.
    const terminated = width * MAX_TEST_LINES;
    const tail = MAX_TEST_BYTES - terminated;
    // A fixture precondition, not a verdict: were `width` zero the terminated
    // lines would carry no content at all and the case would report a bound it
    // never held. `tail` cannot fail this way — it is `MAX_TEST_BYTES mod
    // MAX_TEST_LINES`, always in range.
    assert(
      width >= 1,
      `the byte cap must allow at least one character per line (got width ${width})`,
    );
    const exactBytes = Buffer.from(
      `${"x".repeat(width - 1)}\n`.repeat(MAX_TEST_LINES - 1) +
        "x".repeat(width) +
        "x".repeat(tail),
    );
    writeFileSync(`${wt}/tests-exact.test.ts`, exactBytes);
    const keptExact = await validateSubmitRows(
      [{ criterionId: "AC1", testFiles: ["tests-exact.test.ts"] }],
      { spec: SPEC, exists: () => true, existsAtBase: noBase, wt },
    );
    assert(
      exactBytes.length === MAX_TEST_BYTES &&
        linesOf(exactBytes) === MAX_TEST_LINES &&
        keptExact.kept[0]?.testFiles.includes("tests-exact.test.ts") === true,
      `a file of exactly ${MAX_TEST_BYTES} bytes under the line bound is KEPT — the bound refuses excess, not the bound (size ${exactBytes.length}, lines ${linesOf(exactBytes)})`,
    );
    // One byte more and the same file is refused, on the stat — and by the BYTE
    // rule, not the line rule arriving late: the extra byte extends the tail, so
    // the line count is unchanged, and the guard below pins that (=== the bound
    // rather than <=, so a fixture that lost its tail would not pass unnoticed).
    writeFileSync(`${wt}/tests-over.test.ts`, Buffer.from(`${exactBytes.toString()}x`));
    const keptOver = await validateSubmitRows(
      [{ criterionId: "AC1", testFiles: ["tests-over.test.ts"] }],
      { spec: SPEC, exists: () => true, existsAtBase: noBase, wt },
    );
    assert(
      keptOver.kept.length === 0 &&
        linesOf(Buffer.from(`${exactBytes.toString()}x`)) === MAX_TEST_LINES &&
        keptOver.dropped[0]?.reason ===
          `tests-over.test.ts is ${MAX_TEST_BYTES + 1} bytes; an acceptance test is at most ${MAX_TEST_BYTES} bytes`,
      `one byte past the bound is refused with the byte count in its reason (got ${JSON.stringify(keptOver.dropped.map((d) => d.reason))})`,
    );
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}

// ---- Infra versus verdict: a stat that will not answer is not a drop --------
//
// The rule the boundary keeps having to be pulled back from: a toolchain that
// could not look must not come back as "the adversary wrote nothing", because
// that is a VERDICT about work nobody judged. The split is on the error's `code`,
// not on whether it threw at all. EIO / EMFILE / EACCES are the filesystem
// declining to answer — `infra`, and a handback. ENOENT / ENOTDIR / ELOOP are
// statements about the NAME the child submitted: the capture reading that same
// name refuses it for the same fact, so the size rule says so too, as a DROP that
// names the code and carries no message.
//
// Both arms are driven through the `statSize` seam, which is what the boundary
// calls: a test cannot arrange a disk fault on command, and a `{ why }` refusal
// from the read is classified by what it IS — a verdict on the file — never by
// parsing an errno out of prose (see `missingPathCode`).
{
  const wt = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/pi-lean-test-infra-`);
  writeFileSync(`${wt}/tests-ok.test.ts`, "// fine\n");
  const errWith =
    (code: string): (() => number) =>
    () => {
      throw Object.assign(new Error(`${code}: a message no operator should ever read`), { code });
    };
  const runOne = async (
    rel: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ kept: unknown[]; dropped: { reason: string }[]; threw?: unknown }> => {
    try {
      return await validateSubmitRows([{ criterionId: "AC1", testFiles: [rel] }], {
        spec: SPEC,
        exists: () => true,
        existsAtBase: noBase,
        wt,
        ...extra,
      });
    } catch (err) {
      return { kept: [], dropped: [], threw: err };
    }
  };
  try {
    // (1) A non-path errno is infrastructure, for each family of real failure —
    // and neither the code nor the message rides into the handback.
    for (const code of ["EIO", "EMFILE", "EACCES"]) {
      const got = await runOne("tests-ok.test.ts", { statSize: errWith(code) });
      assert(
        got.threw instanceof SpecifyInfraError &&
          got.threw.message.includes("could not read tests-ok.test.ts") &&
          got.threw.message.includes(code) === false,
        `a stat that throws with code ${code} is INFRASTRUCTURE — SpecifyInfraError, which specify-run maps to a handback, naming no errno and carrying no message (got ${String(got.threw)})`,
      );
    }
    // (2) A missing-path code is a DROP, worded with the code and nothing else.
    for (const code of ["ENOENT", "ENOTDIR", "ELOOP"]) {
      const got = await runOne("tests-ok.test.ts", { statSize: errWith(code) });
      assert(
        got.threw === undefined &&
          got.kept.length === 0 &&
          got.dropped.length === 1 &&
          got.dropped[0]?.reason === `test tests-ok.test.ts could not be read (${code})`,
        `a stat that throws with code ${code} is a DROP on the child's own path, naming the code and nothing else (got ${JSON.stringify(got.dropped.map((d) => d.reason))})`,
      );
    }
    // (3) An error that carries no `code` at all is not a missing-path verdict:
    // there is nothing to read, so the rule cannot claim the child's name is
    // the problem, and a message is never parsed for one.
    const got = await runOne("tests-ok.test.ts", {
      statSize: () => {
        throw new Error("ENOENT: this message must not decide anything");
      },
    });
    assert(
      got.threw instanceof SpecifyInfraError && got.dropped.length === 0,
      `a stat error with no \`code\` is INFRASTRUCTURE even when its MESSAGE names an errno — the code is the contract, the prose is not (got ${String(got.threw)})`,
    );
    // (4) A `{ why }` refusal from the read stays a drop, in the capture's own
    // words: an empty file is the child's, not the toolchain's.
    writeFileSync(`${wt}/tests-empty.test.ts`, "");
    const empty = await runOne("tests-empty.test.ts");
    assert(
      empty.threw === undefined &&
        empty.dropped.length === 1 &&
        empty.dropped[0]?.reason === "test tests-empty.test.ts is empty" &&
        (empty.dropped[0]?.reason.includes(wt) ?? true) === false,
      `a read that refuses the file is a drop worded exactly as the capture words it, with no absolute path (got ${JSON.stringify(empty.dropped.map((d) => d.reason))})`,
    );
    // (5) A stat that does not return a size is not a size. No file has a
    // negative, fractional, infinite or beyond-safe-integer size, and reasoning
    // from one would let a broken seam decide what the byte rule saw.
    for (const [label, size] of [
      ["NaN", Number.NaN],
      ["-1", -1],
      ["1.5", 1.5],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["a size past MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 10],
    ] as const) {
      const bad = await runOne("tests-ok.test.ts", { statSize: () => size });
      assert(
        bad.threw instanceof SpecifyInfraError,
        `a stat returning ${label} is INFRASTRUCTURE, not a byte-bound verdict (got ${String(bad.threw)})`,
      );
    }
    // (6) And a drop never carries a raw error message: a refusal the FILE
    // explains (`readOneDescriptor`'s own `{ why }`) is a drop in the capture's
    // words, and no absolute path rides along in it.
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

// ---- The grow window: a file that grew AFTER validation is refused at capture
//
// The byte bound in `sizeJudgement` is a bound on ONE VALIDATION. The child
// owns the window between that validation and the capture — it wrote the file
// and it can keep writing — so `specify-run.ts` re-checks the bytes it actually
// against the same constant before a single one of them is rewritten into the
// tree. Without that second bound the rule would be a promise about a snapshot
// the run never keeps, and the trial that froze a thousand lines is exactly the
// shape a grow exploits: pass the bound while the boundary looks, keep writing
// past `MAX_TEST_BYTES`, and have the oversized file committed anyway.
{
  const grew = "tests-grew.test.ts";
  const bytes = WIDE_OVER_BOUND_BYTES;
  let captured: Map<string, Buffer> | undefined;
  const r = await growRun(bytes, (got) => {
    captured = got;
  });
  // The fixture's own bounds are asserted once, where it is defined, so by
  // here the growth is known to be real rather than a stubbed number.
  assert(
    captured?.has(grew) === true,
    "the capture itself accepted the file (it holds a looser `MAX_CAPTURE_BYTES` ceiling), so what refused it can only be the pipeline's re-check",
  );
  assert(
    r.threw === undefined &&
      r.notes.some((n) => n.includes(grew) && n.includes(`is ${bytes.length} bytes`)) &&
      r.written.has(grew) === false,
    `a file that grew past ${MAX_TEST_BYTES} after validation is refused at capture with the byte reason, and none of its bytes are rewritten into the tree (threw ${String(r.threw)}; notes ${JSON.stringify(r.notes)})`,
  );
  assert(
    r.committed.includes(grew) === false,
    `the grown file is nowhere in the commit the step made (commit ${JSON.stringify(r.committed)})`,
  );
}

/**
 * Drive `runTestPipeline` once against a REAL git tree, with a capture that hands
 * back an over-bound file. `validate` is a pass-through (production's own boundary
 * is pinned in the sections above; this case is about the SECOND bound), so the
 * only thing standing between these bytes and the commit is the re-check in step
 * 2. `written` lists what ended up in the tree and `committed` what the step's own
 * commit contains — both read back from git, not from a claim.
 */
async function growRun(
  bytes: Buffer,
  onCapture: (captured: Map<string, Buffer>) => void,
): Promise<{ threw?: unknown; notes: string[]; written: Set<string>; committed: string[] }> {
  const wt = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/pi-lean-grow-`);
  const rel = "tests-grew.test.ts";
  const written = new Set<string>();
  const committed: string[] = [];
  const out = { threw: undefined as unknown, notes: [] as string[], written, committed };
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    HOME: wt,
    XDG_CONFIG_HOME: wt,
  };
  const git = (...argv: string[]): string => {
    const r = spawnSync("git", ["-C", wt, ...argv], { encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
    return (r.stdout ?? "").trim();
  };
  const exec: ExecFn = async (_cmd, opts) => {
    const argv = (opts?.argv ?? []) as string[];
    // Run exactly what the pipeline asked for — the argv it built IS the thing
    // under test here, and a filter would make the case pass for the wrong reason.
    const r = spawnSync("git", ["-C", (opts?.cwd as string) ?? wt, ...argv], {
      encoding: "utf8",
      env,
      input: "",
    });
    if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${(r.stderr ?? "").trim()}`);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(`${wt}/a.ts`, "1\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const headBefore = git("rev-parse", "HEAD");
    // The child's own file, present when the step validates and captures it.
    writeFileSync(`${wt}/${rel}`, "// small when the boundary looked at it\n");
    const verdict = await runTestPipeline(
      {
        exec,
        wt,
        repoRoot: wt,
        issue: 77,
        branch: "main",
        headBefore,
        runnerTemplate: "sh {file}",
        wanted: ["AC1"],
        coverage: "any-red",
        extract: () => ({ rows: [{ criterionId: "AC1", testFiles: [rel] }], skipped: 0 }),
        validate: async (rows) => ({ kept: rows, dropped: [] }),
        prepare: async () => ({ wt, linked: [] }),
        commitMessage: "test: grown",
        capture: () => {
          const got = new Map([[rel, bytes]]);
          onCapture(got);
          return { captured: got, dropped: [] };
        },
      },
      { toolUses: [] },
    );
    out.notes = (verdict.reason ?? "").split("; ");
    // What the pipeline left in the tree is exactly what `writeCaptured` was
    // handed: the capture's map minus whatever step 2 refused. The reset
    // deleted the child's small version of the same name, so a name present here
    // can only have come from the captured bytes — and the step's own commit is
    // read back from git rather than from anything the pipeline claims about
    // itself.
    for (const f of git("ls-files").split("\n").filter(Boolean)) written.add(f);
    for (const f of git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean))
      written.add(f);
    for (const f of git("show", "--name-only", "--pretty=", "HEAD").split("\n").filter(Boolean))
      committed.push(f);
  } catch (err) {
    out.threw = err;
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
  return out;
}

console.log(
  exit === 0 ? "\nAcceptance-test byte bound and infra split are pinned." : "\nFAILED: byte bound",
);
process.exit(exit);
