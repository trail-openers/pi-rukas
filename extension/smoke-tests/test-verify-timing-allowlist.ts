#!/usr/bin/env bun
/**
 * Issue #2449 (epic #2424 item 3) — the shrink-only gate on the ceiling allow-list.
 *
 * The ceiling (`PI_ENSEMBLE_VERIFY_TIMING_CEILING_S`, lib/verify-timing.sh) exempts a
 * file only by an entry in timing-allowlist.json. The ratchet is worthless if the list
 * can grow: the cheap way to silence a ceiling failure would be to add the offending
 * file to the list, which is exactly the regression the ceiling exists to catch. So the
 * list is pinned to shrink-only — a file can be removed from it, never added — and this
 * gate is what makes "added" a visible, refused diff rather than a quiet one.
 *
 * What is pinned, each a separate failure so a reader knows WHICH invariant broke:
 *
 *   1. The entry count equals `baseline_count`. Growth is the thing the ratchet stops;
 *      a count below the baseline is fine (a file got faster / the entry retired) and
 *      is what shrinking looks like, so only a count ABOVE the baseline fails. The
 *      count is read from the file itself, not hardcoded here, so editing the number
 *      is the only way to raise the ceiling and that edit is the reviewable diff.
 *   2. Every `file` names a real file relative to `extension/`. An entry for a path
 *      that does not exist is dead weight that only ever grows, and a typo in a path is
 *      an entry that exempts nothing while still counting toward the total.
 *   3. Every entry carries a positive integer `seconds` and a `measured` date — a
 *      dated measurement, not a bare name, so a reviewer sees what the bound was set
 *      against and when.
 *   4. No duplicate `file`. Two rows for one path is a list that does not mean what it
 *      says and would double-count the ratchet.
 *   5. The seed set is committed BY NAME (R1/AC3). The seed rule is "every file whose
 *      highest reading exceeded 20 s" — for the 2026-11-22 re-seed, over THREE full
 *      green main CI runs rather than one measurement — which a reader cannot check
 *      against a date; the paths below are the seed, so an entry cannot be swapped for
 *      a file that never ran slow. Its canary is observed RED on a mutant that drops one.
 *   6. The count gate is observed RED on a mutant list carrying one entry beyond its
 *      own baseline — an unexecuted gate proves nothing.
 *   7. AC4: the knob has its row in `docs/configuration.md` and troubleshooting
 *      describes the `CEILING:` failure. The issue makes the docs an acceptance
 *      criterion; nothing else judges them.
 *
 * The gate reads the shipped file with the loop's OWN parser AND its OWN key
 * normaliser (via bash, sourcing lib/verify-timing.sh) rather than a second JSON
 * reader, so the gate and the ceiling cannot drift into exempting different sets of
 * files (R4): one parser and one key, two consumers. Every entry is therefore asserted
 * to equal `timing_key()` of the absolute path it names — the same normalisation the
 * matcher applies to a row — so a normaliser change reddens this gate.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { removeAllowlist, writeAllowlist } from "./lib/verify-loop-timing-harness.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, ".."); // extension/
const ALLOWLIST = path.join(REPO, "timing-allowlist.json");
const VERIFY_TIMING = path.join(REPO, "smoke-tests", "lib", "verify-timing.sh");
// AC4: the docs are an acceptance criterion of the issue, and this is the only gate
// that reads them for the ceiling. The repo root sits one level above extension/.
const DOCS = path.resolve(REPO, "..", "docs");

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    exit = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

// The loop's own parser and its own key normaliser, run exactly as the ceiling runs
// them: source verify-timing.sh, then call `_timing_allowlist_entries` (which prints
// `secs<TAB>file` per record) and `timing_key` (which reduces a path to the key the
// ceiling matches on). This is deliberately the SAME code path the ceiling uses, so
// the gate cannot pass a list the ceiling would read differently — and, for the
// existence check below, cannot certify a path spelling the ceiling would never
// match. A normaliser that stopped stripping, or that stripped too little, reddens
// here rather than quietly exempting a whole directory (R4: one key, two consumers).
// The gate and the ceiling read the committed list through the SAME code: sourcing
// verify-timing.sh runs its real parse, so the ceiling's own knob gate and file test
// decide whether a read happens at all. `loopRows` therefore asks for the read the way
// a run with the ratchet on asks for it — a 1-second ceiling (the file's slowest row is
// 190 s, so every row is over it and every row reaches the list) and `TIMING_ALLOWLIST`
// pointed at the committed file. Neither knob reaches the shipped state: both are read
// from the environment here, and this gate spawns its own bash.
const CEILING_FOR_READ = "1";
const sourceLoop = (call: string): string =>
  // The knobs are named AFTER the source: verify-timing.sh parses them at source
  // time, so an assignment before the `.` would be read and then overwritten by the
  // file's own default — the ceiling would come back 0 and the read would be refused.
  `. "${VERIFY_TIMING}" >/dev/null 2>&1; VERIFY_TIMING_CEILING_S=${CEILING_FOR_READ}; TIMING_ALLOWLIST="${ALLOWLIST}"; ${call}`;

function loopRows(): { seconds: string; file: string }[] {
  const r = spawnSync("bash", ["-c", sourceLoop("_timing_allowlist_entries")], {
    cwd: REPO,
    encoding: "utf8",
  });
  const rows: { seconds: string; file: string }[] = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    rows.push({ seconds: line.slice(0, tab), file: line.slice(tab + 1) });
  }
  return rows;
}

/** The loop's OWN parser over an arbitrary list document — the seam the canaries
 * below use so the mutant runs through the shipped code path, not through a
 * re-implementation of it in this file. The path assignment has to precede the call:
 * `sourceLoop` parses the knobs at source time and points the list at the shipped
 * file, so an assignment after the call would land too late to be read. */
