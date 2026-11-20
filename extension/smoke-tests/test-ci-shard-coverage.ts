#!/usr/bin/env bun
/**
 * Issue #2425 (epic #2424 item 1b, R1 + R6) — every offline smoke file lands in
 * exactly one of CI's 4 shards.
 *
 * `.github/workflows/ci.yml` runs the offline suite as a 4-way matrix. Each
 * shard re-enumerates the suite at run time and keeps the files whose 0-based
 * index in the sorted offline list mod 4 equals its shard index:
 *
 *   ls smoke-tests/test-*.ts | grep -v -- '-live[.]ts$' | LC_ALL=C sort \
 *     | awk -v s="$SHARD" '(NR-1) % 4 == s'
 *
 * The failure mode this guards is a VACUOUS GREEN: a shard whose split matches
 * nothing has no files to fail, and the shell guard that refuses an empty shard
 * lives in the same run block that could delete it. So the invariant is stated
 * here independently of that guard — every offline file lands in one shard and
 * one only, no shard is empty — and the shard count and the modulus are READ
 * OUT of ci.yml rather than restated, since a test that hard-coded 4 would keep
 * passing while the matrix quietly narrowed to 3.
 *
 * The enumeration is the workflow's rule over the same directory (same glob,
 * same `-live.ts` exclusion, same byte-order sort), cross-checked against
 * `isOfflineTest` from `src/work-driver-verify-shared.ts` so the three
 * spellings of "offline" cannot drift, and against the workflow's own shell
 * pipeline run once here. Readers live in `lib/ci-shard-split.ts` so the
 * canaries can judge mutated splits in memory: ci.yml is a gate file and this
 * test never writes it, or anything else.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  matrixShardKeys,
  offlineSmokeFiles,
  padShards,
  shardCoverageFailures,
  shardsOf,
  splitModulus,
} from "./lib/ci-shard-split.ts";
import { isOfflineTest } from "../src/work-driver-verify-shared.ts";

const SMOKE_DIR = import.meta.dirname;
const EXT_DIR = path.resolve(SMOKE_DIR, "..");
const WORKFLOW = path.resolve(EXT_DIR, "..", ".github", "workflows", "ci.yml");

/** readdirSync over the same directory the workflow's `ls` expands: this test
 * reads the directory listing and the two files it names, and writes nothing. */
function readdirNames(): string[] {
  return readdirSync(SMOKE_DIR);
}

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

let workflow: string;
try {
  workflow = readFileSync(WORKFLOW, "utf8");
} catch (err) {
  const code = typeof err === "object" && err && "code" in err ? String(err.code) : String(err);
  console.error(`✗ ${WORKFLOW} is NOT readable (${code}) — the shard split is unpinned`);
  console.log("\nexit 1");
  process.exit(1);
}

const shardKeys = matrixShardKeys(workflow);
const mod = splitModulus(workflow);
assert(
  shardKeys !== null,
  `ci.yml declares a readable matrix shard key list (${JSON.stringify(shardKeys)})`,
);
assert(mod !== null, `ci.yml declares a readable awk split modulus (${JSON.stringify(mod)})`);
if (shardKeys === null || mod === null) {
  console.log("\nFAILED — cannot judge a split whose width is unreadable");
  process.exit(1);
}
assert(
  shardKeys.every((k, i) => k === i) && shardKeys.length >= 2,
  `the shard keys are 0..${shardKeys.length - 1} (got ${shardKeys.join(",")}) — every index awk can answer`,
);
assert(
  shardKeys.length === mod,
  `the matrix lists ${shardKeys.length} shard key(s) and awk splits mod ${mod} — one shard per key`,
);

const globbed = readdirNames().filter((n) => /^test-[^/]+\.ts$/.test(n));
const live = globbed.filter((n) => /-live\.ts$/.test(n));
const offline = offlineSmokeFiles(globbed);

