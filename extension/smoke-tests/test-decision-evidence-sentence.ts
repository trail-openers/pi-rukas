#!/usr/bin/env bun
/**
 * #1381 — a citation must be a whole sentence, not a substring.
 *
 * `citationPresent` was a normalised `includes()` with a twelve-character
 * floor, so *any* substring of a doctrine file that long verified. Against
 * this repo's own `AGENTS.md` that meant all of these returned `true`:
 *
 *   - "LLMs / agents are allowed to squash merge PRs" — the permission clause
 *     of the §9 grant, quoted **without** its leading conditional ("If all
 *     project quality gates have been met …"), which is the condition itself;
 *   - "## 9. Git workflow" — a heading, which asserts nothing;
 *   - "when gates pass" — the inside of a bullet;
 *   - a fenced `BREAKING CHANGE:` line and a table cell — an example and a
 *     cell, neither of them a rule the document states in its own voice.
 *
 * Every one of those is a grant a judge could hand the driver, and the seam
 * would report `evidence.passed: true` with no warning: the bug is silent,
 * which is why the tests below assert on real substrings rather than invented
 * sentences. An invented sentence was never the problem — no test contained a
 * real one, so the exploit stayed invisible.
 *
 * The unit model (`citationUnits`): a sentence of a paragraph, or the whole
 * content of a list item. Nothing else verifies.
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  citationPresent,
  citationUnits,
  classifyCitation,
  normaliseForCitation,
  verifyEvidence,
} from "../src/decision-evidence.ts";
import { resolveMergeAuthority } from "../src/work-driver-merge-authority.ts";
import { citationUnits as reExportedUnits } from "../src/work-driver-policy.ts";
import {
  type DoctrineDoc,
  MERGE_POLICY_QUESTION,
  type PolicyAnswer,
  askPolicy,
  policyPrompt,
} from "../src/work-driver-policy.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const AGENTS = readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");

/** Read from disk, not duplicated: a fixture copied from the file can drift. */
const GRANT_LINE = AGENTS.split("\n").find((l) =>
  l.startsWith("If all project quality gates have been met"),
);
// Item 6: every §9 assertion below dereferences this with `as string`. If the
// line ever moves or is reworded, that is a broken fixture, not a passing test
// over `undefined` — so locate it before anything depends on it.
assert(
  typeof GRANT_LINE === "string" && GRANT_LINE.length > 40,
  "MUST-PASS canary: the AGENTS.md §9 grant line was located as its own assert before use",
);
const REAL_GRANT_LINE = GRANT_LINE;

const judgeSaying =
  (...answers: Partial<PolicyAnswer>[]) =>
  async () => ({ toolUses: answers.map((a) => ({ name: "report_policy", arguments: a })) });
const docs = (text: string, file = "AGENTS.md"): DoctrineDoc[] => [{ file, text }];

// ------------------------------------------------------- the real §9 grant

{
  assert(
    GRANT_LINE !== undefined && citationPresent(GRANT_LINE as string, AGENTS),
    "the §9 grant read verbatim from the real AGENTS.md verifies — the rule does not break the grant it guards",
  );
  assert(
    !citationPresent("LLMs / agents are allowed to squash merge PRs", AGENTS),
    "the same sentence's permission clause, minus its leading conditional, does NOT — that is the bug",
  );
  assert(
    !citationPresent("If all project quality gates have been met", AGENTS),
    "...nor the conditional alone, which is the other half of the same sentence",
  );
  assert(
    !citationPresent("(code reviews, CI, linters, type checks etc)", AGENTS),
    "...nor a parenthetical lifted out of it",
  );
}

// ------------------------------------------- the non-prose structures excluded

{
  assert(!citationPresent("## 9. Git workflow", AGENTS), "a heading is never a grant sentence");
  assert(
    !citationPresent("### 🚨 Pre-Push Quality Gates (BLOCKING)", AGENTS),
    "...not even one carrying internal punctuation",
  );
  assert(
    !citationPresent(
      "BREAKING CHANGE: hardcoded 10-slot limit is now configurable via env var.",
      AGENTS,
    ),
    "a fenced code line is not a rule the document asserts",
  );
  assert(
    !citationPresent("ask hard-denies (no human to consent).", AGENTS),
    "a table cell is not a rule either",
  );
  assert(
    !citationPresent("when gates pass", AGENTS),
    "a fragment from the interior of a list item does not verify",
  );
  assert(
    !citationPresent("the agent's runtime, not the user's", AGENTS),
    "...nor a mid-sentence span of a long paragraph line",
  );
}

