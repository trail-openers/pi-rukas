#!/usr/bin/env bun
/**
 * #1043 — the /plan investigation cache (plan-investigation-cache.ts).
 *
 * A confirmed dry run reuses its inventory + investigation barrier when the
 * descriptor, context, type and git HEAD are unchanged and the entry is
 * inside the expiry. Drafting, validation and the gap gate ALWAYS re-run;
 * the gate is seeded with the prior dry run's gaps as "already settled" on a
 * miss. Covered: hit reuse, HEAD / context / type / expiry misses, the key's
 * sensitivity to each input, a cached duplicate-risk HIGH still halting, a
 * halted dry run writing nothing, and the reuse statement in the rendered
 * result.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import {
  type CacheInputs,
  investigationCacheKey,
  setPlanGitStateFn,
} from "../src/plan-investigation-cache.ts";
import { type RegisteredPlanTool, registerPlanTool } from "../src/plan-tool.ts";
import type { PlanDriverInput, PlanResult } from "../src/plan-types.ts";
import {
  forgeStub,
  gatePrompts,
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

let head = "a".repeat(40);
let cacheDir = "";
const tmpDirs: string[] = [];
let dupReply = "DUPLICATE_RISK: none — no overlapping open work";
const log = { explore: 0, gate: 0 };

async function newCache(): Promise<void> {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "plan-inv-cache-"));
  tmpDirs.push(cacheDir);
  head = "a".repeat(40);
  setPlanGitStateFn(async () => ({ head, cacheDir }));
}

async function cacheFiles(): Promise<string[]> {
  try {
    return (await readdir(cacheDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

async function mutateEntry(
  fn: (e: { createdAt: number; barrier: Record<string, unknown> }) => void,
) {
  const [f] = await cacheFiles();
  const p = path.join(cacheDir, f ?? "");
  const e = JSON.parse(await readFile(p, "utf8"));
  fn(e);
  await writeFile(p, JSON.stringify(e));
}

/** Counting dispatch: every explore (duplicate-risk + angles) and gate call. */
function installDispatch(gates: string[]) {
  log.explore = 0;
  log.gate = 0;
  gatePrompts.length = 0;
  setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
    if (spec.role === "adversarial-developer") {
      gatePrompts.push(spec.prompt);
      const text = gates[Math.min(log.gate, gates.length - 1)] ?? "";
      log.gate++;
      return Promise.resolve({
        role: spec.role,
        ok: true,
        text,
        toolUses: [],
        ms: 1,
        exitCode: 0,
      });
    }
    log.explore++;
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        role: "explore",
        ok: true,
        text: dupReply,
        toolUses: [],
        ms: 1,
        exitCode: 0,
      });
    }
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "summary prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: {
            kind: "acceptance-criterion",
            text: "the tool registers",
            angle: "x",
          },
        },
      ],
      ms: 1,
      exitCode: 0,
    });
  }) as never);
}

function pipeline(input: Partial<PlanDriverInput> = {}): Promise<PlanResult> {
  return runPlanPipeline({} as never, { descriptor: DESC, ...input }, REPO);
}

installOfflineVipuneStub();
installForgeStub();

// ------------------------------------------------------------- key

{
  const base: CacheInputs = { descriptor: DESC, type: "feature", head: "h1" };
  const k = investigationCacheKey(base);
  assert(k === investigationCacheKey({ ...base }), "key is stable for identical inputs");
  assert(k !== investigationCacheKey({ ...base, head: "h2" }), "key changes with git HEAD");
  assert(k !== investigationCacheKey({ ...base, type: "bug" }), "key changes with the type");
  assert(
    k !== investigationCacheKey({ ...base, descriptor: `${DESC} now` }),
    "key changes with the descriptor",
  );
  const ctx = (c: string | undefined) => investigationCacheKey({ ...base, context: c });
  assert(ctx(undefined) !== ctx(""), "absent context is distinct from the empty string");
  assert(ctx("") !== ctx(" "), "empty context is distinct from whitespace-only");
  assert(ctx(undefined) !== ctx("note"), "key changes with the context");
}

// ------------------------------------------------------------- hit

await newCache();
installDispatch([GAP_HIGH]);
const dry = await pipeline({ dryRun: true });
assert(!dry.filed && !dry.filingFailure, "dry run: not filed and no filing failure");
assert((await cacheFiles()).length === 1, "successful dry run stores one cache entry");
assert(log.explore > 0, "dry run dispatches the investigation barrier");

installDispatch([GAP_HIGH]);
const conf = await pipeline();
assert(log.explore === 0, "confirming run with unchanged inputs dispatches no investigation");
assert(log.gate >= 1, "confirming run still dispatches the gap gate");
assert(
  conf.investigationReused !== undefined && conf.investigationReused.ageMs >= 0,
  "confirming run reports the reuse with the dry run's age",
);
assert(conf.filed, "confirming run files the reviewed spec");
assert(!gatePrompts.some((p) => p.includes("ALREADY SETTLED")), "a cache hit never seeds the gate");
assert(conf.spec.includes("the tool registers"), "drafted body is built from the cached findings");
assert(!conf.timings?.some((t) => t.phase === "inventory"), "inventory is not re-run on a hit");
assert(forgeStub.created.length >= 1, "filing still goes through the forge");

