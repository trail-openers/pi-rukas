#!/usr/bin/env bun
/**
 * #2261 (adversarial round 3, finding 1) — the fallback notice keeps the command it
 * points at.
 *
 * `lens-diff-bound.ts` states that the fenced block and the notice printed after it
 * TOGETHER never exceed the budget, and that the notice's actionable parts — the
 * omitted-path list and the reread command — are never what a cut removes. Both
 * halves move with the walk's cap: the block grows with the files it affords, the
 * notice grows with the files it has to NAME. Below ~1 500 files the block dominates
 * and the sum has slack; from roughly two thousand files up the notice dominates —
 * measured, a 3 000-file diff put 100 355 characters in the notice against a
 * 19 661-character block — and that is where `trimNote`'s reserve for its own
 * "…characters of the per-file inventory dropped…" sentence decides the outcome. That
 * reserve was fixed at 70 characters and the sentence renders ~105, so re-assembling
 * the note re-grew it past the room it had just been handed (120 014–120 026 for a
 * 3 000–4 250 file diff), and the block-gives fallback beneath it could not fire
 * because its room came from the oversized note it had already accepted. The suites
 * that shipped with that fix used 3-file fixtures and stayed green through it.
 *
 * Round 3 found the other band: the arm of `trimNote` that fires when even the FIXED
 * prose has no room. It head-cut the note — dropping its LAST line, the reread
 * command, while the omitted-path line above it went on saying "read each one with
 * the command below". A lens left holding paths it could name and no command to read
 * them with. Cases (4) and (5) are that arm reached two ways, and both assert the arm
 * precondition as well as the outcome: the shapes that reach the cut are narrow (see
 * (4)), and a fixture that never reaches it passes for the wrong reason.
 *
 * The assertions are written as INVARIANTS rather than as the literal the module
 * renders for a command, because the pre-fix module renders a shorter notice that
 * also satisfies "it fits" — what has to be pinned is that the notice never keeps the
 * promise and drops the thing promised.
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

/**
 * `sections` vendored-looking sections of `lines` `width`-character lines each, under
 * `dir`. With `width` around 200 no section is affordable whole, so the block becomes
 * the line-boundary slice — see (4) for why that width, that line count and that
 * directory depth are the shape that ALSO leaves the notice short enough to need the
 * cut.
 */