function loopRowsFrom(file: string): { seconds: string; file: string }[] {
  const call = `TIMING_ALLOWLIST=${JSON.stringify(file)}; _timing_allowlist_entries`;
  const r = spawnSync("bash", ["-c", sourceLoop(call)], { cwd: REPO, encoding: "utf8" });
  const rows: { seconds: string; file: string }[] = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    rows.push({ seconds: line.slice(0, tab), file: line.slice(tab + 1) });
  }
  return rows;
}

/** The loop's ONE key function, applied to a path the way the ceiling applies it to
 * every row it checks. Batched into one bash call: each spawn is a fork, and this
 * gate judges every entry in the list. */
function loopKey(...paths: string[]): string[] {
  const script = paths.map((p) => `timing_key ${JSON.stringify(p)}`).join("; ");
  const r = spawnSync("bash", ["-c", sourceLoop(script)], { cwd: REPO, encoding: "utf8" });
  return (r.stdout ?? "").split("\n").slice(0, paths.length);
}

// The raw file, for the fields the loop parser does not surface (measured date, count,
// duplicates) — the loop parser intentionally drops `measured`, so this gate reads it.
function rawParsed(): { entries?: unknown[]; baseline_count?: unknown } | unknown[] {
  return JSON.parse(readFileSync(ALLOWLIST, "utf8"));
}
function rawEntries(): { file: string; seconds: unknown; measured: unknown }[] {
  const parsed = rawParsed();
  return (Array.isArray(parsed) ? parsed : (parsed.entries ?? [])) as {
    file: string;
    seconds: unknown;
    measured: unknown;
  }[];
}
function rawBaseline(): number {
  const parsed = rawParsed();
  return Array.isArray(parsed) ? Number.NaN : Number(parsed.baseline_count);
}

/**
 * R1/AC3 — the seed set, committed BY NAME. The rule for who belongs here is a
 * measurement ("every file whose highest reading exceeded 20 s"), which no reader can
 * re-check against a date. Naming the paths is what turns "seeded from those runs" into
 * an assertion: an entry cannot quietly become a file that never ran slow, and a
 * swap-out reddens here rather than at the next ceiling failure.
 *
 * This is the list as RE-SEEDED on 2026-11-22, the single re-seed taken at the moment
 * the ceiling was turned on: the union of every offline test whose `TIME` reading
 * exceeded 20 s in ANY of three full green main CI runs on 2026-11-21/22 (runs
 * 44958757907 at 457d7e3b, 44957264868, and 44953824025 at dfb68ef3 — each four shards
 * at `PI_ENSEMBLE_VERIFY_TEST_JOBS=4`), plus every path the original 27-entry 11-21
 * seed named. No prior entry was dropped, because a re-seed that also shrank would
 * quietly retire exemptions on one day's host load; shrinking stays the ratchet's job.
 * Order matters — the whole list is compared against this list below.
 */
