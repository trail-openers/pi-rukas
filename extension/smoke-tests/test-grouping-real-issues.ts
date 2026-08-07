#!/usr/bin/env bun
/**
 * #376 — the grouping rules, run against REAL issue bodies.
 *
 * The existing grouping tests use synthetic fixtures written to match the
 * regexes, so all four rules passed while four of them did nothing on the
 * actual backlog. These fixtures are `gh issue view --json number,title,body`
 * captured verbatim from this repo's own issues, which is the only input shape
 * that could have caught:
 *
 *   - R3/R4 seeing one line of compact JSON (so `^` under /m never matched),
 *   - R3's literal not being the sentence anyone writes,
 *   - R4 needing `[tag]` where /plan mandates `feat: ` prefixes,
 *   - R2 demanding a directory component where issues write `module.ts:1274`.
 *
 * Measured before the fix: R3 fired on 0 of 7; path extraction returned 0 for
 * 5 of 7.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { groupIssues } from "../src/work-driver-grouping.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "issues");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * Rebuild exactly what `commands.ts` now hands `groupIssues`: the PARSED
 * title + body, not the raw `--json` stdout. If this helper and the production
 * assembly ever diverge, this whole file stops testing production.
 */
function bodyFor(n: number): string {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES, `${n}.json`), "utf8")) as {
    title?: string;
    body?: string;
  };
  return `title: ${raw.title ?? ""}\n${raw.body ?? ""}`;
}

const ALL = [279, 287, 288, 289, 290, 366, 368, 341];
const bodies: Record<number, string> = {};
for (const n of ALL) bodies[n] = bodyFor(n);

// Sanity: the fixtures must actually contain multi-line bodies, or every
// assertion below would be vacuous.
assert(
  ALL.every((n) => (bodies[n] ?? "").split("\n").length > 20),
  "fixtures carry real multi-line bodies (not the single-line JSON blob)",
);

// ------------------------------------------------------------------ R3

{
  // Every one of these issues ends with the standing split sentence.
  const res = groupIssues([287, 289, 290], bodies);
  const splitNote = res.notes.find((x) => x.startsWith("R3 split:"));
  assert(splitNote !== undefined, "R3 fires on real issues — it fired on ZERO of 7 before the fix");
  assert(
    Object.keys(res.groups).length === 3,
    "issues marked split stay in their own groups regardless of overlap",
  );
}
{
  // The regression this locks: the sentence people actually write.
  const res = groupIssues([287, 288], {
    287: "title: x\n\nThis work must ship as its own separate PR, independent of any other open issue.",
    288: "title: y\n\nnothing special here",
  });
  assert(
    (res.notes.find((x) => x.startsWith("R3 split:")) ?? "").includes("#287"),
    "R3 matches 'This work must ship as its own separate PR' — the real phrasing",
  );
}
{
  const res = groupIssues([1, 2], {
    1: "title: a\n\nSplit: true\n",
    2: "title: b\n\nnothing",
  });
  assert(
    (res.notes.find((x) => x.startsWith("R3 split:")) ?? "").includes("#1"),
    "the original `Split: true` form still works (no regression)",
  );
}
{
  const res = groupIssues([1, 2], {
    1: "title: a\n\nThese two changes are independent of each other.",
    2: "title: b\n\nalso independent",
  });
  assert(
    res.notes.find((x) => x.startsWith("R3 split:")) === undefined,
    "bare 'independent' still does NOT trigger a split (the #312 false-positive magnet stays removed)",
  );
}

// ------------------------------------------------------------------ R4

{
  // #287 is `feat(work-driver): …`, #290 is `feat(plan): …` — different
  // scopes, so they must NOT be unioned by R4.
  const res = groupIssues([287, 290], bodies);
  const r4 = res.notes.find((x) => x.startsWith("R4 subsystem:"));
  assert(r4 === undefined, "different conventional-commit scopes are not unioned");
}
{
  const res = groupIssues([1, 2], {
    1: "title: fix(work-driver): first thing\n\nbody",
    2: "title: fix(work-driver): second thing\n\nbody",
  });
  assert(
    (res.notes.find((x) => x.startsWith("R4 subsystem:")) ?? "").includes("work-driver"),
    "R4 reads the conventional-commit scope — /plan titles can never carry a leading [tag]",
  );
}
{
  const res = groupIssues([1, 2], {
    1: "title: [frontend] one\n\nbody",
    2: "title: [frontend] two\n\nbody",
  });
  assert(
    (res.notes.find((x) => x.startsWith("R4 subsystem:")) ?? "").includes("frontend"),
    "the original [tag] form still works (no regression)",
  );
}

// ------------------------------------------------------------------ R2

{
  // Bare `module.ts:NNN` is how these issues actually cite code.
  const res = groupIssues([1, 2], {
    1: "title: a\n\nSee work-driver.ts:1274 and commands.ts:262 for the shape.",
    2: "title: b\n\nAlso work-driver.ts:1290 plus commands.ts:300.",
  });
  assert(
    res.notes.some((x) => x.startsWith("R2 path-overlap:")),
    "R2 fires on bare module.ts:NNN anchors — it extracted 0 paths from 5 of 7 issues before",
  );
}
{
  // Precision: a prose mention with no line anchor is not a citation.
  const res = groupIssues([1, 2], {
    1: "title: a\n\nWe should probably rewrite commands.ts at some point.",
    2: "title: b\n\nAnd commands.ts is getting long too.",
  });
  assert(
    !res.notes.some((x) => x.startsWith("R2 path-overlap:")),
    "an unanchored prose mention of a file does NOT count as a path reference",
  );
}
{
  const res = groupIssues([1, 2], {
    1: "title: a\n\nTouches extension/src/foo.ts and extension/src/bar.ts",
    2: "title: b\n\nTouches extension/src/foo.ts and extension/src/bar.ts",
  });
  assert(
    res.notes.some((x) => x.startsWith("R2 path-overlap:")),
    "directory-qualified paths still work (no regression)",
  );
}

// ------------------------------------------------------------------ R1

{
  const res = groupIssues([1, 2], {
    1: "title: a\n\nDepends-on: #2\n",
    2: "title: b\n\nbody",
  });
  assert(Object.keys(res.groups).length === 1, "R1 link markers still union (no regression)");
}

{
  // Truthfulness. #287 is split-marked AND shares the `work-driver` scope with
  // #366/#368, so its R4 unions are blocked. They must not be reported as
  // fired: notes are the only explanation of why grouping decided what it did,
  // and ones the operator cannot trust are worse than none.
  const res = groupIssues([287, 366, 368], bodies);
  const r4 = res.notes.filter((x) => x.startsWith("R4 subsystem:"));
  assert(
    r4.every((x) => !x.includes("#287")),
    "a split-blocked union is NOT reported as having fired",
  );
  assert(
    r4.some((x) => x.includes("#366") && x.includes("#368")),
    "...while the union that did happen still is",
  );
}

// ------------------------------------------------- the whole backlog

{
  // The realistic shape: fire the grouper at the actual open backlog and
  // assert it produces *some* signal rather than silently degrading to R5.
  const res = groupIssues(ALL, bodies);
  assert(res.notes.length > 0, "grouping the real backlog produces at least one fired rule");
  assert(
    Object.values(res.groups).every((g) => g.issues.length > 0),
    "every group is non-empty",
  );
  assert(
    Object.values(res.groups).flatMap((g) => g.issues).length === ALL.length,
    "every issue lands in exactly one group",
  );
  console.log(`  (rules fired: ${res.notes.join("; ") || "none"})`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
