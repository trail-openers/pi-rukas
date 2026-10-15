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
import { runPlan } from "../src/work-driver-plan.ts";
import {
  deriveContractEdges,
  detectPortReference,
  foldPortPlan,
  mergeWithContract,
  symbolKey,
} from "../src/work-driver-plan-contract.ts";
import { mergeCoupledWorkstreams } from "../src/work-driver-plan-coupling.ts";
import { parseWorkstreams } from "../src/work-driver-plan-workstreams.ts";
import { inlinePlanPrompt } from "../src/work-driver-prompts-early.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { foldTwo } from "../src/workstream-fold.ts";

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
const PLAN_1297 = [
  "## Workstreams",
  "",
  "### ws-1 — errorStop shape",
  "- paths: extension/src/types.ts",
  "- out-of-scope: extension/src/work-driver-failure-taxonomy.ts",
  "- introduces: `errorStop.providerRepeats`",
  "",
  "### ws-2 — failure taxonomy",
  "- paths: extension/src/work-driver-failure-taxonomy.ts",
  "- introduces: isFinalProviderFault()",
  "",
  "### ws-3 — consumers",
  "- paths: extension/src/work-driver-adversarial-reentry.ts, extension/src/work-driver-step-router.ts",
  "- consumes: providerRepeats, isFinalProviderFault",
  "",
  "### ws-4 — producers",
  "- paths: extension/src/adversarial-retry.ts, extension/src/adversarial-classify.ts",
  "- consumes: errorStop.providerRepeats",
  "",
].join("\n");

const DISJOINT = [
  "## Workstreams",
  "",
  "### task-a — docs",
  "- paths: docs/a.md",
  "",
  "### task-b — script",
  "- paths: scripts/b.sh",
  "",
].join("\n");

// ── parsing ─────────────────────────────────────────────────────────────
{
  const ws = parseWorkstreams(PLAN_1297);
  assert(
    JSON.stringify(ws["ws-1"]?.introduces) === JSON.stringify(["`errorStop.providerRepeats`"]),
    "parse: `introduces:` is read",
  );
  assert(
    JSON.stringify(ws["ws-3"]?.consumes) ===
      JSON.stringify(["providerRepeats", "isFinalProviderFault"]),
    "parse: `consumes:` is read as a comma list",
  );
  const plain = parseWorkstreams(DISJOINT);
  assert(
    !("introduces" in (plain["task-a"] ?? {})) && !("consumes" in (plain["task-a"] ?? {})),
    "parse: a plan without contract lines carries no contract keys (pre-#1322 shape)",
  );
}

// ── symbol keys ─────────────────────────────────────────────────────────
assert(symbolKey("`errorStop.providerRepeats`") === "providerRepeats", "key: qualified → last segment");
assert(symbolKey("isFinalProviderFault()") === "isFinalProviderFault", "key: call parens dropped");
assert(symbolKey("Mod::thing (new)") === "thing", "key: :: and annotation handled");
assert(symbolKey("(none)") === undefined, "key: prose is not a symbol");

// ── derived edges ───────────────────────────────────────────────────────
{
  const { workstreams, edges } = deriveContractEdges(parseWorkstreams(PLAN_1297));
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
  const plain = parseWorkstreams(DISJOINT);
  const none = deriveContractEdges(plain);
  assert(
    none.edges.length === 0 && JSON.stringify(none.workstreams) === JSON.stringify(plain),
    "edges: a plan with no contract is unchanged",
  );
  const self = deriveContractEdges({
    a: { id: "a", scope: "a", paths: ["x"], outOfScope: [], introduces: ["s"], consumes: ["s"] },
  });
  assert(self.edges.length === 0, "edges: a symbol a workstream introduces itself is no edge");
  const base = deriveContractEdges({
    a: { id: "a", scope: "a", paths: ["x"], outOfScope: [], introduces: ["s"] },
    b: { id: "b", scope: "b", paths: ["y"], outOfScope: [], consumes: ["existingAtBase"] },
  });
  assert(base.edges.length === 0, "edges: a consumed symbol no sibling introduces is no edge");
}