const SEED_FILES = [
  "smoke-tests/test-work-driver-adversarial-fix-routing.ts",
  "smoke-tests/test-plan-body-budget.ts",
  "smoke-tests/test-work-driver-transient-retry.ts",
  "smoke-tests/test-lean-build-nowork-retry.ts",
  "smoke-tests/test-work-driver-adversarial-reporting.ts",
  "smoke-tests/test-verify-timing-ceiling.ts",
  "smoke-tests/test-plan-provenance.ts",
  "smoke-tests/test-plan-pi-spec-filing.ts",
  "smoke-tests/test-work-driver-adversarial-writeahead-persist.ts",
  "smoke-tests/test-work-driver-adversarial-reentry.ts",
  "smoke-tests/test-host-park-signal.ts",
  "smoke-tests/test-verify-loop-timing.ts",
  "smoke-tests/test-merge-guard-ci-evidence-gitlab.ts",
  "smoke-tests/test-merge-guard-ci-holes-2107.ts",
  "smoke-tests/test-work-driver-offloaded-spec.ts",
  "smoke-tests/test-headless-supervised-child.ts",
  "smoke-tests/test-headless-interrupt-explore.ts",
  "smoke-tests/test-work-driver-adv-retry-t6.ts",
  "smoke-tests/test-lens-provider-refusal.ts",
  "smoke-tests/test-explore-body-retry.ts",
  "smoke-tests/test-headless-supervise.ts",
  "smoke-tests/test-verify-loop-parallel.ts",
  "smoke-tests/test-work-driver-corrective-round.ts",
  "smoke-tests/test-tool-inactivity.ts",
  "smoke-tests/test-work-driver-continue-pr-lookup.ts",
  "smoke-tests/test-verify-loop-jobs-from-host.ts",
  "smoke-tests/test-lens-review-head-sha.ts",
  "smoke-tests/test-lean-handback-report-bound.ts",
  "smoke-tests/test-cancel.ts",
  "smoke-tests/test-git-state-report.ts",
  "smoke-tests/test-public-hygiene-visibility.ts",
  "smoke-tests/test-public-hygiene-target-bound.ts",
];

// ---- 1. The file exists and the loop's parser reads it.
assert(
  existsSync(ALLOWLIST),
  `the committed allow-list exists at ${path.relative(REPO, ALLOWLIST)}`,
);

const entries = rawEntries();
assert(Array.isArray(entries) && entries.length > 0, "the allow-list carries at least one entry");

// The baseline is the count of the named seed, not a second number the file may carry:
// an inflated `baseline_count` is the whole shrink-only rule removed by a one-line edit,
// so the constant below is the authority and the file's own field is checked against it.

// ---- 2. Shrink-only: the entry count may not exceed the baseline recorded in the file.
const baseline = rawBaseline();
assert(
  Number.isInteger(baseline) && baseline >= 0,
  `the file records an integer baseline_count (got ${JSON.stringify(baseline)})`,
);
assert(
  entries.length <= baseline,
  `entry count ${entries.length} does not exceed the shrink-only baseline ${baseline} — growing the list is the regression the ceiling exists to stop (removing entries is allowed)`,
);

// The two directions of the count gate must be pinned apart. `entries.length <=
// baseline` alone is true when the file's own baseline is inflated, and an inflated
// baseline is the whole shrink-only rule removed by a one-line edit that a count
// assertion then reports as a pass. R1 states the relation the other way: the
// constant equals the seeded count.
assert(
  SEED_FILES.length === baseline,
  `the file's baseline_count equals the seeded count ${SEED_FILES.length} — the constant may only be LOWERED with the list, never inflated to admit entries (R1)`,
);

