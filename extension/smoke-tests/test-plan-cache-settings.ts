#!/usr/bin/env bun
/**
 * #1224 — the reviewed-plan cache outlives a phone-paced confirm.
 *
 * Covered: (1) a confirm carrying the reviewedDigest whose dry run expired, and
 * whose re-run pipeline drafts a DIFFERENT spec, files nothing and says so (the
 * new spec is cached as a dry run, so confirming its digest files it verbatim);
 * a re-run that reproduces the reviewed bytes still files. (2)
 * `PI_ENSEMBLE_PLAN_CACHE_TTL_MS` sets the expiry (0 = no expiry; invalid =
 * default). (3) `PI_ENSEMBLE_PLAN_CACHE_DIR` puts the cache outside the clone,
 * shared by two clones of one repository and separate for another repository,
 * so a confirm from a fresh clone at the same origin commit files the reviewed spec.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPlanPipeline } from "../src/plan-driver.ts";
import {
  INVESTIGATION_CACHE_TTL_MS,
  planCacheTtlMs,
  resolvePlanGitState,
  setPlanGitStateFn,
} from "../src/plan-investigation-cache.ts";
import { type RegisteredPlanTool, registerPlanTool } from "../src/plan-tool.ts";
import {
  DESC,
  DUP_NONE,
  GAP_HIGH,
  forgeStub,
  installCountingDispatch,
  installForgeStub,
  installOfflineVipuneStub,
  invokePlanTool,
  log,
  makeJobDeliverer,
  mutateEntry,
  newPlanCache,
  pipeline,
  setPlanDispatch,
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

const THREE_HOURS = 3 * 60 * 60_000;

/**
 * The counting dispatch, but every angle reports a DIFFERENT acceptance
 * criterion — a re-run investigation that drafts a different spec.
 */
function installChangedDispatch(): void {
  log.explore = 0;
  log.gate = 0;
  setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
    const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
    if (spec.role === "adversarial-developer") {
      log.gate++;
      return Promise.resolve({ ...base, role: spec.role, text: GAP_HIGH });
    }
    log.explore++;
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({ ...base, role: "explore", text: DUP_NONE });
    }
    const item = { kind: "acceptance-criterion", text: "the tool also rolls back", angle: "x" };
    return Promise.resolve({
      ...base,
      role: "explore",
      text: "summary prose",
      toolUses: [{ name: "report_plan_item", arguments: item }],
    });
  }) as never);
}

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

// ------------------------------------------------------------- (1) expired + changed spec is held

{
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  const dry = await pipeline({ dryRun: true });
  await mutateEntry((e) => {
    e.createdAt = Date.now() - THREE_HOURS;
  });
  installChangedDispatch();
  const conf = await pipeline({ reviewedDigest: dry.reviewedDigest });
  assert(log.explore > 0 && log.gate > 0, "(1) an expired confirm re-runs the full pipeline");
  assert(conf.spec !== dry.spec, "(1) fixture: the re-run drafts a different spec");
  assert(!conf.filed && forgeStub.created.length === 0, "(1) the changed spec is NOT filed");
  assert(
    (conf.reviewedSpecChanged?.reason ?? "").includes("expired"),
    "(1) the result says the reviewed spec changed, and why (expired)",
  );
  assert(
    !!conf.reviewedDigest && conf.reviewedDigest !== dry.reviewedDigest,
    "(1) the held result carries the NEW spec's digest",
  );
  installChangedDispatch();
  const reconf = await pipeline({ reviewedDigest: conf.reviewedDigest });
  assert(
    reconf.filedFromDryRun !== undefined && log.explore === 0 && log.gate === 0,
    "(1) confirming the new digest files the held spec verbatim",
  );
  assert(forgeStub.created[0]?.body === conf.spec, "(1) the filed body is the held spec");
}

{
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  const dry = await pipeline({ dryRun: true });
  await mutateEntry((e) => {
    e.createdAt = Date.now() - THREE_HOURS;
  });
  installCountingDispatch(GAP_HIGH);
  const same = await pipeline({ reviewedDigest: dry.reviewedDigest });
  assert(
    same.filed && same.reviewedSpecChanged === undefined && forgeStub.created[0]?.body === dry.spec,
    "(1) a re-run that reproduces the reviewed bytes still files",
  );
}

