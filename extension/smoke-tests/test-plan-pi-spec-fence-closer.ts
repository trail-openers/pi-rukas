#!/usr/bin/env bun
/**
 * #2171 — the two pi-spec readers agree on ONE closing fence.
 *
 * `plan-pi-spec-descriptor.ts`'s section walker and `lean/spec.ts`'s strips judge
 * the same drafted bytes, and `lean/spec.ts` exports `closesFenceLine` precisely so
 * no second regex can drift from it — including the "nothing but whitespace after
 * the run" half, which each reader used to supply for itself. Where they disagree
 * the same body reads two ways: a tab-closed sample the walker kept open left its
 * quoted `## Acceptance criteria` line as section text that ended the walk early —
 * zero bullets, a legitimate shape, so `piSpecFromDraft` filed NO machine block at
 * all, silently — while `stripPiSpecBlocks` (which trims the tail) had already
 * called that same block terminated and stripped it from the oracle seat.
 *
 * Split from `test-plan-pi-spec-problem.ts` by the AGENTS.md §12 file-size cap.
 */
import { closesFenceLine, stripPiSpecBlocks } from "../src/lean/spec.ts";
import { descriptorProblem, sectionLines } from "../src/plan-pi-spec-descriptor.ts";
import { piSpecFromDraft } from "../src/plan-pi-spec.ts";
import { assert, specExit } from "./lib/plan-pi-spec-fixture.ts";

// A closer's trailing whitespace is stripped by CommonMark, so a tab after the run
// is as much a closer as a space — the rule `lean/spec.ts`'s `closesFenceLine`
// applies (it TRIMS everything after the run, so a tab-closed pi-spec block is a
// block there and is stripped from what the oracle seat is
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
// closer line, and the verdict the closing rule MUST give — written out here, not
// computed by calling the predicate under test, because an expected value taken from
// the function being checked is a gate that cannot fail. The other half of the
// comparison is what the walker actually did, read from the sentinel's OWN tag
// rather than from its mere presence: when a sample is closed the walker jumps it and
// the sentinel comes back as the author's markdown (`false`), while an unclosed
// sample keeps the sample's lines and reports them as kept sample text (`true`) — and
// asking "did the sentinel appear at all" would be true under both readings. A tab
// tail the rule accepts and a spaces-only pattern refuses is a swallowed sample; a
// run shorter than its opener that this reader accepted and the rule refuses is a
// sample ended early, leaking its quoted `## ` heading as a section boundary.
const SENTINEL = "sentinel below the sample";
for (const [name, opener, closer, wantCloses] of [
  ["plain", "```md", "```", true],
  ["spaces", "```md", "```   ", true],
  ["tab", "```md", "```" + "\t", true],
  ["tab and spaces", "```md", "```" + "\t \t", true],
  ["tilde, tab", "~~~md", "~~~" + "\t", true],
  ["long opener, longer closer", "````md", "````" + "\t", true],
  ["long opener, short closer", "````md", "```" + "\t", false],
  // The tails that are NOT whitespace. A closer carries no info string, so none of
  // these closes anything, and this is the class the shared rule exists for: a
  // reader that asked only "does a fence run start this line" closed the sample
  // here, took the sample's own `## Acceptance criteria` line for its boundary, read
  // zero bullets, and filed NO block at all, while `stripPiSpecBlocks` (which trims
  // the tail) called that same line content. Pinned rather than assumed, because
  // every whitespace-only tail above agrees under both the tail test and a `\s*$`
  // anchor, and so cannot distinguish them.
  ["non-whitespace tail: letter", "```md", "```x", false],
  ["non-whitespace tail: tab then letter", "```md", "```" + "\tx", false],
  ["non-whitespace tail: info string", "```md", "``` md", false],
  ["tilde, non-whitespace tail", "~~~md", "~~~x", false],
  // The line that separates a trimmed tail from a `\s*$` anchor, and the only one
  // that does. JS treats U+2028/U+2029 as LINE terminators, so `.` in the shared
  // pattern cannot match one — the tail never reaches `rest`, and `trim()` never
  // sees it — while `\s` does match it. So a closer written ` ``` ` + U+2028 is
  // content under the shared rule and a boundary under a local `\s*$` pattern: the
  // local one jumps the sample, hits the sample's own `## Acceptance criteria` as a
  // boundary, and the draft files nothing while the strip, agreeing with the shared
  // rule, left the block in the oracle seat. Every other row above agrees under both
  // spellings, which is exactly why this row is here.
  ["U+2028 after the run", "```md", "```" + "\u2028", false],
  ["U+2029 after the run", "~~~md", "~~~" + "\u2029", false],
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
  // The opener's own character and run length — what the closing rule is asked.
  const opened = /^(\`{3,}|~{3,})/.exec(opener)?.[1];
  if (opened === undefined) throw new Error(`the fixture opener ${opener} is not a fence`);
  const lines = sectionLines(body, "Context & motivation");
  const sentinel = lines.find(([l]) => l === SENTINEL);
  const closed = sentinel !== undefined && !sentinel[1];
  assert(
    closed === wantCloses,
    `cross-reader: the ${name} closer ${wantCloses ? "must close" : "must NOT close"} the sample — this reader ${closed ? "closed" : "kept it open"} (${JSON.stringify({ closer, wantCloses, lines })})`,
  );
  // …and the shared predicate agrees with the verdict this row states, so the two
  // readers cannot each be internally consistent and still disagree on the line.
  assert(
    closesFenceLine(closer, opened[0] as string, opened.length) === wantCloses,
    `cross-reader: lean/spec.ts's rule says the ${name} closer ${wantCloses ? "closes" : "stays open"}, matching this row (${JSON.stringify({ closer })})`,
  );
  // …and the STRIP agrees on that line, which is the other half of the claim: what
  // makes a disagreement expensive is that the oracle seat and the mapper read ONE
  // body two ways, so pinning the walker alone would let the strip drift back. A
  // `pi-spec` block closed by a non-closer is no block at all, so its own lines stay
  // in the text the adversary is shown — the same verdict the walk above gave.
  if (!wantCloses) {
    // The block is opened with the ROW's fence character and run length, so "this
    // line is not its closer" is the same question in both readers: the four-run row
    // really does stay whole (its short run is content), and an opener whose run is
    // long enough for the closer would be stripped by the shared rule while a reader
    // that refused the line kept it.
    const openRun = /^(\`{3,}|~{3,})/.exec(opener)?.[1];
    if (openRun === undefined) throw new Error(`the fixture opener ${opener} is not a fence`);
    const specBody = [
      "prose before",
      "",
      `${openRun}pi-spec v1`,
      "{}",
      closer,
      "prose after",
    ].join("\n");
    assert(
      stripPiSpecBlocks(specBody) === specBody,
      `cross-reader: stripPiSpecBlocks refuses the ${name} closer too, so a block closed only by that line survives in the oracle seat rather than being stripped by one reader and kept by the other (got ${JSON.stringify(stripPiSpecBlocks(specBody))})`,
    );
  }
}

process.exit(specExit());