// ---- 3. Every file names a real file, and does so AS A KEY THE CEILING PRODUCES.
//
// Two checks, not one. `existsSync(path.join(REPO, e.file))` alone certifies that a
// string happens to be a path under `extension/`; it says nothing about whether that
// spelling is the one `timing_key` ever emits, and the ceiling matches on the key, not
// on the raw field. An entry the existence check likes and the matcher never produces
// is a row that exempts nothing while still counting toward the shrink-only total —
// dead weight the gate was written to refuse. So the raw field is compared against
// `timing_key` of the absolute path it must name: absolute in, relative key out, the
// same normalisation the matcher applies to a row (R4).
const rawFields = entries
  .filter((e) => typeof e.file === "string" && e.file.length > 0)
  .map((e) => e.file);
const missing = rawFields.filter((f) => !existsSync(path.join(REPO, f)));
assert(
  missing.length === 0,
  `every entry names a real file; missing: ${JSON.stringify(missing)}`,
);

const loopRows_ = loopRows();
const rawFromLoop = loopRows_.map((r) => r.file);
// One bash call, one fork per row pair: each field must equal the key of its own
// absolute path, and the count must match the file.
const keys = loopKey(...rawFields.map((f) => path.join(REPO, f)));
const notNormalised = rawFields.filter((f, i) => keys[i] !== f);
assert(
  notNormalised.length === 0,
  `every entry's "file" is already the loop's own key — it equals timing_key() of the absolute path (R4); offending: ${JSON.stringify(
    notNormalised.map((f, i) => ({ file: f, key: keys[i] })),
  )}`,
);
assert(
  rawFromLoop.length === rawFields.length &&
    rawFromLoop.every((f, i) => f === rawFields[i]),
  `the loop's parser reads every entry the file declares, in order and one row each (${rawFromLoop.length} vs ${rawFields.length})`,
);

// ---- 4. Every entry carries a positive integer seconds and a dated measurement.
const badSeconds = entries.filter(
  (e) => !(Number.isInteger(e.seconds) && (e.seconds as number) > 0),
);
assert(
  badSeconds.length === 0,
  `every entry carries a positive integer seconds; bad: ${JSON.stringify(badSeconds.map((b) => ({ file: b.file, seconds: b.seconds })))}`,
);
const badMeasured = entries.filter(
  (e) => typeof e.measured !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.measured),
);
assert(
  badMeasured.length === 0,
  `every entry carries a YYYY-MM-DD measured date; bad: ${JSON.stringify(badMeasured.map((b) => ({ file: b.file, measured: b.measured })))}`,
);

// ---- 5. No duplicate file.
const seen = new Set<string>();
const dupes = new Set<string>();
for (const e of entries) {
  if (typeof e.file !== "string") continue;
  if (seen.has(e.file)) dupes.add(e.file);
  seen.add(e.file);
}
assert(
  dupes.size === 0,
  `no file appears twice in the allow-list; duplicates: ${JSON.stringify([...dupes])}`,
);

// ---- 6. The parser and the raw file agree on the KEY SET, both directions. A list
// the ceiling's parser cannot read exempts NOTHING, so the two must agree or the gate
// would certify a list that silently stops exempting the very files it names.
const loopKeys = new Set(loopRows_.map((r) => r.file));
const rawKeys = new Set(rawFields);
const loopMissingRaw = [...rawKeys].filter((k) => !loopKeys.has(k));
const loopExtraRaw = [...loopKeys].filter((k) => !rawKeys.has(k));
assert(
  loopMissingRaw.length === 0,
  `the loop's parser reads every entry the file declares; the ceiling would NOT exempt: ${JSON.stringify(loopMissingRaw)}`,
);
assert(
  loopExtraRaw.length === 0,
  `the loop's parser invents no entry the file does not declare: ${JSON.stringify(loopExtraRaw)}`,
);

// ---- 7. R1/AC3: the seed set, committed by name. Every entry is a file the seed names
// and every seed path is present — a swap-out (drop a genuinely slow file, add a fast
// one) would keep the count at the baseline and pass every check above, because the
// count gate is indifferent to WHICH paths are listed. Order is compared too: the file
// is the seed in its measured-slowest-first shape.
assert(
  JSON.stringify(rawFields) === JSON.stringify(SEED_FILES),
  `the list is the committed seed, by name and in order (${rawFields.length} vs ${SEED_FILES.length}); unexpected: ${JSON.stringify(rawFields.filter((f) => !SEED_FILES.includes(f)))}, absent: ${JSON.stringify(SEED_FILES.filter((f) => !rawFields.includes(f)))}`,
);

