#!/usr/bin/env bun
/**
 * #1856 — the source issue is a cache LINEAGE dimension, in both directions.
 *
 * `sourceIssue` changes what the duplicate-risk child is shown, what it may
 * return, and what the post-filter may downgrade — so an investigation
 * gathered WITHOUT the number must never satisfy a run WITH it (the cached HIGH
 * against the plan's own subject would re-halt the very plan the field exists
 * to unblock), and one gathered WITH it must never satisfy a run without it
 * (that would let a caller drop the number and inherit a downgrade it never
 * earned). The key is not decoration: `readInvestigationCache` reuses the whole
 * barrier — findings and verdict together — with no dispatch at all.
 *
 * The stub forge makes "halted" and "drafted" unmistakable: `created.length`
 * is 0 and `log.gate` is 0 on a halt, `log.gate >= 1` on a drafting run.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { setPlanForge } from "../src/plan-filing.ts";
import { setPlanVipuneSearch } from "../src/plan-inventory.ts";
import { setPlanGitStateFn } from "../src/plan-investigation-cache.ts";
import type { PlanDriverInput } from "../src/plan-types.ts";
import { DESC, REPO } from "./plan-cache-fixture.ts";

const SELF_HIGH = "DUPLICATE_RISK: high — this is #1856 (OPEN) restated verbatim";
const DUP_NONE = "DUPLICATE_RISK: none — no overlapping open work";
const GAP =
  "GAP: HIGH — the spec omits the rollback path — proposed resolution: add one\nVERDICT: READY";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_FORGE = "none";

const dirs: string[] = [];
const cacheState = { dir: "", keySha: "a".repeat(40) };
async function newCache(): Promise<void> {
  cacheState.dir = await mkdtemp(path.join(os.tmpdir(), "plan-src-lineage-"));
  dirs.push(cacheState.dir);
  cacheState.keySha = "a".repeat(40);
  setPlanGitStateFn(async () => ({ keySha: cacheState.keySha, cacheDir: cacheState.dir }));
}
async function freshHead(): Promise<void> {
  cacheState.keySha = "b".repeat(40);
}

const created: string[] = [];
setPlanForge(() =>
  Promise.resolve({
    issueCreate: (title: string) => {
      created.push(title);
      return Promise.resolve({ url: "https://github.com/test/test/issues/7", number: 7 });
    },
  } as never),
);
setPlanVipuneSearch(async () => ({ kind: "hits", hits: [] }));

const log = { explore: 0, gate: 0 };
let dupReply = DUP_NONE;
setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
  const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
  if (spec.role === "adversarial-developer") {
    log.gate++;
    return Promise.resolve({ ...base, role: spec.role, text: GAP });
  }
  log.explore++;
  if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
    return Promise.resolve({ ...base, role: "explore", text: dupReply });
  }
  return Promise.resolve({
    ...base,
    role: "explore",
    text: "prose",
    toolUses: [
      {
        name: "report_plan_item",
        arguments: { kind: "acceptance-criterion", text: "the tool registers", angle: "x" },
      },
    ],
  });
}) as never);

function run(input: Partial<PlanDriverInput> = {}) {
  return runPlanPipeline({} as never, { descriptor: DESC, ...input }, REPO);
}

// ---- A no-source dry run that HALTED must not be reused by a with-source run.

{
  await newCache();
  dupReply = SELF_HIGH;
  log.explore = 0;
  log.gate = 0;
  created.length = 0;
  const halted = await run({ dryRun: true });
  assert(
    halted.filingFailure?.reason === "duplicate-risk" && log.gate === 0,
    "baseline: with no source issue the self-only HIGH halts before the gate",
  );

  // Same descriptor/context/type, now naming the source issue: a DIFFERENT plan.
  log.explore = 0;
  log.gate = 0;
  const withSource = await run({ dryRun: false, sourceIssue: 1856 });
  assert(
    log.gate >= 1 && withSource.filingFailure?.reason !== "duplicate-risk",
    `a with-source run never inherits the no-source lineage (gate ${log.gate}, reason ${withSource.filingFailure?.reason ?? "none"})`,
  );
  assert(
    log.explore >= 1,
    "a with-source run re-dispatches the barrier rather than reusing the halted one",
  );
  assert(
    String(withSource.spec).includes("## Duplicate check — excluded candidates"),
    "the with-source run's body carries the exclusion disclosure",
  );
}

// ---- A with-source dry run that DRAFTED must not be reused by a no-source run.

{
  await newCache();
  dupReply = SELF_HIGH;
  log.explore = 0;
  log.gate = 0;
  created.length = 0;
  const drafted = await run({ dryRun: true, sourceIssue: 1856 });
  assert(
    drafted.filingFailure?.reason !== "duplicate-risk" && log.gate >= 1,
    "baseline: with the source issue named, the same HIGH drafts",
  );

  log.explore = 0;
  log.gate = 0;
  created.length = 0;
  const noSource = await run({ dryRun: false, reviewedDigest: drafted.reviewedDigest });
  assert(
    noSource.filingFailure?.reason === "duplicate-risk" && log.gate === 0,
    `a run that drops --issue is re-investigated and halts, never inheriting the downgrade (reason ${noSource.filingFailure?.reason ?? "NONE — it inherited"}, gate ${log.gate})`,
  );
  assert(
    noSource.filedFromDryRun === undefined,
    "the with-source reviewed spec is not filed verbatim to a no-source confirm",
  );
  assert(created.length === 0, "nothing is filed on the inherited-downgrade attempt");
}

// ---- A moved HEAD is still a miss, so the lineage change did not weaken #1132.

{
  await newCache();
  dupReply = DUP_NONE;
  log.explore = 0;
  log.gate = 0;
  const dry = await run({ dryRun: true, sourceIssue: 1856 });
  assert(!!dry.reviewedDigest, "lineage: a clean dry run reports a digest");
  await freshHead();
  log.explore = 0;
  log.gate = 0;
  created.length = 0;
  const moved = await run({ dryRun: false, sourceIssue: 1856, reviewedDigest: dry.reviewedDigest });
  assert(
    log.gate >= 1,
    `lineage: a moved origin/<default> re-runs the pipeline rather than filing stale bytes (gate ${log.gate})`,
  );
  assert(moved.filed, "lineage: the re-run files its own fresh spec");
}

for (const d of dirs) await rm(d, { recursive: true, force: true });
setPlanDispatch(null);
setPlanForge(null);
setPlanGitStateFn(null);
setPlanVipuneSearch(null);
process.exit(exit);
