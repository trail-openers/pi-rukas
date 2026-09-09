#!/usr/bin/env bun
/**
 * Disclosure & delivery fixes from the vipune fixture-run verification
 * (2026-09-09). The defect class throughout was "state correct, rendering
 * silent" — so these tests assert the RENDERED text the operator reads,
 * not just result fields.
 *
 *   C1 — a draft-invalid halt on a dryRun must render as NOT FILEABLE with
 *        the FILING STATUS block, and must NOT invite "re-call with dryRun
 *        omitted to file" (the old head did, and the test session read a
 *        rejected placeholder draft as a clean gate pass).
 *   C3 — a failed/timed-out angle surfaces in the result text
 *        (INVESTIGATION STATUS) and in the drafted body, never silently
 *        filtered out.
 *   C4 — writeback routing: the singular "acceptance criterion" (the gate
 *        prompt's own template wording) routes to the AC section; the
 *        heading matched EARLIEST in the resolution text wins; Sub-issues
 *        is writable; hyphenated forms match.
 *   C6 — parseDuplicateRisk ignores the echoed template menu, takes the
 *        LAST real marker, and windows the rationale around it.
 *   C2/C5 — renderPriorContext clips an oversized item to fit instead of
 *        dropping it whole, and the driver orders context-param entries
 *        ahead of vipune snapshots.
 */

import {
  PRIOR_CONTEXT_CHILD_PROMPT_CAP,
  renderPriorContext,
} from "../src/plan-draft.ts";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { gapGateVerifyPrompt } from "../src/plan-gate-prompt.ts";
import { parseDuplicateRisk } from "../src/plan-investigate.ts";
import { registerPlanTool } from "../src/plan-tool.ts";
import { destinationFor } from "../src/plan-writeback.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_FORGE = "none";

// ---------------------------------------------- C6: duplicate-risk parser

{
  const echoOnly = parseDuplicateRisk(
    "Task restated: Return a short verdict: DUPLICATE_RISK: high|medium|low|none plus 2-3 sentences.",
  );
  assert(
    echoOnly.level === "medium",
    `C6: the echoed template menu is NOT a verdict (got ${echoOnly.level}, absent-marker fallback medium)`,
  );
  const echoPlusReal = parseDuplicateRisk(
    "The task said: DUPLICATE_RISK: high|medium|low|none.\nChecked all issues.\nDUPLICATE_RISK: none — no overlapping open work",
  );
  assert(echoPlusReal.level === "none", "C6: the real verdict wins over the echoed menu");
  const lastWins = parseDuplicateRisk(
    "Initially DUPLICATE_RISK: medium seemed right, but after checking #103:\nDUPLICATE_RISK: high — issue #103 covers this",
  );
  assert(lastWins.level === "high", "C6: the LAST real marker wins (the verdict line closes the reply)");
  assert(
    lastWins.rationale.includes("issue #103 covers this"),
    "C6: the rationale is windowed around the matched marker, not a blind head-slice",
  );
}

// ------------------------------------------ C2/C5: prior-context clipping

{
  const bigFact = "x".repeat(3000);
  const one = renderPriorContext([{ source: "context param", fact: bigFact }]);
  assert(
    one.length <= PRIOR_CONTEXT_CHILD_PROMPT_CAP + 200,
    "clip: output stays near the cap",
  );
  assert(
    one.includes("x".repeat(500)),
    "clip: an oversized single item KEEPS its head (the old loop dropped it whole)",
  );
  assert(/1 item\(s\) clipped/.test(one), "clip: the marker names the clipped count");

  const first = { source: "context param", fact: "y".repeat(1950) };
  const second = { source: "context param", fact: "z".repeat(500) };
  const two = renderPriorContext([first, second]);
  assert(
    /item\(s\) omitted/.test(two) && !two.includes("zzzz"),
    "clip: an item that cannot get a meaningful clip is counted omitted",
  );
}

// --------------------------------------------- C4: writeback destinations

{
  const gap = (resolution: string) => ({
    severity: "CRITICAL" as const,
    description: "d",
    resolution,
  });
  assert(
    destinationFor(gap("add a sharper acceptance criterion covering the retry path"), "feature")
      ?.heading === "Acceptance criteria",
    "C4: the gate template's SINGULAR 'acceptance criterion' routes to the AC section",
  );
  assert(
    destinationFor(
      gap("sharpen the acceptance criterion and remove the contradictory test surface language"),
      "feature",
    )?.heading === "Acceptance criteria",
    "C4: the heading matched EARLIEST in the text wins (not array order)",
  );
  assert(
    destinationFor(
      gap("document it under test surface, then revisit the acceptance criteria"),
      "feature",
    )?.heading === "Test surface",
    "C4: ...and the converse order picks Test surface",
  );
  assert(
    destinationFor(gap("split this into a dedicated sub-issue for the migration"), "epic")
      ?.heading === "Sub-issues",
    "C4: Sub-issues is a writable destination for epics",
  );
  assert(
    destinationFor(gap("move the telemetry work out-of-scope"), "feature")?.heading ===
      "Out of scope",
    "C4: hyphenated section names match",
  );
  assert(
    destinationFor(gap("name which of the two caps wins"), "feature") === null,
    "C4: a resolution naming no section still falls to branch 3 (operator-owned)",
  );
  assert(
    /SUPERSEDE/.test(gapGateVerifyPrompt("body", [])),
    "C4: round-2 verification prompt carries the applied-resolutions-supersede instruction",
  );
}

