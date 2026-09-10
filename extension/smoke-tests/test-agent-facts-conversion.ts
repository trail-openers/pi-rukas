#!/usr/bin/env bun
/**
 * #660 B2 — the agentFactsToDetectedFacts + extractAgentFacts contract.
 *
 * B2 (this workstream) supplies the data layer: a PURE total/lossless
 * conversion from the AgentFacts wire format into B1's DetectedFacts, and a
 * fails-closed extractor that reads the wire format off a dispatch's
 * `toolUses` channel (mirroring extractPolicyAnswer).
 *
 * What is asserted here is the part that must never be wrong regardless of
 * what the explore child reports:
 *   - the conversion never throws (total) and drops nothing (lossless);
 *   - it never adds a `.github/workflows/` prefix to ciWorkflows (the
 *     renderer applies that);
 *   - absent fields become undefined (scalar) / [] (array), never a guess;
 *   - the extractor returns `undefined` (not a partial value) for the four
 *     fails-closed cases: empty toolUses, a wrong tool name, malformed args,
 *     and a prose-only reply with no tool call at all.
 */

import {
  agentFactsToDetectedFacts,
  extractAgentFacts,
  type AgentFacts,
} from "../src/agents-md/detect.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------ fully populated

{
  const input: AgentFacts = {
    language: "ruby",
    packageManager: "ruby",
    manifest: "Gemfile",
    commands: [
      { name: "bundle exec rspec", command: "bundle exec rspec", kind: "test" },
      { name: "rubocop", command: "bundle exec rubocop", kind: "lint" },
    ],
    codeStyleBullets: [
      "Use double-quoted symbols in frozen files",
      "No trailing whitespace",
    ],
    architectureBullets: [
      "src/foo.rb — the classifier: changes require corresponding tests",
    ],
    ciWorkflows: ["ci.yml", "lint.yml"],
  };
  const out = agentFactsToDetectedFacts(input);

  assert(out.runner === undefined, "runner is undefined (the wire format carries none)");
  assert(
    out.language === "ruby" && out.packageManager === "ruby" && out.manifest === "Gemfile",
    "scalar fields copied through unchanged",
  );
  assert(out.commands.length === 2, "commands array length preserved (lossless)");
  assert(
    out.commands[0]?.command === "bundle exec rspec" &&
      out.commands[1]?.command === "bundle exec rubocop",
    "command bodies copied through unchanged",
  );
  assert(
    out.commands[0]?.kind === "test" && out.commands[1]?.kind === "lint",
    "kind union values copied through unchanged",
  );
  assert(
    !("runner" in (out.commands[0] ?? {})) || out.commands[0]?.runner === undefined,
    "no runner is synthesized onto a copied command",
  );
  assert(
    out.ciWorkflows[0] === "ci.yml" && out.ciWorkflows[1] === "lint.yml",
    "ciWorkflows copied through as RAW filenames — NO .github/workflows/ prefix",
  );
  assert(
    !out.ciWorkflows.some((w) => w.includes(".github/workflows/")),
    "...asserted explicitly: no prefix anywhere in the converted ciWorkflows",
  );
  assert(Array.isArray(out.notes) && out.notes.length === 0, "notes is the empty array");
  assert(
    !("architectureBullets" in out) && out.architectureBullets === undefined,
    "architectureBullets is DROPPED by the conversion (stays on the AgentFacts side only)",
  );
  assert(
    !("codeStyleBullets" in out) && out.codeStyleBullets === undefined,
    "codeStyleBullets is DROPPED by the conversion (stays on the AgentFacts side only)",
  );
}

// ------------------------------------------------------------------- empty {}