// ------------- review (b): the denial reason names the actual fault

{
  // A partial quote and a fabricated quote both fail, and both stay fail-closed,
  // but an operator reading the reason must be able to tell a judge that
  // paraphrased from a judge that invented.

  // (b) The two denials read differently, on the vouched branch too.
  const GRANT = REAL_GRANT_LINE as string;
  const vouched = { texts: [{ name: "AGENTS.md", text: GRANT }] };
  const half = await verifyEvidence(
    vouched,
    "LLMs / agents are allowed to squash merge PRs",
    undefined,
  );
  assert(
    !half.passed && /real text of any supplied text but not one whole sentence/.test(half.reason),
    `MUST-PASS: a clause of a vouched text is called a partial quote, not an invention (${half.reason})`,
  );
  const fiction = await verifyEvidence(
    vouched,
    "Agents may merge anything at any time.",
    undefined,
  );
  assert(
    !fiction.passed && /does not appear in/.test(fiction.reason),
    `...and an invented quote still reads as an invention (${fiction.reason})`,
  );
  const nameMatched = await verifyEvidence(
    vouched,
    "LLMs / agents are allowed to squash merge PRs",
    "AGENTS.md",
  );
  assert(
    !nameMatched.passed &&
      /real text of AGENTS.md but not one whole sentence/.test(nameMatched.reason),
    `the name-matched branch words it the same way (${nameMatched.reason})`,
  );
  assert(
    !half.passed && !fiction.passed && !nameMatched.passed,
    "all three stay fail-closed — the new wording changes the reason, never the verdict",
  );
}

// ------------------------- item 5: an I/O fault is not a fabricated citation

{
  const root = mkdtempSync(path.join(os.tmpdir(), "sentence-io-"));
  const Q = "Agents may merge once CI is green and review approved.";
  writeFileSync(path.join(root, "POLICY.md"), `# Policy\n\n${Q}\n`);
  writeFileSync(path.join(root, "unreadable.md"), `${Q}\n`);
  chmodSync(path.join(root, "unreadable.md"), 0o000);
  const fileCheck = { repoRoot: root, texts: [] };

  const missing = await verifyEvidence(fileCheck, Q, "nope.md");
  assert(
    !missing.passed && /not a readable file/.test(missing.reason),
    `a missing file says so (${missing.reason})`,
  );
  const outside = await verifyEvidence(fileCheck, Q, "../../etc/hosts");
  assert(
    !outside.passed && /outside the repo root/.test(outside.reason),
    `a path escaping the root says so (${outside.reason})`,
  );
  const escapesButMissing = await verifyEvidence(fileCheck, Q, "../outside-only/MISSING-doc.md");
  assert(
    !escapesButMissing.passed && /outside the repo root/.test(escapesButMissing.reason),
    // The confinement check runs before the existence check: otherwise a judge
    // could probe which paths outside the root exist by reading the reasons.
    `a traversal to a file that does not exist still says "outside", not "not found" (${escapesButMissing.reason})`,
  );
  const huge = path.join(root, "huge.md");
  writeFileSync(huge, `${Q}\n${"x".repeat(300 * 1024)}`);
  const oversized = await verifyEvidence(fileCheck, Q, "huge.md");
  assert(
    !oversized.passed && /larger than/.test(oversized.reason),
    `an oversized file says so rather than reading it (${oversized.reason})`,
  );
  const unreadable = await verifyEvidence(fileCheck, Q, "unreadable.md");
  chmodSync(path.join(root, "unreadable.md"), 0o644);
  assert(
    !unreadable.passed && /I\/O fault/.test(unreadable.reason),
    `MUST-FAIL: an EACCES says "I/O fault", never "the quote does not appear" (${unreadable.reason})`,
  );
  assert(
    !/does not appear/.test(unreadable.reason),
    "...so an operator with a permissions problem is not told the judge hallucinated",
  );
  assert(
    !unreadable.passed && !missing.passed && !outside.passed && !oversized.passed,
    "every read failure stays fail-closed — the verdict is unchanged, only the reason",
  );

  // The distinction that matters for a hallucination signal: real text, wrong
  // granularity, named as such.
  const partial = await verifyEvidence(fileCheck, "Agents may merge once CI is green", "POLICY.md");
  assert(
    !partial.passed && /real text of POLICY.md but not one whole sentence/.test(partial.reason),
    `a real-but-partial quote is called what it is (${partial.reason})`,
  );
  const invented = await verifyEvidence(
    fileCheck,
    "Agents may merge whenever they feel like it.",
    "POLICY.md",
  );
  assert(
    !invented.passed && /does not appear in POLICY.md/.test(invented.reason),
    "a fabricated quote keeps the existing wording, which callers match on",
  );
  assert(
    classifyCitation(Q, Q) === "whole-unit" &&
      classifyCitation("Agents may merge once CI is green", Q) === "partial-unit" &&
      classifyCitation("Agents may merge whenever they feel like it.", Q) === "absent" &&
      classifyCitation("short", Q) === "too-short",
    "classifyCitation names all four outcomes distinctly",
  );
}

