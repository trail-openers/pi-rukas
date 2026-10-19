#!/usr/bin/env bun
/**
 * #1352 — an apostrophe in a quoted argument made the PM bash guard fail
 * closed on an allowlisted read. The common way to put an apostrophe inside a
 * single-quoted argument is bash's `'driver'\''s'` idiom: close the quote,
 * an escaped `\'`, reopen. `stripQuotedSegments` did not honour a backslash
 * OUTSIDE quotes, so it read that `\'` as the start of a new quoted run, found
 * it unterminated, and returned the raw command — whose `<issue>` placeholder
 * then tripped the injection check. The parser must follow bash here: an
 * escaped character outside quotes is literal and never opens a quote.
 *
 * What must NOT change: a quote bash itself cannot close (a lone apostrophe
 * inside a single-quoted run) still fails closed, an escaped operator is still
 * refused rather than read as a separator-free command, and a real operator
 * after a well-formed escape is still caught.
 */

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const { matchBashSubcommand, stripQuotedSegments } = await import("../src/bash-command-parser.ts");
const { loadAgentsJson } = await import("../src/permission-config.ts");

const pmBash = (loadAgentsJson()["project-manager"]?.permission?.bash ?? {}) as Record<
  string,
  string
>;
const pm = (c: string) => matchBashSubcommand(c, pmBash);

// --- the bug: bash's quote-escape idiom
const idiom =
  "vipune add 'PM: read .pi/work-state/<issue>.json - it conflicts with the driver'\\''s own loop.' --memory-type guard";
assert(
  !/[<>]/.test(stripQuotedSegments(idiom)),
  "the '\\'' idiom strips cleanly (quoted <issue> is not command structure)",
);
assert(pm(idiom) === "allow", "the '\\'' idiom on an allowlisted vipune add is allowed");
assert(
  pm("gh issue view 127 --json title --jq '.title | test(\"driver'\\''s\")'") === "allow",
  "an escaped apostrophe between single-quoted runs does not fail closed",
);
assert(
  pm(`vipune add "the driver's own loop <issue>" --memory-type guard`) === "allow",
  "apostrophe in double quotes stays allowed",
);
assert(
  pm("vipune add driver\\'s --memory-type guard") === "allow",
  "an unquoted escaped apostrophe is literal",
);

// --- fail-closed behaviour that must hold
const malformed = "vipune add 'the driver's own loop <issue>' --memory-type guard";
assert(
  stripQuotedSegments(malformed) === malformed,
  "a quote bash cannot close still returns the raw command",
);
assert(pm(malformed) === null, "a malformed apostrophe with an operator char still fails closed");
assert(pm("git log -1 \\; rm -rf /") === null, "an escaped `;` is still refused");
assert(pm("git log -1 \\$(whoami)") === null, "an escaped `$` is still refused");
assert(
  pm("vipune add 'it'\\''s' && rm -rf /") === null,
  "an operator after a well-formed escape is still caught",
);
assert(
  pm("vipune add 'it'\\''s' | sh") === null,
  "a pipe after a well-formed escape is still caught",
);
assert(
  matchBashSubcommand("vipune update abc -t 'it'\\''s new'", { "vipune *": "allow" }) === "deny",
  "the vipune write guard still refuses an escaped content rewrite",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
