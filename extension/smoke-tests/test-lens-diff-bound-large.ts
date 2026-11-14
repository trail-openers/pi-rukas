#!/usr/bin/env bun
/**
 * #2261 (adversarial round 2, finding 1) — the file-count band where the NOTICE
 * becomes the larger half of the prompt, which is the only band the module's
 * central promise can break in.
 *
 * `lens-diff-bound.ts` states that the fenced block and the notice printed after
 * it TOGETHER never exceed the budget. Both halves move with the walk's cap: the
 * block grows with the files it affords, the notice grows with the files it has
 * to NAME. At a handful of files the block dominates and the sum has slack; from
 * roughly two thousand files up the notice dominates — measured, a 3 000-file
 * diff put 100 355 characters in the notice against a 19 661-character block —
 * and that is the band where the reserve `trimNote` keeps for its own
 * "…characters of the per-file inventory dropped…" sentence decides the outcome.
 * That reserve was fixed at 70 characters and the sentence renders ~105, so
 * re-assembling the note re-grew it past the room it had just been handed
 * (120 014–120 026 for a 3 000–4 250 file diff), and the block-gives fallback
 * beneath it could not fire because its room was computed from the oversized note
 * it had already accepted.
 *
 * The suites that shipped with the fix used 3-file fixtures and stayed green
 * through the whole defect — the walk reaches the budget before the note ever
 * needs trimming there. So the discriminating assertion is not just the sum: it
 * is the sum taken on a diff that PROVES it trimmed (the admission sentence is
 * present), with a margin below the bound, so a reserve shorter than the sentence
 * cannot pass by a hair.
 *
 * Driven straight at the module rather than through a child: this is a property of
 * the bound, and the end-to-end seam (`runLensReview` → the recorded `spec.prompt`)
 * is `test-lens-diff-large.ts`'s job.
 */

import { MAX_INLINE_DIFF_CHARS } from "../src/adversarial-diff-cap.ts";
import { boundLensPromptDiff } from "../src/lens-diff-bound.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const RANGE = { base: "origin/main", head: "HEAD" };

/** `files` copies of a 10-line file, each line `width` characters of `fill`. */
function smallFileDiff(files: number, width = 40, fill = "x"): string {
  const line = fill.repeat(width);
  return Array.from({ length: files }, (_u, f) => {
    const body = Array.from({ length: 10 }, (_x, i) => `${String(i)} ${line}`).join("\n");
    return `diff --git a/f${String(f)}.ts b/f${String(f)}.ts\nindex 1111111..2222222 100644\n--- /dev/null\n+++ b/f${String(f)}.ts\n@@ -0,0 +1,10 @@\n${body}\n`;
  }).join("");
}

/** `sections` vendored-looking sections of `lines` lines each — none affordable whole. */
function oversizedSections(sections: number, lines: number): string {
  return Array.from({ length: sections }, (_u, f) => {
    const body = Array.from(
      { length: lines },
      (_x, i) => `line ${String(i)} of generated output for vendored file ${String(f)} padding`,
    ).join("\n");
    return `diff --git a/vendor/f${String(f)}.gen b/vendor/f${String(f)}.gen\nindex 1111111..2222222 100644\n--- /dev/null\n+++ b/vendor/f${String(f)}.gen\n@@ -0,0 +1,${String(lines)} @@\n${body}\n`;
  }).join("");
}

/** The inventory row width the fixtures below are built from, and the tolerance
 * for the margin assertion. A row is `"  <path>  +10 -0  yes/no"`, so the note's
 * length after a row-trim is quantised to that width — a fixed reserve that is a
 * few characters short of the admission sentence re-grows the note by whole rows
 * and can park anywhere within one row-width of the bound. The tolerance is
 * therefore one row width, and the test below asserts the DIFFERENCE against a
 * measured reserve rather than a fixed distance below the bound: over-trimming
 * (a reserve far too large) is equally wrong and lands ~3 KB away, so an
 * equality-band test is what makes both directions fail. */
const ROW_WIDTH_TOLERANCE = 60;

/** The note's rendered length with the reservation measured from the sentence. */
const MEASURED_NOTE = 100_305;

