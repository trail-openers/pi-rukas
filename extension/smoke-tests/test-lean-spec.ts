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
  hasSurvivingSpecShapedFence,
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

  // The shapes that are NOT the block: unterminated fences of every flavour, an
  // info string that merely starts with the spec info, a fence too deeply indented
  // to open one, and a closer too short to close it. Each keeps a sentinel line a
  // strip that ate too much would lose — and the unterminated ones are the cases an
  // eat-to-end strip fails, cutting the body at its opener instead of keeping the
  // prose a truncated draft still has.
  const sentinel = "SENTINEL-line";
  const notBlocks: [string, string][] = [
    ["unterminated", `\`\`\`pi-spec v1\n${JSON.stringify(SPEC)}\n${sentinel}`],
    // An unterminated fence whose info is NOT the spec info: still not a block, so
    // still whole — the same claim as the case above, on the shape whose `## `
    // heading is a quoted sample rather than a real section.
    [
      "unterminated non-spec fence",
      "prose\n```md\n## Acceptance criteria\n" + sentinel,
    ],
    ["body ends mid-fence", "line one\n```md\n" + sentinel],
    ["two openers, neither closed", "```a\nfirst\n```b\n" + sentinel],
    ["info with extra text", `\`\`\`pi-spec v1 extra\n${sentinel}\n\`\`\``],
    // Four spaces of indent is outside CommonMark's 0–3: not a fence, so the
    // "closer" is prose and the body is untouched.
    ["indented 4 spaces", `    \`\`\`pi-spec v1\n${sentinel}\n    \`\`\``],
    // A run shorter than the opener never closes it, so the block is unterminated
    // and — like any unterminated fence — stays whole. The shape that separates a
    // reader that tracks the run's LENGTH from one that only looks for a fence line,
    // and `plan-pi-spec-descriptor.ts`'s section walker judges the same bytes.
    ["closer too short", `\`\`\`\`pi-spec v1\n${sentinel}\n\`\`\``],
    ["closer too short, non-spec", "````md\n" + sentinel + "\n````"],
    // A fence that opened for another info string and closed clean: the pi-spec
    // text inside it is content of THAT block, not a spec of its own.
    ["other info string", `\`\`\`json\npi-spec v1\n${sentinel}\n\`\`\``],
    // A quoted heading inside a non-spec sample survives exactly where it was
    // found: the strip never rescues a body whose other reader mis-reads a fence,
    // which is why that reader has to get the rule right on its own.
    [
      "quoted heading in a sample",
      "## Context & motivation\n\n```md\n## Acceptance criteria\n```\n\n" + sentinel,
    ],
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

  // The predicate `lean/issue-prose.ts` uses to refuse a section that would reprint
  // the contract, judged on the body the CALLER actually hands it — the stripped one
  // (`issue-prose.ts` calls it on `stripPiSpecBlocks(body)`), so every row below is a
  // body that still carries its fences.
  //
  // It is a FENCE-SHAPE test, not a substring test over the body: two rows differ only
  // in whether the string sits on an opening fence line, and a whole-body `includes`
  // would answer them the same way — the bug that silently dropped the issue section
  // for any `/plan` body that quoted the block format in its own prose.
  //
  // Shape alone is not enough either. A predicate that reads lines one at a time cannot
  // tell an OPENING fence from a line that merely looks like one, so it refuses the
  // WHOLE section for text the strip kept as another fence's CONTENT — and the strip
  // keeps such a line precisely when the closer is SHORTER than the opener (a real
  // block, so `parsePiSpec` reads it and the run has real criteria). `short-closer`
  // below is that body: the old line-by-line test called its quoted `pi-spec v1` line
  // an opener, and the builder silently lost its tail requirement on an issue that is
  // well-formed — the same silent-empty-section failure #2228 exists to close.
  const TAIL_REQ = "TAIL requirement.";
  const specBlock = (info = SPEC_INFO, closer = "```", fence = "```", indent = ""): string =>
    `${indent}${fence}${info}\n${JSON.stringify(SPEC, null, 2)}\n${indent}${closer}`;
  for (const [name, body, want] of [
    ["look-alike fence (info has extra text)", "```pi-spec v1 extra\nkeep\n```", true],
    ["look-alike tilde fence", "~~~pi-spec v1 draft\nkeep\n~~~", true],
    ["indented look-alike fence", "   ```pi-spec v1 extra\nkeep\n   ```", true],
    ["prose that quotes the format", "A `pi-spec v1` block summarises it.\n\nTAIL requirement.", false],
    ["a json fence whose CONTENT mentions it", "```json\npi-spec v1\n```", false],
    ["prose with no fence at all", "Nothing shaped like a fence here.", false],
    // The red row: a 4-backtick block whose 3-backtick closer is too short to close
    // it, so `pi-spec v1 extra` is CONTENT of that block (`parsePiSpec` reads the spec,
    // the strip keeps the sample whole) and nothing here reopens the contract.
    [
      "a look-alike inside a fence its closer is too short to close",
      `${specBlock("md", "\`\`\`", "\`\`\`\`")}\n\n${TAIL_REQ}`,
      false,
    ],
    // A `pi-spec v1` line quoted inside a tilde sample is that sample's content.
    [
      "a spec line inside a tilde sample",
      `~~~md\n${SPEC_INFO}\n~~~\n\n${TAIL_REQ}`,
      false,
    ],
    // An inline code span quoting the format, alone on its line — the same text as the
    // `prose that quotes the format` row above with one backtick each side, which is
    // what makes a shape-only line test get it wrong.
    [
      "an inline code span on its own line",
      `${TAIL_REQ}\n\n\`${SPEC_INFO} extra\``,
      false,
    ],
    // The positive control beside the red row: the same 4-backtick look-alike at depth
    // 0, with a closer long enough to close it, IS a second spec block and does refuse.
    [
      "a genuine 4-backtick look-alike at depth 0",
      `\`\`\`\`${SPEC_INFO} extra\nkeep\n\`\`\`\`\n\n${TAIL_REQ}`,
      true,
    ],
    // The info has to be the spec info as a WHOLE WORD. `/plan` renames every drafted
    // `pi-spec v1` opener to `pi-spec v1-example` (`PI_SPEC_EXAMPLE_INFO` in
    // `plan-pi-spec.ts`) precisely so a body that QUOTES the block format stays prose,
    // so a `/plan`-filed body always carries such a fence beside the real block. A
    // prefix test counted it as a second spec and silently dropped the issue section
    // from every seat for every one of those bodies.
    [
      "the example fence /plan files a quoting body with",
      `${TAIL_REQ}\n\n\`\`\`${SPEC_INFO}-example\n${JSON.stringify(SPEC, null, 2)}\n\`\`\``,
      false,
    ],
    // …and the positive control: a glued suffix is not an info string, so the shape
    // that genuinely carries a second contract still refuses.
    [
      "a spec-shaped fence with a real info string",
      `${TAIL_REQ}\n\n\`\`\`${SPEC_INFO} example\n${JSON.stringify(SPEC, null, 2)}\n\`\`\``,
      true,
    ],
  ] as const) {
    // Judged on BOTH bodies the predicate is ever handed. `lean/issue-prose.ts` calls
    // it on `stripPiSpecBlocks(body)`; the rows above are written as raw bodies, and a
    // strip that ate too much (or too little) would make the two readings disagree —
    // which is exactly the drift the strip's jsdoc says the two must not have.
    assert(
      hasSurvivingSpecShapedFence(body) === want &&
        hasSurvivingSpecShapedFence(stripPiSpecBlocks(body)) === want,
      `surviving-fence: a ${name} reads ${String(want)} on the raw and the stripped body (got ${String(hasSurvivingSpecShapedFence(body))} / ${String(hasSurvivingSpecShapedFence(stripPiSpecBlocks(body)))})`,
    );
  }
  assert(
    hasSurvivingSpecShapedFence(stripPiSpecBlocks(valid())) === false,
    "surviving-fence: a body whose real block was stripped carries no spec-shaped fence",
  );

  // A removed block takes ONE of its flanking blanks with it. A block is flanked by
  // blanks to be a block at all, so removing its three lines and nothing else left
  // the oracle seat a double blank inside the fence — a gap the issue never had, on
  // every body that carries a spec. Exactly one goes, and only when a blank still
  // survives on both sides of the removal, so `valid()`'s own trailing blank is the
  // one that goes. The three shapes below say what the rule is NOT — a general
  // whitespace trim that took a body's own blank run.
  const around = (before: string, after: string): string =>
    `${before}\n\n\`\`\`pi-spec v1\n${JSON.stringify(SPEC, null, 2)}\n\`\`\`\n${after}`;
  assert(
    stripPiSpecBlocks(around("prose before", "\nprose after")) ===
      "prose before\n\nprose after",
    "strip: a block flanked by blanks on both sides leaves one blank, not a double",
  );
  for (const [name, body, want] of [
    ["no blank before it", around("", "prose after"), "\n\nprose after"],
    ["no blank after it", around("prose before", "prose after"), "prose before\n\nprose after"],
    ["nothing after it", around("prose before", ""), "prose before\n"],
  ] as const) {
    assert(
      stripPiSpecBlocks(body) === want,
      `strip: with ${name} no blank is taken from the body (got ${JSON.stringify(stripPiSpecBlocks(body))})`,
    );
  }
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
