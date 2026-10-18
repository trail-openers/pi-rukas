#!/usr/bin/env bun
/**
 * #1043 — the /plan investigation cache (plan-investigation-cache.ts).
 *
 * A confirmed dry run reuses its inventory + investigation barrier when the
 * descriptor, context, type and git HEAD are unchanged and the entry is
 * inside the expiry. Drafting, validation and the gap gate ALWAYS re-run;
 * the gate is seeded with the prior dry run's gaps as "already settled".
 * Covered: hit reuse, HEAD / context / type / expiry misses, the key's
 * sensitivity to each input, a cached duplicate-risk HIGH still halting, a
 * halted dry run writing nothing, and the reuse statement in the rendered
 * result.
 */

import {
  type CacheInputs,
  investigationCacheKey,
  resolvePlanGitState,
} from "../src/plan-investigation-cache.ts";
import { type RegisteredPlanTool, registerPlanTool } from "../src/plan-tool.ts";
import {
  DESC,
  GAP_CRITICAL,
  GAP_HIGH,
  REPO,
  cacheFiles,
  cacheState,
  forgeStub,
  gatePrompts,
  installCountingDispatch,
  installForgeStub,
  installOfflineVipuneStub,
  invokePlanTool,
  log,
  makeJobDeliverer,
  mutateEntry,
  newPlanCache,
  pipeline,
  teardownPlanCache,
} from "./plan-test-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

installOfflineVipuneStub();
installForgeStub();

// ------------------------------------------------------------- isolation canary

// verify-loop.sh exports PI_ENSEMBLE_PLAN_CACHE=0: the real git-state lookup must
// then return nothing, so no offline test can write the clone's real cache. Set
// and unset explicitly here, so the canary holds standalone and under the loop.
{
  const prior = process.env.PI_ENSEMBLE_PLAN_CACHE;
  process.env.PI_ENSEMBLE_PLAN_CACHE = "0";
  const localBase = { readRoot: REPO, baseSha: "a".repeat(40), release: async () => undefined };
  const off = await resolvePlanGitState(REPO, localBase);
  delete process.env.PI_ENSEMBLE_PLAN_CACHE;
  const on = await resolvePlanGitState(REPO, localBase);
  if (prior === undefined) delete process.env.PI_ENSEMBLE_PLAN_CACHE;
  else process.env.PI_ENSEMBLE_PLAN_CACHE = prior;
  assert(off === undefined, "canary: PI_ENSEMBLE_PLAN_CACHE=0 disables the real git-state lookup");
  assert(
    on?.keySha === "a".repeat(40),
    "canary: unset, the real lookup keys on the run's origin SHA",
  );
}

// ------------------------------------------------------------- key