function oversizedSections(sections: number, lines: number, width = 65, dir = "vendor"): string {
  return Array.from({ length: sections }, (_u, f) => {
    const body = Array.from(
      { length: lines },
      (_x, i) =>
        `line ${String(i)} of generated output for vendored file ${String(f)} ${"p".repeat(width)}`,
    ).join("\n");
    return `diff --git a/${dir}/f${String(f)}.gen b/${dir}/f${String(f)}.gen\nindex 1111111..2222222 100644\n--- /dev/null\n+++ b/${dir}/f${String(f)}.gen\n@@ -0,0 +1,${String(lines)} @@\n${body}\n`;
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
// this: below ~1 500 files the walk reaches the budget before the note ever needs
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

// ── (4) the tight-budget notice keeps the command the omitted-path line promises.
//
// `trimNote` is handed the room the block left, and when the note's FIXED prose — no
// inventory rows at all — does not fit that room, the arm below fires and something
// has to be cut from prose a lens acts on. Pre-fix it head-cut the whole note, so the
// line that went was the LAST one: the reread command. The line above it went on
// saying "read each one with the command below", leaving the lens with paths it could
// name and no command to read them with.
//
// The discriminating shape was found by sweeping the arm and is narrow: ~200-character
// section lines (long enough that no whole-file cap affords a section, short enough
// that the notice stays small and the block still takes ~119 KB), a SHORT directory (a
// deep one inflates the note until its fixed prose fits the room and the cut never
// fires), and TWO sections. What makes the arm reachable at all is that the block is
// sized from the UNTRIMMED note and then kept, so the room left for the note is
// smaller than the note the module intends to print — which is what the precondition
// below asserts rather than assumes: a fixture that never routes through the cut
// passes for the wrong reason.
{
  const diff = oversizedSections(2, 800, 200);
  // The untrimmed note (no rows dropped) is what the caller sizes the block against;
  // measure the room it leaves, so the precondition names the actual pressure rather
  // than a rendering detail that the trim itself can change.
  const b = boundLensPromptDiff({ diff, context: "CTX", range: RANGE });
  const sum = b.diff.length + (b.note?.length ?? 0);
  const note = b.note ?? "";
  assert(
    b.mode === "bounded" &&
      diff.length > MAX_INLINE_DIFF_CHARS &&
      b.diff.length + 1 >= MAX_INLINE_DIFF_CHARS - 1_000,
    `(4) precondition: the block was sized against an untrimmed note and took almost the whole bound, leaving the fixed prose no room (${String(b.diff.length)} of ${String(MAX_INLINE_DIFF_CHARS)})`,
  );
  assert(
    note.includes("read each one with the command"),
    "(4) precondition: and the notice names its omitted paths and points at a command",
  );
  assert(
    note.includes("git diff"),
    `(4) where the notice points at a command, a command is actually printed (${String(note.length)} chars: ${note})`,
  );
  assert(
    sum <= MAX_INLINE_DIFF_CHARS,
    `(4) and block + notice still land inside the bound (${String(b.diff.length)} + ${String(note.length)} = ${String(sum)} <= ${String(MAX_INLINE_DIFF_CHARS)})`,
  );
}

// ── (5) the same arm, reached through a wide NOTICE instead of a wide block.
//
// A long ref range makes the reread line itself enormous, so the fixed prose is the
// larger half of the notice the module INTENDS to print, `trimNote` is handed almost
// no room, and the block has to give ~71 KB of itself before the pair fits. Pre-fix
// that produced a 511-character notice over a 71 264-character block — the pair fits,
// and the notice that got there had lost the command. What the notice is still owed:
// it names both omitted paths, so it still owes the reader a command. A ref past 4 000
// characters is refused outright by `rereadCommand`, so this is the widest notice the
// module will render at all.
{
  const b = boundLensPromptDiff({
    diff: oversizedSections(2, 800, 200),
    context: "CTX",
    range: { base: `origin/${"release/".repeat(3_000)}`, head: "HEAD" },
  });
  const sum = b.diff.length + (b.note?.length ?? 0);
  const note = b.note ?? "";
  assert(
    b.mode === "bounded" &&
      b.diff.length > 40_000 &&
      note.includes("vendor/f0.gen") &&
      note.includes("read each one with the command"),
    `(5) precondition: the notice still names its omitted paths and points below itself at a command, over a large block (block ${String(b.diff.length)}, note ${String(note.length)})`,
  );
  assert(
    note.includes("git diff"),
    `(5) and a command is still printed for the paths the notice names (${String(note.length)} chars)`,
  );
  assert(
    sum <= MAX_INLINE_DIFF_CHARS,
    `(5) block + notice stay inside the bound at the widest notice (${String(b.diff.length)} + ${String(note.length)} = ${String(sum)} <= ${String(MAX_INLINE_DIFF_CHARS)})`,
  );
}

// ── (6) the delta arm: the full-branch block is charged to the SAME budget as the
// diff, before the whole-file walk, not added on top of it.
//
// The module header claims "ONE budget" and `appendFullContext` says the block is
// "kept inside the prompt's ONE budget" — but it was handed the budget the walk had
// ALREADY spent in full, and gave the block half of it. A delta review of a large
// change therefore put a ~120 000-character fenced diff and a ~60 000-character
// full-branch block in one prompt: the bound the lenses die over is a character
// bound, so the arm that exists to stop HTTP 400 "maximum context length" was
// under-bound by half a budget on exactly the input that triggers it.
//
// The block is diff text wearing a context label, so it is sized against what the
// prompt has LEFT rather than against the budget the walk has already spent in full.
// Pre-fix `appendFullContext` ran AFTER the walk and was handed the whole budget, so
// a delta arm put a ~120 000 fenced diff and a ~60 000 orientation block in one
// prompt — the bound is a character bound, and this is the arm whose bound decides
// whether the provider answers HTTP 400 "maximum context length".
{
  // The widest orientation block the delta arm actually builds today
  // (`buildDeltaFullContext`'s own cap), so this is a real delta review's shape and
  // not a made-up size.
  const fullContext = `FULL BRANCH DIFF\n${`${"o".repeat(79)}\n`.repeat(2_000)}`;
  assert(
    fullContext.length > MAX_INLINE_DIFF_CHARS / 2,
    `(6) precondition: the full-branch block is large enough to matter (${String(fullContext.length)})`,
  );
  const b = boundLensPromptDiff({
    diff: smallFileDiff(4_000),
    context: "CTX",
    fullContext,
    range: RANGE,
  });
  assert(
    b.mode === "bounded" && b.note !== undefined,
    `(6) precondition: this really is the bounded arm with a notice (mode ${b.mode})`,
  );
  const block = b.diff.length;
  const note = b.note?.length ?? 0;
  const addedByBlock = b.context.length - "CTX".length;
  assert(
    addedByBlock > 40_000,
    `(6) precondition: the delta arm really appended a large full-branch block (${String(addedByBlock)} characters onto the caller's "CTX")`,
  );
  // The single-budget invariant: fenced block + notice + everything the block added
  // to the caller's context never exceed what the prompt may inline, minus the
  // caller's own context (which the bound does not charge itself for).
  assert(
    block + note + addedByBlock <= MAX_INLINE_DIFF_CHARS - "CTX".length,
    `(6) block + notice + full-branch block fit the ONE budget the prompt is bounded by (${String(block)} + ${String(note)} + ${String(addedByBlock)} = ${String(block + note + addedByBlock)} <= ${String(MAX_INLINE_DIFF_CHARS - "CTX".length)})`,
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
