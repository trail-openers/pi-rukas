#!/usr/bin/env bun
/**
 * The lens blocking bar must not depend on how much of a sentence was quoted.
 *
 * `severityIn` scanned the judge's quote for severity tokens and took the FIRST
 * of `["CRITICAL","HIGH","MEDIUM","LOW"]` it found — i.e. the most severe named,
 * which is the LOOSEST bar. AGENTS.md §1 used to read:
 *
 *   "Six-pass review findings are blocking at MEDIUM severity and above. The fix
 *    loop continues until all MEDIUM, HIGH, and CRITICAL findings are resolved …
 *    Only LOW findings may be deferred."
 *
 * Quote the first sentence → MEDIUM. Quote the passage → CRITICAL. Both verify
 * against the file; both are honest citations by a judge that is not lying. The
 * gate silently moved two levels, and HIGH and MEDIUM findings stopped blocking.
 * (§1 now states HIGH — raised by operator decision 2026-10-25 — but the
 * defect this test guards was the quote-length dependence, so the canary below
 * tracks the current sentence.)
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

const S1 = "Six-pass review findings are blocking at HIGH severity and above.";
const FULL = `${S1} The fix loop continues until every finding at HIGH severity and above is resolved. MEDIUM and LOW findings are disclosed on the PR and may be deferred.`;

// ------------------------------------- this repo's own doctrine, both quotes

{
  assert(severityFromQuote(S1) === "HIGH", "the short quote resolves to HIGH");
  assert(
    severityFromQuote(FULL) === "HIGH",
    `canary: the FULL passage also resolves to HIGH (got ${severityFromQuote(FULL)}) — it resolved to CRITICAL, loosening the gate two levels on an honest quote`,
  );
  assert(
    severityFromQuote(FULL) !== "LOW" && severityFromQuote(FULL) !== "MEDIUM",
    "...and not to LOW or MEDIUM either — the 'may be deferred' clause must not over-tighten it",
  );
  // §1's SECOND sentence on its own. It used to read "until all HIGH and
  // CRITICAL findings are resolved" — a bare list with no blocking relation, so
  // `severityFromQuote` abstained and a judge that quoted only that sentence
  // silently fell back to the MEDIUM default. Abstention is the correct
  // semantics for a sentence with no bar (review-threshold.ts stays as is), but
  // the fallback is the wrong answer, so §1 now states the relation itself and
  // this sentence resolves to HIGH on its own. STRICT on purpose: an abstaining
  // quote here is a §1 regression, not a pass.
  const S2 = "The fix loop continues until every finding at HIGH severity and above is resolved.";
  const s2 = severityFromQuote(S2);
  assert(
    s2 === "HIGH",
    `canary: §1's second sentence alone resolves to HIGH (got ${s2}) — abstention here means the sentence states no bar, and a judge quoting only it would fall back to the MEDIUM default`,
  );
  // And the deferral sentence alone must not read as a bar at all.
  const S3 = "MEDIUM and LOW findings are disclosed on the PR and may be deferred.";
  const s3 = severityFromQuote(S3);
  assert(
    s3 === undefined || s3 === "HIGH",
    `§1's deferral sentence alone does not set a looser bar (got ${s3})`,
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