assert(
  offline.length > 100,
  `the enumeration saw the suite (${offline.length} offline files of ${globbed.length} glob matches)`,
);
// The exclusion must actually exclude: an offline set equal to the raw glob
// means no `-live.ts` file exists to drop, i.e. the glob or the suffix changed.
assert(
  live.length > 0 && offline.length + live.length === globbed.length,
  `the -live.ts exclusion drops ${live.length} file(s) from the ${globbed.length}-file glob, leaving ${offline.length} offline`,
);
// The offline/live boundary is one rule with three spellings; assert the src
// predicate agrees file-for-file with the rule this test and ci.yml use.
const disagree = offline.filter((f) => !isOfflineTest(`smoke-tests/${f}`));
assert(
  disagree.length === 0,
  `isOfflineTest() agrees with the workflow's glob+exclusion for all ${offline.length} files${
    disagree.length ? ` — disagree: ${disagree.join(", ")}` : ""
  }`,
);
// And with the tool the workflow actually runs, over the real directory:
// `LC_ALL=C sort` is the definition of the order, so this is where a JS
// comparator that ever disagreed with it is caught.
const shellSorted = execFileSync(
  "sh",
  ["-c", "ls smoke-tests/test-*.ts | grep -v -- '-live[.]ts$' | LC_ALL=C sort"],
  { cwd: EXT_DIR, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
)
  .trim()
  .split("\n")
  .map((p) => p.split("/").pop() as string);
assert(
  shellSorted.length > 100 && shellSorted.join() === offline.join(),
  `the JS byte-order enumeration equals the workflow's shell pipeline (${shellSorted.length} files)`,
);

const N = shardKeys.length;
const shards = shardsOf(offline, mod);
const cleanFails = shardCoverageFailures(offline, shards);
for (const f of cleanFails) console.error(`✗ ${f}`);
if (cleanFails.length > 0) exit = 1;
console.log(
  `✓ ${offline.length} offline files split ${N} ways: ${shards
    .map((s, i) => `shard ${i}=${s.length}`)
    .join(" ")}`,
);
assert(
  shards.reduce((n, s) => n + s.length, 0) === offline.length,
  `the shards' file counts sum to the offline total (${offline.length})`,
);

// ---- canaries: the gate observed red, in memory. ci.yml is never written.
//
// The three verdicts are deliberately different wording, so a case that only
// wanted "some failure" could be satisfied by the wrong one: a split that loses
// files is named as an OMISSION, a split that leaves a shard with nothing to run
// as an EMPTY SHARD, a split that runs a file twice as an OVERLAP. A reader that
// reported all three alike would pass these cases while telling the reader the
// opposite of what happened.
const OFF = "lands in no shard";
const EMPTY = "is empty";
const OVERLAP = "lands in both shard";

// Every case is judged on the REAL suite and the REAL declared shard count, and
// each names the verdict it must produce and nothing else (`every`): any rule
// other than the shipped one over a suite this size either leaves a declared
// shard with nothing to run or leaves files that answer no declared shard, so
// the demand is meaningful and not an artefact of a toy list. `differ` is the
// one arm whose mutant is a permutation and so cannot be judged by the
// correctness arms — see its own comment.
const mutations: Array<[string, string[][], string, "fail" | "differ"]> = [
  [
    "mod 3 — narrower than the matrix, so the fourth shard has nothing to run",
    padShards(shardsOf(offline, 3), N),
    EMPTY,
    "fail",
  ],
  [
    "mod 2 — two of the four declared shards left unfed",
    padShards(shardsOf(offline, 2), N),
    EMPTY,
    "fail",
  ],
  [
    "mod 5 — wider than the matrix, so files answer no declared shard",
    shardsOf(offline, 5).slice(0, N),
    OFF,
    "fail",
  ],
  // The split read 1-based where the workflow reads 0-based: `NR % 4 == s`
  // instead of `(NR-1) % 4 == s`. Over a suite whose length is a multiple of the
  // width that shift is a permutation — every file still runs exactly once, so
  // the omission/overlap arms are silent by construction (an early version of
  // this case passed for exactly that reason). What it changes is WHICH shard
  // owns which file, so the case is judged by "the mutated board must not equal
  // the shipped one": a reader blind to that would call a mis-based split
  // correct. Measured on the suite as it stands, every shard's list differs.
  [
    "an off-by-one index base (`NR % 4` where the workflow is `(NR-1) % 4`)",
    Array.from({ length: N }, (_, i) => offline.filter((_, k) => (k + 1) % N === i)),
    OFF,
    "differ",
  ],
  [
    "the head of every shard dropped",
    shards.map((s) => s.slice(Math.ceil(s.length / 4))),
    OFF,
    "fail",
  ],
  ["every file assigned to two shards", [...shards, ...shards], OVERLAP, "fail"],
  [
    "one shard holding the whole suite",
    [Array.from(offline), ...shards.slice(1).map(() => [])],
    EMPTY,
    "fail",
  ],
];
for (const [label, mutated, want, kind] of mutations) {
  if (kind === "differ") {
    // The case whose mutant is a permutation: the correctness arms are silent by
    // construction, so what this canary demands is that the mutated board is
    // NOT the shipped one — which is what makes the split's index base a
    // checkable property at all.
    const same = mutated.every((s, i) => s.join() === (shards[i] ?? []).join());
    if (!same)
      console.log(`✓ canary ${label}: reassigns files, so the shipped split is not reproduced`);
    else {
      console.error(
        `✗ canary ${label}: the mutated split equals the shipped one — the case tests nothing`,
      );
      exit = 1;
    }
    continue;
  }
  const fails = shardCoverageFailures(offline, mutated);
  const ok = fails.length > 0 && fails.every((f) => f.includes(want));
  if (ok) console.log(`✓ canary ${label}: reported as ${JSON.stringify(want)}`);
  else {
    console.error(
      `✗ canary ${label}: want every failure to read ${JSON.stringify(want)}, got ${fails.length}: ${fails[0]?.slice(0, 70) ?? "none"}`,
    );
    exit = 1;
  }
}
assert(cleanFails.length === 0, "canary: the shipped split is the case that passes");

// The empty-shard arm on its own: a board with no files is vacuously complete,
// so only that arm makes an all-empty matrix red. A reader that dropped it would
// report this as a clean run.
const emptyArm = shardCoverageFailures(
  [],
  Array.from({ length: N }, () => [] as string[]),
);
assert(
  emptyArm.length === N && emptyArm.every((f) => f.includes(EMPTY)),
  `canary: an all-empty shard board is reported ${N} times, never as a clean run`,
);

// The enumeration's own arms: a glob that matched nothing, or an exclusion that
// excluded nothing, would report a clean 0-file split.
assert(
  offlineSmokeFiles(["helper-x.ts", "spike-y.ts", "test-a.ts.md", "test-a.ts"]).join() ===
    "test-a.ts",
  "canary: the glob admits only test-*.ts and drops helper/spike/other extensions",
);
assert(
  offlineSmokeFiles(["test-a.ts", "test-b-live.ts"]).join() === "test-a.ts",
  "canary: the exclusion drops a -live.ts file the glob matched",
);
// Byte order, judged on a pair whose collation answers differently — so a
// comparator that degraded to `localeCompare` is caught rather than agreeing by
// luck. Every name in the current suite is lower-case ASCII plus digits, where
// the two agree; the case pair is what makes the comparator's rule observable.
const probe = ["test-a.ts", "test-A.ts"];
const sortedByte = [...probe].sort((a, b) =>
  Buffer.from(a, "utf8").compare(Buffer.from(b, "utf8")),
);
const sortedLocale = [...probe].sort((a, b) => a.localeCompare(b));
assert(
  offlineSmokeFiles(probe).join() === "test-A.ts,test-a.ts" &&
    sortedByte.join() === "test-A.ts,test-a.ts",
  `canary: the byte comparator puts uppercase before lowercase (${sortedByte.join()})`,
);
assert(
  sortedLocale.join() !== sortedByte.join(),
  `canary: the probe separates the comparators — locale answers ${sortedLocale.join()} (so a locale-degraded reader is caught, not rewarded)`,
);

// The width readers, judged on mutants of the shipped text — never on the file.
// A reader that fell back to a default when the shape was unreadable would keep
// this gate green through exactly the edit it exists to catch.
const AWK_SPLIT_PREFIX = "awk -v s=\"$SHARD\" '";

/** Rewrite the awk split expression on the line the workflow actually runs, and
 * only there — asserted to have applied, so a mutant that matched nothing (or
 * matched a comment instead) is a red rather than a canary that judged the
 * shipped text and called it a mutation. */
function mutateAwkSplit(text: string, replacement: string): string {
  const at = text.indexOf(AWK_SPLIT_PREFIX);
  if (at < 0) throw new Error(`the workflow no longer runs \`${AWK_SPLIT_PREFIX}\``);
  const start = at + AWK_SPLIT_PREFIX.length;
  const end = text.indexOf("')", start);
  const current = text.slice(start, end);
  if (current !== "(NR-1) % 4 == s")
    throw new Error(`the shipped awk split is ${JSON.stringify(current)}, not the pinned form`);
  const mutated = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
  if (mutated === text) throw new Error(`the ${JSON.stringify(replacement)} mutant did not apply`);
  return mutated;
}

const widthMutants: Array<[string, string, number[] | null, number | null]> = [
  [
    "shard keys narrowed to 3",
    workflow.replace("shard: [0, 1, 2, 3]", "shard: [0, 1, 2]"),
    [0, 1, 2],
    mod,
  ],
  [
    "shard keys shifted off zero",
    workflow.replace("shard: [0, 1, 2, 3]", "shard: [1, 2, 3, 4]"),
    [1, 2, 3, 4],
    mod,
  ],
  ["the shard key list deleted", workflow.replace("        shard: [0, 1, 2, 3]\n", ""), null, mod],
  [
    "the awk modulus changed to 3",
    mutateAwkSplit(workflow, "(NR-1) % 3 == s"),
    shardKeys,
    3,
  ],
  // The index base is a checkable property only because this reader is asked
  // about it: revert the workflow to the 1-based form and the reader answers
  // null rather than reporting the modulus it was supposed to be reading.
  // Both mutations target the awk LINE, not a bare `replace` over the whole
  // file: the split's spelling also appears in this file's and the workflow's
  // prose, and the first match of a whole-file replace is a comment — a canary
  // that edited prose and still "passed" would be judging nothing.
  [
    "the split reverted to the 1-based form",
    mutateAwkSplit(workflow, "NR % 4 == s"),
    shardKeys,
    null,
  ],
];
for (const [label, text, wantKeys, wantMod] of widthMutants) {
  const gotKeys = matrixShardKeys(text);
  const gotMod = splitModulus(text);
  const ok = JSON.stringify(gotKeys) === JSON.stringify(wantKeys) && gotMod === wantMod;
  if (ok)
    console.log(`✓ canary width reader ${label}: keys ${JSON.stringify(gotKeys)}, mod ${gotMod}`);
  else {
    console.error(
      `✗ canary width reader ${label}: want ${JSON.stringify(wantKeys)}/${wantMod}, got ${JSON.stringify(gotKeys)}/${gotMod}`,
    );
    exit = 1;
  }
}
// And the shipped text is what those two readers must answer, so the canaries
// above cannot be satisfied by a reader that returned a constant.
assert(
  JSON.stringify(matrixShardKeys(workflow)) === JSON.stringify(shardKeys) &&
    splitModulus(workflow) === mod,
  `canary: the readers answer ${shardKeys.length}/${mod} on the shipped ci.yml, not a constant`,
);

console.log(exit === 0 ? "\nAll CI shard coverage checks passed." : "\nFAILED");
process.exit(exit);