{
  const out = agentFactsToDetectedFacts({});
  assert(out.runner === undefined, "empty input → runner undefined");
  assert(out.manifest === undefined, "empty input → manifest undefined");
  assert(out.language === undefined, "empty input → language undefined");
  assert(out.packageManager === undefined, "empty input → packageManager undefined");
  assert(
    Array.isArray(out.commands) && out.commands.length === 0,
    "empty input → commands [] (absent → empty, not a guess)",
  );
  assert(
    Array.isArray(out.ciWorkflows) && out.ciWorkflows.length === 0,
    "empty input → ciWorkflows []",
  );
  assert(Array.isArray(out.notes) && out.notes.length === 0, "empty input → notes []");
}

// -------------------------------------------------------------------- partial

{
  const out = agentFactsToDetectedFacts({
    codeStyleBullets: ["One bullet"],
    architectureBullets: ["src/foo.ts — the critical path: changes require tests"],
  });
  assert(out.manifest === undefined && out.language === undefined, "partial → unfilled scalars stay undefined");
  assert(out.commands.length === 0 && out.ciWorkflows.length === 0, "partial → absent arrays become []");
  assert(
    Array.isArray(out.notes) && out.notes.length === 0,
    "partial → notes [] (codeStyleBullets lives on the AgentOverride, not DetectedFacts)",
  );
  assert(
    out.architectureBullets === undefined && !("architectureBullets" in out),
    "partial → architectureBullets is DROPPED (never surfaces on DetectedFacts)",
  );
}

// ----------------------- architectureBullets never surfaces on DetectedFacts

{
  const out = agentFactsToDetectedFacts({
    architectureBullets: ["src/a.ts — role", "critical path: X, changes require Y"],
  });
  assert(
    out.architectureBullets === undefined && !("architectureBullets" in out),
    "an input carrying ONLY architectureBullets converts with the field dropped, never invented onto DetectedFacts",
  );
  assert(
    out.manifest === undefined && out.commands.length === 0 && out.ciWorkflows.length === 0,
    "dropping architectureBullets leaves the rest of DetectedFacts absent/empty, never a guess",
  );
}

// ----------------------------------------------------- prefix never added, ever

{
  const out = agentFactsToDetectedFacts({ ciWorkflows: ["ci.yml"] });
  assert(
    out.ciWorkflows.length === 1 && out.ciWorkflows[0] === "ci.yml",
    "conversion must NOT add the .github/workflows/ prefix (environmentBody does)",
  );
}

// ------------------------------------------------------------ extractor: fails closed

{
  assert(
    extractAgentFacts([]) === undefined,
    "(a) empty toolUses → undefined (no facts, never a guess)",
  );

  assert(
    extractAgentFacts([{ name: "report_finding", arguments: { verdict: "permitted" } }]) ===
      undefined,
    "(b) a call to some OTHER tool (report_finding) is not an agent-facts report",
  );

  assert(
    extractAgentFacts([
      { name: "report_facts", arguments: { commands: "bun run test" } },
    ]) === undefined,
    "(c) a report_facts call with MALFORMED args (commands a string) is discarded, not coerced",
  );

  // (d) a prose-only reply: toolUses carries only a text block, no report_facts call.
  const proseOnly = [{ type: "text", text: "Here are the facts I found..." }];
  assert(
    extractAgentFacts(proseOnly) === undefined,
    "(d) a prose-only reply (no report_facts tool call) → undefined",
  );
}

// ------------------------------------------------- extractor: happy + malformed-then-valid

{
  const good: AgentFacts = {
    manifest: "Gemfile",
    commands: [{ name: "rspec", command: "rspec", kind: "test" }],
  };
  const out = extractAgentFacts([
    { name: "report_facts", arguments: { commands: "garbage" } }, // malformed, discarded
    { name: "report_facts", arguments: good }, // valid, last one wins
  ]);
  assert(out !== undefined, "a well-formed report_facts call IS extracted");
  assert(
    out?.manifest === "Gemfile" &&
      out?.commands?.length === 1 &&
      out?.commands?.[0]?.command === "rspec",
    "...and the LAST valid call's arguments are returned unchanged",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
