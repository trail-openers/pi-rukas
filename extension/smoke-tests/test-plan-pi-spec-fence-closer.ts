#!/usr/bin/env bun
/**
 * #2171 — the two pi-spec readers agree on ONE closing fence.
 *
 * `plan-pi-spec-descriptor.ts`'s section walker and `lean/spec.ts`'s strips judge
 * the same drafted bytes, and `lean/spec.ts` exports `closesFenceRun` precisely so
 * no second regex can drift from it. Where they disagree the same body reads two
 * ways: a tab-closed sample the walker kept open left its quoted
 * `## Acceptance criteria` line as section text that ended the walk early — zero
 * bullets, a legitimate shape, so `piSpecFromDraft` filed NO machine block at all,
 * silently — while `stripPiSpecBlocks` (which trims the tail) had already called
 * that same block terminated and stripped it from the oracle seat.
 *
 * Split from `test-plan-pi-spec-problem.ts` by the AGENTS.md §12 file-size cap.
 */
import { closesFenceRun } from "../src/lean/spec.ts";
import { descriptorProblem, sectionLines } from "../src/plan-pi-spec-descriptor.ts";
import { piSpecFromDraft } from "../src/plan-pi-spec.ts";
import { assert, specExit } from "./lib/plan-pi-spec-fixture.ts";

// A closer's trailing whitespace is stripped by CommonMark, so a tab after the run
// is as much a closer as a space — the rule `lean/spec.ts`'s `closesFenceRun`
// callers judge by (`fencedBlocks` TRIMS everything after the run, so a tab-closed
// pi-spec block is a block there and is stripped from what the oracle seat is
// shown). The tails sit at column 0 deliberately: an INDENTED closer is the
// separate 0–3 bound (pinned in the sibling file), and a tab is whitespace, so an
// indented tab would test that rule and not this one.
for (const [name, closer] of [
  ["tab", "```" + "\t"],
  ["tab then spaces", "```" + "\t  "],
] as const) {
  const mapped = piSpecFromDraft({
    type: "feature",
    title: "a title",
    body: [
      "## Acceptance criteria",
      "",
      "- one",
      "```md",
      "## Acceptance criteria",
      "- the check runs before the draw",
      closer,
      "- two",
    ].join("\n"),
  });
  assert(
    mapped !== undefined && mapped.criteria.map((c) => c.text).join(",") === "one,two",
    `problem: a sample closed by a ${name} tail is sample text, so the section keeps its bullets and the block is filed (got ${mapped === undefined ? "NO BLOCK — the whole spec was dropped" : JSON.stringify(mapped.criteria.map((c) => c.text))})`,
  );
  const truncatingBody = (c: string): string =>
    "## Context & motivation\n\n```md\n## Acceptance criteria\n" +
    c +
    "\n\nthe real statement\n\n## Acceptance criteria\n\n- a\n";
  assert(
    descriptorProblem(truncatingBody(closer)) === "the real statement",
    `problem: a sample closed by a ${name} tail cannot truncate the section (got ${JSON.stringify(descriptorProblem(truncatingBody(closer)))})`,
  );
}

// The AGREEMENT, pinned rather than assumed. Each row carries the opener, the
// closer, and the run plus its opener's char and length that `closesFenceRun` is
// asked about, so the rule judges the same triple the walk does: a tab tail the
// rule accepts and a spaces-only pattern refuses is a swallowed sample, and a run
// shorter than its opener that this reader accepted and the rule refuses is a
// sample ended early, leaking its quoted `## ` heading as a section boundary. The
// sentinel sits BELOW the closer, and the verdict is taken from the sentinel's OWN
// tag rather than from its mere presence: when a sample is closed the walker jumps
// it and the sentinel comes back as the author's markdown (`false`); when it is not
// closed the walk keeps the sample's lines and reports them as kept sample text
// (`true`). Asking "did the sentinel appear at all" would be true under both readings
// and could not fail, which is what keeps this a cross-reader pin and not a
// tautology.
const SENTINEL = "sentinel below the sample";
for (const [name, opener, closer, run, openChar, openLen] of [
  ["plain", "```md", "```", "```", "`", 3],
  ["spaces", "```md", "```   ", "```", "`", 3],
  ["tab", "```md", "```" + "\t", "```", "`", 3],
  ["tab and spaces", "```md", "```" + "\t \t", "```", "`", 3],
  ["tilde, tab", "~~~md", "~~~" + "\t", "~~~", "~", 3],
  ["long opener, longer closer", "````md", "````" + "\t", "````", "`", 4],
  ["long opener, short closer", "````md", "```" + "\t", "```", "`", 4],
] as const) {
  const body = [
    "## Context & motivation",
    "",
    "Descriptor: the statement",
    opener,
    "## Acceptance criteria",
    "sample content",
    closer,
    "",
    SENTINEL,
    "",
    "## Acceptance criteria",
    "",
    "- a",
  ].join("\n");
  const closes = closesFenceRun(run, openChar, openLen);
  const lines = sectionLines(body, "Context & motivation");
  const sentinel = lines.find(([l]) => l === SENTINEL);
  const closed = sentinel !== undefined && !sentinel[1];
  assert(
    closed === closes,
    `cross-reader: the ${name} closer — this reader ${closed ? "closed" : "kept open"} the sample, lean/spec.ts's rule says it ${closes ? "closes" : "stays open"} (${JSON.stringify({ closer, closes, lines })})`,
  );
}

process.exit(specExit());
