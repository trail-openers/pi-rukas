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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, ".."); // extension/
const ALLOWLIST = path.join(REPO, "timing-allowlist.json");
const VERIFY_TIMING = path.join(REPO, "smoke-tests", "lib", "verify-timing.sh");

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

// ---- 1. The file exists and the loop's parser reads it.
assert(
  existsSync(ALLOWLIST),
  `the committed allow-list exists at ${path.relative(REPO, ALLOWLIST)}`,
);

const entries = rawEntries();
assert(Array.isArray(entries) && entries.length > 0, "the allow-list carries at least one entry");

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

process.exit(exit);
