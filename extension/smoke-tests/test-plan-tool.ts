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
import { calls, invokePlanTool, setPlanVipuneStub } from "./plan-test-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------- registration

import type { RegisteredPlanTool } from "../src/plan-tool.ts";

const tools: RegisteredPlanTool[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal stub; only registerTool is used
const fakePi = {
  registerTool(def: RegisteredPlanTool) {
    tools.push(def);
  },
} as any;

registerPlanTool(fakePi);

// ----------------------------------------------------------- dispatch stub

const gatePrompts: string[] = [];
const gateReplyOverride: string | null = null;

function __responses(spec: { role: string; prompt: string }): any {
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
  if (spec.prompt.includes("DUPLICATE RISK CHECK"))
    return {
      role: "explore",
      ok: true,
      text: "DUPLICATE_RISK: none — no overlapping open work",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    };
  return {
    role: "explore",
    ok: true,
    text: "Task complete: investigated the work area.\n\n- extension/src/plan-driver.ts:42 — existing seam for the pipeline",
    toolUses: [
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
    ],
    ms: 1,
    exitCode: 0,
  };
}

setPlanDispatch(((pi: unknown, spec: { role: string; prompt: string }) => {
  calls.push(`${spec.role}:${spec.prompt.slice(0, 200)}`);
  const ctx = (pi as { __testContext?: string }).__testContext;
  return Promise.resolve(
    __responses({ ...spec, prompt: ctx ? `${ctx}\n${spec.prompt}` : spec.prompt }),
  );
}) as never);

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

// ------------------------------------------- #858: title, dedup, vipune

{
  // #858 e2e: a long descriptor's dry-run title is ≤ 72 chars TOTAL, ends
  // without "…", and starts with the conventional type prefix.
  const longDesc =
    "add a start_plan_driver tool for the plan pipeline in extension; it should gate issue creation behind a compiled seam with a dryRun confirmation and per-phase timings plus structured gap-gate verdicts, discriminated filing failures, and a residual-disclosure union disclosed in the filed body and the operator-visible cap message of the result.";
  const { details, text } = await invokePlanTool(tools, { descriptor: longDesc, dryRun: true });
  const title = (details.title as string) ?? "";
  assert(title.length > 0, "#858 title: the dry-run result carries a title");
  assert(title.length <= 72, `#858 title: ≤ 72 chars TOTAL (got ${title.length}): ${title}`);
  assert(!title.includes("…"), "#858 title: no ellipsis in the filed title");
  assert(title.startsWith("feat: "), `#858 title: conventional type prefix (got ${title})`);
  void text;
}

{
  // #858 AC dedup: the angle stub's criterion is "the new tool registers with
  // the exact TypeBox schema"; the operator supplies a case/whitespace/
  // punctuation-modulo duplicate. The AC section must render it ONCE (first
  // occurrence — the operator's — wins) and the duplicate never appears a
  // second time.
  const dup = "THE NEW TOOL REGISTERS WITH THE EXACT TYPEBOX SCHEMA.";
  const { text } = await invokePlanTool(tools, {
    descriptor: "add a start_plan_driver tool for the plan pipeline in extension",
    context: `ACCEPTANCE CRITERIA:\n- ${dup}`,
    dryRun: true,
  });
  const ac = text.slice(text.indexOf("## Acceptance criteria"), text.indexOf("## References"));
  const needle = "the new tool registers with the exact typebox schema";
  const occ = ac.toLowerCase().split(needle).length - 1;
  assert(
    occ === 1,
    `#858 AC dedup: the case-differing duplicate renders exactly once (occurrences: ${occ})`,
  );
  assert(
    ac.includes(dup),
    "#858 AC dedup: first occurrence wins (the operator's line is the one rendered)",
  );
}

{
  // #858 typed-block lines leave the FILED-body inventory: an ACCEPTANCE
  // CRITERIA block renders each criterion in its section and NOT in the
  // Prior context inventory (only untyped prose lines appear there).
  const acLine = "the retry path is covered by a stubbed-dispatch test";
  const prose = "the operator established the seam layout before this run";
  const { text } = await invokePlanTool(tools, {
    descriptor: "add a start_plan_driver tool for the plan pipeline in extension",
    context: `prose line one that stays in the inventory\nACCEPTANCE CRITERIA:\n- ${acLine}\n\n${prose}`,
    dryRun: true,
  });
  const inv = text.slice(
    text.indexOf("## Prior context inventory"),
    text.indexOf("## Technical context"),
  );
  const ac = text.slice(text.indexOf("## Acceptance criteria"), text.indexOf("## References"));
  assert(
    ac.includes(acLine),
    "#858 inventory: the typed AC bullet renders in the Acceptance criteria section",
  );
  assert(
    !inv.includes(acLine),
    "#858 inventory: the typed AC bullet is ABSENT from the Prior context inventory",
  );
  assert(
    !inv.includes("ACCEPTANCE CRITERIA:"),
    "#858 inventory: the heading line is ABSENT from the inventory",
  );
  assert(
    inv.includes("prose line one that stays in the inventory"),
    "#858 inventory: an untyped prose line still renders in the inventory",
  );
  assert(
    inv.includes(prose),
    "#858 inventory: a second untyped prose line renders in the inventory",
  );
}

{
  // #858 vipune relevance filter: a row below the semantic floor (or missing
  // the hybrid agreement bit) is dropped; a row passing BOTH legs survives.
  const LOW = {
    id: "low1",
    content: "task-b dispatch smoke test confirmed explore role tooling",
    similarity: 0.2,
  };
  const HIGH = {
    id: "high1",
    content: "the vipune search seam is in src/vipune.ts",
    similarity: 0.9,
  };
  setPlanVipuneStub(async (_q, o) => ({
    kind: "hits",
    hits: o?.hybrid ? [HIGH] : [LOW, HIGH],
  }));
  const { text } = await invokePlanTool(tools, {
    descriptor: "add a start_plan_driver tool for the plan pipeline in extension",
    dryRun: true,
  });
  setPlanVipuneStub(null);
  const inv = text.slice(
    text.indexOf("## Prior context inventory"),
    text.indexOf("## Technical context"),
  );
  assert(
    !inv.includes("task-b dispatch smoke test"),
    "#858 vipune: the low-score row is ABSENT from the inventory",
  );
  assert(
    inv.includes("the vipune search seam is in src/vipune.ts"),
    "#858 vipune: a row passing floor + agreement is PRESENT in the inventory",
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
  const pdDriver = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "plan-driver.ts"),
    "utf8",
  );
  assert(
    !/PI_ENSEMBLE_PLAN_GAP_GATE/.test(pdDriver),
    "canary: the PI_ENSEMBLE_PLAN_GAP_GATE knob is deleted from the driver (chore/spike skip the gate unconditionally)",
  );
  const pd = readFileSync(path.resolve(import.meta.dirname, "..", "src", "plan-gaps.ts"), "utf8");
  // #606 canary: the GAP: marker contract is in the prompt AND the parser
  // matches markers only (no bare severityRe fallback).
  assert(
    pd.includes("(CRITICAL|HIGH|MEDIUM|LOW)"),
    "canary: parseGaps matches the structured GAP: marker (plan-gaps.ts)",
  );
  assert(
    !/severityRe/.test(pd),
    "canary: the bare severity-word regex is gone from the gap parser",
  );
  const pgp = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "plan-gate-prompt.ts"),
    "utf8",
  );
  assert(
    /DO NOT re-raise/.test(pgp),
    "canary: the gap gate prompt carries the DO-NOT-RE-RAISE framing (plan-gate-prompt.ts)",
  );
}

process.exit(exit);
