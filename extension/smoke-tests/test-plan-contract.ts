#!/usr/bin/env bun
/**
 * #1322 — plan threaded changes as one workstream.
 *
 * Workstreams may declare `introduces:` / `consumes:` symbols. A consumed
 * symbol a sibling introduces becomes a derived `dependsOn` edge, which the
 * #1005 coupling merge folds (rule 2). The #1297 plan shape (a type field and
 * an export in their own workstreams, their consumers in others) must end as
 * one workstream, never as parallel siblings. An issue that names an existing
 * commit or PR to port plans as one workstream. A plan that declares no
 * symbols, on an issue that names no port, takes the pre-#1322 path.
 *
 * Fully offline: runPlan with an injected dispatchFn, PI_ENSEMBLE_RESUME=0,
 * PI_ENSEMBLE_CROSS_GROUP_CONFLICTS=0.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  deriveContractEdges,
  detectPortReference,
  foldPortPlan,
  mergeWithContract,
  symbolKey,
} from "../src/work-driver-plan-contract.ts";
import { mergeCoupledWorkstreams } from "../src/work-driver-plan-coupling.ts";
import { runPlan } from "../src/work-driver-plan.ts";
import { inlinePlanPrompt } from "../src/work-driver-prompts-early.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { foldTwo } from "../src/workstream-fold.ts";
import {
  type PlanResultShape,
  type WorkstreamArgs,
  planResultFromCalls,
  workstreamsOfCalls,
} from "./lib/plan-workstream-calls.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_RESUME = "0";
process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";
delete process.env.PI_ENSEMBLE_PLAN_CONTRACT;

// The #1297 plan, as the planner should have declared it.
const PLAN_1297: WorkstreamArgs[] = [
  {
    id: "ws-1",
    scope: "errorStop shape",
    paths: ["extension/src/types.ts"],
    outOfScope: ["extension/src/work-driver-failure-taxonomy.ts"],
    introduces: ["`errorStop.providerRepeats`"],
  },
  {
    id: "ws-2",
    scope: "failure taxonomy",
    paths: ["extension/src/work-driver-failure-taxonomy.ts"],
    outOfScope: [],
    introduces: ["isFinalProviderFault()"],
  },
  {
    id: "ws-3",
    scope: "consumers",
    paths: [
      "extension/src/work-driver-adversarial-reentry.ts",
      "extension/src/work-driver-step-router.ts",
    ],
    outOfScope: [],
    consumes: ["providerRepeats", "isFinalProviderFault"],
  },
  {
    id: "ws-4",
    scope: "producers",
    paths: ["extension/src/adversarial-retry.ts", "extension/src/adversarial-classify.ts"],
    outOfScope: [],
    consumes: ["errorStop.providerRepeats"],
  },
];

const DISJOINT: WorkstreamArgs[] = [
  { id: "task-a", scope: "docs", paths: ["docs/a.md"], outOfScope: [] },
  { id: "task-b", scope: "script", paths: ["scripts/b.sh"], outOfScope: [] },
];

/** The same plan with its contract lines removed (the pre-#1322 shape). */
function withoutContract(calls: WorkstreamArgs[]): WorkstreamArgs[] {
  return calls.map(({ introduces: _i, consumes: _c, ...rest }) => rest);
}

// ── parsing ─────────────────────────────────────────────────────────────
{
  const ws = workstreamsOfCalls(PLAN_1297);
  assert(
    JSON.stringify(ws["ws-1"]?.introduces) === JSON.stringify(["`errorStop.providerRepeats`"]),
    "parse: `introduces:` is read",
  );
  assert(
    JSON.stringify(ws["ws-3"]?.consumes) ===
      JSON.stringify(["providerRepeats", "isFinalProviderFault"]),
    "parse: `consumes:` is read as a comma list",
  );
  const plain = workstreamsOfCalls(DISJOINT);
  assert(
    !("introduces" in (plain["task-a"] ?? {})) && !("consumes" in (plain["task-a"] ?? {})),
    "parse: a plan without contract lines carries no contract keys (pre-#1322 shape)",
  );
}

