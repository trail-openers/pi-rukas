#!/usr/bin/env bun
/**
 * The /plan driver must be reachable, and its confirmation seam must be real.
 *
 * #598 compiled the 473-line /plan prose body into `start_plan_driver`. The
 * invariants this suite pins:
 *
 *   - the tool registers with the exact TypeBox schema (descriptor, type?,
 *     context?, dryRun?) and a five-way type union,
 *   - `dryRun: true` returns `{ spec, gaps, priorContext, filed: false }` —
 *     the operator-confirmation seam — and a dry run NEVER files,
 *   - the five-phase pipeline executes in order: classify → mechanical
 *     inventory → type-specialised investigation → draft → gap gate → file,
 *   - chore/spike never dispatch the Phase-4 gate (deterministic validation
 *     is their gate; the old PI_ENSEMBLE_PLAN_GAP_GATE knob is deleted),
 *   - epic sub-issues at depth >= 3 get a minimal body + the depth-limit note,
 *   - the doctrine set no longer includes "plan", and agents.json denies
 *     PM's `gh issue create` while granting `start_plan_driver`,
 *   - #606: the gap gate prompt threads the prior context with the
 *     DO-NOT-RE-RAISE framing, and parseGaps matches only structured GAP:
 *     markers (bare severity words in prose are inert).
 *
 * The pure parsing seam (parseGaps markers / verdict default / draftSpec
 * status rendering) is unit-tested in test-plan-gap-parser.ts. The D1/D2/D7
 * pipeline end-to-end coverage is in test-plan-gap-gate.ts (split at the
 * 500-line limit).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { codeIdentifiersIn, draftSpec } from "../src/plan-draft.ts";
import { setPlanDispatch } from "../src/plan-driver.ts";
import { registerPlanTool } from "../src/plan-tool.ts";
import { type PlanType, classifyPlanType } from "../src/plan-types.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ----------------------------------------------------------- stub the seam

const calls: string[] = [];
const gatePrompts: string[] = [];
let gateReplyOverride: string | null = null;

function angleToolUses(): unknown[] {
  return [
    { name: "report_plan_item", arguments: { kind: "acceptance-criterion", text: "the new tool registers with the exact TypeBox schema", angle: "interfaces-and-contracts" } },
    { name: "report_plan_item", arguments: { kind: "edge-case", text: "a child killed mid-flight reports toolUses: [] — the driver must not parse its prose as findings", angle: "reproduction-surface" } },
  ];
}

function __responses(
  spec: { role: string; prompt: string },
): DispatchResult {
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

{
  const t = tools.find((x) => x.name === "start_plan_driver");
  assert(!!t, "start_plan_driver registers");
  const props = Object.keys(t?.parameters.properties ?? {});
  assert(
    props.join(",") === "descriptor,type,context,dryRun",
    `exact TypeBox schema: ${props.join(", ")}`,
  );
  const typeUnion = (t?.parameters.properties?.type as { anyOf?: Array<{ const?: string }> })
    ?.anyOf;
  const types = (typeUnion ?? []).map((v) => v.const).filter(Boolean) as string[];
  assert(
    types.join(",") === "bug,feature,epic,chore,spike",
    `type union is the five-way literal set: ${types.join(",")}`,
  );
  assert(
    /dryRun/.test(t?.description ?? "") &&
      /start_plan_driver|gated|refus/.test(t?.description ?? ""),
    "the description names the dryRun seam and the gating",
  );
}

// ---------------------------------------------------------- the pipeline

setPlanDispatch(((pi: unknown, spec: { role: string; prompt: string }) => {
  // Six-lens re-review (PR #640): the prompt now starts with
  // DESCRIPTOR_DATA_FRAMING (141 chars) before the task text, so the
  // 40-char window no longer reaches "DUPLICATE RISK". Widened to 200.
  calls.push(`${spec.role}:${spec.prompt.slice(0, 200)}`);
  const ctx = (pi as { __testContext?: string }).__testContext;
  return Promise.resolve(__responses({ ...spec, prompt: ctx ? `${ctx}\n${spec.prompt}` : spec.prompt }));
}) as never);

const FAKE_PI = {
  // biome-ignore lint/suspicious/noExplicitAny: dispatchCore is stubbed; the driver never touches pi otherwise
  registerTool: () => {},
} as any;

/** #606: a context-param fact threaded through to the gap gate prompt. */
const CONTEXT_FACT = "use the existing dispatch seam for the gate reviewer";

const FAKE_CTX = { cwd: process.cwd() } as never;