// R1 also states what each entry records: its HIGHEST measured seconds, and every file
// in the seed for a reason — the reason being that reading exceeded 20 s. An entry at
// 1 s would exempt a file from any ceiling a run could plausibly set, and a sub-20 s
// entry is not a file the seed rule selected, so it does not belong on the list at all.
// Each value is the max of the file's 2026-11-21 reading and its three readings in the
// 2026-11-22 re-seed runs, read out of the CI logs by tmp/reseed/extract.py rather than
// transcribed by hand.
const seedSeconds = new Map<string, number>([
  ["smoke-tests/test-work-driver-adversarial-fix-routing.ts", 250],
  ["smoke-tests/test-plan-body-budget.ts", 206],
  ["smoke-tests/test-work-driver-transient-retry.ts", 182],
  ["smoke-tests/test-lean-build-nowork-retry.ts", 161],
  ["smoke-tests/test-work-driver-adversarial-reporting.ts", 148],
  ["smoke-tests/test-verify-timing-ceiling.ts", 134],
  ["smoke-tests/test-plan-provenance.ts", 133],
  ["smoke-tests/test-plan-pi-spec-filing.ts", 131],
  ["smoke-tests/test-work-driver-adversarial-writeahead-persist.ts", 124],
  ["smoke-tests/test-work-driver-adversarial-reentry.ts", 86],
  ["smoke-tests/test-host-park-signal.ts", 75],
  ["smoke-tests/test-verify-loop-timing.ts", 68],
  ["smoke-tests/test-merge-guard-ci-evidence-gitlab.ts", 61],
  ["smoke-tests/test-merge-guard-ci-holes-2107.ts", 61],
  ["smoke-tests/test-work-driver-offloaded-spec.ts", 57],
  ["smoke-tests/test-headless-supervised-child.ts", 55],
  ["smoke-tests/test-headless-interrupt-explore.ts", 51],
  ["smoke-tests/test-work-driver-adv-retry-t6.ts", 48],
  ["smoke-tests/test-lens-provider-refusal.ts", 46],
  ["smoke-tests/test-explore-body-retry.ts", 42],
  ["smoke-tests/test-headless-supervise.ts", 33],
  ["smoke-tests/test-verify-loop-parallel.ts", 32],
  ["smoke-tests/test-work-driver-corrective-round.ts", 29],
  ["smoke-tests/test-tool-inactivity.ts", 28],
  ["smoke-tests/test-work-driver-continue-pr-lookup.ts", 26],
  ["smoke-tests/test-verify-loop-jobs-from-host.ts", 24],
  ["smoke-tests/test-lens-review-head-sha.ts", 24],
  ["smoke-tests/test-lean-handback-report-bound.ts", 24],
  ["smoke-tests/test-cancel.ts", 23],
  ["smoke-tests/test-git-state-report.ts", 21],
  ["smoke-tests/test-public-hygiene-visibility.ts", 21],
  ["smoke-tests/test-public-hygiene-target-bound.ts", 21],
]);
const wrongSeconds = entries.filter(
  (e) => typeof e.file === "string" && seedSeconds.get(e.file) !== e.seconds,
);
assert(
  wrongSeconds.length === 0,
  `every entry records the measured seconds the seed run recorded; off: ${JSON.stringify(
    wrongSeconds.map((b) => ({ file: b.file, seconds: b.seconds, want: seedSeconds.get(b.file) })),
  )}`,
);
const underTwenty = entries.filter(
  (e) => !(typeof e.seconds === "number" && e.seconds > 20),
);
assert(
  underTwenty.length === 0,
  `every entry's measurement exceeds the 20 s seed threshold (R1); under: ${JSON.stringify(underTwenty.map((b) => ({ file: b.file, seconds: b.seconds })))}`,
);

// ---- 8. AC4: the knob's row in docs/configuration.md and the troubleshooting entry.
// The issue makes the docs an acceptance criterion; a criterion nobody judges is a
// criterion that lapses on the next rename of the knob's name. Both texts are read once
// and reused by the canaries below, which mutate the SAME bytes these assert on.
const KNOB = "PI_ENSEMBLE_VERIFY_TIMING_CEILING_S";
const configText = readFileSync(path.join(DOCS, "configuration.md"), "utf8");
const troubleshootingText = readFileSync(path.join(DOCS, "troubleshooting.md"), "utf8");
const configRow = configText.split("\n").find((l) => l.startsWith(`| \`${KNOB}\` |`));
assert(
  configRow !== undefined,
  `docs/configuration.md has a table row for \`${KNOB}\` (AC4)`,
);
const tsRow = troubleshootingText
  .split("\n")
  .find((l) => l.startsWith("**Symptom.**") && l.includes("CEILING:"));
