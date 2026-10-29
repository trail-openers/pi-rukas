#!/usr/bin/env bun
/**
 * lean/spec — the pi-spec v1 contract.
 *
 * Three things are pinned here, and each is a distinct kind of failure the
 * driver must be able to tell apart:
 *
 *   - parse: the block is found, unique, parseable, and shaped right. "No
 *     block", "two blocks", "invalid JSON" and "wrong type" are FOUR distinct
 *     reasons, because an operator fixing an issue needs to know which one.
 *   - readiness: the rules a well-formed spec can still fail. Each rule gets
 *     its own case, so a rule nobody implemented cannot hide behind a
 *     neighbouring rule that fires on the same fixture.
 *   - render: `parsePiSpec(renderPiSpec(s))` returns `s`. /plan writes the
 *     block with this renderer and /work-lean reads it with that parser, so a
 *     drift between the two files a run at the worst possible moment.
 */

import {
  type PiSpec,
  parsePiSpec,
  readPiSpecBlockInfo,
  readiness,
  renderPiSpec,
} from "../src/lean/spec.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The reason a rejected parse gave, or "" when it did not reject. The
 * discriminated union is narrowed once, here, instead of at every call site:
 * the alternative is a non-null assertion per assertion, which is the kind of
 * cast that silently passes when the parse succeeded and compared undefined
 * against a string.
 */
function reasonOf(body: string): string {
  const r = parsePiSpec(body);
  return r.ok ? "" : r.reason;
}

const SPEC: PiSpec = {
  problem: "the engine re-runs completed steps",
  criteria: [
    { id: "AC1", text: "a completed step never re-runs", verify: "test" },
    { id: "AC2", text: "the full suite passes", verify: "command", command: "bun test" },
  ],
  scope: { paths: ["extension/src/lean/engine.ts"], out: ["extension/src/work-driver.ts"] },
  size: "M",
};

const withBlock = (json: string): string =>
  `## Context\n\n\`\`\`pi-spec v1\n${json}\n\`\`\`\n\nprose after`;
const valid = (): string => withBlock(JSON.stringify(SPEC, null, 2));

// ── parse: the happy path and the four distinct failures ───────────────────

const ok = parsePiSpec(valid());
assert(ok.ok === true, "a well-formed block parses");
if (ok.ok) {
  assert(ok.spec.problem === SPEC.problem, "problem survives the round trip");
  assert(ok.spec.criteria.length === 2, "both criteria survive");
  assert(ok.spec.criteria[1]?.command === "bun test", "a command criterion keeps its command");
  assert(ok.spec.scope?.out?.[0] === "extension/src/work-driver.ts", "scope.out survives");
  assert(ok.spec.size === "M", "size survives");
}

assert(
  reasonOf("no block here at all") === "no pi-spec v1 block",
  "absent block is its own reason",
);
assert(
  reasonOf(`${valid()}\n\n${valid()}`) === "2 pi-spec v1 blocks, expected at most 1",
  "two blocks is its own reason",
);
const badJson = parsePiSpec(withBlock("{not json"));
assert(
  badJson.ok === false && badJson.reason.startsWith("pi-spec v1 block is not valid JSON"),
  "invalid JSON is its own reason",
);
const wrongType = parsePiSpec(withBlock(JSON.stringify({ ...SPEC, size: 7 })));
assert(
  wrongType.ok === false && wrongType.reason === 'spec.size must be one of "S", "M", "L"',
  "a wrong type is its own reason",
);
assert(parsePiSpec(withBlock("[1,2]")).ok === false, "a JSON array is not a spec");
assert(
  reasonOf("```pi-spec\n{}\n```") === "no pi-spec v1 block",
  "an info string without the version is not the block",
);
assert(reasonOf(withBlock("")) === "pi-spec v1 block is empty", "an empty block says so");
assert(
  reasonOf('```pi-spec v1\n{"problem": "unclosed"') === "no pi-spec v1 block",
  "an unterminated fence is no block at all, not broken JSON",
);
// A truncated body whose EARLIER fence closed still reaches the JSON parser,
// and an operator told "invalid JSON" there goes looking for a typo that is
// not there — the body was simply cut off mid-JSON. (A body cut off before its
// FIRST fence is the other case, and it says "no pi-spec v1 block".)
assert(
  reasonOf(
    [
      "prose",
      "",
      "```pi-spec v1",
      '{"problem": "truncated",',
      '"criteria": [',
      "```",
      "",
      "prose after the spec",
      "",
      "```sh",
      "npm test",
    ].join("\n"),
  ).startsWith("pi-spec v1 block is not valid JSON: the fence it sits in was never closed"),
  "a truncated trailing fence is named as truncation, not as a broken byte",
);
// ...and the spec is genuinely read when every fence closed, so the new
// reason cannot become a catch-all that hides a parseable block.
assert(
  parsePiSpec(
    [
      "prose",
      "",
      "```pi-spec v1",
      JSON.stringify(SPEC),
      "```",
      "",
      "prose",
      "",
      "```sh",
      "npm test",
      "```",
    ].join("\n"),
  ).ok === true,
  "the same body with its trailing fence closed parses",
);
// Tildes and indentation are legal CommonMark; a spec written by hand uses them.
assert(
  parsePiSpec(`\`\`\`pi-spec v1\n${JSON.stringify(SPEC)}\n\`\`\``).ok === true,
  "compact JSON parses",
);
assert(
  readPiSpecBlockInfo(valid()) === "pi-spec v1",
  "the info string the renderer emits is the one we read",
);

