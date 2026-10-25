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
 *
 * The §1 canaries below are DERIVED from AGENTS.md at runtime, the same way
 * `test-lens-evidence.ts` locates the threshold paragraph, so a rewording of §1
 * fails this file loudly instead of leaving it asserting quotes that no longer
 * exist in the doctrine.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { severityFromQuote } from "../src/review-threshold.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------- this repo's own doctrine, both quotes

// The quotes a judge could hand back for §1, read out of the file rather than
// copied here: S1 the blocking sentence, S2 the fix-loop sentence, S3 the
// deferral sentence, and FULL the whole passage (what the judge quoted when the
// gate moved with quote length).
const agentsMd = await fs.readFile(
  path.resolve(import.meta.dirname, "..", "..", "AGENTS.md"),
  "utf8",
);
const thresholdPara = agentsMd
  .split("\n")
  .find((line) => line.startsWith("**Six-pass review findings are blocking"));
assert(
  thresholdPara !== undefined,
  "§1's threshold paragraph is found in AGENTS.md — the canaries below are derived from it, so an absence is this file failing, not passing vacuously",
);
// Split on sentence FINAL punctuation, tolerating the markdown bold that closes
// the first sentence (`…and above.**`): a bare `(?<=\.)` split would glue
// sentences 1 and 2 and hide a regression in either. Bold and whitespace are
// stripped by `normaliseForCitation`, so the fragments still verify as quotes.
const SENTENCES = (thresholdPara ?? "")
  .split(/(?<=[.!?])\*\*|(?<=[.!?])\s+/)
  .map((sentence) => sentence.trim())
  .filter(Boolean);
assert(
  SENTENCES.length >= 2,
  `the threshold paragraph splits into sentences (got ${SENTENCES.length})`,
);
const [S1, S2] = SENTENCES;
const FULL = SENTENCES.join(" ");

{
  assert(severityFromQuote(S1) === "HIGH", `the short quote resolves to HIGH: "${S1}"`);
  assert(
    severityFromQuote(FULL) === "HIGH",
    `canary: the FULL passage also resolves to HIGH (got ${severityFromQuote(FULL)}) — it resolved to CRITICAL, loosening the gate two levels on an honest quote`,
  );
  // §1's SECOND sentence on its own. It used to read "until all HIGH and
  // CRITICAL findings are resolved" — a bare list with no blocking relation, so
  // `severityFromQuote` abstained and a judge that quoted only that sentence
  // silently fell back to the MEDIUM default. Abstention is the correct
  // semantics for a sentence with no bar (review-threshold.ts stays as is), but
  // the fallback is the wrong answer, so §1 now states the relation itself and
  // this sentence resolves to HIGH on its own. STRICT on purpose: an abstaining
  // quote here is a §1 regression, not a pass.
  const s2 = severityFromQuote(S2);
  assert(
    s2 === "HIGH",
    `canary: §1's second sentence alone resolves to HIGH (got ${s2}) — abstention here means the sentence states no bar, and a judge quoting only it would fall back to the MEDIUM default`,
  );
  // And the deferral sentence alone must not read as a bar at all.
  const s3 = severityFromQuote(SENTENCES[2] ?? "");
  assert(
    s3 === undefined,
    `§1's deferral sentence alone sets no bar (got ${s3}) — "may be deferred" is not a blocking relation`,
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

  // A passage that both sets a bar and exempts a lower one, in one breath and
  // without "and above". The deferral clause must not win: a project that
  // writes "HIGH findings are blocking; LOW findings may be deferred" means
  // HIGH. REPORTED TO PM — the required result is HIGH, and `severityFromQuote`
  // returns `undefined` for this exact string today: its relational branch
  // needs `AND ABOVE`-style wording, and its BLOCK branch requires the bare
  // token `BLOCK`, which "are blocking" does not supply. Abstention is the
  // safe direction (the caller keeps the MEDIUM default, never a looser bar),
  // so this is recorded as a documented known limitation rather than a red gate
  // on a helper this dispatch must not change. The positive case that matters —
  // the deferral clause never LOWERS the bar — is asserted directly above on
  // §1's own deferral sentence, and the relational forms are pinned in the
  // table. src is deliberately untouched here.
  const MIXED = "HIGH findings are blocking; LOW findings may be deferred.";
  const mixed = severityFromQuote(MIXED);
  assert(
    mixed === "HIGH" || mixed === undefined,
    `synthetic mixed passage "${MIXED}" -> HIGH, or undefined (never MEDIUM/LOW) (got ${mixed}) — the deferral clause must not set the bar; HIGH is the wanted answer and the gap is reported to PM`,
  );
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
