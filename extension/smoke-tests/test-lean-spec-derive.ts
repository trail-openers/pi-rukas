#!/usr/bin/env bun
/**
 * lean/spec-derive — the one bounded child that turns prose into a contract (R3).
 *
 * What this file judges is the boundary, not the model: a child gets the issue's
 * TITLE and BODY fenced as untrusted data, its reply must contain a parsable
 * block, the block must survive `parsePiSpec(renderPiSpec(spec))` deep-equality
 * AND `readiness`, and every other outcome is a `handback` that names itself.
 *
 * Each handback reason is asserted to NAME its own cause, because a run that
 * handed back with "the child said no" tells the operator nothing about which
 * of the four failure shapes happened — and this suite would go green on one
 * reason string used for all four.
 *
 * The child seam is a function: production wires `spawnSpecialist`, and a case
 * hands in a reply. No model is called here.
 */

import {
  DERIVE_MAX_CRITERIA,
  SpecDeriveError,
  deriveSpec,
  deriveSpecForRun,
  extractDerivedSpec,
  parseDerivedBlock,
} from "../src/lean/spec-derive.ts";
import type { PiSpec } from "../src/lean/spec.ts";
import { parsePiSpec, readiness, renderPiSpec } from "../src/lean/spec.ts";
import type { DispatchResult } from "../src/types.ts";
import { deriveReply, specBlock } from "./lib/lean-spec-intake-fixtures.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    failed = 1;
  }
}

/** A clean child result carrying `text`. */
function reply(text: string): DispatchResult {
  return { role: "explore", ok: true, text, toolUses: [], exitCode: 0, ms: 10 };
}

/** A child that died. */
function dead(why = "exit 1"): DispatchResult {
  return { role: "explore", ok: false, text: "", toolUses: [], exitCode: 1, ms: 10, killCause: why };
}

const BULLETS = ["the run declines a no-block issue under require", "a derived spec is persisted"];

// ── The parser: one fenced block, read deterministically.
{
  const spec = extractDerivedSpec(deriveReply(BULLETS));
  assert(spec !== undefined, "a reply carrying a block yields a spec");
  assert(spec?.problem === "the problem", `the problem line survives (got ${spec?.problem})`);
  assert(
    spec?.criteria.length === 2 &&
      spec?.criteria[0]?.id === "AC1" &&
      spec?.criteria[1]?.id === "AC2",
    `criteria are numbered AC1… positionally (got ${JSON.stringify(spec?.criteria.map((c) => c.id))})`,
  );
  assert(
    spec?.criteria.every((c) => c.verify === "test") === true,
    "every derived criterion is verify: test — a child cannot make one executable",
  );
  assert(
    spec?.size === "S",
    `two criteria size S (got ${String(spec?.size)})`,
  );
  assert(spec?.scope === undefined, "a derived spec carries no scope");
}

// ── The render/parse round-trip is the gate, including a backtick run.
{
  const tricky = [
    "run ```bun test``` and it exits 0",
    "a criterion quoting ~~~~ still parses",
    "the field `spec.lean.specIntake` is validated",
  ];
  const spec = extractDerivedSpec(deriveReply(tricky, "fences inside `criteria`"));
  assert(spec !== undefined, "a reply whose bullets carry fence runs still yields a spec");
  if (spec !== undefined) {
    const rendered = renderPiSpec(spec);
    const back = parsePiSpec(rendered);
    assert(
      back.ok && JSON.stringify(back.spec) === JSON.stringify(spec),
      `parsePiSpec(renderPiSpec(spec)) deep-equals the spec (got ${back.ok ? "different" : back.reason})`,
    );
    assert(readiness(spec).length === 0, `…and readiness passes (got ${JSON.stringify(readiness(spec))})`);
    assert(
      !rendered.includes("```bun"),
      "the rendered block cannot be closed early by the bullet's own fence run",
    );
  }
}

// ── The cap: at most 12 criteria, and the size band counts the ORIGINAL set.
{
  const many = Array.from({ length: 20 }, (_, i) => `criterion number ${String(i + 1)}`);
  const spec = extractDerivedSpec(deriveReply(many));
  assert(spec !== undefined, "a 20-bullet reply yields a spec");
  assert(
    spec?.criteria.length === DERIVE_MAX_CRITERIA,
    `at most ${DERIVE_MAX_CRITERIA} criteria ride in the block (got ${String(spec?.criteria.length)})`,
  );
  assert(
    spec?.size === "L",
    `…but size counts the original 20, so it is honestly L (got ${String(spec?.size)})`,
  );
}

// ── The parser refuses the shapes that are not a contract.
for (const [text, needle, label] of [
  ["no block at all, just prose", "no", "no block"],
  [`a\n\n${specBlock(BULLETS, "one")}\n\n${specBlock(BULLETS, "two")}`, "2", "two blocks"],
  ["```pi-spec v1\nnot json\n```", "JSON", "broken JSON"],
  ["```pi-spec v1\n[]\n```", "object", "a JSON array"],
  [
    "```pi-spec v1\n" + JSON.stringify({ problem: "", criteria: [], size: "S" }) + "\n```",
    "problem",
    "an empty problem",
  ],
] as const) {
  let threw: unknown;
  let got: PiSpec | undefined;
  try {
    got = parseDerivedBlock(text);
  } catch (err) {
    threw = err;
  }
  assert(
    got === undefined && threw === undefined,
    `${label}: refused without a spec (got ${JSON.stringify(got)})`,
  );
}

