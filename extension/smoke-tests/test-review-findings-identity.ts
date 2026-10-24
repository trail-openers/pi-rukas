#!/usr/bin/env bun
/**
 * #1105 — the pure identity half of the per-branch review-findings memory:
 * anchor, titleClass, Jaccard and snippetHash, and the matching rule
 * (`pickMatch`) built from them. Split out of test-review-findings-store.ts
 * (#1764, AGENTS.md §12 file-size gate): the clone-backed round trip — the
 * store file, the 200-row cap, suppression, concurrent writers — stayed there.
 *
 * Nothing here touches git or the store: every assertion is a function of its
 * arguments, which is why the two halves can be separate files.
 */

import {
  type FindingIdentity,
  type MatchableRow,
  anchorAt,
  identityOf,
  jaccard,
  pickMatch,
  snippetHashAt,
  titleClassOf,
  titleTokens,
} from "../src/review-findings-match.ts";
import { SRC } from "./lib/review-findings-src-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── pure identity ───────────────────────────────────────────────────────────


assert(
  anchorAt(SRC, 4) === "alpha",
  "anchor: nearest declaration above the cited line is the enclosing function",
);
assert(anchorAt(SRC, 9) === "run", "anchor: a method declaration is found (run, not the class)");
assert(anchorAt(SRC, 1) === "file", "anchor: no declaration at or above the line → file");
assert(anchorAt(SRC, undefined) === "file", "anchor: no line → file");
const shifted = ["x", "y", ...SRC];
assert(anchorAt(shifted, 6) === "alpha", "anchor: a line shift keeps the same anchor");
assert(
  snippetHashAt(SRC, 4) === snippetHashAt(shifted, 6),
  "snippetHash: a positional ±2 window moves with its code, so a pure shift keeps the hash",
);
assert(
  snippetHashAt(SRC, 4) ===
    snippetHashAt(
      SRC.map((l) => l.replace(/ +/g, "  ")),
      4,
    ),
  "snippetHash: whitespace-normalised (runs of spaces collapse)",
);
assert(
  snippetHashAt(SRC, 4) !== snippetHashAt(SRC, 9),
  "snippetHash: different code, different hash",
);

assert(
  titleClassOf("The default timeout is not set") === titleClassOf("Timeout default set"),
  "titleClass: stopwords removed and tokens sorted, so word order and filler do not matter",
);
assert(titleTokens("the a of").length === 0, "titleTokens: stopword-only title yields no tokens");
assert(jaccard(["a", "b", "c"], ["a", "b", "d"]) === 0.5, "jaccard: 2 shared of 4 union = 0.5");
assert(jaccard([], ["a"]) === 0, "jaccard: an empty side is 0");

const mk = (title: string, line: number | undefined, lines: string[] = SRC) =>
  identityOf({ path: "src/a.ts", line, title }, lines);
const rowOf = (
  id: FindingIdentity,
  extra: Partial<MatchableRow> = {},
): MatchableRow & { title: string } => ({
  id: "deadbeef",
  path: id.path,
  anchor: id.anchor,
  titleClass: id.titleClass,
  title: id.title,
  snippetHash: id.snippetHash,
  lastSeen: 1,
  ...extra,
});

const base = mk("Division by zero possible", 4);
assert(
  pickMatch(mk("Division by zero possible", 6, shifted), [rowOf(base)]) !== undefined,
  "match: identical title after a line shift matches (same anchor, same titleClass)",
);
assert(
  pickMatch(mk("possible division by zero!", 4), [rowOf(base)]) !== undefined,
  "match: reworded title with the same tokens matches on titleClass",
);
assert(
  pickMatch(mk("Division by zero may occur", 4), [rowOf(base)]) === undefined,
  "match: a rewording below Jaccard 0.6 on the same snippet is a new finding, not the old row",
);
assert(
  pickMatch(mk("Unrelated logging issue", 3), [rowOf(base)]) === undefined,
  "match: an unrelated title on the same anchor and a different snippet does not match",
);
const otherAnchor = mk("Division by zero possible", 9);
assert(
  pickMatch(otherAnchor, [rowOf(base)]) === undefined,
  "match: a different anchor never matches",
);
const noLine = mk("Missing null check", undefined);
const noLine2 = mk("Hardcoded retry budget", undefined);
assert(noLine.anchor === "file" && !noLine.hasLine, "no-line finding: anchor file, hasLine false");
assert(
  pickMatch(noLine2, [rowOf(noLine)]) === undefined,
  "no-line finding: two different no-line findings in one file do NOT match on the empty snippet",
);
assert(
  pickMatch(mk("Missing null check", undefined), [rowOf(noLine)]) !== undefined,
  "no-line finding: the same title matches on titleClass",
);
const snippetOnly = mk("Completely different words here", 4);
assert(
  pickMatch(snippetOnly, [rowOf(base, { title: "zzz qqq", titleClass: "qqq zzz" })]) === undefined,
  "match: an equal snippetHash alone does not match when titles differ (a new row)",
);

const older = rowOf(base, { id: "00000001", lastSeen: 10 });
const newer = rowOf(base, { id: "00000002", lastSeen: 20, snippetHash: "other" });
assert(
  pickMatch(base, [older, newer])?.id === "00000001",
  "pick: an equal-snippet row beats a more recent row with a different snippet",
);
assert(
  pickMatch(mk("Division by zero possible", 4), [older, { ...older, id: "00000003", lastSeen: 30 }])
    ?.id === "00000003",
  "pick: among equal candidates the most recently seen wins",
);

process.exit(exit);