// ------------------------------------------------------------- HEAD miss (+ gate seed)

await newCache();
installDispatch([GAP_HIGH]);
await pipeline({ dryRun: true });
head = "b".repeat(40);
installDispatch([GAP_HIGH]);
const headMiss = await pipeline();
assert(
  log.explore > 0 && headMiss.investigationReused === undefined,
  "HEAD change misses and re-runs the barrier",
);
assert(
  (gatePrompts[0] ?? "").includes("ALREADY SETTLED") &&
    (gatePrompts[0] ?? "").includes("the spec omits the rollback path"),
  "a miss seeds the gap gate with the prior dry run's gap as already settled",
);

// ------------------------------------------------------------- no prior run: no seed

await newCache();
installDispatch([GAP_HIGH]);
await pipeline();
assert(
  !gatePrompts.some((p) => p.includes("ALREADY SETTLED")),
  "a miss with no prior dry run seeds nothing",
);

// ------------------------------------------------------------- context miss

await newCache();
installDispatch([GAP_HIGH]);
await pipeline({ dryRun: true });
installDispatch([GAP_HIGH]);
const ctxMiss = await pipeline({ context: "" });
assert(
  log.explore > 0 && ctxMiss.investigationReused === undefined,
  "empty-string context misses (absent ≠ empty)",
);

await newCache();
installDispatch([GAP_HIGH]);
await pipeline({
  dryRun: true,
  context: "Prior research: the rollback path is out of scope.",
});
installDispatch([GAP_HIGH]);
const ctxMiss2 = await pipeline({
  context: "Prior research: the rollback path is in scope.",
});
assert(
  log.explore > 0 && ctxMiss2.investigationReused === undefined,
  "a changed context misses and re-runs the barrier",
);

// ------------------------------------------------------------- type miss

await newCache();
installDispatch([GAP_HIGH]);
await pipeline({ dryRun: true });
installDispatch([GAP_HIGH]);
const typeMiss = await pipeline({ type: "bug" });
assert(
  log.explore > 0 && typeMiss.investigationReused === undefined,
  "a different type misses and re-runs the barrier",
);

// ------------------------------------------------------------- expiry

await newCache();
installDispatch([GAP_HIGH]);
await pipeline({ dryRun: true });
await mutateEntry((e) => {
  e.createdAt = Date.now() - 3 * 60 * 60_000;
});
installDispatch([GAP_HIGH]);
const expired = await pipeline();
assert(
  log.explore > 0 && expired.investigationReused === undefined,
  "an entry past the 2h expiry misses and re-runs the barrier",
);

// ------------------------------------------------------------- cached duplicate-risk HIGH halts

await newCache();
installDispatch([GAP_HIGH]);
await pipeline({ dryRun: true });
await mutateEntry((e) => {
  e.barrier.duplicateRisk = { level: "high", rationale: "duplicates #5" };
});
installDispatch([GAP_HIGH]);
const halted = await pipeline();
assert(
  !halted.filed && halted.filingFailure?.reason === "duplicate-risk",
  "a cached duplicate-risk HIGH still halts with duplicate-risk",
);
assert(log.gate === 0, "a cached duplicate-risk HIGH never reaches the gap gate");

// ------------------------------------------------------------- halted dry run writes nothing

await newCache();
dupReply = "DUPLICATE_RISK: high — duplicates #5 which is still open";
installDispatch([GAP_HIGH]);
const haltedDry = await pipeline({ dryRun: true });
dupReply = "DUPLICATE_RISK: none — no overlapping open work";
assert(
  haltedDry.filingFailure?.reason === "duplicate-risk",
  "dry run halted on duplicate-risk HIGH",
);
assert((await cacheFiles()).length === 0, "a halted dry run writes no cache entry");

// ------------------------------------------------------------- rendered result

{
  const tools: RegisteredPlanTool[] = [];
  const fakePi = {
    registerTool(def: RegisteredPlanTool) {
      tools.push(def);
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub; only registerTool is used
  } as any;
  registerPlanTool(fakePi);
  await newCache();
  installDispatch([GAP_HIGH]);
  await invokePlanTool(tools, { descriptor: DESC, dryRun: true });
  installDispatch([GAP_HIGH]);
  const hit = await invokePlanTool(tools, { descriptor: DESC });
  assert(
    hit.text.includes("INVESTIGATION REUSED"),
    "a reused investigation is stated in the rendered result",
  );
  assert(
    hit.details.investigationReused !== undefined,
    "a reused investigation is carried on the details",
  );
  head = "c".repeat(40);
  installDispatch([GAP_HIGH]);
  const miss = await invokePlanTool(tools, { descriptor: DESC });
  assert(
    !miss.text.includes("INVESTIGATION REUSED"),
    "a miss does not claim a reuse in the rendered result",
  );
}

// ------------------------------------------------------------- teardown

setPlanGitStateFn(null);
setPlanDispatch(null);
for (const d of tmpDirs) await rm(d, { recursive: true, force: true });

console.log(`\nexit ${exit}`);
process.exit(exit);
