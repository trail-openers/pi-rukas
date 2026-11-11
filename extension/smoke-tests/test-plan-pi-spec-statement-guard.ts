#!/usr/bin/env bun
/**
 * #2171 — what the FIRST line of `## Context & motivation` is allowed to be.
 *
 * The `problem` field is printed UNFENCED by `lean/specify-prompt.ts` and
 * `lean/challenge-prompt.ts`, between `## The problem` and the next heading. So a
 * first line that is markdown structure — a rule, a table row, a heading, a list
 * item, a raw-HTML block — arrives in the oracle's brief as a section of that
 * brief the step never wrote, and `neutraliseFenceRuns` in `plan-pi-spec.ts`
 * refuses fence RUNS in a field, never `#`, `-` or `|`. The reader therefore
 * refuses the shape rather than carrying it: a refused line falls through to the
 * next line, and if none survives, to the title.
 *
 * The drafter writes a `Descriptor:` line in this slot, so every shape below comes
 * from a hand-edited or angle-populated section.
 *
 * Split out of `test-plan-pi-spec-problem.ts` (AGENTS.md §12: split along a
 * natural seam, never compress) — that file is where the `problem` field comes
 * FROM; this one is what the first line of the section may BE.
 */
import { piSpecFromDraft } from "../src/plan-pi-spec.ts";
import { assert, mustSpec, specExit } from "./lib/plan-pi-spec-fixture.ts";

{
  for (const [name, decoration] of [
    ["bullet list", "- do the thing"],
    ["blockquote", "> do the thing"],
    ["thematic break (dashes)", "---"],
    ["thematic break (stars)", "***"],
    ["thematic break (long run)", "---------------------------------------"],
    ["table row", "| a | b |"],
    ["raw HTML block", "<div>note</div>"],
    ["third-level heading", "### Notes"],
    ["first-level heading", "# Notes"],
    ["setext underline", "========="],
    ["task list item", "- [ ] todo"],
  ] as const) {
    const mapped = mustSpec(
      piSpecFromDraft({
        type: "feature",
        title: "the title wins",
        body: `## Context & motivation\n\n${decoration}\n\nType: feature\n\n## Acceptance criteria\n\n- a\n`,
      }),
      `problem: ${name}`,
    );
    assert(
      mapped.problem === "the title wins",
      `problem: a ${name} as the section's first line is not a statement, so the title is (got ${JSON.stringify(mapped.problem)})`,
    );
  }

  // …and the refusal is of STRUCTURE, not of punctuation. Each line below is a
  // sentence that merely starts with a character the structural class names; a
  // guard that refused `-` and `#` wherever they appear would drop the statement and
  // file the headline in its place, which is the pre-feature bug this issue exists to
  // close — so these are asserted as the LINE ITSELF, not merely "a block was filed".
  for (const [name, prose] of [
    ["a hyphenated word", "well-known behaviour matters"],
    ["a dotted version", "v1.2.3 is broken"],
    ["an ordered list that is really a sentence", "1.2 requests per second is the ceiling"],
    ["a leading hash inside words", "grep for #tag in the feed"],
  ] as const) {
    const mapped = mustSpec(
      piSpecFromDraft({
        type: "feature",
        title: "the headline",
        body: `## Context & motivation\n\n${prose}\n\nType: feature\n\n## Acceptance criteria\n\n- a\n`,
      }),
      `problem: prose ${name}`,
    );
    assert(
      mapped.problem === prose,
      `problem: prose with punctuation at its start — ${name} — is still the statement (got ${JSON.stringify(mapped.problem)})`,
    );
  }

  // …and a decoration does not swallow the statement written below it: the walk
  // CONTINUES past a refused line, so the first real sentence in the section is the
  // problem and the headline is not needed at all.
  {
    const mapped = mustSpec(
      piSpecFromDraft({
        type: "feature",
        title: "the headline",
        body:
          "## Context & motivation\n\n---\n\n### Notes\n\n| a | b |\n\nThe retry helper loses its message.\n\nType: feature\n\n## Acceptance criteria\n\n- a\n",
      }),
      "problem: decoration then statement",
    );
    assert(
      mapped.problem === "The retry helper loses its message.",
      `problem: the walk falls through every decoration line to the first sentence (got ${JSON.stringify(mapped.problem)})`,
    );
  }

  // …and the one shape the guard must NOT refuse: markdown structure that sits in an
  // UNTERMINATED sample. An unclosed fence is not a block, so its lines are the
  // section's own text and dropping them is the eat-to-end strip refused in the
  // sibling file — which is why `sectionLines` reports the kept-sample verdict
  // rather than letting this reader guess from the line's spelling. The `#` here is
  // kept content, not decoration, and the neutraliser renders the opener's run as
  // look-alikes.
  {
    const NEUTRALISED_OPEN = String.fromCharCode(0x2cb, 0x2cb, 0x2cb);
    const mapped = mustSpec(
      piSpecFromDraft({
        type: "feature",
        title: "the title",
        body:
          "## Context & motivation\n\n```md\n### Heading inside an unclosed sample\n\n## Acceptance criteria\n\n- a\n",
      }),
      "problem: heading inside an unclosed sample",
    );
    assert(
      mapped.problem === `${NEUTRALISED_OPEN}md`,
      `problem: an unclosed sample keeps its own lines as the statement — the guard is for the author's markdown, not kept sample text (got ${JSON.stringify(mapped.problem)})`,
    );
  }
}

process.exit(specExit());
