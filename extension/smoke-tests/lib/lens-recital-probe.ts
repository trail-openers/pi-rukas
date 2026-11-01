/**
 * lens-recital-probe — the strings the coverage canaries disagree about.
 *
 * A lens child's closing summary is free text, and the whole denominator is a
 * handful of paths whose spelling ALREADY appears in the diff handed to the
 * lens. So the accounting must tell "the lens NAMED this file" apart from "the
 * lens RECAPS the diff, and the path is buried in there". These constants are
 * built from single-character parts rather than written as literals: a `--- `
 * / `+++ ` line at the start of a source line is a diff header, and a ```
 * fence written literally in a test file is a hazard of its own. Both coverage
 * tests import the identical bytes from here so they cannot drift apart.
 */

const FENCE = String.fromCharCode(96, 96, 96);
const DASH = "-";
const PLUS = "+";
const DOT = ".";
const SLASH = "/";
const Q = String.fromCharCode(34);
const HUNK = "@" + "@" + " -1,2 +1,3 @" + "@";

/** A lens summary that CITES both changed paths as path tokens — each flanked
 * by whitespace, which is how a lens actually names a file. The disclosure must
 * keep accepting this or a genuinely reviewed round loses its coverage claim.
 */
export const TEST_SUMMARY_CITES_BOTH_FILES = [
  "Read src" +
    SLASH +
    "a" +
    DOT +
    "ts and src" +
    SLASH +
    "b" +
    DOT +
    "ts line by line; no issues from this lens.",
].join(String.fromCharCode(10));

/** The quote character, spelled so no line of this file reads as code. */
const QUOTE = String.fromCharCode(34);

/** A lens summary whose only mention of each changed path is a RECAP of the
 * diff — the shape the lying ✓ used to be stamped on. `src/a.ts` occurs only
 * inside a `--- a/...` diff header; `src/b.ts` only inside a quoted path
 * literal, where the character before it is a quote and the character after is
 * a `.` — a path character. Each path occurs exactly once, so an accounted-for
 * result is unambiguously the anchor rule failing rather than a stray mention.
 */
export const TEST_SUMMARY_QUOTES_BOTH_FILES = [
  "Reviewed the change; the diff shows:",
  DASH + DASH + " a/src" + SLASH + "a" + DOT + "ts",
  PLUS + PLUS + " b/src" + SLASH + "a" + DOT + "ts",
  HUNK,
  PLUS +
    "const spec = require(" +
    QUOTE +
    "src" +
    SLASH +
    "b" +
    DOT +
    "ts" +
    DOT +
    "spec" +
    QUOTE +
    ");",
  "All good.",
].join(String.fromCharCode(10));

/** The same recital wrapped in a code fence — a lens pasting the diff back at
 * the operator, paths included, citing none of them.
 */
export const TEST_SUMMARY_NAMES_BOTH_FILES = [
  "Here is the diff I read, verbatim:",
  FENCE + "diff",
  DASH + DASH + " a/src" + SLASH + "a" + DOT + "ts",
  PLUS + PLUS + " b/src" + SLASH + "a" + DOT + "ts",
  HUNK,
  PLUS +
    "const spec = require(" +
    QUOTE +
    "src" +
    SLASH +
    "b" +
    DOT +
    "ts" +
    DOT +
    "spec" +
    QUOTE +
    ");",
  FENCE,
  "All good.",
].join(String.fromCharCode(10));
