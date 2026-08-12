#!/usr/bin/env bun
/**
 * The lens blocking bar must not depend on how much of a sentence was quoted.
 *
 * `severityIn` scanned the judge's quote for severity tokens and took the FIRST
 * of `["CRITICAL","HIGH","MEDIUM","LOW"]` it found — i.e. the most severe named,
 * which is the LOOSEST bar. This repo's own AGENTS.md §1 reads:
 *
 *   "Six-pass review findings are blocking at MEDIUM severity and above. The fix
 *    loop continues until all MEDIUM, HIGH, and CRITICAL findings are resolved …
 *    Only LOW findings may be deferred."
 *
 * Quote the first sentence → MEDIUM. Quote the passage → CRITICAL. Both verify
 * against the file; both are honest citations by a judge that is not lying. The
 * gate silently moved two levels, and HIGH and MEDIUM findings stopped blocking.
 *
 * Note what the fix must NOT be: "take the least severe named" resolves that
 * same passage to LOW, because of the deferral clause. The relation is what
 * carries the meaning — "at X and above" — not the tokens present.
 */

import { severityFromQuote } from "../src/review-threshold.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const S1 = "Six-pass review findings are blocking at MEDIUM severity and above.";
const FULL = `${S1} The fix loop continues until all MEDIUM, HIGH, and CRITICAL findings are resolved — there is no round cap for these severities. Only LOW findings may be deferred or overridden with user confirmation.`;

// ------------------------------------- this repo's own doctrine, both quotes

{
  assert(severityFromQuote(S1) === "MEDIUM", "the short quote resolves to MEDIUM");
  assert(
    severityFromQuote(FULL) === "MEDIUM",
    `canary: the FULL passage also resolves to MEDIUM (got ${severityFromQuote(FULL)}) — it resolved to CRITICAL, loosening the gate two levels on an honest quote`,
  );
  assert(
    severityFromQuote(FULL) !== "LOW",
    "...and not to LOW either — 'only LOW may be deferred' must not over-tighten it",
  );
}

// --------------------------------------------- the relation carries the meaning

{
  for (const [quote, want] of [
    ["blocking at HIGH severity and above", "HIGH"],
    ["we block on CRITICAL findings only", "CRITICAL"],
    ["block at MEDIUM or higher", "MEDIUM"],
    ["findings of LOW severity and above are blocking", "LOW"],
    ["CRITICAL and HIGH findings block the merge", "HIGH"],
  ] as const) {
    const got = severityFromQuote(quote);
    assert(got === want, `"${quote}" -> ${want} (got ${got})`);
  }
}

// ------------------------------------------------- unreadable means default

{
  for (const quote of [
    "we care a lot about code review",
    "",
    "reviews are mandatory before merge",
  ]) {
    assert(
      severityFromQuote(quote) === undefined,
      `no severity claim in "${quote.slice(0, 40)}" -> undefined, so the caller applies the MEDIUM default`,
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
