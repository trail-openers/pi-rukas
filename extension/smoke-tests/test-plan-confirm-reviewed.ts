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

import {
  mkdir,
  readdir,
  rm,
  utimes } from "node:fs/promises";
import path from "node:path";
import { fileReviewedDryRun } from "../src/plan-confirm.ts";
import {
  claimFileableDryRun,
  concurrentFilingOf,
  reviewedDigestOf,
  } from "../src/plan-filing-claim.ts";
import { type RegisteredPlanTool,
  registerPlanTool } from "../src/plan-tool.ts";
import { FORGE_BODY_MAX } from "../src/plan-validate.ts";
import {
  DESC,
  GAP_CRITICAL,
  GAP_HIGH,
  REPO,
  type RawCacheEntry,
  cacheFiles,
  cacheState,
  forgeStub,
  installCountingDispatch,
  installForgeStub,
  installOfflineVipuneStub,
  invokePlanTool,
  log,
  mutateEntry,
  newPlanCache,
  pipeline,
  teardownPlanCache,
  makeJobDeliverer,
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

// ------------------------------------------------------------- (a) + (e) zero-dispatch verbatim filing

await newPlanCache();
installCountingDispatch(GAP_HIGH);
const dry = await pipeline({ dryRun: true });
assert(!dry.filed && !dry.filingFailure, "dry run: not filed");
assert((await cacheFiles()).length === 1, "fileable dry run caches one entry");

installCountingDispatch(GAP_HIGH);
const conf = await pipeline({ reviewedDigest: dry.reviewedDigest });
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

installCountingDispatch(GAP_HIGH);
const repeat = await pipeline({ reviewedDigest: dry.reviewedDigest });
assert(
  !repeat.filed && repeat.filingFailure?.reason === "filing-in-progress",
  "a repeat confirm within the filed-marker window is refused, not re-filed",
);
assert(log.explore === 0, "the refused repeat runs no investigation");
assert(forgeStub.created.length === 1, "the repeat files nothing: still exactly one issue");

// ------------------------------------------------------------- the claim is exclusive

await newPlanCache();
installCountingDispatch(GAP_HIGH);
await pipeline({ dryRun: true });
const claimInputs = { descriptor: DESC, type: "feature" as const, keySha: cacheState.keySha };
const first = await claimFileableDryRun(cacheState.dir, claimInputs);
assert(first !== undefined, "a fileable entry can be claimed");
assert(
  (await claimFileableDryRun(cacheState.dir, claimInputs)) === undefined,
  "a second claim of the same entry is refused (no double filing)",
);
await first?.release();
assert(
  (await claimFileableDryRun(cacheState.dir, claimInputs)) !== undefined,
  "a released claim restores the entry",
);

// ------------------------------------------------------------- the race: a miss while an identical confirm is filing

await newPlanCache();
installCountingDispatch(GAP_HIGH);
await pipeline({ dryRun: true });
const raceInputs = { descriptor: DESC, type: "feature" as const, keySha: cacheState.keySha };
const held = await claimFileableDryRun(cacheState.dir, raceInputs);
installCountingDispatch(GAP_HIGH);
const raced = await fileReviewedDryRun(cacheState.dir, raceInputs, REPO, () => []);
assert(
  !!raced && !raced.filed && raced.filingFailure?.reason === "filing-in-progress",
  "a confirm that misses a claim held by an identical in-flight confirm is refused",
);
assert(
  log.explore === 0 && forgeStub.created.length === 0,
  "the refused race runs no pipeline and files nothing",
);
await held?.release();

const won = await claimFileableDryRun(cacheState.dir, raceInputs);
await won?.commit("https://example.test/issues/9");
const late = await fileReviewedDryRun(cacheState.dir, raceInputs, REPO, () => []);
assert(
  late?.filingFailure?.reason === "filing-in-progress" &&
    (late.filingFailure.detail ?? "").includes("example.test/issues/9"),
  "a confirm arriving just after a filing is refused and names the filed URL",
);

// ------------------------------------------------------------- claim freshness: a dry run 11 min old

await newPlanCache();
installCountingDispatch(GAP_HIGH);
await pipeline({ dryRun: true });
{
  // The entry file keeps the dry run's write time; a claim made now must not inherit it.
  const [f] = await cacheFiles();
  const old = (Date.now() - 11 * 60_000) / 1000;
  await utimes(path.join(cacheState.dir, f ?? ""), old, old);
}
const sessionA = await claimFileableDryRun(cacheState.dir, {
  descriptor: DESC,
  type: "feature",
  keySha: cacheState.keySha,
});
assert(sessionA !== undefined, "(f) session A claims an 11-min-old dry run");
installCountingDispatch(GAP_HIGH);
const sessionB = await pipeline();
assert(
  !sessionB.filed && sessionB.filingFailure?.reason === "filing-in-progress",
  "(f) session B's identical confirm is refused while A's claim is live, not re-run",
);
assert(
  log.explore === 0 && forgeStub.created.length === 0,
  "(f) session B runs no pipeline and files nothing",
);
installCountingDispatch(GAP_HIGH);
await pipeline({
  descriptor: "add a second unrelated plan to trigger a cache sweep",
  dryRun: true,
});
assert(
  (await readdir(cacheState.dir)).some((f) => f.endsWith(".claim")),
  "(f) a sweep from another dry run keeps the live claim",
);
await sessionA?.release();

// ------------------------------------------------------------- (g) depth is part of the key

await newPlanCache();
installCountingDispatch(GAP_HIGH);
await pipeline({ dryRun: true, depth: 0 });
installCountingDispatch(GAP_HIGH);
const deeper = await pipeline({ depth: 3 });
assert(
  deeper.filedFromDryRun === undefined && log.explore > 0,
  "(g) a confirm at depth 3 of a depth-0 dry run runs the full pipeline, not verbatim",
);
assert(forgeStub.created.length === 1, "(g) the depth-3 confirm files its own spec, once");

// ------------------------------------------------------------- (h) a halting dry run invalidates the lineage

await newPlanCache();
installCountingDispatch(GAP_HIGH);
await pipeline({ dryRun: true });
assert((await cacheFiles()).length === 1, "(h) fileable dry run is cached");
installCountingDispatch(GAP_HIGH, "DUPLICATE_RISK: high — overlaps an open issue entirely");
const haltedDry = await pipeline({ dryRun: true });
assert(
  haltedDry.filingFailure?.reason === "duplicate-risk",
  "(h) second dry run halts on duplicate-risk HIGH",
);
assert((await cacheFiles()).length === 0, "(h) the halting dry run drops the stale fileable entry");
installCountingDispatch(GAP_HIGH);
const afterHalt = await pipeline();
assert(
  afterHalt.filedFromDryRun === undefined && log.explore > 0 && afterHalt.filed,
  "(h) confirm after a halting dry run runs the full pipeline, not verbatim",
);

// ------------------------------------------------------------- rendered statement

{
  const tools: RegisteredPlanTool[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub; only registerTool is used
  registerPlanTool({
    registerTool: (d: RegisteredPlanTool) => tools.push(d),
    ...makeJobDeliverer(),
  } as any);
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  const dryOut = await invokePlanTool(tools, { descriptor: DESC, dryRun: true });
  installCountingDispatch(GAP_HIGH);
  const out = await invokePlanTool(tools, {
    descriptor: DESC,
    reviewedDigest: dryOut.details.reviewedDigest,
  });
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
// #1132 addendum: a CRITICAL alone is fileable (filed at the cap with open points).
// A non-fileable dry run is one whose review never completed: a corrective round,
// then an unreadable reply that the strict retry does not rescue.

await newPlanCache();
installCountingDispatch([GAP_CRITICAL, "", ""]);
const blocked = await pipeline({ dryRun: true });
assert(
  blocked.capReason === "review-unparseable",
  "(b) dry run ends unreviewed (review-unparseable)",
);
installCountingDispatch([GAP_CRITICAL, "", ""]);
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

await newPlanCache();
installCountingDispatch(GAP_HIGH);
await pipeline({ dryRun: true, context: "Prior research: rollback is in scope." });
installCountingDispatch(GAP_HIGH);
const ctxChanged = await pipeline({ context: "Prior research: rollback is out of scope." });
assert(
  ctxChanged.filedFromDryRun === undefined && log.explore > 0,
  "(c) changed context runs the full pipeline",
);

await newPlanCache();
installCountingDispatch(GAP_HIGH);
await pipeline({ dryRun: true });
cacheState.keySha = "b".repeat(40);
installCountingDispatch(GAP_HIGH);
const headChanged = await pipeline();
assert(
  headChanged.filedFromDryRun === undefined && log.explore > 0,
  "(c) moved HEAD runs the full pipeline",
);
assert(log.gate > 0, "(c) moved HEAD still runs the gap gate");

// ------------------------------------------------------------- (d) expired / malformed

await newPlanCache();
installCountingDispatch(GAP_HIGH);
await pipeline({ dryRun: true });
await mutateEntry((e) => {
  e.createdAt = Date.now() - 3 * 60 * 60_000;
});
installCountingDispatch(GAP_HIGH);
const expired = await pipeline();
assert(
  expired.filedFromDryRun === undefined && log.explore > 0,
  "(d) expired entry runs the full pipeline",
);

for (const [label, mutate] of [
  [
    "reviewed block missing",
    (e: RawCacheEntry) => {
      e.reviewed = undefined;
    },
  ],
  [
    "fileable not a boolean",
    (e: RawCacheEntry) => {
      if (e.reviewed) e.reviewed.fileable = "yes";
    },
  ],
  [
    "fileable with an empty spec",
    (e: RawCacheEntry) => {
      if (e.reviewed) e.reviewed.spec = "  ";
    },
  ],
] as const) {
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  await pipeline({ dryRun: true });
  await mutateEntry(mutate);
  installCountingDispatch(GAP_HIGH);
  const r = await pipeline();
  assert(
    r.filedFromDryRun === undefined && log.explore > 0,
    `(d) malformed cache (${label}) runs the full pipeline`,
  );
}

// ------------------------------------------------------------- #1043 review: the digest binds the verbatim filing

{
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  const d = await pipeline({ dryRun: true });
  assert(
    typeof d.reviewedDigest === "string" && /^[0-9a-f]{16}$/.test(d.reviewedDigest),
    "a fileable dry run reports a 16-hex reviewedDigest",
  );
  installCountingDispatch(GAP_HIGH);
  const v = await pipeline({ reviewedDigest: d.reviewedDigest });
  assert(
    v.filedFromDryRun !== undefined && log.explore === 0 && log.gate === 0,
    "(1) a correct digest files verbatim with zero dispatches",
  );
  assert(forgeStub.created[0]?.body === d.spec, "(1) the verbatim body is the digest-bound spec");
}

{
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  await pipeline({ dryRun: true });
  installCountingDispatch(GAP_HIGH);
  const noDigest = await pipeline();
  assert(
    noDigest.filedFromDryRun === undefined && log.gate > 0 && noDigest.filed,
    "(2) an identical confirm with no digest runs the normal pipeline",
  );
}

{
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  await pipeline({ dryRun: true });
  const inputs = { descriptor: DESC, type: "feature" as const, keySha: cacheState.keySha };
  assert(
    (await claimFileableDryRun(cacheState.dir, inputs, { digest: "0000000000000000" })) ===
      undefined,
    "(3) a claim with a wrong digest is refused",
  );
  assert((await cacheFiles()).length === 1, "(3) the refused claim restores the entry");
  installCountingDispatch(GAP_HIGH);
  const wrong = await pipeline({ reviewedDigest: "0000000000000000" });
  assert(
    wrong.filedFromDryRun === undefined && log.gate > 0,
    "(3) a wrong digest runs the normal pipeline",
  );
}

{
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  const t = await pipeline({ dryRun: true });
  await mutateEntry((e) => {
    if (e.reviewed) e.reviewed.spec = `${String(e.reviewed.spec)}\n\nINJECTED-AFTER-DRY-RUN`;
  });
  installCountingDispatch(GAP_HIGH);
  const tampered = await pipeline({ reviewedDigest: t.reviewedDigest });
  assert(
    tampered.filedFromDryRun === undefined && log.gate > 0,
    "(4) an entry altered after the dry run is not filed under the original digest",
  );
  assert(
    !forgeStub.created.some((c) => c.body.includes("INJECTED-AFTER-DRY-RUN")),
    "(4) the altered text is never filed",
  );
}

{
  // The digest is caller-supplied, so a spec forged to MATCH its digest must still
  // pass the cheap checks: a NEVER CLAIM phrase in a generated section refuses it.
  await newPlanCache();
  const ctx = "NEVER CLAIM\n- the tool is idempotent";
  installCountingDispatch(GAP_HIGH);
  const nc = await pipeline({ dryRun: true, context: ctx });
  const forgedSpec = `${nc.spec}\n\n## Notes\nthe tool is idempotent`;
  await mutateEntry((e) => {
    if (e.reviewed) e.reviewed.spec = forgedSpec;
  });
  installCountingDispatch(GAP_HIGH);
  const forged = await pipeline({
    context: ctx,
    reviewedDigest: reviewedDigestOf(nc.title, forgedSpec),
  });
  assert(
    forged.filedFromDryRun === undefined && log.gate > 0,
    "(5) a digest-matching spec with a NEVER CLAIM phrase is not filed verbatim",
  );
}

{
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  const big = await pipeline({ dryRun: true });
  const huge = "x".repeat(FORGE_BODY_MAX + 1);
  await mutateEntry((e) => {
    if (e.reviewed) e.reviewed.spec = huge;
  });
  installCountingDispatch(GAP_HIGH);
  const oversized = await pipeline({ reviewedDigest: reviewedDigestOf(big.title, huge) });
  assert(
    oversized.filedFromDryRun === undefined && log.gate > 0,
    "(6) a digest-matching body over the forge limit is not filed verbatim",
  );
}

{
  // A filed-marker that cannot be written keeps the claim, so an identical
  // confirm arriving meanwhile is still refused (commit() error handling).
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  await pipeline({ dryRun: true });
  const inputs = { descriptor: DESC, type: "feature" as const, keySha: cacheState.keySha };
  const [entryName] = await cacheFiles();
  const held = await claimFileableDryRun(cacheState.dir, inputs);
  const blocker = path.join(cacheState.dir, (entryName ?? "").replace(/\.json$/, ".filed"));
  await mkdir(blocker); // a directory where the marker file goes: its write fails
  await held?.commit("https://example.test/issues/11");
  assert(
    (await readdir(cacheState.dir)).some((n) => n.endsWith(".claim")),
    "(7) a failed filed-marker write keeps the claim",
  );
  const busy = await fileReviewedDryRun(cacheState.dir, inputs, REPO, () => []);
  assert(
    busy?.filingFailure?.reason === "filing-in-progress",
    "(7) an identical confirm is still refused while the claim is kept",
  );
  assert(
    (await concurrentFilingOf(cacheState.dir, inputs)) !== undefined,
    "(7) concurrentFilingOf sees the kept claim",
  );
  await rm(blocker, { recursive: true, force: true });
}

// ------------------------------------------------------------- teardown

await teardownPlanCache();

console.log(`\nexit ${exit}`);
process.exit(exit);
