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
 * The gate reads the shipped file with the loop's OWN parser (via bash, sourcing
 * lib/verify-timing.sh) rather than a second JSON reader, so the gate and the ceiling
 * cannot drift into exempting different sets of files (R4): one parser, two consumers.
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

// The loop's own parser, run exactly as the ceiling runs it: source verify-timing.sh
// and call `_timing_allowlist_entries`, which prints `secs<TAB>key` per record. This is
// deliberately the SAME code path the ceiling uses, so the gate cannot pass a list the
// ceiling would read differently (or fail to read at all — a malformed list exempts
// nothing, which the fail-closed parser guarantees but this gate catches loudly).
function loopEntries(): { seconds: string; key: string }[] {
  const script = `. "${VERIFY_TIMING}" >/dev/null 2>&1; _timing_allowlist_entries`;
  const r = spawnSync("bash", ["-c", script], { cwd: REPO, encoding: "utf8" });
  const rows: { seconds: string; key: string }[] = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    rows.push({ seconds: line.slice(0, tab), key: line.slice(tab + 1) });
  }
  return rows;
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

// ---- 3. Every file names a real file, relative to extension/.
const missing = entries
  .filter((e) => typeof e.file === "string" && e.file.length > 0)
  .filter((e) => !existsSync(path.join(REPO, e.file)));
assert(
  missing.length === 0,
  `every entry names a real file; missing: ${JSON.stringify(missing.map((m) => m.file))}`,
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

// ---- 6. The loop's parser agrees with the raw file: same paths, same count. A list the
// ceiling's parser cannot read exempts NOTHING, so the two must agree or the gate would
// certify a list that silently stops exempting the very files it names.
const loopRows = loopEntries();
const loopKeys = new Set(loopRows.map((r) => r.key));
const rawKeys = new Set(entries.map((e) => e.file));
const loopMissingRaw = [...rawKeys].filter((k) => !loopKeys.has(k));
assert(
  loopMissingRaw.length === 0,
  `the loop's parser reads every entry the file declares; the ceiling would NOT exempt: ${JSON.stringify(loopMissingRaw)}`,
);
assert(
  loopRows.length === entries.length,
  `the loop's parser yields one row per entry (${loopRows.length} vs ${entries.length})`,
);

process.exit(exit);
