/**
 * plan-pi-spec-descriptor — the drafted body read as markdown, for the two
 * fields `piSpecFromDraft` takes out of it.
 *
 * `piSpecFromDraft` bounds the fields it emits, but where the `problem` and the
 * criteria come FROM is a parsing question about the drafted body, and it is the
 * part of the mapper that has to read markdown. It lives here so
 * `plan-pi-spec.ts` keeps its bounds, placement and omission logic in one file
 * and this stays the one place that decides what the plan actually said.
 *
 * Both readers go through the one section walker below, and that is the point:
 * `plan-pi-spec-text.ts`'s `SECTION_SLICE` is a regex over raw lines, so a
 * section ends at the next line BEGINNING `## ` wherever it sits. A drafted body
 * QUOTES markdown — an angle item that shows what an issue looks like puts a real
 * `## Acceptance criteria` line inside a code sample — and the slice stops there,
 * so the criteria below it are invisible, zero bullets come back, and the mapper
 * files NO machine block at all. The silence is what makes that expensive: a
 * zero-criteria draft is a legitimate shape and the title fallback sits behind
 * the zero-criteria return, so nothing says why the block vanished.
 */
import { closesFenceRun } from "./lean/spec.ts";
import { AC_FALLBACK } from "./plan-validate.ts";

/** The line `plan-draft.ts` renders the caller's descriptor as, in `## Context & motivation`. */
const DESCRIPTOR_PREFIX = "Descriptor:";

/** A line that OPENS a fenced code sample: up to 3 spaces, then 3+ of one char. */
const FENCE_OPENER = /^(?: {0,3})(?<run>`{3,}|~{3,})/;

/**
 * A line that COULD close a sample: up to 3 spaces, then the run with nothing but
 * WHITESPACE after it, carrying no info string. CommonMark strips a closing fence's
 * trailing whitespace, so a tab tail is as much a closer as a space tail, and this
 * class is `\s` and not `[ ]` because `lean/spec.ts` TRIMS that tail — a pattern
 * that accepted spaces only called a tab-closed sample still open, and the two
 * readers of one body then disagreed about the same line: the strip removed the
 * block the walker was still inside, and the walker carried a quoted `## ` heading
 * as a section boundary that ended the section early (zero bullets, which is a
 * legitimate shape, so the draft filed no machine block at all). Whether a match
 * DOES close the open one is `closesFence`'s predicate, not this pattern's —
 * a run shorter than its opener is content, like any other line.
 *
 * The 0–3 indent is stated here as well as on the opener: a sample written under a
 * list item closes on a run indented as deeply as that item's content, and a reader
 * that recognised openers at 0–3 but closers only at column 0 never closes that
 * sample — so its lines are read as section text and a bullet inside the sample is
 * filed as a criterion, which `placePiSpecSection` then embeds in the contract.
 */
const FENCE_CLOSER = /^(?: {0,3})(?<run>`{3,}|~{3,})\s*$/;

/**
 * Whether `run` closes a sample opened by `char`/`len`.
 *
 * `lean/spec.ts`'s {@link closesFenceRun}, imported rather than restated: this
 * reader and that module's strips judge the SAME bytes, and a closer one accepted
 * and the other refused is the drift that makes a body read two ways — a strip
 * that keeps what the parser dropped, or a section that ends where a strip kept
 * going. The third condition the grammar states (a closer carries no info string)
 * is enforced by the caller, which only asks about a line whose run stands alone.
 * The shape that separates a reader that honours the length rule from one that
 * merely looks for a fence line — a four-run opener with a three-run "closer" —
 * is pinned for both readers, here in `test-plan-pi-spec-problem.ts` and there in
 * `test-lean-spec.ts`.
 */
const closesFence = closesFenceRun;

/** The heading line that opens a named section. */
const sectionHead = (heading: string): RegExp =>
  new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*$`);

/**
 * The raw lines of one `## <heading>` section, read the way markdown is read.
 *
 * A line only ends the section when it is a HEADING, which means it has to sit
 * OUTSIDE every code sample. So this walks the body once, tracking the fence that
 * `lean/spec.ts`'s `fencedBlocks` recognises — up to three leading spaces, a run
 * of three or more of one character, and a closer of the same character at least
 * as long — and takes nothing from inside a CLOSED sample, headings or bullets
 * alike: a `Descriptor:` line inside a sample is not the statement, and a bullet
 * inside one is not a criterion.
 *
 * An UNTERMINATED fence is not a block, which makes it the case a fence-blind
 * reader and an eat-to-end reader both get wrong, in opposite directions. The
 * scan looks ahead for the closer before it decides: a fence with one is a
 * sample and is skipped whole, a fence without one is a truncated body and every
 * line from its opener onward is ordinary text that the section keeps. That is
 * the contract `lean/spec.ts`'s strips honour for the same bytes, and it is what
 * keeps "a draft lost its closing fence" a cosmetic difference rather than a
 * draft that files no machine block at all.
 */
export function sectionLines(body: string, heading: string): string[] {
  const lines = body.split(/\r?\n/);
  const head = sectionHead(heading);
  const out: string[] = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const opener = FENCE_OPENER.exec(line)?.groups?.run;
    if (opener !== undefined) {
      const char = opener[0] as string;
      const len = opener.length;
      // Look ahead for this fence's own closer. Without it the fence is prose and
      // the lines under it are read as prose, so the walk simply falls through
      // them; with it the whole sample is jumped, and `i` lands ON the closer so
      // the next iteration reads the line after it.
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const run = FENCE_CLOSER.exec(lines[j] as string)?.groups?.run;
        if (run !== undefined && closesFence(run, char, len)) {
          end = j;
          break;
        }
      }
      // A run that is not this fence's closer is NOT jumped: the scan stays on the
      // opener's line and reads the short run as prose. Jumping to a line that
      // failed the predicate swallows everything below it, and a body that merely
      // lost the long half of its closing fence would then lose its criteria —
      // zero bullets, which is a legitimate shape, so `piSpecFromDraft` files no
      // machine block and says nothing while doing it.
      if (end >= 0) {
        i = end;
        continue;
      }
    }
    if (!inSection) {
      if (head.test(line)) inSection = true;
      continue;
    }
    if (/^## /.test(line)) break;
    out.push(line);
  }
  return out;
}