// ── readiness: one case per rule ───────────────────────────────────────────

assert(readiness(SPEC).length === 0, "the fixture spec is ready");
assert(
  readiness({ ...SPEC, criteria: [] }).join() === "no acceptance criteria",
  "zero criteria fails",
);
assert(
  readiness({
    ...SPEC,
    criteria: [
      { id: "AC1", text: "t", verify: "test" },
      { id: "AC1", text: "u", verify: "test" },
    ],
  }).some((r) => r.includes("criterion AC1: duplicate id")),
  "duplicate ids fail — and say it once, not twice",
);
assert(
  readiness({ ...SPEC, criteria: [{ id: "accept-1", text: "t", verify: "test" }] }).some((r) =>
    r.includes("does not match"),
  ),
  "an id that is not AC\\d+ fails",
);
assert(
  readiness({ ...SPEC, criteria: [{ id: "AC01", text: "t", verify: "test" }] }).length === 0,
  "AC01 matches — the rule is the pattern, not a taste",
);
assert(
  readiness({ ...SPEC, criteria: [{ id: "AC1", text: "t", verify: "vibes" as "test" }] }).some(
    (r) => r.includes('verify "vibes" is not a valid kind'),
  ),
  "an unknown verify kind fails",
);
assert(
  readiness({ ...SPEC, criteria: [{ id: "AC1", text: "t", verify: "command" }] }).some((r) =>
    r.includes("must carry a non-empty command"),
  ),
  "a command criterion with no command fails",
);
assert(
  readiness({
    ...SPEC,
    criteria: [{ id: "AC1", text: "t", verify: "command", command: "  " }],
  }).some((r) => r.includes("must carry a non-empty command")),
  "a whitespace-only command fails too",
);
assert(
  readiness({ ...SPEC, criteria: [{ id: "AC1", text: "t", verify: "manual" }] }).length === 0,
  "a manual criterion needs no command",
);
assert(
  readiness({ ...SPEC, size: "L" }).join() === "size L is too large for one run — split it",
  "size L says split it, in as many words",
);
assert(readiness({ ...SPEC, size: "S" }).length === 0, "size S is ready");

// ── render: the round trip ─────────────────────────────────────────────────

const rendered = renderPiSpec(SPEC);
assert(
  rendered.startsWith("```pi-spec v1\n") && rendered.endsWith("\n```"),
  "the fence carries the exact info string",
);
const reparsed = parsePiSpec(`preamble\n\n${rendered}\n\ntrailing`);
assert(reparsed.ok === true, "what the renderer writes, the parser reads");
if (reparsed.ok)
  assert(
    JSON.stringify(reparsed.spec) === JSON.stringify(SPEC),
    "the round trip is byte-identical in field order and value",
  );
// A spec whose own text contains a fence is the case a naive renderer breaks.
const tricky: PiSpec = {
  problem: 'a problem that mentions ```pi-spec v1 and "quotes"',
  criteria: [{ id: "AC1", text: "backtick `code` stays", verify: "test" }],
  size: "S",
};
const trickyBack = parsePiSpec(renderPiSpec(tricky));
assert(
  trickyBack.ok === true && JSON.stringify(trickyBack.spec) === JSON.stringify(tricky),
  "a spec containing fence-like text round-trips",
);
// An optional field is absent, not null: `scope` omitted must stay omitted.
const noScope = parsePiSpec(
  renderPiSpec({ problem: "p", criteria: [{ id: "AC1", text: "t", verify: "test" }], size: "S" }),
);
assert(
  noScope.ok === true && noScope.spec.scope === undefined,
  "an omitted scope stays omitted through render",
);

process.exit(exit);
