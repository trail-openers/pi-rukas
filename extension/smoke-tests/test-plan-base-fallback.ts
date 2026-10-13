#!/usr/bin/env bun
/**
 * #1132 (post-cap fix round) — two things the filed body and the dry run must get right.
 *
 * 1. A run that read the local checkout because origin/<default> could not be
 *    read discloses that in the body it files and in the dry-run spec, the same
 *    way residual and open-point sections are disclosed.
 * 2. A dry run that reached the iteration cap with open points is fileable: the
 *    cap files, so the dry run's reviewedDigest must let the confirm file it.
 *
 * The pipeline runs against a temp repo with no origin/HEAD, so the base
 * fallback is real (not stubbed) and the forge is the offline stub.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { filedBodyOf } from "../src/plan-gap-disclosure.ts";
import type { PlanGap } from "../src/plan-types.ts";
import {
  forgeStub,
  installForgeStub,
  installNoPlanCacheStub,
  installOfflineVipuneStub,
  makeDispatchStub,
} from "./plan-test-stubs.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 1. The section is appended when there is a fallback, and absent when there is not.
{
  const open: PlanGap[] = [
    { severity: "CRITICAL", description: "retry cap contradicts quota", resolution: "(none)" },
  ];
  const plain = filedBodyOf("BODY", [], [], undefined);
  assert(plain === "BODY", "no fallback and no disclosure: the body is unchanged");
  const withFallback = filedBodyOf("BODY", [], [], "origin/HEAD is not set");
  assert(
    withFallback.includes("## Base fallback") &&
      withFallback.includes("origin/HEAD is not set") &&
      withFallback.startsWith("BODY"),
    "a fallback adds a Base fallback section with its reason after the spec",
  );
  const all = filedBodyOf("BODY", [], open, "origin/HEAD is not set");
  assert(
    all.indexOf("## Open points") > 0 &&
      all.indexOf("## Base fallback") > all.indexOf("## Open points"),
    "the base fallback section follows the open points section",
  );
}

// Driver fixtures: a temp repo with no origin/HEAD, so openPlanBase records the fallback.
process.env.PI_ENSEMBLE_PLAN_CACHE = "1";
installForgeStub();
installOfflineVipuneStub();
installNoPlanCacheStub();
const DESCRIPTOR = "add a start_plan_driver tool for the plan pipeline in extension";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-base-fallback-"));
try {
  const solo = path.join(root, "solo");
  await execFileP("git", ["init", "-q", "-b", "main", solo]);
  await fs.writeFile(path.join(solo, "a.txt"), "x\n");
  await execFileP("git", ["-C", solo, "add", "-A"]);
  await execFileP("git", [
    "-C",
    solo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "-m",
    "init",
  ]);

  async function run(gateReply: string | string[], dryRun: boolean) {
    forgeStub.created.length = 0;
    forgeStub.mode = "ok";
    setPlanDispatch(makeDispatchStub(gateReply) as never);
    try {
      return await runPlanPipeline({} as never, { descriptor: DESCRIPTOR, dryRun }, solo);
    } finally {
      setPlanDispatch(null);
    }
  }

  const clean = "All sections are sound. Nothing to flag.\nVERDICT: READY";

  {
    const r = await run(clean, false);
    assert(
      (r.baseFallback ?? "").includes("origin/HEAD is not set"),
      "no origin/HEAD: the run records the base fallback",
    );
    assert(r.filed === true, "a fallback run still files");
    assert(
      (forgeStub.created[0]?.body ?? "").includes("## Base fallback"),
      "the filed body discloses the base fallback",
    );
  }

  {
    const r = await run(clean, true);
    assert(
      r.spec.includes("## Base fallback") && (r.baseFallback ?? "").length > 0,
      "the dry-run spec discloses the base fallback too",
    );
  }

  // 2. A dry run at the cap with an open CRITICAL is fileable: no filing failure,
  //    and a reviewedDigest the confirm can echo.
  {
    const critical =
      "GAP: CRITICAL the retry cap contradicts the quota rule\nVERDICT: NEEDS_ITERATION";
    const r = await run([critical, critical], true);
    assert(
      r.capReason === "unresolved-blocking" && r.capHit,
      `dry run at the cap with an open CRITICAL reaches unresolved-blocking (got ${r.capReason})`,
    );
    assert(r.filingFailure === undefined, "…and is not a filing failure (the cap files)");
    assert(
      typeof r.reviewedDigest === "string" && r.reviewedDigest.length > 0,
      "…so the dry run reports a reviewedDigest the confirm can file",
    );
    assert(r.spec.includes("## Open points"), "…with the CRITICAL as an open point in the spec");
  }
} finally {
  setPlanDispatch(null);
  await fs.rm(root, { recursive: true, force: true });
}

process.exit(exit);
