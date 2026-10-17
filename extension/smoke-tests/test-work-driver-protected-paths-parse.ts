#!/usr/bin/env bun
/**
 * #1378 (part 1a of 3) — the two `-z` parsers, unit-pinned.
 *
 * Split out of test-work-driver-protected-paths-read.ts (the 500-line cap,
 * AGENTS.md §12). Nothing here touches git or the develop gate: each parser is
 * fed the exact byte stream git produces — and the malformed streams that must
 * come back unreadable rather than as a shorter list. The layouts differ in
 * field ORDER (`XY new\0orig\0` vs `R100\0from\0to`), which is why they are two
 * parsers and not one; the module header of
 * src/work-driver-protected-paths-read.ts says why they are not merged with the
 * two sibling readers either.
 *
 * Companion files:
 *   - test-work-driver-protected-paths-read.ts — the gate against real git
 *   - test-work-driver-protected-paths-read-canary.ts — the read-shape canary
 */
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  PROTECTED_DIFF_ARGV,
  PROTECTED_STATUS_ARGV,
  changedPaths,
  readCommittedProtectedPaths,
  readProtectedStatusPaths,
  renameSourcePaths,
} from "../src/work-driver-protected-paths-read.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { realExec } from "./lib/exec-fake.ts";
import { isNulDiffRead, isNulStatusRead, nulNameStatus } from "./lib/nul-porcelain.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const CI = ".github/workflows/ci.yml";
const BASE = "b".repeat(40);

/** An executor that answers every call with `stdout`, optionally recording the argv. */
function fake(stdout: string, onCall?: (argv: string[]) => void) {
  return (async (_cmd: string, opts?: { argv?: string[] }) => {
    onCall?.(opts?.argv ?? []);
    return { stdout };
  }) as NonNullable<DriverContext["verifyExecFn"]>;
}

