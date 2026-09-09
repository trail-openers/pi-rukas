#!/usr/bin/env bun
/**
 * agent-facts-extract — the #660 B2 `extractAgentFacts` fails-closed contract.
 *
 * Mirrors the 4-case structure asserted in test-policy-judge.ts (lines
 * 218-236) for `extractPolicyAnswer`: a malformed call is discarded, never
 * coerced; a wrong tool name is ignored; no calls → undefined.
 *
 * `extractAgentFacts` scans the child's raw `tool_use` blocks for a VALID
 * `report_facts` call. `undefined` is the graceful-failure signal: the caller
 * proceeds by calling `agents_md_run` WITHOUT an `agentOverride` at all —
 * "no call = no facts, never a guess".
 */

import { type AgentFacts, extractAgentFacts } from "../src/agents-md/detect.ts";
import { FACTS_EXTRA_ARGS, FACTS_REPORTER_PATH } from "../src/facts-reporter.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------ (a) empty toolUses → undefined

{
  assert(extractAgentFacts([]) === undefined, "(a) empty toolUses → undefined (no call = no facts)");
}

// ----------------------------------- (b) wrong tool name → undefined

{
  const wrongName = [
    { name: "report_finding", arguments: { verdict: "permitted" } },
    { name: "report_policy", arguments: { verdict: "forbidden", quote: "x" } },
  ];
  assert(
    extractAgentFacts(wrongName) === undefined,
    "(b) report_finding/report_policy calls are not report_facts calls",
  );
}

// ---------------------- (c) malformed arguments object → undefined

{
  const malformed = [
    { name: "report_facts", arguments: { commands: "not-an-array" } },
  ];
  assert(
    extractAgentFacts(malformed) === undefined,
    "(c) report_facts with a string where an array is expected → undefined (discarded, not coerced)",
  );

  const malformed2 = [
    { name: "report_facts", arguments: { commands: [{ name: "a", command: "b", kind: "deploy" }] } },
  ];
  assert(
    extractAgentFacts(malformed2) === undefined,
    "(c) report_facts with a 6th kind value ('deploy') → undefined (schema violation discarded)",
  );

  const malformed3 = [{ name: "report_facts", arguments: null }];
  assert(
    extractAgentFacts(malformed3) === undefined,
    "(c) report_facts with null arguments → undefined",
  );
}

// ---------------------------------- (d) prose-only (no tool call) → undefined

{
  // A child that replied in prose without any tool_use blocks:
  // the parent's toolUses array is simply empty of report_facts entries.
  const proseOnly = [
    { name: "read", arguments: { path: "/x" } },
    { name: "bash", arguments: { command: "ls" } },
  ];
  assert(
    extractAgentFacts(proseOnly) === undefined,
    "(d) a child that only used other tools → undefined (prose is ignored; only the tool call counts)",
  );
}

// --------------------------------------------------- a valid call → AgentFacts

{
  const valid = [
    {
      name: "report_facts",
      arguments: {
        language: "ruby",
        manifest: "Gemfile",
        commands: [
          { name: "bundle test", command: "bundle exec rspec", kind: "test", runner: "bundle" },
        ],
        ciWorkflows: ["ci.yml"],
      },
    },
  ];
  const out = extractAgentFacts(valid);
  assert(out !== undefined, "(valid) a well-formed report_facts call is extracted");
  assert(out?.language === "ruby", "(valid) language extracted");
  assert(out?.manifest === "Gemfile", "(valid) manifest extracted");
  assert(out?.commands?.length === 1, "(valid) commands extracted");
  assert(out?.commands?.[0]?.runner === "bundle", "(valid) runner copied through");
  assert(out?.ciWorkflows?.[0] === "ci.yml", "(valid) ciWorkflows extracted (raw filename)");
}

// ----------------------------------------------- partial call (some fields)

{
  const partial = [
    {
      name: "report_facts",
      arguments: {
        codeStyleBullets: ["Use strict mode"],
        // commands/manifest/language all absent
      },
    },
  ];
  const out = extractAgentFacts(partial);
  assert(out !== undefined, "(partial) a partial call is NOT a failure — it is partial information");
  assert(out?.codeStyleBullets?.length === 1, "(partial) codeStyleBullets applied");
  assert(out?.commands === undefined, "(partial) absent commands stay undefined (not invented)");
  assert(out?.manifest === undefined, "(partial) absent manifest stays undefined");
}

// ------------------------------------------- multiple calls → LAST valid wins

{
  const multiple = [
    // First: malformed (discarded).
    { name: "report_facts", arguments: { commands: "bad" } },
    // Second: valid.
    {
      name: "report_facts",
      arguments: { language: "go", manifest: "go.mod" },
    },
    // Third: valid — wins, mirroring extractPolicyAnswer's last-valid-call rule.
    {
      name: "report_facts",
      arguments: { language: "rust", manifest: "Cargo.toml" },
    },
  ];
  const out = extractAgentFacts(multiple);
  assert(out?.language === "rust", "(multiple) the LAST valid call wins (malformed first call discarded)");
  assert(out?.manifest === "Cargo.toml", "(multiple) the third call's manifest, not the second");
}

// ------------------------------------------- non-object entries are skipped

{
  const mixed = [
    "not-an-object",
    42,
    null,
    { name: "report_facts", arguments: { language: "python" } },
  ];
  const out = extractAgentFacts(mixed);
  assert(out?.language === "python", "(mixed) non-object toolUses entries are skipped, valid call still found");
}

// ------------------------------------- FACTS_EXTRA_ARGS is the load seam

{
  assert(FACTS_EXTRA_ARGS.length === 3, "FACTS_EXTRA_ARGS has 3 entries (--no-skills, --extension, path)");
  assert(FACTS_EXTRA_ARGS[0] === "--no-skills", "FACTS_EXTRA_ARGS[0] is --no-skills");
  assert(FACTS_EXTRA_ARGS[1] === "--extension", "FACTS_EXTRA_ARGS[1] is --extension");
  assert(
    FACTS_EXTRA_ARGS[2] === FACTS_REPORTER_PATH &&
      FACTS_REPORTER_PATH.endsWith("facts-reporter.ts"),
    "FACTS_EXTRA_ARGS[2] is the path to facts-reporter.ts",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