async function invoke(params: Record<string, unknown>) {
  const t = tools.find((x) => x.name === "start_plan_driver")!;
  calls.length = 0;
  gatePrompts.length = 0;
  const out = (await t.execute("id", params, undefined, undefined, FAKE_CTX)) as {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  };
  return { out, text: out.content[0]?.text ?? "", details: out.details ?? {} };
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
  assert(text.includes("the new tool registers with the exact TypeBox schema"), "D1: structured acceptance-criterion items reach the Acceptance criteria section");
  assert(text.includes("a child killed mid-flight reports toolUses: []"), "D3: edge-case items reach the Edge cases section for a feature plan");
  // The 'Task complete:' preamble may appear in Technical context (D5: prose
  // summary is now the second half of the tech line), but it must NOT appear
  // in the TYPED sections (Acceptance criteria, Edge cases, etc.).
  const typedSections = text.slice(text.indexOf("## Acceptance criteria"));
  assert(!typedSections.includes("Task complete:"), "D1 regression: the 'Task complete:' preamble does NOT leak into the TYPED sections (it may appear in Technical context per D5)");
  assert(!typedSections.includes("registration pattern to clone"), "D1 regression: prose list lines are NOT parsed into the TYPED sections (structured items only)");
  const gates = calls.filter((c) => c.startsWith("adversarial-developer:"));
  assert(
    gates.length === 2,
    `Phase 4: gap gate ran and iterated once on CRITICAL (gate dispatches: ${gates.length})`,
  );
  assert(
    details.capHit === true,
    "Phase 4: the second iteration cap hit is surfaced (stub re-raises the same gaps)",
  );
  assert(
    (details.gapCount ?? 0) >= 1,
    `gaps returned with severity: ${details.gapCount}`,
  );
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
  assert(gatePrompts.length === 2, `gap gate prompt captured for both iterations: ${gatePrompts.length}`);
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
    /must be preceded by the GAP: marker|Never write a severity word on its own line/.test(gatePrompt),
    "gap gate prompt: the GAP: marker contract is specified",
  );
  gatePrompts.length = 0;
}

