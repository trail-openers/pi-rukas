#!/usr/bin/env bun
/**
 * The /plan driver pipeline e2e (moved from test-plan-tool.ts along the
 * 500-line seam): dryRun confirmation seam, phase ordering, chore/spike
 * gate skip, and the #606/#639 gate-prompt invariants. The registration
 * schema and the doctrine/agents.json pins stay in test-plan-tool.ts; the
 * #858 title/dedup/vipune blocks moved back into test-plan-tool.ts.
 */

import { codeIdentifiersIn, draftSpec, extractPlanItems } from "../src/plan-draft.ts";
import { setPlanDispatch } from "../src/plan-driver.ts";
import { registerPlanTool } from "../src/plan-tool.ts";
import { type PlanType, classifyPlanType } from "../src/plan-types.ts";
import type { DispatchResult } from "../src/types.ts";
import { calls, gatePrompts, invokePlanTool } from "./plan-test-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ----------------------------------------------------------- stub the seam

let gateReplyOverride: string | null = null;

function angleToolUses(): unknown[] {
  return [
    {
      name: "report_plan_item",
      arguments: {
        kind: "acceptance-criterion",
        text: "the new tool registers with the exact TypeBox schema",
        angle: "interfaces-and-contracts",
      },
    },
    {
      name: "report_plan_item",
      arguments: {
        kind: "edge-case",
        text: "a child killed mid-flight reports toolUses: [] — the driver must not parse its prose as findings",
        angle: "reproduction-surface",
      },
    },
  ];
}

function __responses(spec: { role: string; prompt: string }): DispatchResult {
  if (spec.role === "adversarial-developer") {
    gatePrompts.push(spec.prompt);
    return {
      role: "adversarial-developer",
      ok: true,
      text:
        gateReplyOverride ??
        "GAP: CRITICAL — missing acceptance criterion for the failure mode — proposed resolution: add a criterion for the retry path\nVERDICT: NEEDS_ITERATION",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    };
  }
  if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
    return {
      role: "explore",
      ok: true,
      text: "DUPLICATE_RISK: none — no overlapping open work",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    };
  }
  return {
    role: "explore",
    ok: true,
    text: "Task complete: investigated the work area.\n\n- extension/src/plan-driver.ts:42 — existing seam for the pipeline\n- extension/src/work-tool.ts:70 — the registration pattern to clone",
    toolUses: angleToolUses(),
    ms: 1,
    exitCode: 0,
  };
}

// ------------------------------------------------------------- registration

interface Registered {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (...a: unknown[]) => Promise<unknown>;
}

