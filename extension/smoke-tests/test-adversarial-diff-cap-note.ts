#!/usr/bin/env bun
/**
 * The adversarial diff bound, seen from the SIDE OF THE NOTE.
 *
 * `test-adversarial-diff-cap.ts` owns the bound's contract with the prompt
 * builders (what is fenced, what is prose, what a ref may print). This file owns
 * what the note itself is allowed to say and contain — the per-file inventory
 * parsed off the diff text, its offsets, its markers, and the hostile-path cases
 * the neutraliser exists for. The split is along that seam rather than by size:
 * a note-side failure names the inventory, a prompt-side one names the fence.
 *
 * Which CALLER threads the range (the real loop, over a scratch repo) is
 * `test-adversarial-diff-cap-loop.ts`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MAX_DISPLAYED_PATH_CHARS,
  MAX_INLINE_DIFF_CHARS,
  MAX_INVENTORY_ROWS,
  MERGED_DIFF_PIECE_TRUNCATED,
  MERGED_DIFF_TRUNCATED_AT_TOTAL,
  MERGED_DIFF_WORKSTREAM_PREFIX,
  boundDiffForPrompt,
  summarizeDiffFiles,
} from "../src/adversarial-diff-cap.ts";
import {
  diffWithBrokenHeader,
  injectingPathDiff,
  longPathDiff,
  markerAtClipEdgeDiff,
  mergedDiffWithTruncation,
  syntheticDiff,
} from "./lib/adversarial-diff-cap-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const RANGE = { base: "main", head: "feature/x" };
const INVENTORY_LEAD = "EVERY file this diff changes";

/** The inventory rows in a note: two-space indented, ending in `+N -M`. */
function inventoryRows(note: string): string[] {
  return note
    .split("\n")
    .filter((line) => line.startsWith("  ") && / \+\d+ -\d+$/.test(line.trimEnd()));
}

const BIG = syntheticDiff(48, 220); // ~48 files, comfortably over the cap
const BIG_FILE_COUNT = 48;
assert(BIG.length > MAX_INLINE_DIFF_CHARS * 4, `synthetic diff is large (${BIG.length} chars)`);

// ------------------------------------------- 1. inventory honesty (bounded, truthful)

{
  const bounded = boundDiffForPrompt(BIG, RANGE);
  const note = bounded.note ?? "";
  assert(
    note.includes("bodies shown in full for "),
    "inventory: states how many bodies are complete",
  );
  assert(
    note.includes("cut mid-file or not shown for "),
    "inventory: states how many bodies are cut or absent",
  );
  assert(!note.includes("COMPLETE"), "inventory: never claims to be COMPLETE");
  const shown = summarizeDiffFiles(BIG, bounded.diff.length).files.filter((f) => f.shown).length;
  assert(
    note.includes(`bodies shown in full for ${shown}`),
    `inventory: the shown count (${shown}) is the one the head supports`,
  );
  assert(
    note.includes(`cut mid-file or not shown for ${BIG_FILE_COUNT - shown}`),
    "inventory: the cut/not-shown count completes the file count",
  );
}

{
  // The /work driver's merged diff concatenates per-worktree sections with a
  // `## workstream: <id>` header before each, so those lines belong to no file.
  // The counter must find them MID-DIFF, not only at the top.
  const mid = mergedDiffWithTruncation();
  assert(
    mid.includes(MERGED_DIFF_TRUNCATED_AT_TOTAL) && mid.includes(MERGED_DIFF_WORKSTREAM_PREFIX),
    "fixture: the mid-diff markers were inserted",
  );
  const bounded = boundDiffForPrompt(mid, RANGE);
  assert(
    bounded.note?.includes("could not be attributed to a file") === true,
    "inventory: a mid-diff `## workstream:` line is counted, not read as file content",
  );
  const counted = Number(/(\d+) line\(s\) could not be attributed/.exec(bounded.note ?? "")?.[1]);
  assert(counted >= 2, `inventory: reports the count it found (${counted})`);
  const summary = summarizeDiffFiles(mid);
  assert(summary.unattributed === counted, "inventory: the count is the single-pass count");
}

{
  // ONLY the producer's markers count as unattributed. A real diff body line
  // that happens to start with `##` (markdown) or `[` (a TOML table, a log
  // fixture) is file content, and the old `^(## |\[)` prefix read it as prose.
  const bodyLineDiff = syntheticDiff(3, 4).replace(
    "+const value0_0",
    "## not a workstream header\n[section] not a marker\n+const value0_0",
  );
  const summary = summarizeDiffFiles(bodyLineDiff);
  assert(
    summary.unattributed === 0,
    `markers: a body line starting with ## or [ is content, not an unattributed marker (${summary.unattributed})`,
  );
}