/**
 * The statement of the problem a drafted body carries: the text of the
 * `Descriptor:` line, with its prefix removed — the sentence the plan actually
 * says is wrong, which is what the machine `problem` field should hold.
 *
 * `plan-draft.ts` renders that section as `Descriptor: …` then `Type: …`, so the
 * scan skips any `Type:` line and takes the first non-blank line that is not one
 * of the two labels — which is also what makes a body that states the descriptor
 * as bare prose yield a problem rather than the literal word `Type:`. `Type:` is
 * skipped rather than accepted: `Type: feature` is a classification, and
 * `parsePiSpec` refuses an empty `problem` but cannot tell a useless one from a
 * real one.
 *
 * Returns "" when the section holds none, which is the title-fallback case.
 */
export function descriptorProblem(body: string): string {
  for (const raw of sectionLines(body, "Context & motivation")) {
    const trimmed = raw.trim();
    if (trimmed === "" || /^Type\s*:/.test(trimmed)) continue;
    return trimmed.startsWith(DESCRIPTOR_PREFIX)
      ? trimmed.slice(DESCRIPTOR_PREFIX.length).trim()
      : trimmed;
  }
  return "";
}

/**
 * The `## Acceptance criteria` bullets, in order, status-only bullets dropped —
 * the criteria the machine block carries, read through the same fence-aware
 * section walker as the statement above.
 *
 * The filter is `plan-pi-spec-text.ts`'s `sectionBullets`' and has to stay in
 * step with it: `_italic_` lines are status notes, `AC_FALLBACK` is the
 * placeholder `validateDraft` refuses a plan over, and `...` is the drafter's
 * continuation marker. It is applied to lines `sectionLines` has ALREADY cut —
 * `sectionBullets` itself cannot be called on them because it slices by the same
 * fence-blind regex this reader exists to replace, and re-slicing already-sliced
 * text is how a second boundary creeps back in. What differs between the two
 * readers is only WHERE the section ends: here at a heading outside a code
 * sample, there at the next line starting `## `.
 */
export function criteriaBullets(body: string): string[] {
  return sectionLines(body, "Acceptance criteria")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter(
      (l) => l !== "" && !l.startsWith("_") && !l.startsWith(AC_FALLBACK) && !l.startsWith("..."),
    );
}