// ── the #1297 shape through the coupling merge ──────────────────────────
{
  const merged = await mergeWithContract(parseWorkstreams(PLAN_1297), (w) =>
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
  const raw = await mergeWithContract(
    parseWorkstreams(PLAN_1297.replace(/^- (introduces|consumes):.*$/gm, "")),
    (w) => mergeCoupledWorkstreams(w),
  );
  assert(
    Object.keys(raw.workstreams).length === 4 && !raw.changed,
    "no contract: today's single pass, four workstreams",
  );
  process.env.PI_ENSEMBLE_PLAN_CONTRACT = "0";
  const off = await mergeWithContract(parseWorkstreams(PLAN_1297), (w) =>
    mergeCoupledWorkstreams(w),
  );
  assert(
    Object.keys(off.workstreams).length === 4,
    "PI_ENSEMBLE_PLAN_CONTRACT=0: no derived edges",
  );
  delete process.env.PI_ENSEMBLE_PLAN_CONTRACT;
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
    ["This was already fixed upstream in commit 0f9e8d7c6b.", "0f9e8d7c6b"],
    [
      "Landed as https://github.com/o/r/pull/12 in the fork.",
      "https://github.com/o/r/pull/12",
    ],
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
  ];
  for (const body of no) {
    assert(detectPortReference(body) === undefined, `port: no reference in "${body.slice(0, 50)}…"`);
  }
  const folded = foldPortPlan(parseWorkstreams(DISJOINT), "o/r#9");
  const ids = Object.keys(folded);
  assert(ids.length === 1 && ids[0] === "task-a", "port fold: one workstream (the first id)");
  assert(
    folded["task-a"]?.scope.startsWith("Port o/r#9: apply that change and resolve conflicts") ===
      true && folded["task-a"]?.paths.length === 2,
    "port fold: the scope is applying the change; every path kept",
  );
  const same = parseWorkstreams(DISJOINT);
  assert(foldPortPlan(same, undefined) === same, "port fold: no reference → unchanged");
}

// ── the plan prompt ─────────────────────────────────────────────────────
{
  const p = inlinePlanPrompt([1322], "/tmp/scratch");
  assert(/ONE workstream is the default/.test(p), "prompt: one workstream is the default");
  assert(/Split reason:/.test(p), "prompt: each split needs a stated reason");
  assert(/PARTITION BY CONTRACT, NOT BY FILE/.test(p), "prompt: partition by contract");
  assert(/`introduces: <identifiers>`/.test(p), "prompt: documents the introduces line");
  assert(/`consumes: <identifiers>`/.test(p), "prompt: documents the consumes line");
  assert(/cherry-pick it/.test(p), "prompt: a known commit is planned as a port");
}

// ── runPlan end to end ──────────────────────────────────────────────────
const fakePi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;
function mkResult(text: string): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-plan-contract-transcript.json",
  };
}
function stateWithBody(dir: string, body: string): WorkState {
  const artifact = path.join(dir, "issue-body.txt");
  writeFileSync(artifact, body);
  const s0 = initialState(1322, 1_000_000);
  return { ...s0, pipelineState: { ...s0.pipelineState, issueBodyArtifact: artifact } };
}
async function plan(
  body: string,
  reply: string,
): Promise<{ ws: Record<string, Workstream>; prompts: string[] }> {
  const dir = mkdtempSync(path.join(tmpdir(), "plan-contract-"));
  const prompts: string[] = [];
  try {
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 1322,
      dispatchFn: async (_pi, spec) => {
        prompts.push(spec.prompt);
        return mkResult(reply);
      },
    };
    const next = await runPlan(ctx, stateWithBody(dir, body), 1_000_000);
    return { ws: next.pipelineState.workstreams ?? {}, prompts };
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

process.exit(exit);
