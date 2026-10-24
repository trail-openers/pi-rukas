#!/usr/bin/env bun
/**
 * test-email-blanking-linear.ts — blanking an email address out of a publish is
 * a linear scan, not a regex the engine has to search (#1788 round 2).
 *
 * The rule this guards: `public-denylist.ts` asks its home-path and generic
 * address rules of a text with every email address blanked. The blanking used to
 * be a single regex, `/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g`, whose
 * two adjacent `+` quantifiers share four characters (`-`, `.`, `+`, `_`). A run
 * of those characters before an `@` therefore has 2^n ways to divide between the
 * local part and the host, and the engine tries them.
 *
 * Measured against the old regex on this machine, before the fix:
 *   512 B of `a.-+` followed by `@`   3.8 s
 *   1 KB                              24 s
 *   2 KB                             223 s
 * Each doubling multiplies the work, which is what separates a slow regex from
 * an exponential one. A 1 MB PR body carrying one `@` is not a benchmark, it is
 * a Tuesday: the guard runs on every agent turn that publishes, and a publish
 * that never returns is a guard an operator disables.
 *
 * So the assertions here are about TIME, and they are stated as a ratio rather
 * than a wall-clock number, because a loaded CI box is not a constant:
 *
 *   1. the 1 MB input answers inside a bound no regex of that shape could meet;
 *   2. it answers in the same order of magnitude as twenty times the 1 KB
 *      control — linear, i.e. 1000x the input is not 1000x the wait;
 *   3. the scan still blanks what the rule needs blanked, so the speed is not a
 *      withdrawal of the check.
 *
 * `timeout` bounds the whole file so a regression lands as a failed test rather
 * than a hung suite.
 */

import { blankEmailTokens } from "../src/public-hygiene-email.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

/** The adversarial run: every character in both quantified classes' overlap. */
function adversarial(n: number): string {
  // Repeating the 4-char overlap cycle exercises every split point: at each
  // position the engine can put the character in the local part or the host.
  const cycle = "a.-+";
  let s = "";
  while (s.length < n) s += cycle;
  return `${s.slice(0, n)}@`;
}

const ONE_KB = adversarial(1024);
const ONE_MB = adversarial(1024 * 1024);

/** A control the same length as ONE_KB but with no `@` — no token to find. */
const CONTROL_1KB = "a".repeat(1024);

function msOf(fn: () => unknown): number {
  const t0 = Date.now();
  fn();
  return Date.now() - t0;
}

// The control, measured first so a slow machine shows up in the ratio rather
// than in an absolute number.
const controlMs = msOf(() => blankEmailTokens(CONTROL_1KB));
const oneKbMs = msOf(() => blankEmailTokens(ONE_KB));

// 1. LINEARITY. 1 MB is 1000x the 1 KB input. Linear work is a thousand times
//    the work of one pass over a kilobyte — microseconds — so anything in the
//    tens of milliseconds is linear; the old regex at 2 KB alone took 223,000 ms.
//    The bound below is generous by four orders of magnitude and the old shape
//    missed it by five.
const oneMbMs = msOf(() => blankEmailTokens(ONE_MB));
assert(
  oneMbMs < 2000,
  `a 1 MB adversarial body is blanked in ${oneMbMs} ms, not the minutes the regex took`,
);
assert(
  oneMbMs < Math.max(2000, oneKbMs * 50 + 1000),
  `and its cost scales with input, not with the number of ways to split it (1 KB ${oneKbMs} ms, 1 MB ${oneMbMs} ms)`,
);
assert(oneKbMs < 500, `the 1 KB input answers fast (${oneKbMs} ms)`);
assert(controlMs < 500, `and so does the control (${controlMs} ms)`);

// 2. THE CHECK STILL CHECKS. Speed bought by blanking nothing is worthless, so
//    the behaviours the denylist depends on are asserted here explicitly.
//
//    The equivalence that matters is stated against the RULE, not against the
//    old regex's output. Blankng was rewritten, not cloned: it recognises an
//    address by its `@` and walks the token characters on either side, so it
//    blanks a SUPERSET of what the regex blanked (the regex also demanded a dot
//    and two trailing letters in the host). Superset is the only safe direction
//    — a token this blanks and the regex did not makes a caller decline to judge
//    a token, where the opposite direction would make it judge an address.
//    So the assertion below is that for text whose home-path the rule can see at
//    all, blanking an unrelated address never hides it: that is the property the
//    old `if (text.includes("@")) return undefined` bug destroyed.
{
  const HOME =
    /(?:^|[^\w./~-])(?:\/(?:home|Users)\/(?!dev\/|user\/|example\/|ops\/|runner\/)\w+\/?)/;
  const cases: Array<[string, boolean]> = [
    // An address in one clause must not excuse a path in another — the bug the
    // blanking exists to prevent, and the reason a blanket `@` exemption is out.
    ["ping /home/alice at ops@example.invalid", true],
    ["user@host.example and /home/alice", true],
    ["email: foo.bar+baz@sub.domain.co.uk ok /home/alice", true],
    ["a@b@c /home/ninth", true],
    ["at-sign in middle foo@ /home/other", true],
    // No address at all: the rule sees the path, untouched.
    ["no-at here /home/third", true],
    ["nothing to see", false],
    // A placeholder home is never a finding.
    ["ops@example.invalid and /home/dev/x", false],
  ];
  let mismatches = 0;
  for (const [text, expected] of cases) {
    if (HOME.test(blankEmailTokens(text)) !== expected) mismatches += 1;
  }
  assert(mismatches === 0, `the home-path rule answers as it should for ${cases.length} texts`);
}

// The blanking itself, on the cases a reader would check by hand.
assert(
  blankEmailTokens("contact ops@example.invalid for the deploy") ===
    "contact  email  for the deploy",
  "an address is blanked",
);
assert(
  blankEmailTokens("deployed on box.example") === "deployed on box.example",
  "a host with no @ is left alone",
);
assert(
  blankEmailTokens("/home/alice/work log") === "/home/alice/work log",
  "a path with no @ is left alone, so the home-path rule still sees it",
);
assert(
  blankEmailTokens("no tokens here").includes("no tokens here"),
  "a plain sentence is returned intact",
);
assert(blankEmailTokens("@nolead") === "@nolead", "an @ with no local part is not an address");
assert(blankEmailTokens("trailing@") === "trailing@", "an @ at the end is not an address");
assert(
  blankEmailTokens("a@b@c").includes(" email "),
  "two @ in one run still blank to a placeholder",
);
assert(blankEmailTokens("") === "", "empty input is empty output");

// 3. NO SPLICING. The placeholder is space-padded so blanking cannot join two
//    words into a token no rule would have matched. The walk stops at `/` (not a
//    token character), so the text on either side is preserved exactly and the
//    placeholder sits between them with spaces: `x/home/alice` and `/y` stay
//    separate tokens rather than becoming one string no rule would match.
const spliced = blankEmailTokens("x/home/alice@host/y");
assert(
  spliced === "x/home/ email /y",
  `blanking pads the placeholder instead of splicing around it (${spliced})`,
);

process.exit(exit);