// ── symbol keys ─────────────────────────────────────────────────────────
assert(
  symbolKey("`errorStop.providerRepeats`") === "providerRepeats",
  "key: qualified → last segment",
);
assert(symbolKey("isFinalProviderFault()") === "isFinalProviderFault", "key: call parens dropped");
assert(symbolKey("Mod::thing (new)") === "thing", "key: :: and annotation handled");
assert(symbolKey("(none)") === undefined, "key: prose is not a symbol");
for (const [raw, want] of [
  ["providerRepeats: number", "providerRepeats"],
  ["errorStop.providerRepeats?: number", "providerRepeats"],
  ["`providerRepeats`: number", "providerRepeats"],
  ["foo?", "foo"],
  ["foo!,", "foo"],
  ["export function isFinalProviderFault", "isFinalProviderFault"],
  ["export const LIMIT", "LIMIT"],
  ["new type Cause", "Cause"],
  ["interface Workstream", "Workstream"],
  ["field providerRepeats", "providerRepeats"],
  ["class Foo", "Foo"],
  ["enum Kind", "Kind"],
  ["let x1", "x1"],
] as const) {
  assert(symbolKey(raw) === want, `key: "${raw}" → ${want} (got ${symbolKey(raw)})`);
}
assert(symbolKey("export function") === undefined, "key: only keywords → no symbol");

// ── derived edges ───────────────────────────────────────────────────────
{
  const { workstreams, edges } = deriveContractEdges(workstreamsOfCalls(PLAN_1297));
  assert(edges.length === 3, `edges: 3 derived (got ${edges.length})`);
  assert(
    JSON.stringify([...(workstreams["ws-3"]?.dependsOn ?? [])].sort()) ===
      JSON.stringify(["ws-1", "ws-2"]),
    "edges: the consumer depends on both introducers",
  );
  assert(
    JSON.stringify(workstreams["ws-4"]?.dependsOn) === JSON.stringify(["ws-1"]),
    "edges: the producer of the new field depends on the type change",
  );
  const plain = workstreamsOfCalls(DISJOINT);
  const none = deriveContractEdges(plain);
  assert(
    none.edges.length === 0 && JSON.stringify(none.workstreams) === JSON.stringify(plain),
    "edges: a plan with no contract is unchanged",
  );
  const self = deriveContractEdges({
    a: {
      id: "a",
      scope: "a",
      paths: ["x"],
      outOfScope: [],
      introduces: ["s"],
      consumes: ["s"],
    },
  });
  assert(self.edges.length === 0, "edges: a symbol a workstream introduces itself is no edge");
  const base = deriveContractEdges({
    a: { id: "a", scope: "a", paths: ["x"], outOfScope: [], introduces: ["s"] },
    b: {
      id: "b",
      scope: "b",
      paths: ["y"],
      outOfScope: [],
      consumes: ["existingAtBase"],
    },
  });
  assert(base.edges.length === 0, "edges: a consumed symbol no sibling introduces is no edge");
}

// ── the #1297 shape through the coupling merge ──────────────────────────
{
  const merged = await mergeWithContract(workstreamsOfCalls(PLAN_1297), (w) =>
    mergeCoupledWorkstreams(w),
  );
  const ids = Object.keys(merged.workstreams);
  assert(ids.length === 1, `#1297 shape: ends as ONE workstream (got ${ids.join(", ")})`);
  const only = merged.workstreams[ids[0] ?? ""];
  assert(only?.paths.length === 6, "#1297 shape: every file is in the merged workstream");
  assert(!only?.dependsOn, "#1297 shape: no dangling depends-on edge survives");
  assert(
    only?.introduces?.includes("isFinalProviderFault()") === true,
    "#1297 shape: the merged workstream keeps the contract",
  );
  // Without the contract the same plan stays four parallel siblings — the
  // pre-#1322 failure, still what an undeclared plan gets.
  const raw = await mergeWithContract(workstreamsOfCalls(withoutContract(PLAN_1297)), (w) =>
    mergeCoupledWorkstreams(w),
  );
  assert(
    Object.keys(raw.workstreams).length === 4 && !raw.changed,
    "no contract: today's single pass, four workstreams",
  );
  process.env.PI_ENSEMBLE_PLAN_CONTRACT = "0";
  const off = await mergeWithContract(workstreamsOfCalls(PLAN_1297), (w) =>
    mergeCoupledWorkstreams(w),
  );
  assert(
    Object.keys(off.workstreams).length === 4,
    "PI_ENSEMBLE_PLAN_CONTRACT=0: no derived edges",
  );
  delete process.env.PI_ENSEMBLE_PLAN_CONTRACT;
}