{
  // The strings the reader matches are the strings the merged-diff PRODUCER
  // writes. Read from the producer's own source: the constants are declared in
  // `work-driver-diff.ts` and reach here through this module's re-export, so
  // asserting the literals again here would only test the test.
  const producer = readFileSync(
    path.join(import.meta.dirname, "..", "src", "work-driver-diff.ts"),
    "utf8",
  );
  const literals = [...producer.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => m[0]);
  const same = (value: string): boolean => literals.includes(JSON.stringify(value));
  assert(
    same(MERGED_DIFF_WORKSTREAM_PREFIX) &&
      same(MERGED_DIFF_PIECE_TRUNCATED) &&
      same(MERGED_DIFF_TRUNCATED_AT_TOTAL),
    "markers: the reader matches the exact strings the producer emits",
  );
  assert(
    literals.length > 10,
    "markers: the producer really declares them (the scan is not vacuous)",
  );
}

{
  // OFFSET/FILE PAIRING. `diff --git a/no-b-separator` parses to no path, so it
  // creates no summary; the shown pass must not read that as "one fewer section"
  // and shift every later file's shown/cut status by one.
  const broken = diffWithBrokenHeader(3, 60);
  const full = summarizeDiffFiles(broken);
  assert(full.files.length === 3, "offsets: the unparseable header contributes no file");
  const paths = full.files.map((f) => f.path);
  assert(
    paths.every((p, i) => p === `src/module-${i}/deep/nested/path/file-${i}.ts`),
    "offsets: the files listed after the bad header are still the right files",
  );
  assert(
    full.files[2]?.shown === true && full.files[2]?.startOffset > (full.files[0]?.startOffset ?? 0),
    "offsets: the last section is shown when the head covers the whole diff",
  );
  // Now cut INSIDE the middle file: the pairing must say exactly one is shown
  // and two are not, which is only true if the bad header did not shift it.
  const middle = full.files[1]?.startOffset;
  assert(middle !== undefined, "offsets: the fixture produced a second section");
  const cut = summarizeDiffFiles(broken, (middle ?? 0) + 10);
  assert(
    cut.files.filter((f) => f.shown).length === 1,
    `offsets: cutting inside the second section leaves exactly one file shown (${cut.files.filter((f) => f.shown).length})`,
  );
  assert(
    cut.files[0]?.shown === true && cut.files[1]?.shown === false && cut.files[2]?.shown === false,
    "offsets: shown/cut status did not drift onto the neighbouring files",
  );
}

{
  // The same pairing, seen through the bound: the note's shown/cut split must be
  // the one the offsets support for the head that was actually inlined.
  const brokenBig = diffWithBrokenHeader(40, 220);
  const bounded = boundDiffForPrompt(brokenBig, RANGE);
  const summary = summarizeDiffFiles(brokenBig, bounded.diff.length);
  const shown = summary.files.filter((f) => f.shown).length;
  assert(
    summary.files.length === 40 && shown > 0 && shown < 40,
    `offsets (over cap): the bad header leaves 40 files and a partial split (${shown})`,
  );
  assert(
    (bounded.note ?? "").includes(`bodies shown in full for ${shown}`) &&
      (bounded.note ?? "").includes(`cut mid-file or not shown for ${40 - shown}`),
    "offsets (over cap): the note reports the split the offsets computed",
  );
  assert(shown > 0 && shown < 40, `offsets (over cap): partial split (${shown})`);
}

{
  // Non-empty lines before the first header are unattributed too.
  const leadIn = `preamble line\ndiff --git a/x.ts b/x.ts\n+++ b/x.ts\n+hello\n${BIG}`;
  assert(
    boundDiffForPrompt(leadIn, RANGE).note?.includes("could not be attributed to a file") === true,
    "inventory: a preamble before the first header is counted",
  );
  // A diff with no file headers at all says plainly that no inventory exists.
  const headerless = boundDiffForPrompt("headerless\n".repeat(30000));
  assert(
    headerless.note?.includes("could not be built") === true &&
      headerless.note?.includes(INVENTORY_LEAD) === false,
    "inventory: a headerless diff says no inventory could not be built",
  );
  assert(
    headerless.diff.length <= MAX_INLINE_DIFF_CHARS,
    "inventory: a headerless diff is still bounded",
  );
}