const tools: Registered[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal stub; only registerTool is used
const fakePi = {
  registerTool(def: Registered) {
    tools.push(def);
  },
} as any;

registerPlanTool(fakePi);

// ---------------------------------------------------------- the pipeline

setPlanDispatch(((pi: unknown, spec: { role: string; prompt: string }) => {
  // Six-lens re-review (PR #640): the prompt now starts with
  // DESCRIPTOR_DATA_FRAMING (141 chars) before the task text, so the
  // 40-char window no longer reaches "DUPLICATE RISK". Widened to 200.
  calls.push(`${spec.role}:${spec.prompt.slice(0, 200)}`);
  const ctx = (pi as { __testContext?: string }).__testContext;
  return Promise.resolve(
    __responses({ ...spec, prompt: ctx ? `${ctx}\n${spec.prompt}` : spec.prompt }),
  );
}) as never);

const FAKE_PI = {
  // biome-ignore lint/suspicious/noExplicitAny: dispatchCore is stubbed; the driver never touches pi otherwise
  registerTool: () => {},
} as any;

/** #606: a context-param fact threaded through to the gap gate prompt. */
const CONTEXT_FACT = "use the existing dispatch seam for the gate reviewer";

async function invoke(params: Record<string, unknown>) {
  const { text, details } = await invokePlanTool(tools, params);
  return { text, details };
}

{
  // dryRun:true — the confirmation seam. No filing, no gh call.
  const { details, text } = await invoke({
    descriptor: "add a start_plan_driver tool for the plan pipeline in extension",
    context: CONTEXT_FACT,
    dryRun: true,
  });
  assert(details.filed === false, "dryRun: filed is false — nothing was created");
  assert(!details.issueUrl, "dryRun: no issueUrl (there is no ticket to point at)");
  assert(/PLAN DRY-RUN/.test(text), "dryRun: the result text says nothing was filed");
  // Phase 1b duplicate-risk + Phase 2 angles + Phase 4 gate all ran.
  assert(
    calls.some((c) => c.startsWith("explore:") && c.includes("DUPLICATE RISK")),
    "Phase 1b: duplicate-risk explore dispatched",
  );
  const explores = calls.filter((c) => c.startsWith("explore:"));
  assert(
    explores.length >= 2,
    `Phase 2: ${explores.length} explores dispatched (feature = prior-art + interfaces + test-surface, conditional on code identifiers in the descriptor)`,
  );
  // Structured toolUses reach the typed sections; no prose leak (D1/D3).
  // D5 changed Technical context to show counts + prose summary, so prose
  // lines MAY appear in Technical context. The D1 regression invariant is
  // that prose does NOT leak into the TYPED sections (AC, Edge cases, etc.).
  assert(
    text.includes("the new tool registers with the exact TypeBox schema"),
    "D1: structured acceptance-criterion items reach the Acceptance criteria section",
  );
  assert(
    text.includes("a child killed mid-flight reports toolUses: []"),
    "D3: edge-case items reach the Edge cases section for a feature plan",
  );
  // The 'Task complete:' preamble may appear in Technical context (D5: prose
  // summary is now the second half of the tech line), but it must NOT appear
  // in the TYPED sections (Acceptance criteria, Edge cases, etc.).
  const typedSections = text.slice(text.indexOf("## Acceptance criteria"));
  assert(
    !typedSections.includes("Task complete:"),
    "D1 regression: the 'Task complete:' preamble does NOT leak into the TYPED sections (it may appear in Technical context per D5)",
  );
  assert(
    !typedSections.includes("registration pattern to clone"),
    "D1 regression: prose list lines are NOT parsed into the TYPED sections (structured items only)",
  );
  const gates = calls.filter((c) => c.startsWith("adversarial-developer:"));
  assert(
    gates.length === 2,
    `Phase 4: gap gate ran and iterated once on CRITICAL (gate dispatches: ${gates.length})`,
  );
  assert(
    details.capHit === true,
    "Phase 4: the second iteration cap hit is surfaced (stub re-raises the same gaps)",
  );
  assert((details.gapCount ?? 0) >= 1, `gaps returned with severity: ${details.gapCount}`);
  // #639 (re-points the Bug 3 #606 assertions to the new structured-
  // parameter semantics): the round-2 gate child receives the RE-DRAFTED
  // body — the reviewer sees the applied resolution. The resolution text
  // ("add a criterion for the retry path") is written back into the
  // Acceptance criteria section (the default destination — the resolution
  // names no specific section), AND the carried gap's Open Questions bullet
  // renders `status: resolved` with the decision owner PM. The round-2 gate
  // prompt is built from that re-draft (the makeGatePrompt thunk closes over
  // the reassigned `body`), so it contains BOTH the written-back AC bullet
  // and the resolved bullet — not just the round-1 body.
  assert(
    gatePrompts.length === 2,
    `gate prompt capture: 2 gate dispatches recorded (got ${gatePrompts.length})`,
  );
  const r2 = gatePrompts[1] ?? "";
  assert(
    r2.includes("status: open"),
    "#639: round-2 gate prompt renders the no-section resolution as status: open (Decision A branch 3, structured parameter not prefix)",
  );
  // The resolution in this test's gate reply does NOT name a section, so
  // per Decision A it falls to branch 3 (open, body unmodified). The
  // round-2 gate prompt therefore does NOT contain a writeback bullet — it
  // contains the gap description in Open Questions with status: open.
  // (The writeback test with a section-naming resolution is in
  // test-plan-gap-writeback.ts.)
  assert(
    r2.includes("status: open"),
    "#639: round-2 gate prompt renders the no-section resolution as status: open (Decision A branch 3)",
  );
  assert(
    r2.includes("missing acceptance criterion"),
    "#639: the round-1 gap description travels into the re-draft's Open Questions section",
  );
  // The resolution in this test does NOT name a section, so per Decision A
  // it falls to branch 3 (open, body unmodified) — no writeback bullet in
  // the AC section. The gap description is in Open Questions with status: open.
  // (The section-naming writeback case is covered in test-plan-gap-writeback.ts.)
  const r2Ac = r2.slice(r2.indexOf("## Acceptance criteria"), r2.indexOf("## References"));
  assert(
    !r2Ac.includes("- add a criterion for the retry path"),
    "#639: no-section resolution is NOT written back to the AC section (Decision A branch 3)",
  );
  // The Open Questions section must NOT contain a duplicate pending bullet
  // for the carried gap.
  const r2Oq = r2.slice(r2.indexOf("## Open Questions"), r2.indexOf("## Out of scope"));
  assert(
    (r2Oq.match(/status: pending/g) ?? []).length === 0,
    "#639: no pending bullet in the round-2 Open Questions (the carried gap is not re-marked open)",
  );
  assert(
    /prior-art|interfaces-and-contracts|test-surface/.test(text),
    "the spec carries the type-specialised angle names",
  );
  assert(/dryRun/i.test(text), "...and tells PM to re-call on confirmation");
  // #606 bug 1: the gap gate prompt carries the prior context with the
  // DO-NOT-RE-RAISE framing.
  assert(
    gatePrompts.length === 2,
    `gap gate prompt captured for both iterations: ${gatePrompts.length}`,
  );
  const gatePrompt = gatePrompts[0] ?? "";
  assert(
    gatePrompt.includes(CONTEXT_FACT),
    "gap gate prompt: the context-param fact reaches the gate reviewer",
  );
  assert(
    /DO NOT re-raise/i.test(gatePrompt),
    "gap gate prompt: the DO-NOT-RE-RAISE framing is present",
  );
  assert(
    /must be preceded by the GAP: marker|Never write a severity word on its own line/.test(
      gatePrompt,
    ),
    "gap gate prompt: the GAP: marker contract is specified",
  );
  gatePrompts.length = 0;
}

{
  // #606 bug 2 (e2e): a clean reply — severity words in prose only, zero
  // GAP: markers, a parsed READY verdict — is a GENUINE clean: zero gaps,
  // dispositions render '(none)'. (The old synthetic MEDIUM fallback is
  // deleted — a zero-marker NO-verdict reply is now the review-unparseable
  // fail-closed path, covered in test-plan-gate-unparseable.ts.)
  gateReplyOverride =
    "Overall the spec is solid. I considered CRITICAL and HIGH findings but found none; no MEDIUM or LOW items warrant a gap either.\nVERDICT: READY";
  const { details, text } = await invoke({
    descriptor: "add a start_plan_driver tool for the plan pipeline in extension",
    dryRun: true,
  });
  gateReplyOverride = null;
  assert(
    details.gapCount === 0 && /=== GAP DISPOSITIONS ===\n- \(none\)/.test(text),
    "severity words in prose are NOT parsed as gaps — a READY reply with zero markers is a clean '(none)'",
  );
  assert(details.capHit !== true, "READY verdict with no blocking gaps: no cap hit");
}

{
  // Chore never dispatches the LLM gap gate (deterministic validation is
  // its gate — no env knob; the old PI_ENSEMBLE_PLAN_GAP_GATE is deleted).
  const { details, text } = await invoke({
    descriptor: "bump the extension dependency pin and tidy the lockfile",
    dryRun: true,
  });
  assert(details.type === "chore", "chore classification from trigger words");
  assert(
    !calls.some((c) => c.startsWith("adversarial-developer:")),
    "Phase 4 never runs for chore (deterministic validation only, no env knob)",
  );
  assert(details.capHit !== true, "no cap hit (the gate did not run)");
  assert(/chore/.test(text), "result carries the chore type");
}

{
  // The gate always runs for feature (no env var can turn it off).
  process.env.PI_ENSEMBLE_PLAN_GAP_GATE = "0"; // must be inert — the knob is deleted
  await invoke({
    descriptor: "implement a new start_plan_driver tool with a five-phase pipeline",
    dryRun: true,
  });
  assert(
    calls.some((c) => c.startsWith("adversarial-developer:")),
    "gate runs unconditionally for feature types (the deleted env var is inert)",
  );
  delete process.env.PI_ENSEMBLE_PLAN_GAP_GATE;
}

console.log(`\nexit ${exit}`);

// D4 sub-issues + D3 edge-cases (moved from test-plan-tool.ts along the 500-line seam)

{
  // D4: sub-issues come from tool calls, not line splits (the old path
  // line-split decomposition prose with minLen=6 + a 4-word blocklist, so
  // junk like "Deps: none" / "## subIssues[]" survived into the spec).
  const subs = extractPlanItems(
    [
      {
        name: "report_plan_item",
        arguments: { kind: "sub-issue", text: "Retry backoff config — scope: the retry module" },
      },
      {
        name: "report_plan_item",
        arguments: { kind: "sub-issue", text: "Timeout surfaces — scope: spawn.ts" },
      },
    ],
    "decomposition-surface",
  );
  const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  const { body } = draftSpec(
    "epic",
    "epic descriptor",
    [
      {
        name: "decomposition-surface",
        ok: true,
        text: "Task complete: decomposed the epic.\n## subIssues[]\n- Retry backoff config\nDeps: none\nOrder: 2",
        toolUses: subs,
      },
    ],
    [],
    [],
    [],
    1,
    NO_DIRS,
    [],
  );
  const subSection = body.slice(body.indexOf("## Sub-issues"));
  assert(
    subSection.includes("Retry backoff config — scope: the retry module"),
    "D4: sub-issue text comes from the tool call (title + scope intact)",
  );
  assert(
    subSection.includes("Timeout surfaces — scope: spawn.ts"),
    "D4: second sub-issue from tool call",
  );
  assert(
    !subSection.includes("Deps: none"),
    "D4: line-split junk ('Deps: none') does not reach the spec",
  );
  assert(!subSection.includes("## subIssues[]"), "D4: heading debris does not reach the spec");
  assert(!subSection.includes("Task complete:"), "D4: the prose preamble does not reach the spec");
  // #633: the sub-issue prose line-split fallback is DELETED. With the driver's
  // aggregate all-angles-failed guard, this path is unreachable — if zero angles
  // produced structured items, the pipeline halts before draftSpec. So when
  // epicSubIssues has zero sub-issue items, it returns [] and the caller renders
  // the "(decomposition not available)" fallback string. No prose parsing at all.
  const prose = draftSpec(
    "epic",
    "epic descriptor",
    [
      {
        name: "decomposition-surface",
        ok: true,
        text: "## subIssues[]\n- first sub-task one\n- second sub-task two\nDeps: none\nOrder: 2",
        toolUses: [],
      },
    ],
    [],
    [],
    [],
    1,
    NO_DIRS,
    [],
  );
  const proseSection = prose.body.slice(prose.body.indexOf("## Sub-issues"));
  assert(
    proseSection.includes("(decomposition not available)"),
    "#633: zero sub-issue items → '(decomposition not available)' fallback, no prose parsing",
  );
  assert(
    !proseSection.includes("first sub-task one"),
    "#633: prose lines do NOT become checkboxes",
  );
  assert(
    !proseSection.includes("second sub-task two"),
    "#633: no prose line-split into sub-issues",
  );
  assert(!proseSection.includes("Deps: none"), "#633: no junk in the sub-issues section");
  assert(
    !proseSection.includes("## subIssues[]"),
    "#633: no heading debris in the sub-issues section",
  );
}

{
  // D3: edge cases populate for a feature-type plan — the old filter matched
  // only angle names "risk-surface" / "reproduction-surface", so for
  // feature/epic/chore/spike it matched nothing and the fallback string
  // printed even when the operator supplied an explicit pitfalls list.
  const edgeItems = extractPlanItems(
    [
      {
        name: "report_plan_item",
        arguments: {
          kind: "edge-case",
          text: "the retry path must not double-fire on provider timeout",
          angle: "test-surface",
        },
      },
    ],
    "test-surface",
  );
  const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  const { body } = draftSpec(
    "feature",
    "add a retry path to the plan driver",
    [{ name: "test-surface", ok: true, text: "summary", toolUses: edgeItems }],
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  const edgeSection = body.slice(body.indexOf("## Edge cases"));
  assert(
    edgeSection.includes("the retry path must not double-fire on provider timeout"),
    "D3: edge-case items from ANY angle populate the Edge cases section for a feature plan",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
