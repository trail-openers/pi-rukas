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
  SPEC_INFO,
  parsePiSpec,
  readPiSpecBlockInfo,
  readiness,
  renderPiSpec,
  stripPiSpecBlocks,
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

// ── stripPiSpecBlocks: the oracle seat's view of the same body (#2171) ──────
//
// The adversary prompts show the issue text and already print the criteria, so
// the block is stripped from what they render. The rule is `fencedBlocks`'
// closing rule and nothing looser: ONLY a terminated fence whose info is exactly
// `pi-spec v1` goes, and everything that merely resembles one survives byte for
// byte — including a truncated body, whose half-block is prose the reader still
// needs.
{
  const stripped = stripPiSpecBlocks(valid());
  assert(
    !stripped.includes(SPEC_INFO) &&
      !stripped.includes("pi-spec") &&
      stripped.includes("prose after") &&
      stripped.includes("## Context"),
    "strip: a terminated pi-spec block is removed and the prose around it survives",
  );
  assert(
    stripPiSpecBlocks("no block here\njust prose") === "no block here\njust prose",
    "strip: a body with no fence is returned byte-identical",
  );

  // The shapes that are NOT the block: an unterminated one, an info string that
  // merely starts with the spec info, a fence too deeply indented to open one,
  // and a closer too short to close it. Each keeps a sentinel line a strip that
  // ate too much would lose.
  const sentinel = "SENTINEL-line";
  const notBlocks: [string, string][] = [
    ["unterminated", `\`\`\`pi-spec v1\n${JSON.stringify(SPEC)}\n${sentinel}`],
    ["info with extra text", `\`\`\`pi-spec v1 extra\n${sentinel}\n\`\`\``],
    // Four spaces of indent is outside CommonMark's 0–3: not a fence, so the
    // "closer" is prose and the body is untouched.
    ["indented 4 spaces", `    \`\`\`pi-spec v1\n${sentinel}\n    \`\`\``],
    // A run shorter than the opener never closes it, so the block is unterminated
    // and — like any unterminated fence — stays whole.
    ["closer too short", `\`\`\`\`pi-spec v1\n${sentinel}\n\`\`\``],
    // A fence that opened for another info string and closed clean: the pi-spec
    // text inside it is content of THAT block, not a spec of its own.
    ["other info string", `\`\`\`json\npi-spec v1\n${sentinel}\n\`\`\``],
  ];
  for (const [name, body] of notBlocks) {
    assert(
      stripPiSpecBlocks(body) === body,
      `strip: a ${name} fence is left byte-identical (it is not the block)`,
    );
  }

  // A tilde fence whose info is exactly the spec info IS the block — CommonMark
  // allows either character — and an indented-within-0–3 one is too.
  for (const [name, body] of [
    ["tilde", `~~~pi-spec v1\n${sentinel}\n~~~`],
    ["indented 2", `  \`\`\`pi-spec v1\n${sentinel}\n  \`\`\``],
  ] as const) {
    const out = stripPiSpecBlocks(body);
    assert(
      !out.includes(SPEC_INFO) && !out.includes(sentinel),
      `strip: a ${name} spec block is the block and is removed (got ${JSON.stringify(out)})`,
    );
  }

  // A real block AND a look-alike: only the real one goes.
  const mixed = `${valid()}\n\n\`\`\`pi-spec v1 extra\nkeep me\n\`\`\``;
  const mixedOut = stripPiSpecBlocks(mixed);
  assert(
    mixedOut.includes("keep me") &&
      mixedOut.includes("pi-spec v1 extra") &&
      !mixedOut.includes("\`\`\`pi-spec v1\n"),
    "strip: with a real block and an info-with-extra look-alike, exactly the real one is dropped",
  );
  assert(
    parsePiSpec(stripPiSpecBlocks(valid())).ok === false,
    "strip: a stripped body has no block left to parse — the section is not a second contract",
  );
}

// ── the prose scan's view of a quoted `## ` line (#2171) ────────────────────
//
// A drafted body QUOTES markdown: an angle item that shows what an issue looks
// like puts a real `## Acceptance criteria` line inside a code sample. That one
// shape is what turns a defect in either reader into a whole dropped spec rather
// than a misread field — the slice stops at the quoted heading, `sectionBullets`
// answers "zero criteria", and `piSpecFromDraft` files no machine block at all,
// silently, with its title fallback sitting behind that zero-criteria return.
// The oracle seat's strip has to keep the body's shape whatever it removes, so
// the assertion is not "the prose reads X" but "the criteria were filed", which
// is the fact an operator notices.
{
  const sentinel = "SENTINEL-tail-line";
  // An unterminated fence is not a block, so none of these is removed: the
  // strip's whole contract for a truncated body is that it keeps its text.
  for (const [name, body] of [
    ["unterminated, prose after", "prose\n```md\n## Acceptance criteria\n" + sentinel],
    ["body ends mid-fence", "line one\n```md\n" + sentinel],
    ["two openers, neither closed", "```a\nfirst\n```b\n" + sentinel],
    ["closer too short to close", "````md\n" + sentinel + "\n```"],
  ] as const) {
    assert(
      stripPiSpecBlocks(body) === body,
      `strip-fences: an unterminated ${name} fence keeps every line (a strip that stopped at the opener would cut the body here) (got ${JSON.stringify(stripPiSpecBlocks(body))})`,
    );
  }

  // The strip leaves a quoted heading exactly where it found it, which is what
  // makes the criteria slice's fence-awareness the thing that has to get this
  // right — the strip is not the reader that can rescue a body from it.
  const quoted = "## Context & motivation\n\n```md\n## Acceptance criteria\n```\n\n" + sentinel;
  assert(
    stripPiSpecBlocks(quoted) === quoted,
    "strip-fences: a non-spec code sample is left byte-identical, quoted heading and all",
  );
}

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