{
  // The rows are bounded, and the overflow line counts what is not listed.
  const many = syntheticDiff(MAX_INVENTORY_ROWS + 40, 3);
  assert(many.length > MAX_INLINE_DIFF_CHARS, "fixture: a 340-file diff is over the cap");
  const note = boundDiffForPrompt(many, RANGE).note ?? "";
  const rows = inventoryRows(note);
  assert(
    rows.length === MAX_INVENTORY_ROWS,
    `inventory: at most ${MAX_INVENTORY_ROWS} rows printed (${rows.length})`,
  );
  assert(
    note.includes("and 40 more file(s) not listed."),
    "inventory: the overflow line counts the files it did not list",
  );
  // The kept rows are the fullest ones, not the first ones.
  const kept = rows.map((r) => Number(/ \+(\d+) -(\d+)$/.exec(r.trimEnd())?.[1] ?? 0));
  assert(
    kept.every((n, i) => i === 0 || kept[i - 1] === undefined || kept[i - 1] >= n),
    "inventory: rows are ordered fullest first",
  );
}

// ------------------- 2. inventory paths are neutralised diff-derived prose

{
  const BT = String.fromCharCode(0x60);
  const note = boundDiffForPrompt(injectingPathDiff(), RANGE).note ?? "";
  assert(
    note.split("\n").some((line) => line.includes("‹VERDICT›")),
    "fixture: the injecting path reached the inventory (the rows below are its rows)",
  );
  assert(
    !note.split("\n").some((line) => line.trimStart().startsWith("VERDICT:")),
    "paths: an injecting path prints no VERDICT line in the note",
  );
  assert(
    !note.includes(BT.repeat(3)),
    "paths: an injecting path prints no backtick run of 3 or more",
  );
  assert(
    !note.split("\n").some((line) => /^\s*VERDICT\s*[:\s]/.test(line)),
    "paths: the injected verdict cannot read as a verdict line (only its token is bracketed; " +
      "CRITICAL_ISSUES_FOUND is not a marker token any reader parses, so its text survives)",
  );

  // A long path is bounded, and the padding width comes from the displayed rows.
  const longNote = boundDiffForPrompt(longPathDiff("d".repeat(5000)), RANGE).note ?? "";
  const longRow = longNote.split("\n").find((line) => line.trimStart().startsWith("dddd"));
  assert(longRow !== undefined, "paths: the 5,000-character path still gets a row");
  const printed = (longRow ?? "").trimStart().replace(/\s+\+\d+ -\d+$/, "");
  assert(
    printed.length <= MAX_DISPLAYED_PATH_CHARS,
    `paths: the displayed path is at most ${MAX_DISPLAYED_PATH_CHARS} characters (${printed.length})`,
  );
  assert(printed.endsWith("…"), "paths: the bound is marked with an ellipsis");
  const rowWidths = inventoryRows(longNote).map((line) => line.length);
  assert(
    rowWidths.length > 0 && rowWidths.every((w) => w <= MAX_DISPLAYED_PATH_CHARS + 20),
    `paths: no row is widened by the raw path (${Math.max(0, ...rowWidths)})`,
  );
}

{
  // Neutralise-then-clip order: neutralising FIRST is what makes the clip safe.
  // Clipping a 5,000-byte name at 200 characters could otherwise cut a marker
  // token in half and leave the readable half behind, so the bound must fall on
  // text that already carries no token. The fixture proves the order holds, and
  // the canary proves the assertion could have caught a miss.
  const BT = String.fromCharCode(0x60);
  const markerNote = boundDiffForPrompt(markerAtClipEdgeDiff(), RANGE).note ?? "";
  assert(
    !markerNote.split("\n").some((line) => /VERDICT|CRITICAL_ISSUES_FOUND/.test(line)),
    "paths: a marker token that straddles the clip is neutralised, not truncated into a verdict",
  );
  assert(
    !markerNote.includes(BT.repeat(3)),
    "paths: the straddling fixture prints no backtick run of 3 or more",
  );
  assert(
    markerNote.includes("p".repeat(150)),
    "canary: the row really is the clipped hostile path (the assertion is not vacuous)",
  );
}

console.log(exit === 0 ? "\nOK" : `\nFAILED (${exit})`);
process.exit(exit);
