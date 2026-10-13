#!/usr/bin/env bun
/**
 * #1043 review — the claim protocol's digest-before-claim rule and the
 * filed-marker's HEAD binding (plan-filing-claim.ts). Split out of
 * test-plan-confirm-reviewed.ts along the 500-line seam (AGENTS.md §12).
 *
 * A call that would not file (wrong digest, non-fileable entry) never renames the
 * entry, so it cannot make a concurrent correct confirm see "filing-in-progress".
 * A filed-marker refuses a re-confirm only at the HEAD it was written at.
 */

import { readdir, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { claimFileableDryRun, concurrentFilingOf } from "../src/plan-filing-claim.ts";
import {
  DESC,
  GAP_CRITICAL,
  GAP_HIGH,
  cacheFiles,
  cacheState,
  installCountingDispatch,
  installForgeStub,
  installOfflineVipuneStub,
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

// ------------------------------------------------------------- #1043 review: check the digest BEFORE claiming

{
  // A call that would not file must not rename the entry: a rename would make a
  // concurrent correct confirm see "filing-in-progress" for a dry run it can file.
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  const d = await pipeline({ dryRun: true });
  const inputs = { descriptor: DESC, type: "feature" as const, keySha: cacheState.head };
  // Stamp a known past mtime: a claim-then-restore rewrites it (utimes on the
  // claim, then link back), so an untouched mtime proves the entry was never claimed.
  const [entryName] = await cacheFiles();
  const entryPath = path.join(cacheState.dir, entryName ?? "");
  const past = (Date.now() - 5 * 60_000) / 1000;
  await utimes(entryPath, past, past);
  const before = (await stat(entryPath)).mtimeMs;
  assert(
    (await claimFileableDryRun(cacheState.dir, inputs, { digest: "0000000000000000" })) ===
      undefined,
    "(8) a wrong-digest claim is refused",
  );
  assert(
    (await stat(entryPath)).mtimeMs === before,
    "(8) a refused wrong-digest call never touches the entry (mtime unchanged)",
  );
  assert(
    !(await readdir(cacheState.dir)).some((f) => f.endsWith(".claim")),
    "(8) a refused wrong-digest call takes no claim",
  );
  assert(
    (await concurrentFilingOf(cacheState.dir, inputs)) === undefined,
    "(8) a refused call leaves no filing-in-progress signal for a concurrent confirm",
  );
  const right = await claimFileableDryRun(cacheState.dir, inputs, { digest: d.reviewedDigest });
  assert(right !== undefined, "(8) the correct confirm still claims after the refused call");
  await right?.release();
}

{
  // Non-fileable entries are refused before any rename, digest or not.
  await newPlanCache();
  installCountingDispatch([GAP_CRITICAL, "", ""]); // unreviewed after a corrective round: non-fileable
  await pipeline({ dryRun: true });
  const inputs = { descriptor: DESC, type: "feature" as const, keySha: cacheState.head };
  assert(
    (await claimFileableDryRun(cacheState.dir, inputs)) === undefined &&
      !(await readdir(cacheState.dir)).some((f) => f.endsWith(".claim")),
    "(9) a non-fileable entry is not claimed and leaves no claim behind",
  );
}

// ------------------------------------------------------------- #1043 review: the filed-marker is bound to HEAD

{
  await newPlanCache();
  installCountingDispatch(GAP_HIGH);
  await pipeline({ dryRun: true });
  const atHead = { descriptor: DESC, type: "feature" as const, keySha: cacheState.head };
  const won = await claimFileableDryRun(cacheState.dir, atHead);
  await won?.commit("https://example.test/issues/12");
  assert(
    (await concurrentFilingOf(cacheState.dir, atHead)) !== undefined,
    "(10) the filed-marker refuses a re-confirm at the filed HEAD",
  );
  assert(
    (await concurrentFilingOf(cacheState.dir, { ...atHead, keySha: "c".repeat(40) })) === undefined,
    "(10) the filed-marker does not refuse once HEAD has moved",
  );
}

// ------------------------------------------------------------- teardown

await teardownPlanCache();

console.log(`\nexit ${exit}`);
process.exit(exit);