// ------------------------------------------------- the closed abbreviation set

{
  for (const [doc, quote] of [
    ["Run the tests e.g. before you push them.", "Run the tests e.g. before you push them."],
    [
      "Use a linter i.e. the tool that checks style.",
      "Use a linter i.e. the tool that checks style.",
    ],
    ["Gate on lint, tests etc before shipping.", "Gate on lint, tests etc before shipping."],
    ["Prefer the smaller one vs. the faster one.", "Prefer the smaller one vs. the faster one."],
    ["See the spec cf. the appendix for details.", "See the spec cf. the appendix for details."],
  ] as const) {
    assert(citationPresent(quote, doc), `"${quote.slice(0, 32)}…" survives the abbreviation set`);
  }
  // The other half: an abbreviation must not glue two sentences into one unit,
  // or a quote of the second would need the first to verify.
  assert(
    citationPresent("That is all.", "Run the tests e.g. before pushing. That is all."),
    "a sentence AFTER an abbreviation is still its own unit",
  );
  assert(
    !citationPresent(
      "before pushing. That is all.",
      "Run the tests e.g. before pushing. That is all.",
    ),
    "...and the boundary there is real, not swallowed by the abbreviation rule",
  );
}

// ------------------------------------------- formatting tolerance must survive

{
  const FILE = "## 9. Git workflow\n\nLLMs / agents are **allowed** to squash\nmerge PRs.\n";
  assert(
    citationPresent("LLMs / agents are allowed to squash merge PRs.", FILE),
    "bold markers and a line wrap still verify — the sentence rule did not cost the formatting tolerance",
  );
  const BOLD_LEADIN =
    "**Agent Merge Authorization**: Agents may squash-merge a PR to main once CI is green.";
  assert(
    citationPresent(BOLD_LEADIN, BOLD_LEADIN),
    "the lead-in is a colon rather than a full stop, so it does not end a unit: the bullet-style lead-in and the clause after it are one unit, and quoting it whole still verifies",
  );
  const FI = "Agentit saavat yhdistää pull requestin main-haaraan itsenäisesti, kun CI on vihreä.";
  assert(citationPresent(FI, `# Ohjeet\n\n${FI}\n`), "a Finnish whole sentence still verifies");
  assert(
    citationPresent("Agentit saavat yhdistää.", "Agentit saavat yhdistää. Luokset on pidettävä."),
    "...and a Finnish sentence splits on its full stop like any other",
  );
}

// --------------------------------- verifyEvidence: all three branches agree

