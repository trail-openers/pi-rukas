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
 *   - `PI_ENSEMBLE_PLAN_GAP_GATE=0` skips Phase 4 for chore/spike types,
 *   - epic sub-issues at depth >= 3 get a minimal body + the depth-limit note,
 *   - the doctrine set no longer includes "plan", and agents.json denies
 *     PM's `gh issue create` while granting `start_plan_driver`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { codeIdentifiersIn, draftSpec } from "../src/plan-draft.ts";
import { setPlanDispatch } from "../src/plan-driver.ts";
import { registerPlanTool } from "../src/plan-tool.ts";
import { type PlanType, classifyPlanType, planTitle } from "../src/plan-types.ts";
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
//
// plan-driver.ts calls `dispatchCore` via its ESM namespace import; the
// namespace object is live, and Bun's module registry keeps the source
// module's exports writable, so we swap the binding there (not on the
// frozen-ish consumer view).

const calls: string[] = [];

function __responses(spec: { role: string; prompt: string }): DispatchResult {
  if (spec.role === "adversarial-developer") {
    return {
      role: "adversarial-developer",
      ok: true,
      text: "CRITICAL — missing acceptance criterion for the failure mode\nHIGH — no out-of-scope boundary named\nVERDICT: NEEDS_ITERATION",
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
    text: "- extension/src/plan-driver.ts:42 — existing seam for the pipeline\n- extension/src/work-tool.ts:70 — the registration pattern to clone",
    toolUses: [],
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
    `type union is the five-way literal set: ${types.join(", ")}`,
  );
  assert(
    /dryRun/.test(t?.description ?? "") &&
      /start_plan_driver|gated|refus/.test(t?.description ?? ""),
    "the description names the dryRun seam and the gating",
  );
}

// ---------------------------------------------------------- the pipeline

// Install the dispatch stub. plan-tool.ts calls runPlanPipeline, which reads
// the seam set here on every invocation.
setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
  calls.push(`${spec.role}:${spec.prompt.slice(0, 40)}`);
  return Promise.resolve(__responses(spec));
}) as never);

const FAKE_PI = {
  // biome-ignore lint/suspicious/noExplicitAny: dispatchCore is stubbed; the driver never touches pi otherwise
  registerTool: () => {},
} as any;

const FAKE_CTX = { cwd: process.cwd() } as never;

async function invoke(params: Record<string, unknown>) {
  const t = tools.find((x) => x.name === "start_plan_driver")!;
  calls.length = 0;
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
  const gates = calls.filter((c) => c.startsWith("adversarial-developer:"));
  assert(
    gates.length === 2,
    `Phase 4: gap gate ran and iterated once on CRITICAL/HIGH (gate dispatches: ${gates.length})`,
  );
  assert(
    details.capHit === true,
    "Phase 4: the second iteration cap hit is surfaced (no infinite loop)",
  );
  assert((details.gapCount ?? 0) >= 2, `gaps returned with severity: ${details.gapCount}`);
  assert(
    /prior-art|interfaces-and-contracts|test-surface/.test(text),
    "the spec carries the type-specialised angle names",
  );
  assert(/dryRun/i.test(text), "...and tells PM to re-call on confirmation");
}

{
  // PI_ENSEMBLE_PLAN_GAP_GATE=0 + chore → no gate dispatch.
  process.env.PI_ENSEMBLE_PLAN_GAP_GATE = "0";
  const { details, text } = await invoke({
    descriptor: "bump the extension dependency pin and tidy the lockfile",
    dryRun: true,
  });
  assert(details.type === "chore", "chore classification from trigger words");
  assert(
    !calls.some((c) => c.startsWith("adversarial-developer:")),
    "Phase 4 skipped for chore under PI_ENSEMBLE_PLAN_GAP_GATE=0",
  );
  assert(details.capHit !== true, "no cap hit (the gate did not run)");
  assert(/chore/.test(text), "result carries the chore type");
  delete process.env.PI_ENSEMBLE_PLAN_GAP_GATE;
}

{
  // PI_ENSEMBLE_PLAN_GAP_GATE=0 does NOT skip for non-chore/spike types.
  process.env.PI_ENSEMBLE_PLAN_GAP_GATE = "0";
  await invoke({
    descriptor: "implement a new start_plan_driver tool with a five-phase pipeline",
    dryRun: true,
  });
  assert(
    calls.some((c) => c.startsWith("adversarial-developer:")),
    "gate still runs for feature types even with the escape hatch (it only exempts chore/spike)",
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
  const findings = [
    {
      name: "decomposition-surface",
      ok: true,
      text: "- first sub-task line one\n- second sub-task line two",
    },
  ];
  const under = draftSpec("epic", "epic descriptor", findings, [], [], [], 1);
  assert(/## Sub-issues/.test(under.body), "depth 1: sub-issues section present");
  const at = draftSpec("epic", "epic descriptor", findings, [], [], [], 3);
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
    [{ name: "scoping", ok: true, text: "- a decision by Friday" }],
    [],
    [],
    [],
    0,
  );
  assert(
    /Expected deliverable/.test(spike.body),
    "spike: deliverable section replaces acceptance criteria",
  );
}

{
  const t = planTitle("add a start_plan_driver tool for the plan pipeline", "feature");
  assert(t.startsWith("feat: "), `title prefix: ${t}`);
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
  const pd = readFileSync(path.resolve(import.meta.dirname, "..", "src", "plan-driver.ts"), "utf8");
  assert(
    /PI_ENSEMBLE_PLAN_GAP_GATE === "0"/.test(pd),
    "escape hatch: PI_ENSEMBLE_PLAN_GAP_GATE=0 in the driver",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