{
  // No cache at all (a fresh clone, caching off): a digest-carrying confirm is still held.
  setPlanGitStateFn(async () => undefined);
  forgeStub.created.length = 0;
  installChangedDispatch();
  const nocache = await pipeline({ reviewedDigest: "0123456789abcdef" });
  assert(
    !nocache.filed && nocache.reviewedSpecChanged !== undefined,
    "(1) without a cache, a digest-carrying confirm whose spec differs is held",
  );
}

{
  // The rendered tool result tells the PM to show the new spec and ask again.
  await newPlanCache();
  const tools: RegisteredPlanTool[] = [];
  registerPlanTool({
    registerTool: (d: RegisteredPlanTool) => tools.push(d),
    // #1044: the launched job's report reaches the registered pi.
    ...makeJobDeliverer(),
  } as unknown as Parameters<typeof registerPlanTool>[0]);
  installCountingDispatch(GAP_HIGH);
  const dry = await invokePlanTool(tools, { descriptor: DESC, dryRun: true });
  await mutateEntry((e) => {
    e.createdAt = Date.now() - THREE_HOURS;
  });
  installChangedDispatch();
  const out = await invokePlanTool(tools, {
    descriptor: DESC,
    reviewedDigest: dry.details.reviewedDigest,
  });
  assert(
    out.text.startsWith("PLAN NOT FILED — THE REVIEWED SPEC CHANGED") &&
      out.text.includes("ask again") &&
      out.text.includes("expired"),
    "(1) the tool result leads with THE REVIEWED SPEC CHANGED, the reason, and 'ask again'",
  );
  assert(
    out.details.filed === false && out.details.reviewedSpecChanged !== undefined,
    "(1) the tool details carry reviewedSpecChanged",
  );
}

// ------------------------------------------------------------- (2) PI_ENSEMBLE_PLAN_CACHE_TTL_MS

assert(
  withEnv("PI_ENSEMBLE_PLAN_CACHE_TTL_MS", undefined, planCacheTtlMs) ===
    INVESTIGATION_CACHE_TTL_MS,
  "(2) unset: the 2 h default",
);
assert(
  withEnv("PI_ENSEMBLE_PLAN_CACHE_TTL_MS", "60000", planCacheTtlMs) === 60_000,
  "(2) a non-negative integer overrides the expiry",
);
assert(
  withEnv("PI_ENSEMBLE_PLAN_CACHE_TTL_MS", "0", planCacheTtlMs) === Number.POSITIVE_INFINITY,
  "(2) 0 disables the expiry",
);
for (const bad of ["-1", "abc", "1.5", "1e400"]) {
  assert(
    withEnv("PI_ENSEMBLE_PLAN_CACHE_TTL_MS", bad, planCacheTtlMs) === INVESTIGATION_CACHE_TTL_MS,
    `(2) invalid value "${bad}" falls back to the default`,
  );
}

{
  process.env.PI_ENSEMBLE_PLAN_CACHE_TTL_MS = "0";
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  const dry = await pipeline({ dryRun: true });
  await mutateEntry((e) => {
    e.createdAt = Date.now() - 30 * 24 * 60 * 60_000;
  });
  installChangedDispatch();
  const old = await pipeline({ reviewedDigest: dry.reviewedDigest });
  assert(
    old.filedFromDryRun !== undefined && forgeStub.created[0]?.body === dry.spec,
    "(2) with TTL 0 a month-old reviewed dry run still files verbatim",
  );

  process.env.PI_ENSEMBLE_PLAN_CACHE_TTL_MS = "60000";
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  const dry2 = await pipeline({ dryRun: true });
  await mutateEntry((e) => {
    e.createdAt = Date.now() - 5 * 60_000;
  });
  installCountingDispatch(GAP_HIGH);
  const short = await pipeline({ reviewedDigest: dry2.reviewedDigest });
  assert(
    short.filedFromDryRun === undefined && log.explore > 0,
    "(2) with a 1-min TTL a 5-min-old dry run is a miss",
  );
  delete process.env.PI_ENSEMBLE_PLAN_CACHE_TTL_MS;
}

