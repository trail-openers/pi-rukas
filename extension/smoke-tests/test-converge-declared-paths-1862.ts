/**
 * #1862 (c) — a declared deliverable path that is a GLOB, a DIRECTORY, or
 * annotated with a leading `new ` is matched against the diff instead of
 * compared literally.
 *
 * The field symptom: a deliverable declaring `"new tests/test_x*.py"` produced
 * `partial` (or `absent`, which caps at develop) although its files were all in
 * the diff — `convergeEvidence` compares declared paths literally, and
 * `normaliseDeclaredPath` stripped only a TRAILING parenthetical, so the leading
 * word made the slot name nothing.
 *
 * Driven through `classifyDeliverables`, the function whose verdict the gate
 * reports, and `declaredPathMatches`, the matcher the #819 plan-to-spec coverage
 * gate shares — the two must not disagree, which is the reason they share it.
 *
 * The four GLOB/DIRECTORY rows are REGRESSION rows, not new behaviour: today's
 * answers are pinned so a later loosening of the matcher cannot quietly turn a
 * `partial` into a false `implemented`. Only the leading-`new ` strip is new,
 * and the bare-directory row asserts behaviour that already existed.
 */

import { classifyDeliverables } from "../src/work-driver-converge-classify.ts";
import { declaredPathMatches } from "../src/work-driver-deliverable-paths.ts";
import { stripLeadingPathAnnotation } from "../src/declared-path-annotation.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

const DIFF = new Set(["tests/deep/a.py", "tests/test_x_foo.py", "docs/x.md", "src/a.ts"]);

function deliverable(id: string, paths: string[]) {
  return { id, description: `d ${id}`, paths };
}

function statusOf(paths: string[]): { status: string; reason: string } {
  const got = classifyDeliverables([deliverable("d1", paths)], DIFF);
  const d = got.deliverables[0];
  return { status: d?.status ?? "(none)", reason: d?.reason ?? "" };
}

// ────────────────────────────── 1. the field case: a leading `new ` no longer
// hides a satisfied deliverable. Each spelling is the one a spec author writes.
for (const [spelling, why] of [
  ["new tests/test_x*.py", "the issue's own fixture"],
  ["New tests/test_x*.py", "capitalised"],
  ["a new tests/test_x*.py", "with an article"],
  ["  new  docs/x.md  ", "loose whitespace"],
  ["new tests", "a bare directory behind the word"],
] as const) {
  const got = statusOf([spelling]);
  assert(
    got.status === "implemented",
    `${spelling} (${why}) is implemented, not partial (got ${got.status}: ${got.reason})`,
  );
  assert(
    declaredPathMatches(spelling, DIFF) === true,
    `and the shared matcher agrees for ${spelling}`,
  );
}

// ────────────────────────────── 2. the strip is a WORD rule, not a prefix rule
// — these are file names, and deleting their first token would delete a real
// directory or rename a real file.
for (const [name, expected] of [
  ["new-repo/README.md", "new-repo/README.md"],
  ["newline.ts", "newline.ts"],
  ["newman/test.ts", "newman/test.ts"],
  ["added/notes.md", "added/notes.md"],
  ["new", "new"],
] as const) {
  assert(
    stripLeadingPathAnnotation(name) === expected,
    `${JSON.stringify(name)} keeps its name (got ${JSON.stringify(stripLeadingPathAnnotation(name))})`,
  );
}

// ────────────────────────────── 3. REGRESSION ROWS — today's answers for the
// four glob/directory spellings against a diff containing `tests/deep/a.py`,
// pinned so the matcher cannot be loosened by accident. All four are the
// DIRECTORY reading (`dir/**` and `dir/*` mean the directory), and a bare
// `tests` is existing directory behaviour asserted, not changed.
for (const declared of ["tests/**", "tests/*", "tests", "tests/deep/**"]) {
  assert(
    declaredPathMatches(declared, DIFF) === true,
    `${declared} matches tests/deep/a.py (pinned today's answer)`,
  );
}

// A glob does NOT get the directory rule: `src/*` is one segment, so a file two
// segments down is not a match. Widening this is the false pass that would
// satisfy a deliverable about one directory with work in another.
// A glob does NOT get the directory rule — and this is the row that pins it.
// `src/**` reads as the DIRECTORY `src` (the fence grammar's reading, which
// `stripFenceGlob` collapses `dir/**` and `dir/*` to), and `src/*` reads as ONE
// segment. Neither matches a file two segments down, which is the false pass
// the matcher's header refuses: a deliverable about one directory must not be
// satisfied by work in another. `tests/deep/**` above is the same rule one
// level deeper, and it fires because its directory IS in the diff.
assert(
  declaredPathMatches("src/*", new Set(["src/a/b.ts"])) === false,
  "a single-segment glob never gets the directory rule (src/* vs src/a/b.ts)",
);
assert(
  declaredPathMatches("src/**", new Set(["src/a/b.ts"])) === false,
  "and neither does the globstar spelling — the collapse is to the directory, not to a prefix match (src/** vs src/a/b.ts)",
);

// ────────────────────────────── 4. the strip cannot turn a MISS into a HIT:
// nothing in the diff under `tests/` named `z*`, so the deliverable is still not
// implemented however the slot is annotated.
for (const spelling of ["new tests/z*.py", "new tests/nope.py", "added docs/nope.md"]) {
  const got = statusOf([spelling]);
  assert(
    got.status !== "implemented",
    `${spelling} is still not implemented (got ${got.status}: ${got.reason})`,
  );
}

// ────────────────────────────── 5. the two gates still share one grammar: the
// #819 coverage gate reads slots through the same split, so a slot the converge
// gate can match is a slot the coverage gate sees identically.
{
  const annotated = "new tests/test_x*.py";
  const convergeSays = declaredPathMatches(annotated, DIFF);
  const coverageSays = classifyDeliverables([deliverable("d1", [annotated])], DIFF, {
    ws1: ["tests/test_x_1.py"],
  }).deliverables[0]?.status;
  assert(
    convergeSays === true && coverageSays === "implemented",
    `converge and the workstream-ownership arm agree on ${annotated} (matcher ${convergeSays}, verdict ${coverageSays})`,
  );
}

process.exit(exit);