// ── the #1297 shape written with type annotations still merges ─────────
{
  const typed: WorkstreamArgs[] = [
    { ...PLAN_1297[0], introduces: ["`errorStop.providerRepeats?: number`"] },
    { ...PLAN_1297[1], introduces: ["export function isFinalProviderFault"] },
    { ...PLAN_1297[2], consumes: ["`providerRepeats`: number", "isFinalProviderFault"] },
    { ...PLAN_1297[3], consumes: ["providerRepeats: number"] },
  ];
  const merged = await mergeWithContract(workstreamsOfCalls(typed), (w) =>
    mergeCoupledWorkstreams(w),
  );
  assert(
    Object.keys(merged.workstreams).length === 1,
    `#1297 shape, typed symbols: ends as ONE workstream (got ${Object.keys(merged.workstreams).join(", ")})`,
  );
}

// ── fold keeps the contract ─────────────────────────────────────────────
{
  const f = foldTwo(
    { id: "a", scope: "a", paths: ["x"], outOfScope: [], introduces: ["s"] },
    { id: "b", scope: "b", paths: ["y"], outOfScope: [], consumes: ["s", "t"] },
  );
  assert(
    f.introduces?.[0] === "s" && f.consumes?.length === 2,
    "fold: introduces / consumes are unioned",
  );
  const plain = foldTwo(
    { id: "a", scope: "a", paths: ["x"], outOfScope: [] },
    { id: "b", scope: "b", paths: ["y"], outOfScope: [] },
  );
  assert(!("introduces" in plain) && !("consumes" in plain), "fold: no contract keys added");
}

// ── port detection ──────────────────────────────────────────────────────
{
  const yes: Array<[string, string]> = [
    ["Found and fixed in janit/pi-rukas#81 — port it.", "janit/pi-rukas#81"],
    ["Please cherry-pick 1a2b3c4d onto main.", "1a2b3c4d"],
    ["Port the fix from PR #81.", "PR #81"],
    ["Backport #412 to the release line.", "#412"],
    ["It regressed last week. Port janit/pi-rukas#81 to fix it.", "janit/pi-rukas#81"],
    ["This was already fixed upstream in commit 0f9e8d7c6b.", "0f9e8d7c6b"],
    ["Landed as https://github.com/o/r/pull/12 in the fork.", "https://github.com/o/r/pull/12"],
  ];
  for (const [body, ref] of yes) {
    const got = detectPortReference(body);
    assert(got === ref, `port: "${body}" → ${ref} (got ${got})`);
  }
  const no = [
    "Related: #1005 (the coupling merge), #1250.",
    "The same change already existed as one commit in a fork, and cherry-picking it needed two import-conflict fixes (PR #1321).",
    "Fixed in #1200 but it regressed.",
    "Implement the port scanner for #33.",
    "Add a deadbeef constant.",
    "Do not cherry-pick #12; it is the wrong fix.",
    "Don't port janit/pi-rukas#81 — rewrite it.",
    "We should never backport 1a2b3c4d.",
    "This regressed by 0f9e8d7c6b.",
    "Fixed in 1a2b3c4d, then regressed by janit/pi-rukas#90.",
  ];
  for (const body of no) {
    assert(
      detectPortReference(body) === undefined,
      `port: no reference in "${body.slice(0, 50)}…"`,
    );
  }
  const folded = foldPortPlan(workstreamsOfCalls(DISJOINT), "o/r#9");
  const ids = Object.keys(folded);
  assert(ids.length === 1 && ids[0] === "task-a", "port fold: one workstream (the first id)");
  assert(
    folded["task-a"]?.scope.startsWith("Port o/r#9: apply that change and resolve conflicts") ===
      true && folded["task-a"]?.paths.length === 2,
    "port fold: the scope is applying the change; every path kept",
  );
  const same = workstreamsOfCalls(DISJOINT);
  assert(foldPortPlan(same, undefined) === same, "port fold: no reference → unchanged");
}

