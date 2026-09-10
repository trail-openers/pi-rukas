#!/usr/bin/env bun
/**
 * test-facts-reporter — the #660 B2 companion extension.
 *
 * `facts-reporter.ts` registers exactly ONE tool, `report_facts`, whose TypeBox
 * schema IS the `AgentFacts` wire format. This test drives the real registered
 * tool with a stub ExtensionAPI (the pattern the sibling reporters lack — they
 * are exercised through their parents) and asserts:
 *   - exactly one tool is registered, named `report_facts` (no second tool, no
 *     prose-marker fallback)
 *   - the TypeBox schema ACCEPTS a minimal call ({}) and a fully-populated call
 *   - the schema REJECTS a 6th kind value ("deploy") and a non-object call
 *   - execute() returns the ack shape { content: [{type:"text", text}], details }
 *     with no side effects, and details passthroughs the raw arguments
 */

import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import factsReporter, { AGENT_FACTS_COMMAND_KINDS } from "../src/facts-reporter.ts";

// ---------------------------------------------------------- capture registerTool
interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    id: string,
    raw: unknown,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: { cwd: string },
  ) => Promise<{
    content: { type: string; text: string }[];
    details: Record<string, unknown>;
  }>;
}
const tools: RegisteredTool[] = [];
const fakePi = {
  registerTool(t: RegisteredTool) {
    tools.push(t);
  },
} as unknown as ExtensionAPI;

factsReporter(fakePi);

// ------------------------------------------------------------- exactly one tool
assert.equal(tools.length, 1, "facts-reporter must register exactly one tool");
assert.equal(tools[0].name, "report_facts", "the tool must be named report_facts");
assert.match(tools[0].description, /EXACTLY ONCE/, "description must pin the single-call contract");

// --------------------------------------------------------------- kind union
// The 5-value kind union must match detect.ts's Command.kind exactly.
assert.deepEqual(
  [...AGENT_FACTS_COMMAND_KINDS],
  ["test", "lint", "format", "typecheck", "build"],
  "AGENT_FACTS_COMMAND_KINDS must be the exact 5-value detect.ts union",
);

// The schema's `commands` item must reject a 6th kind via TypeBox validation.
const schema = tools[0].parameters as Parameters<typeof Value.Check>[0];
// Walk the TypeBox schema to reach the `commands` array item `kind` field.
const itemProps = (schema.properties as Record<string, Record<string, unknown> | undefined>)
  .commands?.items as Record<string, unknown> | undefined;
assert.ok(itemProps, "schema.commands must be an array type with an items object");
const kindProp = (itemProps as { properties: Record<string, unknown> }).properties.kind;
assert.ok(kindProp, "schema.commands.items must declare a kind field");
// A 6th kind value must fail validation against the full object schema.
const full: Record<string, unknown> = {
  language: "ruby",
  packageManager: "bundler",
  manifest: "Gemfile",
  commands: [{ name: "rspec", command: "bundle exec rspec", kind: "deploy" }],
  codeStyleBullets: ["Use rspec, not minitest"],
  testingNotes: ["Uses rspec with a 70% coverage floor via simplecov"],
  ciWorkflows: ["ci.yml"],
};
assert.equal(
  Value.Check(schema, full),
  false,
  "a 6th kind value ('deploy') must fail schema validation",
);
// The same call with a valid kind must pass.
const valid = {
  ...full,
  commands: [{ name: "rspec", command: "bundle exec rspec", kind: "test" }],
  architectureBullets: [
    "src/facts-reporter.ts — the pre-pass wire contract",
    "critical path: src/classify.ts — changes require corresponding tests",
  ],
};
assert.equal(
  Value.Check(schema, valid),
  true,
  "a fully-populated call (including testingNotes and architectureBullets) with a valid kind must pass",
);

// testingNotes: a string[] is accepted; a non-string-array is rejected.
assert.equal(
  Value.Check(schema, { testingNotes: ["bullet1", "bullet2"] }),
  true,
  "testingNotes: string[] must pass schema validation",
);
assert.equal(
  Value.Check(schema, { testingNotes: 42 }),
  false,
  "testingNotes: 42 (a number, not an array) must fail schema validation",
);
assert.equal(
  Value.Check(schema, { testingNotes: [42] }),
  false,
  "testingNotes: [42] (an array of non-strings) must fail schema validation",
);

// architectureBullets must be validated as string[] — a string (not an array)
// is a schema violation, not coerced into an array.
assert.equal(
  Value.Check(schema, { architectureBullets: "prose paragraph, not bullets" }),
  false,
  "architectureBullets: 'prose' (string, not array) must fail schema validation",
);
assert.equal(
  Value.Check(schema, { architectureBullets: ["a", 42] }),
  false,
  "architectureBullets with a non-string entry must fail schema validation",
);

