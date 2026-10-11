#!/usr/bin/env bun
/**
 * #1043 — an identical confirm files the REVIEWED dry-run spec (plan-confirm.ts).
 *
 * A fileable dry run caches its drafted title + body and its verdict. An
 * identical confirm (descriptor, context, type, git HEAD; inside the expiry)
 * files exactly those bytes with ZERO investigation, drafting or gate
 * dispatches. Covered: the zero-dispatch verbatim filing, the byte-identical
 * body, the non-fileable and changed-input / HEAD / expiry / malformed misses
 * (each runs the full pipeline), and that a successful filing consumes the
 * entry so a repeated confirm cannot file the same spec twice.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { setPlanGitStateFn } from "../src/plan-investigation-cache.ts";
import { type RegisteredPlanTool, registerPlanTool } from "../src/plan-tool.ts";
import type { PlanDriverInput, PlanResult } from "../src/plan-types.ts";
import {
  forgeStub,
  installForgeStub,
  installOfflineVipuneStub,
  invokePlanTool,
} from "./plan-test-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const DESC = "add a start_plan_driver tool for the plan pipeline in extension";
const REPO = process.cwd();
const GAP_HIGH =
  "GAP: HIGH — the spec omits the rollback path — proposed resolution: add a rollback section\nVERDICT: READY";
const GAP_CRITICAL =
  "GAP: CRITICAL the spec commits to both a retry cap of 3 and an infinite retry — proposed resolution: name which wins\nVERDICT: NEEDS_ITERATION";

let head = "a".repeat(40);
let cacheDir = "";
const tmpDirs: string[] = [];
const log = { explore: 0, gate: 0 };

async function newCache(): Promise<void> {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "plan-confirm-"));
  tmpDirs.push(cacheDir);
  head = "a".repeat(40);
  setPlanGitStateFn(async () => ({ head, cacheDir }));
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
}

async function cacheFiles(): Promise<string[]> {
  try {
    return (await readdir(cacheDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

async function mutateEntry(fn: (e: Record<string, any>) => void): Promise<void> {
  const [f] = await cacheFiles();
  const p = path.join(cacheDir, f ?? "");
  const e = JSON.parse(await readFile(p, "utf8"));
  fn(e);
  await writeFile(p, JSON.stringify(e));
}

/** Counts every investigation (explore) and gap-gate dispatch. */
function installDispatch(gateReply: string) {
  log.explore = 0;
  log.gate = 0;
  setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
    const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
    if (spec.role === "adversarial-developer") {
      log.gate++;
      return Promise.resolve({ ...base, role: spec.role, text: gateReply });
    }
    log.explore++;
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        ...base,
        role: "explore",
        text: "DUPLICATE_RISK: none — no overlapping open work",
      });
    }
    return Promise.resolve({
      ...base,
      role: "explore",
      text: "summary prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: { kind: "acceptance-criterion", text: "the tool registers", angle: "x" },
        },
      ],
    });
  }) as never);
}

function pipeline(input: Partial<PlanDriverInput> = {}): Promise<PlanResult> {
  return runPlanPipeline({} as never, { descriptor: DESC, ...input }, REPO);
}

installOfflineVipuneStub();
installForgeStub();

// ------------------------------------------------------------- (a) + (e) zero-dispatch verbatim filing

await newCache();
installDispatch(GAP_HIGH);
const dry = await pipeline({ dryRun: true });
assert(!dry.filed && !dry.filingFailure, "dry run: not filed");
assert((await cacheFiles()).length === 1, "fileable dry run caches one entry");

installDispatch(GAP_HIGH);
const conf = await pipeline();
assert(conf.filed === true, "identical confirm files");
assert(conf.filedFromDryRun !== undefined, "result carries filedFromDryRun");
assert(log.explore === 0, "(a) identical confirm dispatches zero investigation calls");
assert(log.gate === 0, "(a) identical confirm dispatches zero gap-gate calls");
assert(
  conf.timings?.every((t) => t.phase !== "inventory" && t.phase !== "draft") === true,
  "(a) no inventory or drafting phase ran",
);
assert(forgeStub.created.length === 1, "identical confirm creates exactly one issue");
const filed = forgeStub.created[0];
assert(filed?.body === dry.spec, "(e) the filed body is byte-identical to the dry run's spec");
assert(filed?.title === dry.title, "(e) the filed title is the dry run's title");