// ------------------------------- pipeline + rendered text (C1, C3, order)

interface Registered {
  name: string;
  execute: (...a: unknown[]) => Promise<unknown>;
}
const tools: Registered[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal stub; only registerTool is used
registerPlanTool({ registerTool: (d: Registered) => void tools.push(d) } as any);
const tool = tools.find((t) => t.name === "start_plan_driver");
const FAKE_CTX = { cwd: process.cwd() } as never;

async function invoke(params: Record<string, unknown>) {
  const out = (await tool?.execute("id", params, undefined, undefined, FAKE_CTX)) as {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  };
  return { text: out.content[0]?.text ?? "", details: out.details ?? {} };
}

function angleItem(kind: string, text: string) {
  return { name: "report_plan_item", arguments: { kind, text, angle: "x" } };
}

let angleMode: "no-ac" | "one-failed" = "no-ac";
setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }, opts?: { label?: string }) => {
  if (spec.role === "adversarial-developer") {
    return Promise.resolve({
      role: "adversarial-developer",
      ok: true,
      text: "VERDICT: READY",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    });
  }
  if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "DUPLICATE_RISK: none — no overlap",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    });
  }
  if (angleMode === "one-failed" && (opts?.label ?? "").includes("interfaces")) {
    // A timed-out child: dispatch not ok, exit 143, no tool calls.
    return Promise.resolve({ role: "explore", ok: false, text: "", toolUses: [], ms: 1, exitCode: 143 });
  }
  const toolUses =
    angleMode === "no-ac"
      ? [angleItem("edge-case", "a pitfall")]
      : [angleItem("acceptance-criterion", "the tool registers correctly")];
  return Promise.resolve({ role: "explore", ok: true, text: "prose summary", toolUses, ms: 1, exitCode: 0 });
}) as never);

{
  // C1: draft-invalid on a dryRun renders NOT FILEABLE + FILING STATUS and
  // never invites filing.
  angleMode = "no-ac";
  const { text, details } = await invoke({
    descriptor: "add a lifecycle hook capture path for extension/src/plan-tool.ts",
    dryRun: true,
  });
  assert(
    (details.filingFailure as { reason?: string })?.reason === "draft-invalid",
    "C1: the halt fired (draft-invalid)",
  );
  assert(/NOT FILEABLE AS-IS \(draft-invalid\)/.test(text), "C1: the head says NOT FILEABLE, loudly");
  assert(/=== FILING STATUS ===/.test(text), "C1: the FILING STATUS block renders on dryRun");
  assert(/failed deterministic validation/.test(text), "C1: ...and carries the validator's detail");
  assert(
    !text.includes("re-call start_plan_driver with dryRun omitted to file"),
    "C1: the invitation to file a rejected draft is GONE",
  );
}

{
  // C3: a failed angle is disclosed in the result text AND the drafted body.
  angleMode = "one-failed";
  const { text, details } = await invoke({
    descriptor: "add a lifecycle hook capture path for extension/src/plan-tool.ts",
    dryRun: true,
  });
  assert(/=== INVESTIGATION STATUS ===/.test(text), "C3: INVESTIGATION STATUS block renders");
  assert(
    /interfaces-and-contracts: dispatch failed or timed out \(exit 143 — killed at the dispatch bound\)/.test(
      text,
    ),
    "C3: the failed angle is named with its cause",
  );
  assert(
    /NOT investigated; treat this surface as unverified/.test(text),
    "C3: the drafted body itself shows the hole (Technical context line)",
  );
  const failed = details.failedAngles as { name: string }[] | undefined;
  assert(
    failed?.length === 1 && failed[0]?.name === "interfaces-and-contracts",
    "C3: failedAngles carried on details",
  );
}

{
  // C2/C5 ordering: context-param entries come FIRST in priorContext (the
  // clip site's droppable tail is vipune, never the operator).
  angleMode = "one-failed";
  const r = await runPlanPipeline(
    { registerTool: () => {} } as never,
    {
      descriptor: "add a lifecycle hook capture path for extension/src/plan-tool.ts",
      context: "the operator's establishing fact",
      dryRun: true,
    },
    process.cwd(),
  );
  assert(
    r.priorContext[0]?.source === "context param",
    `ordering: context-param entries lead priorContext (got ${r.priorContext[0]?.source})`,
  );
}

setPlanDispatch(null);
delete process.env.PI_ENSEMBLE_FORGE;

console.log(`\nexit ${exit}`);
process.exit(exit);