// ── (1) the shape that actually trims: many small files, so the inventory alone
// outgrows what the block leaves and the notice has to drop rows and say so.
{
  const b = boundLensPromptDiff({ diff: smallFileDiff(4_000), context: "CTX", range: RANGE });
  const sum = b.diff.length + (b.note?.length ?? 0);
  assert(
    b.note !== undefined && b.note.includes("characters of the per-file inventory dropped"),
    `(1) precondition: this diff really does trim the inventory table and admit it (block ${String(b.diff.length)}, note ${String(b.note?.length ?? 0)}) — a fixture that never trims proves nothing`,
  );
  assert(
    sum <= MAX_INLINE_DIFF_CHARS,
    `(1) a notice carrying its own admission stays inside the bound (${String(b.diff.length)} + ${String(b.note?.length ?? 0)} = ${String(sum)} <= ${String(MAX_INLINE_DIFF_CHARS)})`,
  );
  // The differential. A reserve shorter than the admission sentence overshoots the
  // bound; a reserve far longer than it throws away ~3 KB of inventory the reviewer
  // could have read. Measured against the rendering the shipped module produces on
  // this exact fixture, both directions fail; a sum-only check passes either one.
  assert(
    Math.abs((b.note?.length ?? 0) - MEASURED_NOTE) <= ROW_WIDTH_TOLERANCE,
    `(1) the note fills the room the block leaves, to within one inventory row: ${String(b.note?.length)} vs the ${String(MEASURED_NOTE)} a measured reservation renders (a reserve shorter than the admission sentence overshoots the 120 000 bound; one far longer over-trims and loses usable inventory)`,
  );
  assert(
    b.note !== undefined && b.note.includes("git diff origin/main...HEAD"),
    "(1) and it trimmed by dropping ROWS, not by clipping the reread command the lens can act on",
  );
  assert(
    b.note !== undefined && b.note.includes("f0.ts") && b.note.includes("f3999.ts"),
    "(1) and every omitted path is still named, first and last",
  );
}

// ── (2) the band itself, walked. The old suites' 3-file fixtures sit far below
// this: below ~1 500 files the walk reaches the budget before the note needs
// trimming, which is exactly why the defect survived them.
for (const files of [1800, 2100, 2500, 3000, 4000, 4250, 5000]) {
  const b = boundLensPromptDiff({ diff: smallFileDiff(files, 44), context: "CTX", range: RANGE });
  const sum = b.diff.length + (b.note?.length ?? 0);
  assert(
    sum <= MAX_INLINE_DIFF_CHARS,
    `(2) ${String(files)} files: block + notice stay inside the ONE bound (${String(b.diff.length)} + ${String(b.note?.length ?? 0)} = ${String(sum)} <= ${String(MAX_INLINE_DIFF_CHARS)})`,
  );
  assert(
    b.note !== undefined && b.note.includes("git diff origin/main...HEAD"),
    `(2) ${String(files)} files: and the reread command survived the trim`,
  );
  assert(
    b.note !== undefined && b.note.includes("f0.ts") && b.note.includes(`f${String(files - 1)}.ts`),
    `(2) ${String(files)} files: and every omitted path is named, first and last`,
  );
}

// ── (3) the other large shape: sections all past the floor, so none is affordable
// whole and the block is the line-boundary fallback. Widens the invariant's
// coverage; no input found reaches the block-gives rescue, so what is asserted is
// that the pair never escapes the budget at any size.
{
  const b = boundLensPromptDiff({
    diff: oversizedSections(800, 800),
    context: "CTX",
    range: RANGE,
  });
  const sum = b.diff.length + (b.note?.length ?? 0);
  assert(
    b.diff.length > 0,
    `(3) precondition: an all-oversized diff still gets a non-empty block rather than a blank fence (${String(b.diff.length)} characters)`,
  );
  assert(
    sum <= MAX_INLINE_DIFF_CHARS,
    `(3) and block + notice still land inside the bound (${String(b.diff.length)} + ${String(b.note?.length ?? 0)} = ${String(sum)} <= ${String(MAX_INLINE_DIFF_CHARS)})`,
  );
  assert(
    b.note !== undefined && b.note.includes("git diff origin/main...HEAD"),
    "(3) with the reread command intact for the files it could not inline",
  );
}

console.log(`\nlarge-diff bound ${failures() === 0 ? "green" : "RED"} (${String(failures())} failing)`);
process.exit(failures());
