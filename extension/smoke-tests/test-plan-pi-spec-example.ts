#!/usr/bin/env bun
/**
 * plan-pi-spec — a DRAFTED block is an example, never the contract (#1883).
 *
 * The adversarial finding this pins: if the drafted body already parsed as a
 * pi-spec — an angle item that QUOTES the ```pi-spec v1 format — the placer used to
 * skip its own block and the example, written to illustrate and not to promise,
 * became what the lean executor ran against. The rule now is that every drafted
 * `pi-spec v1` fence has its info string renamed to `pi-spec-example v1` before
 * ours is placed, and ours is ALWAYS placed. These assertions drive the renamer
 * directly and the placer through a quoted backtick and a quoted tilde example.
 *
 * Split from `test-plan-pi-spec.ts` by the AGENTS.md 12 file-size cap.
 */
import { parsePiSpec } from "../src/lean/spec.ts";
import {
  PI_SPEC_EXAMPLE_INFO,
  PI_SPEC_HEADING,
  neutraliseDraftedPiSpecFences,
  piSpecFromDraft,
  placePiSpecSection,
} from "../src/plan-pi-spec.ts";
import { assert, draftBody, specExit } from "./lib/plan-pi-spec-fixture.ts";
// -------------------- a drafted body that QUOTES the block never becomes the contract

{
  // An angle item that shows what a pi-spec block looks like used to WIN: the
  // body parsed, the placer deferred to it, and the example became the contract.
  const quoted = [
    "## Acceptance criteria",
    "",
    "- the parser reads the block",
    "- `bun test` is green",
    "",
    "## Example",
    "",
    "A block looks like this:",
    "",
    "~~~pi-spec v1",
    '{ "problem": "an example someone quoted", "criteria": [], "size": "S" }',
    "~~~",
    "",
  ].join("\n");
  const placed = placePiSpecSection(quoted, "feature", "our real title");
  assert(
    placed.omitted === undefined,
    "example: our block is placed even when the body quotes one",
  );
  assert(
    /~{3,}pi-spec v1-example/.test(placed.body) &&
      placed.body.indexOf(PI_SPEC_EXAMPLE_INFO) > placed.body.indexOf(PI_SPEC_HEADING),
    "example: the drafted example's info string is renamed, so it is prose not contract",
  );
  const parsed = parsePiSpec(placed.body);
  assert(
    parsed.ok === true &&
      parsed.spec.problem === "our real title" &&
      parsed.spec.criteria.length === 2,
    "example: what FILES is our spec, not the quoted example",
  );
  assert(
    placed.body.indexOf(PI_SPEC_HEADING) < placed.body.indexOf(PI_SPEC_EXAMPLE_INFO),
    "example: our block sits above the renamed example, which stays where the draft put it",
  );
  // The renamer alone, on the shapes the fence reader accepts: either char, any
  // indent 0–3, any run length, trailing spaces.
  const shapes = [
    "```pi-spec v1",
    "~~~pi-spec v1",
    "   ``` pi-spec v1  ",
    "````pi-spec v1",
    "# pi-spec v1",
    "```pi-spec-example v1",
  ].join("\n");
  const renamed = neutraliseDraftedPiSpecFences(shapes).split("\n");
  const at = (n: number): string => renamed[n] ?? "";
  assert(
    at(0) === "```pi-spec v1-example" &&
      at(1) === "~~~pi-spec v1-example" &&
      at(2).startsWith("   ```") &&
      at(2).endsWith("pi-spec v1-example") &&
      at(3) === "````pi-spec v1-example",
    "renamer: either fence char, ≤3 spaces of indent, any run length, trailing spaces",
  );
  assert(
    at(4) === "# pi-spec v1" && at(5) === "```pi-spec-example v1",
    "renamer: prose and an already-renamed example are left alone",
  );
}

{
  const snippet = ["```", "const x = 1;", "````"].join("\n");
  const body = placePiSpecSection(
    draftBody([`the module prints ${snippet} when run`, "and `bun test` is green"]),
    "feature",
    "fenced criterion",
  ).body;
  const parsed = parsePiSpec(body);
  assert(parsed.ok === true, "round-trip: a criterion with a multi-line ``` snippet parses");
  assert(
    parsed.ok === true &&
      parsed.spec.criteria.length === 2 &&
      parsed.spec.criteria[1]?.command === "bun test",
    "round-trip: the fenced criterion does not swallow its neighbour",
  );
  // A bullet that carries a whole fenced CODE BLOCK (its fences on lines of their
  // own) collapses to the block's opening line once every line is flattened — so
  // assert on a criterion that SURVIVES flattening, and on the fenced one's
  // fences: what matters is that the multi-line snippet can neither break the
  // block's own fence nor swallow the criterion after it (both asserted above).
  assert(
    parsed.ok === true &&
      parsed.spec.criteria.every((c) => !/(`{3,}|~{3,})/.test(c.text)) &&
      parsed.spec.criteria.every(
        (c) => c.command === undefined || !/(`{3,}|~{3,})/.test(c.command),
      ),
    "round-trip: no embedded field carries a fence run the reader could reopen",
  );
  assert(
    placePiSpecSection(draftBody(["prints `const x = 1;` inline"]), "feature", "t").body.includes(
      "const x = 1;",
    ),
    "round-trip: inline code inside a criterion survives neutralisation verbatim",
  );
}

console.log(`${specExit() === 0 ? "PASS" : "FAIL"} test-plan-pi-spec`);
process.exit(specExit());
console.log(`${specExit() === 0 ? "PASS" : "FAIL"} test-plan-pi-spec-example`);
process.exit(specExit());