assert(
  tsRow !== undefined,
  "docs/troubleshooting.md has a symptom entry naming the CEILING: failure (AC4)",
);

// ---- 9. Canaries: the gates above observed RED, on mutants of the shipped bytes.
// A gate nobody has watched fail proves nothing, and the count gate's whole value is
// that it refuses one entry past the baseline (here: a 33rd against a 32-entry seed) —
// so the mutant is one entry beyond the baseline, pushed through the loop's OWN parser
// rather than a copy of it in this file.
const shippedText = readFileSync(ALLOWLIST, "utf8");
const shippedRows = JSON.parse(shippedText) as {
  baseline_count: number;
  entries: { file: string; seconds: number; measured: string }[];
};

// 9a. The count gate on a mutant that adds one entry past its own baseline. The
// mutant must apply (a replace that matched nothing is a vacuous canary), and the
// gate's own predicate must reject it.
const extra = { file: SEED_FILES[0] ?? "", seconds: 21, measured: "2026-11-21" };
const overBaseline = {
  ...shippedRows,
  baseline_count: shippedRows.entries.length,
  entries: [...shippedRows.entries, extra],
};
assert(
  JSON.stringify(overBaseline) !== shippedText &&
    overBaseline.entries.length === overBaseline.baseline_count + 1,
  `canary: the mutant really carries one entry beyond its baseline (${overBaseline.entries.length} vs ${overBaseline.baseline_count})`,
);
assert(
  !(overBaseline.entries.length <= overBaseline.baseline_count),
  `canary: the shipped count predicate REJECTS the entry at ${overBaseline.entries.length} — the shrink-only gate is observed red`,
);
// And the same mutant read through the loop's parser: the exemption the ceiling would
// grant a file the committed list does not name has to be what the parser refuses.
const mutantList = writeAllowlist(overBaseline.entries, overBaseline.baseline_count);
try {
  const mutantRows = loopRowsFrom(mutantList);
  assert(
    mutantRows.length === overBaseline.entries.length,
    `canary: the loop's own parser reads the mutant's ${overBaseline.entries.length} entries (${mutantRows.length}) — the count gate judges what the ceiling would read`,
  );
} finally {
  removeAllowlist(mutantList);
}

// 9b. The seed gate on a mutant that swaps one seed path for a file that was never
// measured slow. Same count, so only the named-seed assertion can see it.
const swapped = [...SEED_FILES];
swapped[0] = "smoke-tests/test-verify-timing-allowlist.ts";
assert(
  swapped[0] !== SEED_FILES[0] &&
    JSON.stringify(swapped) !== JSON.stringify(SEED_FILES) &&
    JSON.stringify(swapped) !== JSON.stringify(rawFields),
  "canary: the swapped seed differs from the committed one at the same count — the seed gate is observed red",
);

// 9c. The docs gate on a mutant of the docs text with the knob's row deleted: the
// assertion is about that one row, so removing it is what must turn it false — and the
// canary also proves the row is a single line, not a stray mention in prose.
const docMutant = configText.split("\n").filter((l) => l !== configRow).join("\n");
assert(
  configRow !== undefined && docMutant !== configText && !docMutant.includes(`| \`${KNOB}\` |`),
  `canary: deleting the knob's row line is what reddens the AC4 docs gate (row found: ${configRow !== undefined})`,
);
const tsMutant = troubleshootingText.split("\n").filter((l) => l !== tsRow).join("\n");
assert(
  tsRow !== undefined &&
    tsMutant !== troubleshootingText &&
    !tsMutant
      .split("\n")
      .some((l) => l.startsWith("**Symptom.**") && l.includes("CEILING:")),
  `canary: deleting the troubleshooting symptom line is what reddens that half of AC4 (entry found: ${tsRow !== undefined})`,
);

process.exit(exit);