// ── the plan prompt ─────────────────────────────────────────────────────
{
  const p = inlinePlanPrompt([1322], "/tmp/scratch");
  assert(/ONE workstream is the default/.test(p), "prompt: one workstream is the default");
  assert(/Split reason:/.test(p), "prompt: each split needs a stated reason");
  assert(/PARTITION BY CONTRACT, NOT BY FILE/.test(p), "prompt: partition by contract");
  assert(/`introduces`/.test(p), "prompt: documents the introduces field");
  assert(/`consumes`/.test(p), "prompt: documents the consumes field");
  assert(/cherry-pick it/.test(p), "prompt: a known commit is planned as a port");
}

// ── runPlan end to end ──────────────────────────────────────────────────
const fakePi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;
function mkResult(plan: PlanResultShape): DispatchResult {
  return {
    role: "explore",
    ok: true,
    ...plan,
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-plan-contract-transcript.json",
  };
}
function stateWithBody(dir: string, body: string): WorkState {
  const artifact = path.join(dir, "issue-body.txt");
  writeFileSync(artifact, body);
  const s0 = initialState(1322, 1_000_000);
  return {
    ...s0,
    pipelineState: { ...s0.pipelineState, issueBodyArtifact: artifact },
  };
}
async function plan(
  body: string,
  reply: WorkstreamArgs[],
): Promise<{
  ws: Record<string, Workstream>;
  prompts: string[];
  reason?: string;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), "plan-contract-"));
  const prompts: string[] = [];
  try {
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 1322,
      dispatchFn: async (_pi, spec) => {
        prompts.push(spec.prompt);
        return mkResult(planResultFromCalls(reply));
      },
    };
    const next = await runPlan(ctx, stateWithBody(dir, body), 1_000_000);
    return {
      ws: next.pipelineState.workstreams ?? {},
      prompts,
      reason: next.pipelineState.planQuality?.reason,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const r = await plan("Thread providerRepeats through the retry pipeline.", PLAN_1297);
  assert(Object.keys(r.ws).length === 1, "runPlan: the #1297 plan is stored as ONE workstream");
  assert(r.prompts.length === 1, "runPlan: no corrective re-plan was needed");
  assert(!/## Port detected/.test(r.prompts[0] ?? ""), "runPlan: no port section without a port");
}
{
  const r = await plan("Two unrelated chores.", DISJOINT);
  assert(
    Object.keys(r.ws).length === 2 && r.ws["task-a"]?.scope === "docs",
    "runPlan: a contract-less disjoint plan keeps today's split",
  );
}
{
  const r = await plan("Already fixed in janit/pi-rukas#81; port it upstream.", DISJOINT);
  assert(/## Port detected/.test(r.prompts[0] ?? ""), "runPlan: the prompt names the port");
  assert(/janit\/pi-rukas#81/.test(r.prompts[0] ?? ""), "runPlan: the port reference is quoted");
  const ids = Object.keys(r.ws);
  assert(
    ids.length === 1 && /^Port janit\/pi-rukas#81: /.test(r.ws[ids[0] ?? ""]?.scope ?? ""),
    "runPlan: a port issue is planned as one cherry-pick workstream",
  );
}
{
  // #1652 — a plan with no report_workstream call is no plan: one corrective,
  // and an empty corrective parks. There is no synthetic `default` to fall back
  // to, so the port scope the old fallback carried has nothing to attach to.
  const r = await plan("Already fixed in janit/pi-rukas#81; port it upstream.", []);
  assert(r.prompts.length === 2, "runPlan: a plan with no call gets exactly one corrective");
  assert(Object.keys(r.ws).length === 0, "runPlan: an empty corrective parks with no workstreams");
  assert(
    r.reason === "plan-spec-mismatch",
    "runPlan: the empty corrective parks as plan-spec-mismatch",
  );
}

process.exit(exit);