{
  const root = mkdtempSync(path.join(os.tmpdir(), "sentence-ev-"));
  const Q = "Agents may merge once CI is green and review approved.";
  const PARTIAL = "Agents may merge once CI is green";
  writeFileSync(path.join(root, "POLICY.md"), `# Policy\n\n${Q}\n`);
  const fileCheck = { repoRoot: root, texts: [] };
  const vouched = { texts: [{ name: "AGENTS.md", text: Q }] };
  assert(
    (await verifyEvidence(fileCheck, Q, "POLICY.md")).passed,
    "the file-cited branch accepts the whole sentence",
  );
  assert(
    !(await verifyEvidence(fileCheck, PARTIAL, "POLICY.md")).passed,
    "...and the FILE-cited branch rejects a real-but-partial substring of it — the exploit, at the entry point",
  );
  assert(
    (await verifyEvidence(vouched, Q, undefined)).passed,
    "the vouched-texts branch accepts the whole sentence",
  );
  assert(
    !(await verifyEvidence(vouched, PARTIAL, undefined)).passed,
    "...and the vouched-texts branch rejects the same partial quote — the two branches cannot disagree",
  );
  assert(
    !(await verifyEvidence({ texts: [{ name: "AGENTS.md", text: Q }] }, PARTIAL, "AGENTS.md"))
      .passed,
    "the name-matched branch rejects it too",
  );
  assert(
    (await verifyEvidence({ texts: [{ name: "AGENTS.md", text: Q }] }, Q, "AGENTS.md")).passed,
    "...and accepts the whole one",
  );
  // The 12-char floor keeps its own meaning: short and whole is still not evidence.
  assert(
    !(await verifyEvidence({ texts: [{ name: "a", text: "Yes." }] }, "Yes.", undefined)).passed,
    "the ≥12-char floor stays a separate guard: short and whole is still not evidence",
  );
  assert(
    normaliseForCitation("A") !== normaliseForCitation("B"),
    "normaliseForCitation is untouched (a sanity check on the shared helper)",
  );
}

// ------------------------------- the grant path: a partial quote is citation-failed

{
  const REAL_GRANT = REAL_GRANT_LINE as string;
  const granted = await resolveMergeAuthority(
    judgeSaying({ verdict: "permitted", quote: REAL_GRANT, sourceFile: "AGENTS.md" }),
    docs(AGENTS),
  );
  assert(
    granted.granted && granted.source === "doctrine",
    "resolveMergeAuthority honours the real §9 sentence quoted whole",
  );
  const partial = await resolveMergeAuthority(
    judgeSaying({
      verdict: "permitted",
      quote: "LLMs / agents are allowed to squash merge PRs",
      sourceFile: "AGENTS.md",
    }),
    docs(AGENTS),
  );
  assert(
    !partial.granted && partial.source === "citation-failed",
    "the same document quoted partially yields source 'citation-failed', never a silent 'none'",
  );
  assert(
    partial.authorityQuote === undefined || partial.authorityQuote.length > 0,
    "the rejected quote is still recorded for the operator to read",
  );
  const decision = await askPolicy(
    judgeSaying({
      verdict: "permitted",
      quote: "LLMs / agents are allowed to squash merge PRs",
      sourceFile: "AGENTS.md",
    }),
    MERGE_POLICY_QUESTION,
    docs(AGENTS),
  );
  assert(
    !decision.permitted && decision.citationFailed === true,
    "askPolicy flags a partial quote as a citation failure, same as a fabricated one",
  );
  assert(
    /real text of AGENTS.md but not one whole sentence/.test(decision.reason),
    "...with a reason that says the quote is real but partial, which is not the wording a fabricated quote gets",
  );
  // The same thing on a synthetic document, so the assertion does not depend on
  // this repo's wording staying as it is (which is out of scope to change).
  const QUALIFIED = "Agents may merge once CI is green and a human has approved.";
  const partialSource = await resolveMergeAuthority(
    judgeSaying({
      verdict: "permitted",
      quote: "Agents may merge once CI is green",
      sourceFile: "AGENTS.md",
    }),
    docs(QUALIFIED),
  );
  assert(
    !partialSource.granted && partialSource.source === "citation-failed",
    "a real-but-partial substring of a doctrine sentence is refused as citation-failed, never a silent 'none'",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