{
  const statusCalls: string[][] = [];
  const st = await readProtectedStatusPaths(
    fake("R  .pi/verify-cmd2\0src/a.ts\0", (a) => statusCalls.push(a)),
    "/wt",
  );
  assert(
    st.ok === true && st.paths.join("|") === ".pi/verify-cmd2|src/a.ts",
    "status -z: a rename contributes BOTH sides, new name first (`XY new\\0orig\\0`)",
  );
  assert(
    statusCalls[0]?.join(" ") === PROTECTED_STATUS_ARGV.join(" "),
    "status read is argv-shaped: `git status --porcelain -z --untracked-files=all`",
  );

  assert(
    (await readProtectedStatusPaths(fake("R  only-one-side\0"), "/wt")).ok === false,
    "status -z: a rename with no origin token is unreadable, not a one-sided guess",
  );
  assert(
    (await readProtectedStatusPaths(fake("ZZ\u0000src/a.ts\u0000"), "/wt")).ok === false,
    "status -z: a malformed record (no status separator) is unreadable",
  );
  assert(
    (await readProtectedStatusPaths(fake(""), "/wt")).ok === true &&
      (await readProtectedStatusPaths(fake(""), "/wt")).paths.length === 0,
    "status -z: an empty stream is an empty change set, not an error",
  );

  const diffCalls: string[][] = [];
  const df = await readCommittedProtectedPaths(
    fake("R100\0.github/workflows/ci.yml\0src/ci.yml\0", (a) => diffCalls.push(a)),
    "/wt",
    BASE,
  );
  assert(
    df.ok === true &&
      changedPaths(df.targets).join() === "src/ci.yml" &&
      renameSourcePaths(df.targets).join() === CI,
    "diff -z: the destination is a changed path, the source is protected-only (`R100\\0from\\0to`)",
  );
  assert(
    df.ok === true &&
      df.targets.length === 1 &&
      df.targets[0].kind === "R" &&
      df.targets[0].score === "100",
    "diff -z: the rename record keeps its kind and git's similarity score (a mispaired rename's only clue)",
  );
  assert(
    diffCalls[0]?.join(" ") === [...PROTECTED_DIFF_ARGV, `${BASE}..HEAD`].join(" "),
    "committed read is argv-shaped with -z, --name-status, -M and --end-of-options",
  );
  const deletion = await readCommittedProtectedPaths(
    fake("D\0.pi/verify-cmd\0"),
    "/wt",
    BASE,
  );
  assert(
    deletion.ok === true &&
      changedPaths(deletion.targets).join() === ".pi/verify-cmd" &&
      deletion.targets[0]?.kind === "D",
    "diff -z: a `D` record is a first-class path AND stays typed `D` (a delete-plus-add pair does not collapse to R100, and a deletion test is not a modification test)",
  );
  const addition = await readCommittedProtectedPaths(
    fake("A\0.github/workflows/new.yml\0"),
    "/wt",
    BASE,
  );
  assert(
    addition.ok === true && addition.targets[0]?.kind === "A",
    "diff -z: an `A` record keeps its kind too — the kinds are emitted, not collapsed to M",
  );
  const typeChange = await readCommittedProtectedPaths(fake("T\0src/link\0"), "/wt", BASE);
  assert(
    typeChange.ok === true &&
      typeChange.targets[0]?.kind === "other" &&
      changedPaths(typeChange.targets).join() === "src/link",
    "diff -z: a kind git prints that is none of M/A/D/R (T here) keeps its letter and still contributes its path",
  );
  assert(
    (await readCommittedProtectedPaths(fake("R100\0src/a.ts\0"), "/wt", BASE)).ok === false,
    "diff -z: a rename record missing its destination is unreadable",
  );
  assert(
    (await readCommittedProtectedPaths(fake("M\0"), "/wt", BASE)).ok === false,
    "diff -z: a status record without its path is unreadable",
  );
  // A NON-EMPTY token in the code slot is the case the empty check did not cover.
  // A path there is not an exotic kind — it is a codeless stream, and reading on
  // would pair it with the NEXT token and drop the protected path from the change
  // set while returning ok:true, which is the exact failure this gate exists to
  // prevent.
  const codelessProtected = await readCommittedProtectedPaths(
    fake(".github/workflows/ci.yml\0src/ci.yml\0"),
    "/wt",
    BASE,
  );
  assert(
    codelessProtected.ok === false,
    "diff -z: a path in the code slot (codeless stream) is unreadable, not an `other` record that swallows the protected path",
  );
  assert(
    codelessProtected.ok === false &&
      /unrecognised name-status code/.test(codelessProtected.unreadable) &&
      codelessProtected.unreadable.includes(CI),
    "diff -z: the rejection names the offending code token so the operator sees which record broke",
  );
  assert(
    (await readCommittedProtectedPaths(fake("agents.json\0src/a.ts\0"), "/wt", BASE)).ok ===
      false,
    "diff -z: a protected `agents.json` in the code slot is unreadable too — no non-letter token is accepted as a kind",
  );
  const renamed = await readCommittedProtectedPaths(
    fake(`R100\0${CI}\0src/ci.yml\0`),
    "/wt",
    BASE,
  );
  assert(
    renamed.ok === true && renamed.targets.length === 1 && renamed.targets[0].kind === "R",
    "diff -z: a committed R100 record is typed `R` (the letter dispatch runs before the code-shape check, so a scored rename is never `other`)",
  );
  // -z names are verbatim: a backslash or a tab is data, not an escape to decode.
  const verbatim = await readCommittedProtectedPaths(
    fake("A\0.github/back\\slash.yml\0A\0.github/tab\there.yml\0"),
    "/wt",
    BASE,
  );
  assert(
    verbatim.ok === true &&
      changedPaths(verbatim.targets).join("|") ===
        ".github/back\\slash.yml|.github/tab\there.yml",
    "diff -z: a backslash or a tab in a protected name arrives verbatim, undecoded",
  );
  const verbatimStatus = await readProtectedStatusPaths(
    fake("?? .github/back\\slash.yml\0?? .github/tab\there.yml\0"),
    "/wt",
  );
  assert(
    verbatimStatus.ok === true &&
      verbatimStatus.paths.join("|") === ".github/back\\slash.yml|.github/tab\there.yml",
    "status -z: a backslash or a tab in a protected name arrives verbatim, undecoded",
  );
  const boom = (async () => {
    throw new Error("stdout maxBuffer length exceeded");
  }) as NonNullable<DriverContext["verifyExecFn"]>;
  const failedDiff = await readCommittedProtectedPaths(boom, "/wt", BASE);
  assert(
    failedDiff.ok === false && /maxBuffer/.test(failedDiff.unreadable),
    "diff -z: a rejected read is unreadable with the error text (no silent truncation of the rename list)",
  );
  const stringRejection = await readCommittedProtectedPaths(
    (async () => {
      throw "git died without an Error object";
    }) as NonNullable<DriverContext["verifyExecFn"]>,
    "/wt",
    BASE,
  );
  assert(
    stringRejection.ok === false &&
      stringRejection.unreadable.includes("git died without an Error object"),
    'diff -z: a non-Error rejection is narrowed, not cast — the reason carries its text, not "undefined"',
  );

  // The scripted fakes in every develop-gate test spell a committed change set as
  // `nulNameStatus("src/a.ts")` / `"D\t.pi/verify-cmd"`. If that spelling collapsed
  // every kind to `M`, a "deletion halts" assertion would be answered by a stream
  // that never said deletion — so the fake's kinds are pinned through the real parser.
  const spelled = await readCommittedProtectedPaths(
    fake(
      nulNameStatus(
        "src/mod.ts",
        "A\t.github/workflows/new.yml",
        "D\t.pi/verify-cmd",
        `R\t${CI}\tsrc/moved.yml`,
      ),
    ),
    "/wt",
    BASE,
  );
  assert(
    spelled.ok === true &&
      spelled.targets.map((r) => r.kind).join(",") === "M,A,D,R" &&
      changedPaths(spelled.targets).join("|") ===
        "src/mod.ts|.github/workflows/new.yml|.pi/verify-cmd|src/moved.yml" &&
      renameSourcePaths(spelled.targets).join() === CI,
    "fake fidelity: nulNameStatus emits the kind the test spelled (M/A/D survive, R keeps both sides)",
  );

  // A COPY is not a rename: `cp .github/workflows/ci.yml src/ci.yml` leaves the
  // workflow in place and duplicates it, and git reports `C100\0from\0to`. The
  // protected gate must consult the source exactly as it does a rename's, or a
  // developer reads a protected file out and hands it over as their own artifact.
  // `kind` is `C`, not a re-labelled `R` — the two are different acts, and the
  // finding the operator reads should say which one git saw. (`C` only ever
  // appears in production because `PROTECTED_DIFF_ARGV` carries `-C`; `-M` alone
  // never emits one.)
  const copied = await readCommittedProtectedPaths(
    fake(nulNameStatus(`C\t${CI}\tsrc/copied.yml`)),
    "/wt",
    BASE,
  );
  assert(
    copied.ok === true &&
      copied.targets[0]?.kind === "C" &&
      copied.targets[0].kind === "C" &&
      copied.targets[0].score === "100" &&
      copied.targets[0].from === CI &&
      copied.targets[0].to === "src/copied.yml",
    "diff -z: a `C` record is its own kind, carrying its score, source and destination",
  );
  const copiedLowScore = await readCommittedProtectedPaths(
    fake(nulNameStatus(`C75\t.pi/verify-cmd\tsrc/x`)),
    "/wt",
    BASE,
  );
  assert(
    copiedLowScore.ok === true &&
      copiedLowScore.targets[0]?.kind === "C" &&
      copiedLowScore.targets[0].kind === "C" &&
      copiedLowScore.targets[0].score === "75",
    "fake fidelity: nulNameStatus emits a C record with the score the test spelled (C75, not C100)",
  );
  const copyOnlyStream = await readCommittedProtectedPaths(
    fake(nulNameStatus(`C\t${CI}\tsrc/copied.yml`)),
    "/wt",
    BASE,
  );
  assert(
    copyOnlyStream.ok === true && renameSourcePaths(copyOnlyStream.targets).join() === CI,
    "fake fidelity: a copy's SOURCE reaches renameSourcePaths, the list only the protected gate reads",
  );
  assert(
    copyOnlyStream.ok === true && changedPaths(copyOnlyStream.targets).join() === "src/copied.yml",
    "a copy contributes only its DESTINATION to changedPaths — the source left the tree intact, and it belongs to the protected list alone",
  );
  // `R` and `C` side by side: both sources are collected, neither is mistaken
  // for the other's kind, and the destinations alone reach the change union.
  const mixed = await readCommittedProtectedPaths(
    fake(
      nulNameStatus(`R\t${CI}\tsrc/moved.yml`, `C\t.pi/verify-cmd\tsrc/copied`, "M\tsrc/a.ts"),
    ),
    "/wt",
    BASE,
  );
  assert(
    mixed.ok === true &&
      mixed.targets.map((t) => t.kind).join(",") === "R,C,M" &&
      renameSourcePaths(mixed.targets).join("|") === `${CI}|.pi/verify-cmd` &&
      changedPaths(mixed.targets).join("|") === "src/moved.yml|src/copied|src/a.ts",
    "R and C are handled wherever each other is: both sources collected, both destinations in the union, kinds preserved",
  );

  // The fakes in lib/nul-porcelain.ts match these two reads by comparing the
  // command line `commandOf` builds against the argv constants. If the reader ever
  // sends something the matchers do not recognise, EVERY scripted fake falls through
  // to `{stdout:""}` and the assertions pass against an empty change set — so the
  // routing is asserted here, at the source of truth, rather than trusted.
  const routed: string[] = [];
  const router = ((cmd: string, opts?: { argv?: string[] }) => {
    const line = commandOf(cmd, opts);
    routed.push(line);
    return Promise.resolve({ stdout: "" });
  }) as NonNullable<DriverContext["verifyExecFn"]>;
  await readProtectedStatusPaths(router, "/wt");
  await readCommittedProtectedPaths(router, "/wt", BASE);
  assert(
    routed.length === 2 && isNulStatusRead(routed[0] ?? "") && isNulDiffRead(routed[1] ?? ""),
    "routing: a real argv call through commandOf satisfies both fake matchers (a drift would make every scripted fake vacuous)",
  );
  assert(
    isNulStatusRead("git status --porcelain --untracked-files=all") === false &&
      isNulDiffRead("git diff --name-status -M a..HEAD") === false,
    "routing: the pre-`-z` command lines do NOT match — a fake cannot answer a read the gate no longer makes",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