// ------------------------------------------------------------------ acceptance
// Minimal call ({}) is valid — the schema is the total wire format, all optional.
assert.equal(Value.Check(schema, {}), true, "an empty {} call must pass schema validation");
assert.equal(Value.Check(schema, { manifest: "Gemfile" }), true, "a single-field call must pass");
assert.equal(Value.Check(schema, valid), true, "a fully-populated call must pass");

// Non-object arguments are rejected by the object schema.
assert.equal(Value.Check(schema, "not an object"), false, "a non-object argument must fail");
assert.equal(Value.Check(schema, [1, 2, 3]), false, "an array argument must fail");

// ciWorkflows entries that already carry a prefix are still schema-valid (the
// constraint is descriptive, enforced by the renderer not the schema) — but the
// kind discriminator is the one structural rejection we assert here.
assert.equal(
  Value.Check(schema, { ciWorkflows: ["ci.yml"] }),
  true,
  "raw ciWorkflows filenames must pass",
);

// ------------------------------------------------------------------ execute ack
const res = await tools[0]!.execute(
  "id-1",
  {
    manifest: "Gemfile",
    language: "ruby",
    commands: [{ name: "rspec", command: "bundle exec rspec", kind: "test" }],
    testingNotes: ["Uses rspec with a 70% coverage floor via simplecov"],
  },
  new AbortController().signal,
  () => {},
  { cwd: "/tmp" },
);
assert.equal(res.content.length, 1, "execute must return exactly one content block");
assert.equal(res.content[0]!.type, "text", "the content block must be of type text");
assert.match(
  res.content[0]!.text,
  /recorded agent facts/,
  "ack text must confirm the facts were recorded",
);
assert.match(res.content[0]!.text, /manifest: Gemfile/, "ack text should mention the manifest");
assert.match(res.content[0]!.text, /1 command\(s\)/, "ack text should mention the command count");
assert.match(
  res.content[0]!.text,
  /1 testing note\(s\)/,
  "ack text should mention the testing note count",
);
assert.doesNotMatch(
  res.content[0]!.text,
  /architecture bullet/,
  "an absent architectureBullets must NOT appear in the ack parts",
);
// details is a passthrough of the raw arguments — the caller reads these.
assert.deepEqual(res.details, {
  manifest: "Gemfile",
  language: "ruby",
  commands: [{ name: "rspec", command: "bundle exec rspec", kind: "test" }],
  testingNotes: ["Uses rspec with a 70% coverage floor via simplecov"],
});

// A POPULATED architectureBullets array must show up in the ack (the ack is
// the human-visible confirmation of what was recorded) and in details.
const archRes = await tools[0]!.execute(
  "id-3",
  {
    manifest: "Gemfile",
    architectureBullets: ["src/a.ts — role", "critical path: X, changes require Y"],
  },
  new AbortController().signal,
  () => {},
  { cwd: "/tmp" },
);
assert.match(
  archRes.content[0]!.text,
  /2 architecture bullet\(s\)/,
  "a populated architectureBullets ack must mention the count",
);
assert.deepEqual(archRes.details.architectureBullets, [
  "src/a.ts — role",
  "critical path: X, changes require Y",
]);

// A populated codeStyleBullets array must mention the count (existing branch).
const styleRes = await tools[0]!.execute(
  "id-4",
  { codeStyleBullets: ["Use rspec"] },
  new AbortController().signal,
  () => {},
  { cwd: "/tmp" },
);
assert.match(
  styleRes.content[0]!.text,
  /1 code-style bullet\(s\)/,
  "a populated codeStyleBullets ack must mention the count",
);

// A minimal/empty call acks with "none populated" and empty-ish details.
const empty = await tools[0]!.execute("id-2", {}, new AbortController().signal, () => {}, {
  cwd: "/tmp",
});
assert.match(empty.content[0]!.text, /none populated/, "an empty call should ack 'none populated'");
assert.deepEqual(empty.details, {});

// An empty architectureBullets array populates nothing — no count branch fires.
const emptyArch = await tools[0]!.execute(
  "id-5",
  { architectureBullets: [] },
  new AbortController().signal,
  () => {},
  { cwd: "/tmp" },
);
assert.match(
  emptyArch.content[0]!.text,
  /none populated/,
  "an empty architectureBullets array should ack 'none populated'",
);
assert.doesNotMatch(
  emptyArch.content[0]!.text,
  /architecture bullet/,
  "an empty architectureBullets array must not emit a count part",
);

console.log("✓ test-facts-reporter: all assertions passed");