{
  const base: CacheInputs = { descriptor: DESC, type: "feature", keySha: "h1" };
  const k = investigationCacheKey(base);
  assert(k === investigationCacheKey({ ...base }), "key is stable for identical inputs");
  assert(
    k !== investigationCacheKey({ ...base, keySha: "h2" }),
    "key changes with origin/<default>",
  );
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

await newPlanCache();
installCountingDispatch([GAP_HIGH]);
const dry = await pipeline({ dryRun: true });
assert(!dry.filed && !dry.filingFailure, "dry run: not filed and no filing failure");
assert((await cacheFiles()).length === 1, "successful dry run stores one cache entry");
assert(log.explore > 0, "dry run dispatches the investigation barrier");

installCountingDispatch([GAP_HIGH]);
const conf = await pipeline({ reviewedDigest: dry.reviewedDigest });
assert(log.explore === 0, "confirming run with unchanged inputs dispatches no investigation");
assert(log.gate === 0, "#1043: a fileable dry run's confirm dispatches no gap gate");
assert(
  conf.filedFromDryRun !== undefined && conf.filedFromDryRun.ageMs >= 0,
  "a fileable confirm reports the verbatim filing with the dry run's age",
);
assert(conf.filed, "confirming run files the reviewed spec");
assert(conf.spec.includes("the tool registers"), "the filed spec is the cached reviewed body");
assert(!conf.timings?.some((t) => t.phase === "inventory"), "inventory is not re-run on a hit");
assert(forgeStub.created.length >= 1, "filing still goes through the forge");

// ------------------------------------------------------------- non-fileable hit: barrier reuse + gate seed

await newPlanCache();
// Non-fileable = the review never completed (corrective round, then unreadable).
installCountingDispatch([GAP_CRITICAL, "", ""]);
await pipeline({ dryRun: true });
installCountingDispatch([GAP_CRITICAL, "", ""]);
const nonFileable = await pipeline();
assert(log.explore === 0, "a non-fileable dry run's confirm reuses the investigation");
assert(log.gate >= 1, "a non-fileable dry run's confirm still runs the gap gate");
assert(
  nonFileable.investigationReused !== undefined && !nonFileable.filed,
  "a non-fileable confirm reports the reuse and does not file verbatim",
);
assert(
  (gatePrompts[0] ?? "").includes("ALREADY SETTLED"),
  "a non-fileable hit seeds the gate with the dry run's settled gaps",
);

// ------------------------------------------------------------- HEAD miss (+ gate seed)

await newPlanCache();
installCountingDispatch([GAP_HIGH]);
await pipeline({ dryRun: true });
cacheState.keySha = "b".repeat(40);
installCountingDispatch([GAP_HIGH]);
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

await newPlanCache();
installCountingDispatch([GAP_HIGH]);
await pipeline();
assert(
  !gatePrompts.some((p) => p.includes("ALREADY SETTLED")),
  "a miss with no prior dry run seeds nothing",
);

// ------------------------------------------------------------- context miss

await newPlanCache();
installCountingDispatch([GAP_HIGH]);
await pipeline({ dryRun: true });
installCountingDispatch([GAP_HIGH]);
const ctxMiss = await pipeline({ context: "" });
assert(
  log.explore > 0 && ctxMiss.investigationReused === undefined,
  "empty-string context misses (absent ≠ empty)",
);

await newPlanCache();
installCountingDispatch([GAP_HIGH]);
await pipeline({
  dryRun: true,
  context: "Prior research: the rollback path is out of scope.",
});
installCountingDispatch([GAP_HIGH]);
const ctxMiss2 = await pipeline({
  context: "Prior research: the rollback path is in scope.",
});
assert(
  log.explore > 0 && ctxMiss2.investigationReused === undefined,
  "a changed context misses and re-runs the barrier",
);

// ------------------------------------------------------------- type miss

await newPlanCache();
installCountingDispatch([GAP_HIGH]);
await pipeline({ dryRun: true });
installCountingDispatch([GAP_HIGH]);
const typeMiss = await pipeline({ type: "bug" });
assert(
  log.explore > 0 && typeMiss.investigationReused === undefined,
  "a different type misses and re-runs the barrier",
);

// ------------------------------------------------------------- expiry

await newPlanCache();
installCountingDispatch([GAP_HIGH]);
await pipeline({ dryRun: true });
await mutateEntry((e) => {
  e.createdAt = Date.now() - 3 * 60 * 60_000;
});
installCountingDispatch([GAP_HIGH]);
const expired = await pipeline();
assert(
  log.explore > 0 && expired.investigationReused === undefined,
  "an entry past the 2h expiry misses and re-runs the barrier",
);

// ------------------------------------------------------------- schema-drifted entry is a miss

await newPlanCache();
installCountingDispatch([GAP_HIGH]);
await pipeline({ dryRun: true });
await mutateEntry((e) => {
  e.barrier.neverClaimDisclosure = undefined; // JSON drops it on write
});
installCountingDispatch([GAP_HIGH]);
const drifted = await pipeline();
assert(
  log.explore > 0 && drifted.investigationReused === undefined,
  "an entry missing a barrier field is a miss, not a crash",
);

// ------------------------------------------------------------- cached duplicate-risk HIGH halts

await newPlanCache();
installCountingDispatch([GAP_CRITICAL]);
await pipeline({ dryRun: true });
await mutateEntry((e) => {
  e.barrier.duplicateRisk = { level: "high", rationale: "duplicates #5" };
});
installCountingDispatch([GAP_HIGH]);
const halted = await pipeline();
assert(
  !halted.filed && halted.filingFailure?.reason === "duplicate-risk",
  "a cached duplicate-risk HIGH still halts with duplicate-risk",
);
assert(log.gate === 0, "a cached duplicate-risk HIGH never reaches the gap gate");

// ------------------------------------------------------------- halted dry run writes nothing

await newPlanCache();
installCountingDispatch([GAP_HIGH], "DUPLICATE_RISK: high — duplicates #5 which is still open");
const haltedDry = await pipeline({ dryRun: true });
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
    // #1044: the launched job's report is delivered to the registered pi.
    ...makeJobDeliverer(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub; registerTool + delivery
  } as any;
  registerPlanTool(fakePi);
  await newPlanCache();
  installCountingDispatch([GAP_CRITICAL]);
  await invokePlanTool(tools, { descriptor: DESC, dryRun: true });
  installCountingDispatch([GAP_CRITICAL]);
  const hit = await invokePlanTool(tools, { descriptor: DESC });
  assert(
    hit.text.includes("INVESTIGATION REUSED"),
    "a reused investigation is stated in the rendered result",
  );
  assert(
    hit.text.includes("working tree was NOT compared"),
    "a reused investigation states that the working tree was not compared",
  );
  assert(
    hit.details.investigationReused !== undefined,
    "a reused investigation is carried on the details",
  );
  cacheState.keySha = "c".repeat(40);
  installCountingDispatch([GAP_HIGH]);
  const miss = await invokePlanTool(tools, { descriptor: DESC });
  assert(
    !miss.text.includes("INVESTIGATION REUSED"),
    "a miss does not claim a reuse in the rendered result",
  );
}

// ------------------------------------------------------------- #1043 review: shape guard covers every dereferenced field

await newPlanCache();
installCountingDispatch([GAP_HIGH]);
await pipeline({ dryRun: true });
await mutateEntry((e) => {
  e.barrier.findings = [{}]; // a finding with no name/ok/toolUses: the pipeline would crash on it
});
installCountingDispatch([GAP_HIGH]);
const hollow = await pipeline();
assert(
  log.explore > 0 && hollow.investigationReused === undefined,
  "a barrier finding missing its fields is a miss, and the pipeline runs",
);

// ------------------------------------------------------------- teardown

await teardownPlanCache();

console.log(`\nexit ${exit}`);
process.exit(exit);
