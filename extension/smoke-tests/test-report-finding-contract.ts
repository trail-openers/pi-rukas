#!/usr/bin/env bun
/**
 * The `report_finding` call contract, as the lens is told it.
 *
 * Pi validates the tool's arguments against the registered schema and names
 * ONE missing key per rejection. A lens that sent only `description` was told
 * about `title`, re-sent, and was then told about `severity` — a turn each —
 * because neither the tool description nor the lens prompt said which fields
 * are required. The rejection text is Pi's; what the lens is told up front is
 * ours:
 *   1. the tool description names every field the schema requires and carries
 *      one complete example call that satisfies the schema
 *   2. the lens prompt marks exactly the schema's required fields as required
 *   3. a call that recorded nothing is visible in the per-lens summary line
 *      (the count was computed and then rendered nowhere for a lens that ran)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractFindings, lensPromptFor, renderSummary } from "../src/lens-review-format.ts";
import {
  LENS_REPORTER_PATH,
  type LensReviewSummary,
  type LensRunResult,
} from "../src/lens-review.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface RegisteredTool {
  name: string;
  description: string;
  parameters: { required?: string[]; properties: Record<string, unknown> };
}
// Loaded from the path production hands to `--extension`, so this reads the
// file a lens child actually gets.
const { default: registerLensReporter } = (await import(LENS_REPORTER_PATH)) as {
  default: (pi: ExtensionAPI) => void;
};
let tool: RegisteredTool | undefined;
registerLensReporter({
  registerTool: (t: RegisteredTool) => {
    tool = t;
  },
} as unknown as ExtensionAPI);
if (!tool) throw new Error("lens-reporter registered no tool");

const required = tool.parameters.required ?? [];
const optional = Object.keys(tool.parameters.properties).filter((k) => !required.includes(k));
assert(
  JSON.stringify([...required].sort()) === JSON.stringify(["path", "severity", "title"]),
  `schema requires severity, path, title (got ${required.join(", ")})`,
);

// 1. Tool description: every required field named, plus a complete example.
{
  const d = tool.description;
  assert(/required/i.test(d), "tool description says which fields are required");
  for (const k of required) assert(d.includes(k), `tool description names required field ${k}`);
  const example = d.match(/Example: (\{.*?\})\. /)?.[1];
  assert(!!example, "tool description carries one example call");
  const args = example ? (JSON.parse(example) as Record<string, unknown>) : {};
  for (const k of required) assert(k in args, `example call carries required field ${k}`);
  // The example must be a call the parent would actually record.
  const { findings, skipped } = extractFindings(
    [{ name: "report_finding", arguments: args }],
    "ERROR_HANDLING",
  );
  assert(findings.length === 1 && skipped === 0, "example call is recorded as one finding");
}

// 2. Lens prompt: required fields marked, optional ones not.
{
  const prompt = lensPromptFor(
    { name: "ERROR_HANDLING", skill: "code-review-error-handling" },
    "diff --git a/x b/x",
    "ctx",
  );
  for (const k of required) {
    assert(prompt.includes(`- ${k} (required):`), `lens prompt marks ${k} as required`);
  }
  for (const k of optional) {
    assert(prompt.includes(`- ${k}:`), `lens prompt leaves ${k} unmarked (optional)`);
  }
}

// 3. A lens that ran with skipped calls says so beside its finding count.
{
  const lens = (parseError?: string): LensRunResult => ({
    lens: "ERROR_HANDLING",
    ok: true,
    ms: 1000,
    findings: [],
    attempts: 1,
    blocked: false,
    summary: "Reviewed the diff for this lens.",
    parseError,
  });
  const render = (l: LensRunResult) =>
    renderSummary(
      {
        verdict: "APPROVED",
        totalFindings: 0,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        lenses: [l],
        findings: [],
      } as LensReviewSummary,
      4,
    );
  const note = "2 malformed report_finding call(s) skipped";
  const row = (text: string) => text.split("\n").find((l) => l.includes("ERROR_HANDLING")) ?? "";
  assert(row(render(lens(note))).includes(note), "per-lens line shows the skipped-call count");
  assert(!row(render(lens())).includes("skipped"), "no note on a lens with nothing skipped");
}

process.exit(exit);