// ------------------------------------------------------------- (3) PI_ENSEMBLE_PLAN_CACHE_DIR

{
  const root = await mkdtemp(path.join(os.tmpdir(), "plan-cache-dir-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
      .toString()
      .trim();
  // Two clones of one local origin (so the run's origin fetch works offline and
  // origin/HEAD is set) and a clone of a second origin.
  const originOne = path.join(root, "one.git");
  const originTwo = path.join(root, "two.git");
  const seed = path.join(root, "seed");
  execFileSync("git", ["init", "-q", seed]);
  git(
    seed,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "x",
  );
  for (const o of [originOne, originTwo]) execFileSync("git", ["clone", "-q", "--bare", seed, o]);
  const cloneA = path.join(root, "a");
  const cloneB = path.join(root, "b");
  const other = path.join(root, "other");
  const shared = path.join(root, "shared-cache");
  for (const [o, d] of [
    [originOne, cloneA],
    [originOne, cloneB],
    [originTwo, other],
  ] as const) {
    execFileSync("git", ["clone", "-q", o, d]);
  }
  const baseSha = git(cloneA, "rev-parse", "origin/HEAD");

  const priorCache = process.env.PI_ENSEMBLE_PLAN_CACHE;
  delete process.env.PI_ENSEMBLE_PLAN_CACHE; // verify-loop.sh disables the real lookup
  setPlanGitStateFn(null);
  process.env.PI_ENSEMBLE_PLAN_CACHE_DIR = shared;
  const a = await resolvePlanGitState(cloneA, { baseSha });
  const b = await resolvePlanGitState(cloneB, { baseSha });
  const o = await resolvePlanGitState(other, { baseSha });
  assert(
    !!a && a.cacheDir.startsWith(`${shared}${path.sep}`),
    "(3) the cache dir is under PI_ENSEMBLE_PLAN_CACHE_DIR",
  );
  assert(!!a && !!b && a.cacheDir === b.cacheDir, "(3) two clones of one repository share it");
  assert(!!a && !!o && a.cacheDir !== o.cacheDir, "(3) another repository gets its own subdir");
  assert(
    git(cloneB, "rev-parse", "origin/HEAD") === baseSha,
    "fixture: both clones see the same origin/<default> commit",
  );

  // End to end: dry run in clone A, confirm from clone B (a fresh clone per turn).
  forgeStub.created.length = 0;
  installCountingDispatch(GAP_HIGH);
  const dry = await runPlanPipeline({} as never, { descriptor: DESC, dryRun: true }, cloneA);
  installChangedDispatch();
  const conf = await runPlanPipeline(
    {} as never,
    { descriptor: DESC, reviewedDigest: dry.reviewedDigest },
    cloneB,
  );
  assert(
    conf.filedFromDryRun !== undefined && log.explore === 0 && forgeStub.created.length === 1,
    "(3) a confirm from a fresh clone at the same origin commit files the reviewed spec verbatim",
  );

  process.env.PI_ENSEMBLE_PLAN_CACHE_DIR = "relative/cache";
  const rel = await resolvePlanGitState(cloneA, { baseSha });
  assert(
    !!rel &&
      rel.cacheDir ===
        path.join(
          git(cloneA, "rev-parse", "--path-format=absolute", "--git-common-dir"),
          "pi-plan-cache",
        ),
    "(3) a relative PI_ENSEMBLE_PLAN_CACHE_DIR is ignored (per-clone cache)",
  );

  delete process.env.PI_ENSEMBLE_PLAN_CACHE_DIR;
  if (priorCache !== undefined) process.env.PI_ENSEMBLE_PLAN_CACHE = priorCache;
  await rm(root, { recursive: true, force: true });
}

// ------------------------------------------------------------- teardown

await teardownPlanCache();

console.log(`\nexit ${exit}`);
process.exit(exit);
