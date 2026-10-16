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

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  citationPresent,
  citationUnits,
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

// ------------------------------------------------------------- the unit model

{
  const DOC = [
    "# Heading here",
    "",
    "First sentence. Second sentence stands alone. Third one too.",
    "",
    "- a bullet with e.g. a period, and another. still the same item.",
    "- short bullet with no terminal punctuation",
    "",
    "```",
    "Fenced. Line.",
    "```",
    "",
    "| col | col |",
    "| --- | --- |",
    "| a row. with a period | b |",
  ].join("\n");
  const units = citationUnits(DOC);
  assert(units.length === 5, `five units, no more (got ${JSON.stringify(units)})`);
  assert(
    units.includes("first sentence.") &&
      units.includes("second sentence stands alone.") &&
      units.includes("third one too."),
    "a paragraph splits into its three sentences",
  );
  assert(
    units.includes("a bullet with e.g. a period, and another. still the same item."),
    "a list item is ONE unit — interior `.` does not split it",
  );
  assert(
    units.includes("short bullet with no terminal punctuation"),
    "a bullet with no terminal punctuation is its own unit",
  );
  assert(
    !units.some((u) => u.includes("heading here") || u.includes("fenced") || u.includes("a row")),
    "headings, fenced code and table rows produce no units at all",
  );
  assert(
    reExportedUnits === citationUnits,
    "work-driver-policy re-exports the same unit matcher, so tests import it from the existing site",
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
  const REAL_GRANT = GRANT_LINE as string;
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
    /does not appear in/.test(decision.reason),
    "...with the existing denial reason, so no caller sees a new source value",
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

// ---------------------------- the escape hatches stay exactly as they were

{
  const REAL_GRANT = GRANT_LINE as string;
  const prevJudge = process.env.PI_ENSEMBLE_POLICY_JUDGE;
  process.env.PI_ENSEMBLE_POLICY_JUDGE = "0";
  assert(
    !(
      await askPolicy(
        judgeSaying({ verdict: "permitted", quote: REAL_GRANT, sourceFile: "AGENTS.md" }),
        MERGE_POLICY_QUESTION,
        docs(AGENTS),
      )
    ).permitted,
    "PI_ENSEMBLE_POLICY_JUDGE=0 still denies a perfectly valid whole-sentence grant",
  );
  if (prevJudge === undefined) delete process.env.PI_ENSEMBLE_POLICY_JUDGE;
  else process.env.PI_ENSEMBLE_POLICY_JUDGE = prevJudge;

  const prev = process.env.PI_ENSEMBLE_DECISIONS;
  process.env.PI_ENSEMBLE_DECISIONS = "0";
  const root = mkdtempSync(path.join(os.tmpdir(), "sentence-decisions-"));
  const where = { repoRoot: root, issues: [1381] };
  assert(
    (
      await askPolicy(
        judgeSaying({ verdict: "permitted", quote: REAL_GRANT, sourceFile: "AGENTS.md" }),
        MERGE_POLICY_QUESTION,
        docs(AGENTS),
        where,
      )
    ).permitted,
    "PI_ENSEMBLE_DECISIONS=0 still honours a verified whole-sentence grant",
  );
  assert(
    !(
      await askPolicy(
        judgeSaying({
          verdict: "permitted",
          quote: "LLMs / agents are allowed to squash merge PRs",
          sourceFile: "AGENTS.md",
        }),
        MERGE_POLICY_QUESTION,
        docs(AGENTS),
        where,
      )
    ).permitted,
    "...and still denies a partial one",
  );
  assert(
    !(
      await askPolicy(
        judgeSaying({
          verdict: "permitted",
          quote: "Agents may merge anything at any time for any reason.",
          sourceFile: "AGENTS.md",
        }),
        MERGE_POLICY_QUESTION,
        docs(AGENTS),
        where,
      )
    ).permitted,
    "...and still denies a fabricated one",
  );
  if (prev === undefined) delete process.env.PI_ENSEMBLE_DECISIONS;
  else process.env.PI_ENSEMBLE_DECISIONS = prev;
}

// -------------------------------- the reviewer's own instruction stays in step

{
  // The code now enforces "one sentence, word for word"; the prompt and the
  // reporter schema must keep demanding the same thing, or an honest judge
  // that quotes a clause is denied with nothing telling it why.
  const prompt = policyPrompt(MERGE_POLICY_QUESTION, docs("Agents may merge once CI is green."));
  assert(
    /word for word/i.test(prompt) && /one sentence/i.test(prompt),
    "policyPrompt still demands the one sentence copied word for word",
  );
  const reporter = readFileSync(
    path.join(REPO_ROOT, "extension", "src", "policy-reporter.ts"),
    "utf8",
  );
  assert(
    /WORD FOR WORD/.test(reporter) && /sentence/i.test(reporter),
    "the report_policy schema still describes the quote as a single sentence copied word for word",
  );
}

// ------------------------------------- the docs state the rule they now enforce

{
  const lines = readFileSync(path.join(REPO_ROOT, "docs/troubleshooting.md"), "utf8").split("\n");
  const from = lines.findIndex((l) => l.startsWith("### Merge authority"));
  let to = from + 1;
  while (to < lines.length && !/^###? /.test(lines[to])) to++;
  const section = lines.slice(from, to).join("\n");
  assert(
    from >= 0 && /whole sentence/i.test(section),
    "docs/troubleshooting.md 'Merge authority' states the whole-sentence rule",
  );
  const configuration = readFileSync(path.join(REPO_ROOT, "docs/configuration.md"), "utf8");
  const row = configuration.split("\n").find((l) => l.includes("PI_ENSEMBLE_POLICY_JUDGE")) ?? "";
  assert(
    /whole sentence/i.test(row),
    "docs/configuration.md's PI_ENSEMBLE_POLICY_JUDGE row states it too",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