// ------------------------------------------------------------- consumed: a repeat is not a second copy

installDispatch(GAP_HIGH);
const repeat = await pipeline();
assert(
  repeat.filedFromDryRun === undefined,
  "a repeat confirm after filing is not a verbatim re-file",
);
assert(
  log.explore > 0,
  "a repeat confirm after filing runs the pipeline (duplicate check applies)",
);

// ------------------------------------------------------------- rendered statement

{
  const tools: RegisteredPlanTool[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub; only registerTool is used
  registerPlanTool({ registerTool: (d: RegisteredPlanTool) => tools.push(d) } as any);
  await newCache();
  installDispatch(GAP_HIGH);
  await invokePlanTool(tools, { descriptor: DESC, dryRun: true });
  installDispatch(GAP_HIGH);
  const out = await invokePlanTool(tools, { descriptor: DESC });
  assert(
    out.text.includes("FILED FROM REVIEWED DRY RUN") &&
      out.text.includes("no investigation, drafting or gap gate ran"),
    "the verbatim filing is stated in the rendered result",
  );
  assert(
    out.details.filedFromDryRun !== undefined,
    "the verbatim filing is carried on the details",
  );
}

// ------------------------------------------------------------- (b) non-fileable dry run

await newCache();
installDispatch(GAP_CRITICAL);
const blocked = await pipeline({ dryRun: true });
assert(blocked.capReason === "unresolved-blocking", "(b) dry run ends with an unresolved CRITICAL");
installDispatch(GAP_CRITICAL);
const blockedConf = await pipeline();
assert(
  blockedConf.filedFromDryRun === undefined && !blockedConf.filed,
  "(b) non-fileable dry run never files verbatim",
);
assert(log.gate > 0, "(b) confirm after a non-fileable dry run runs the gap gate");
assert(
  blockedConf.investigationReused !== undefined,
  "(b) …and still reuses the investigation barrier",
);
assert(forgeStub.created.length === 0, "(b) nothing filed");

// ------------------------------------------------------------- (c) changed context / HEAD

await newCache();
installDispatch(GAP_HIGH);
await pipeline({ dryRun: true, context: "Prior research: rollback is in scope." });
installDispatch(GAP_HIGH);
const ctxChanged = await pipeline({ context: "Prior research: rollback is out of scope." });
assert(
  ctxChanged.filedFromDryRun === undefined && log.explore > 0,
  "(c) changed context runs the full pipeline",
);

await newCache();
installDispatch(GAP_HIGH);
await pipeline({ dryRun: true });
head = "b".repeat(40);
installDispatch(GAP_HIGH);
const headChanged = await pipeline();
assert(
  headChanged.filedFromDryRun === undefined && log.explore > 0,
  "(c) moved HEAD runs the full pipeline",
);
assert(log.gate > 0, "(c) moved HEAD still runs the gap gate");

// ------------------------------------------------------------- (d) expired / malformed

await newCache();
installDispatch(GAP_HIGH);
await pipeline({ dryRun: true });
await mutateEntry((e) => {
  e.createdAt = Date.now() - 3 * 60 * 60_000;
});
installDispatch(GAP_HIGH);
const expired = await pipeline();
assert(
  expired.filedFromDryRun === undefined && log.explore > 0,
  "(d) expired entry runs the full pipeline",
);

for (const [label, mutate] of [
  [
    "reviewed block missing",
    (e: Record<string, any>) => {
      e.reviewed = undefined;
    },
  ],
  [
    "fileable not a boolean",
    (e: Record<string, any>) => {
      e.reviewed.fileable = "yes";
    },
  ],
  [
    "fileable with an empty spec",
    (e: Record<string, any>) => {
      e.reviewed.spec = "  ";
    },
  ],
] as const) {
  await newCache();
  installDispatch(GAP_HIGH);
  await pipeline({ dryRun: true });
  await mutateEntry(mutate);
  installDispatch(GAP_HIGH);
  const r = await pipeline();
  assert(
    r.filedFromDryRun === undefined && log.explore > 0,
    `(d) malformed cache (${label}) runs the full pipeline`,
  );
}

// ------------------------------------------------------------- teardown

setPlanGitStateFn(null);
setPlanDispatch(null);
for (const d of tmpDirs) await rm(d, { recursive: true, force: true });

console.log(`\nexit ${exit}`);
process.exit(exit);