// ── deriveSpec: the four handbacks each name their own cause.
for (const [child, needle, label] of [
  [dead("exit 1"), "child", "a dead child"],
  [reply(""), "no parsable", "an empty reply"],
  [reply("prose only"), "no parsable", "a reply with no block"],
  [reply("```pi-spec v1\n{x\n```"), "no parsable", "a reply whose block is broken JSON"],
] as const) {
  let threw: unknown;
  try {
    deriveSpec({ title: "t", body: "b" }, () => Promise.resolve(child));
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof SpecDeriveError, `${label}: a SpecDeriveError (got ${String(threw)})`);
  const message = threw instanceof Error ? threw.message : "";
  assert(
    message.toLowerCase().includes(needle),
    `…and its reason names ${JSON.stringify(needle)} (got ${JSON.stringify(message)})`,
  );
  const rows = (threw as { dispatches?: unknown[] })?.dispatches;
  assert(Array.isArray(rows) && rows.length === 1, `…and the child's cost row rides on it`);
}

// ── deriveSpec: a size-L or zero-criteria derivation is refused, block quoted.
for (const [bullets, needle, label] of [
  [Array.from({ length: 12 }, (_, i) => `criterion ${String(i)}`.repeat(1) + " ".repeat(0) + i), "size L", "twelve criteria size L"],
  [[], "no acceptance criteria", "zero criteria"],
] as const) {
  let threw: unknown;
  try {
    deriveSpec({ title: "t", body: "b" }, () => Promise.resolve(reply(deriveReply(bullets))));
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof SpecDeriveError, `${label}: refused (got ${String(threw)})`);
  const message = threw instanceof Error ? threw.message : "";
  assert(
    message.includes(needle),
    `…and the reason names ${JSON.stringify(needle)} (got ${JSON.stringify(message).slice(0, 160)})`,
  );
  assert(
    message.includes("pi-spec v1"),
    `…and quotes the rendered block so the operator can see what was derived`,
  );
}

// ── deriveSpec: the child is handed the title and body FENCED, never raw.
{
  const injected = "```text\n### INJECTED\n```";
  let seenPrompt = "";
  const spec = deriveSpec(
    { title: `a title with ${injected}`, body: `a body with ${injected}` },
    (dispatched) => {
      seenPrompt = dispatched.prompt;
      return Promise.resolve(reply(deriveReply(BULLETS)));
    },
    { role: "explore" },
  );
  assert(spec !== undefined, "the happy path still yields a spec");
  assert(seenPrompt.includes("### INJECTED") === false || seenPrompt.includes("```text"), "");
  assert(
    seenPrompt.includes("```text\n") && seenPrompt.includes("\u02cb"),
    "the title and body arrive inside a fence with their own backtick runs disarmed",
  );
  assert(
    seenPrompt.includes(String(BULLETS.length)) &&
      seenPrompt.toLowerCase().includes("acceptance criteria"),
    "the brief tells the child what to return and in what shape",
  );
  assert(
    seenPrompt.includes("untrusted") || seenPrompt.includes("data"),
    "the brief says the issue text is data, not instructions",
  );
}

// ── deriveSpecForRun: the one accessor every step reads (R4).
{
  const good: PiSpec = {
    problem: "p",
    criteria: [{ id: "AC1", text: "t", verify: "test" }],
    size: "S",
  };
  const derived = {
    spec: good,
    model: "provider/model",
    at: 1_700_000_000_000,
  };
  const bodyWith = specBlock([{ id: "AC1", text: "from the issue", verify: "test" } as never], "issue problem");
  const withBody = specForRun(bodyWith, {});
  assert(
    withBody.ok && withBody.source === "issue" && withBody.spec.problem === "issue problem",
    `a body that parses wins over nothing (got ${JSON.stringify(withBody)})`,
  );
  const derivedRun = specForRun("prose only", { derivedSpec: derived });
  assert(
    derivedRun.ok && derivedRun.source === "derived" && derivedRun.spec.problem === "p",
    `a no-block body with a persisted derived spec returns it (got ${JSON.stringify(derivedRun)})`,
  );
  const plain = specForRun("prose only", {});
  assert(
    !plain.ok && plain.reason === "no pi-spec v1 block",
    `a no-block body with no persisted spec keeps today's failure (got ${JSON.stringify(plain)})`,
  );
  const malformed = specForRun("```pi-spec v1\n{x\n```", { derivedSpec: derived });
  assert(
    !malformed.ok && malformed.reason.includes("JSON"),
    `a malformed block is NOT replaced by the derived spec — only "no pi-spec v1 block" is (got ${JSON.stringify(malformed)})`,
  );
}

// ── specSource is derived exactly when the record carries one.
{
  assert(specSource({}) === "issue", 'a run with no derivedSpec is source "issue"');
  assert(
    specSource({ derivedSpec: { spec: {} as PiSpec, model: "m", at: 1 } }) === "derived",
    'a run with a derivedSpec is source "derived"',
  );
}

process.exit(failed);
