#!/usr/bin/env bun
/**
 * #1381 (part 2 of 2) — what counts as a citation unit.
 *
 * `test-decision-evidence-sentence.ts` holds the bug's repro and the grant
 * path; this file holds the unit model itself, split out so both stay under the
 * repo's file-size cap. Same harness, same real `AGENTS.md`.
 *
 * The unit model (`citationUnits`): a sentence of a paragraph, or the whole
 * content of a list item. Everything markdown uses for structure rather than
 * assertion — headings, fenced code, table rows, blockquotes, thematic breaks,
 * indented code — produces no unit at all.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { citationPresent, citationUnits } from "../src/decision-evidence.ts";
import { resolveMergeAuthority } from "../src/work-driver-merge-authority.ts";
import { citationUnits as reExportedUnits } from "../src/work-driver-policy.ts";
import {
  type DoctrineDoc,
  MERGE_POLICY_QUESTION,
  type PolicyAnswer,
  askPolicy,
  policyPrompt,
} from "../src/work-driver-policy.ts";
import { AGENTS, createRunner, grantLineFrom, REPO_ROOT } from "./citation-units-harness.ts";

const runner = createRunner();
const { assert } = runner;

const judgeSaying =
  (...answers: Partial<PolicyAnswer>[]) =>
  async () => ({ toolUses: answers.map((a) => ({ name: "report_policy", arguments: a })) });
const docs = (text: string, file = "AGENTS.md"): DoctrineDoc[] => [{ file, text }];

const REAL_GRANT_LINE = grantLineFrom(AGENTS);
assert(
  typeof REAL_GRANT_LINE === "string" && REAL_GRANT_LINE.length > 40,
  "MUST-PASS canary: the AGENTS.md §9 grant line was located as its own assert before use",
);

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

// ------------------- item 1 (HIGH): a condition line can never be split off

{
  // The shape a doc author reaches for when a two-clause rule will not fit on
  // one line: the condition on its own line (no terminator at all — `…etc)`),
  // the permission below it. The two lines are ONE unit, so a judge quoting the
  // permission alone quotes a string that is not a unit of the document.
  const SPLIT_GRANT = [
    "If all project quality gates have been met (code reviews, CI, linters, type checks etc)",
    "LLMs / agents are allowed to squash merge PRs/MRs.",
  ].join("\n");
  const units = citationUnits(SPLIT_GRANT);
  assert(
    !units.includes("llms / agents are allowed to squash merge prs/mrs."),
    "MUST-FAIL: the bare permission line is never a unit of its own — quoting it alone is not quoting the rule",
  );
  assert(
    !units.includes(
      "if all project quality gates have been met (code reviews, ci, linters, type checks etc)",
    ),
    "MUST-FAIL: the condition line alone is not a unit — it joins what it qualifies",
  );
  assert(
    units.includes(
      "if all project quality gates have been met (code reviews, ci, linters, type checks etc) llms / agents are allowed to squash merge prs/mrs.",
    ),
    "...and condition + permission together are one unit, so quoting the rule whole still works",
  );
  assert(
    !citationPresent("LLMs / agents are allowed to squash merge PRs/MRs.", SPLIT_GRANT),
    "the standalone permission line does NOT verify in that shape — that is the whole point",
  );
  // The other shape: the first line closes a sentence and seals it behind a
  // closer, so the break is real and the two lines are two units. Measured over
  // this repo's doctrine this is 90 of 756 joins; splitting at every bare
  // terminator would be 601 of 756 and would break hundreds of honest quotes.
  const SEALED_SPLIT = [
    'The lead said: "all project quality gates have been met."',
    "LLMs / agents are allowed to squash merge PRs/MRs.",
  ].join("\n");
  assert(
    citationUnits(SEALED_SPLIT).includes(
      'the lead said: "all project quality gates have been met."',
    ),
    "MUST-PASS: a closer-sealed line IS its own unit — the break there is real, not a wrap",
  );
  // An abbreviation behind a closer is still not a boundary: `…etc.)` continues.
  assert(
    citationUnits("Prefer the smaller one etc.) the faster one.").length === 1,
    "MUST-FAIL: `etc.)` never ends a unit, sealed or not",
  );
  // And the shape that must NOT collapse: an ordinary paragraph wrapped at a
  // bare sentence end. The lines join, so a judge that copied the sentence
  // across the wrap still matches it whole.
  const WRAPPED = [
    "Agents may squash-merge once every gate has",
    "passed, including lint and the full test suite.",
  ].join("\n");
  assert(
    citationPresent(
      "Agents may squash-merge once every gate has passed, including lint and the full test suite.",
      WRAPPED,
    ),
    "MUST-PASS: a sentence an honest judge copied across a line wrap still verifies",
  );
  // Two finished assertions, one per line, stay two units — the rule tightens
  // partial quotes without dissolving ordinary prose.
  const TWO_SENTENCES = [
    "Agents must file an issue before starting work.",
    "Refinements to an existing issue go in its body.",
  ].join("\n");
  assert(
    citationUnits(TWO_SENTENCES).includes("agents must file an issue before starting work.") &&
      citationUnits(TWO_SENTENCES).includes("refinements to an existing issue go in its body."),
    "MUST-PASS: two sentences on two lines are still two units — each quotable on its own",
  );
  // The same rule on one line (this repo's actual §9) must still grant.
  assert(
    citationPresent(REAL_GRANT_LINE as string, AGENTS),
    "the real AGENTS.md §9 grant still verifies when quoted whole",
  );
}

// -------------------------------------- item 2: numbered items are list items

{
  const NUMBERED = [
    "1. Agents may merge after the gates pass",
    "   and only on a green build",
    "2) Agents may revert their own merge.",
  ].join("\n");
  const units = citationUnits(NUMBERED);
  assert(
    units.includes("agents may merge after the gates pass and only on a green build"),
    "the enumerator is stripped and the indented continuation belongs to the same unit",
  );
  assert(units.includes("agents may revert their own merge."), "`2)` enumerators strip too");
  assert(
    !units.some((u) => /^\d+[.)]$/.test(u) || u.includes("1.")),
    `no bare "1." unit is ever emitted (got ${JSON.stringify(units)})`,
  );
  assert(
    !citationUnits("Rules:\n1.\n2.\n3)\n").some((u) => /^\d/.test(u)),
    "a lone enumerator on its own line produces no unit at all",
  );
  assert(
    !citationPresent("Agents may merge after the gates pass", NUMBERED),
    "...so the head of an item cannot be quoted without its continuation",
  );
}

// ------------- items 3 & 4: structures that are not units, and closers that are

{
  const DOC = [
    "The team may ship on Fridays.",
    "",
    "> A quoted rule someone else wrote.",
    "",
    "---",
    "***",
    "___",
    "    four space indented code.",
    "",
    'The captain said "ship it." Then the team shipped.',
  ].join("\n");
  const units = citationUnits(DOC);
  assert(units.includes("the team may ship on fridays."), "MUST-PASS: ordinary prose still works");
  assert(
    !units.some((u) => u.includes("quoted rule someone else wrote")),
    "MUST-FAIL: a blockquote line is another author's words, never a unit here",
  );
  assert(
    !units.some((u) => /^[-*_]+$/.test(u)),
    `MUST-FAIL: a thematic break is a separator with no content (got ${JSON.stringify(units)})`,
  );
  assert(
    !units.some((u) => u.includes("four space indented code")),
    "MUST-FAIL: a 4-space indented line is markdown's unfenced code block",
  );
  assert(
    units.includes('the captain said "ship it."') && units.includes("then the team shipped."),
    'item 4 MUST-PASS: `."` ends the sentence — the closer belongs to it, not the next one',
  );
  assert(
    citationPresent('The captain said "ship it."', DOC),
    '...and a quote ending `."` verifies as its own unit',
  );
}

// -------------------------------- item 5 / review (a): fences and heading depth

{
  // (a) An unclosed fence is a typo in the doctrine, not a veto over it. Before
  // the fix the opener flipped `inFence` and nothing flipped it back, so every
  // rule after it — including a deliberate merge grant — silently stopped being
  // quotable, and the gate denied with no hint that a missing ``` was the cause.
  const GRANT =
    "If all project quality gates have been met (code reviews, CI, linters, type checks etc) LLMs / agents are allowed to squash merge PRs (GitLab: MRs).";
  const UNCLOSED = ["## 9. Git workflow", "", "```", "npm run build", "", GRANT, ""].join("\n");
  assert(
    citationPresent(GRANT, UNCLOSED),
    "MUST-PASS: a §9-style grant after an UNCLOSED fence still verifies — a stray ``` does not delete the rest of the file",
  );
  const CLOSED = ["## 9. Git workflow", "", "```", "npm run build", "```", "", GRANT, ""].join(
    "\n",
  );
  assert(
    citationPresent(GRANT, CLOSED),
    "...and the same grant verifies when the fence does close",
  );
  const FENCED_GRANT = ["Rules:", "", "```", GRANT, "```", "", "Prose after the fence.", ""].join(
    "\n",
  );
  assert(
    !citationPresent(GRANT, FENCED_GRANT),
    "MUST-FAIL: a *closed* fence still hides its contents — unclosed is a typo, a real block is still an example",
  );
  const TILDE_UNCLOSED = ["prose before.", "~~~", "tilde fence body", "", GRANT].join("\n");
  assert(
    citationPresent(GRANT, TILDE_UNCLOSED),
    "...and `~~~` fences obey the same rule as ``` fences",
  );

  // (c) An ATX heading is 1-6 `#` then a space. Beyond that it is literal text.
  const SEVEN = "####### Deeply hash'd sentence that is not a heading.";
  assert(
    citationUnits(SEVEN).some((u) => u.includes("deeply hash'd")),
    "MUST-PASS: `#######` is seven hashes — literal text, so it is still a unit, not a swallowed heading",
  );
  const SIX = "###### Six hashes is a heading sentence.";
  assert(
    !citationUnits(SIX).some((u) => u.includes("six hashes is a heading")),
    "MUST-FAIL: `######` (six) IS a heading and must produce no unit",
  );
}

// ---------------------------- the escape hatches stay exactly as they were

{
  const REAL_GRANT = REAL_GRANT_LINE as string;
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

console.log(`\nexit ${runner.exit}`);
process.exit(runner.exit);