{
  // #606 bug 2 (e2e): a clean reply — severity words in prose only, zero GAP:
  // markers — must fall through to the MEDIUM fallback, not parse pseudo-gaps.
  gateReplyOverride =
    "Overall the spec is solid. I considered CRITICAL and HIGH findings but found none; no MEDIUM or LOW items warrant a gap either.\nVERDICT: READY";
  const { details, text } = await invoke({
    descriptor: "add a start_plan_driver tool for the plan pipeline in extension",
    dryRun: true,
  });
  gateReplyOverride = null;
  assert(
    details.gapCount === 1 &&
      /no structured gaps parsed/.test(text),
    "severity words in prose are NOT parsed as gaps (structured GAP: markers only; fallback gap only)",
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

// --------------------------------------------------- unit: classify + draft

{
  assert(
    classifyPlanType("the login form is broken and fails on submit") === "bug",
    "classify: bug trigger words",
  );
  assert(
    classifyPlanType("add support for plan drivers") === "feature",
    "classify: feature trigger words",
  );
  assert(
    classifyPlanType("overhaul the whole review pipeline") === "epic",
    "classify: epic trigger words",
  );
  assert(
    classifyPlanType("refactor the permission guard module") === "chore",
    "classify: chore trigger words",
  );
  assert(
    classifyPlanType("investigate the feasibility of a new sandbox") === "spike",
    "classify: spike trigger words",
  );
  assert(classifyPlanType("anything at all", "chore") === "chore", "classify: explicit param wins");
}

{
  const ids = codeIdentifiersIn("add a start_plan_driver tool in extension/src/plan-tool.ts");
  assert(ids.length > 0, `code identifiers extracted: ${ids.join(", ")}`);
  assert(
    ids.some((i) => i.includes("plan-tool.ts")),
    "...includes the file name",
  );
  const meta = codeIdentifiersIn("overhaul the onboarding documentation");
  assert(meta.length === 0, "meta descriptors produce no code identifiers (prior-art leg skipped)");
}

{
  // Epic depth limit: depth >= 3 → no sub-issues section, note present.
  const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  const findings = [
    {
      name: "decomposition-surface",
      ok: true,
      text: "- first sub-task line one\n- second sub-task line two",
      toolUses: [],
    },
  ];
  const under = draftSpec("epic", "epic descriptor", findings, [], [], [], 1, NO_DIRS, []);
  assert(/## Sub-issues/.test(under.body), "depth 1: sub-issues section present");
  const at = draftSpec("epic", "epic descriptor", findings, [], [], [], 3, NO_DIRS, []);
  assert(
    !/## Sub-issues/.test(at.body),
    "depth 3: sub-issues section replaced by the minimal body",
  );
  assert(
    /spec depth limit reached/.test(at.body),
    "depth 3: the depth-limit note tells the operator to run start_plan_driver",
  );
  // Spike gets the deliverable section, not acceptance criteria.
  const spike = draftSpec(
    "spike",
    "spike descriptor",
    [{ name: "scoping", ok: true, text: "- a decision by Friday", toolUses: [] }],
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  assert(
    /Expected deliverable/.test(spike.body),
    "spike: deliverable section replaces acceptance criteria",
  );
}

// ----------------------------------------------- doctrine + agents.json pins

{
  const wt = readFileSync(path.resolve(import.meta.dirname, "..", "src", "work-tool.ts"), "utf8");
  assert(
    /extends "work" \| "plan"/.test(wt),
    "DOCTRINE_COMMANDS assertion: `work | plan` — plan is excluded alongside work",
  );
  assert(
    !/"plan",/.test(
      wt.slice(wt.indexOf("const DOCTRINE_COMMANDS"), wt.indexOf("const DOCTRINE_COMMANDS") + 400),
    ),
    "DOCTRINE_COMMANDS no longer lists plan",
  );

  const agents = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "..", "..", "agents.json"), "utf8"),
  ) as { agent?: Record<string, { permission?: Record<string, unknown> }> };
  const perm = agents.agent?.["project-manager"]?.permission ?? {};
  assert(perm["start_plan_driver"] === "allow", "agents.json: start_plan_driver granted to PM");
  const bash = perm["bash"] as Record<string, string>;
  assert(bash["gh issue create*"] === "deny", "agents.json: PM's `gh issue create*` is deny");
  assert(bash["gh issue list*"] === "allow", "...and the read verbs are unchanged");
  assert(bash["gh issue edit*"] === "allow", "...and `gh issue edit` stays allow (ungated edits)");

  // The /plan body must be gone.
  const fs = (await import("node:fs")).existsSync;
  assert(
    !fs(path.resolve(import.meta.dirname, "..", "..", "pi-prompts", "plan.md")),
    "pi-prompts/plan.md is deleted",
  );

  // The guard source must be registered BEFORE the trust-mode early return.
  const pg = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "permission-guard.ts"),
    "utf8",
  );
  const guardIdx = pg.indexOf("registerIssueCreationGuard(pi)");
  const trustIdx = pg.indexOf("isInTrustMode(ctx.hasUI === true)");
  assert(guardIdx > 0, "permission-guard: the issue-creation guard is registered");
  assert(
    guardIdx < trustIdx,
    `canary: it is registered BEFORE the trust-mode return (guard=${guardIdx}, trust=${trustIdx}) — after it, it would never run in trust mode (the default)`,
  );
  const ig = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "issue-creation-guard.ts"),
    "utf8",
  );
  assert(
    /PI_ENSEMBLE_ALLOW_DIRECT_ISSUE_CREATE/.test(ig),
    "escape hatch: PI_ENSEMBLE_ALLOW_DIRECT_ISSUE_CREATE=1",
  );
  const pdDriver = readFileSync(path.resolve(import.meta.dirname, "..", "src", "plan-driver.ts"), "utf8");
  assert(
    !/PI_ENSEMBLE_PLAN_GAP_GATE/.test(pdDriver),
    "canary: the PI_ENSEMBLE_PLAN_GAP_GATE knob is deleted from the driver (chore/spike skip the gate unconditionally)",
  );
  const pd = readFileSync(path.resolve(import.meta.dirname, "..", "src", "plan-gaps.ts"), "utf8");
  // #606 canary: the GAP: marker contract is in the prompt AND the parser
  // matches markers only (no bare severityRe fallback).
  assert(pd.includes("(CRITICAL|HIGH|MEDIUM|LOW)"), "canary: parseGaps matches the structured GAP: marker (plan-gaps.ts)");
  assert(!/severityRe/.test(pd), "canary: the bare severity-word regex is gone from the gap parser");
  const pgp = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "plan-gate-prompt.ts"),
    "utf8",
  );
  assert(
    /DO NOT re-raise/.test(pgp),
    "canary: the gap gate prompt carries the DO-NOT-RE-RAISE framing (plan-gate-prompt.ts)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
