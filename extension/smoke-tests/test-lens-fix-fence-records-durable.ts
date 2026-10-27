#!/usr/bin/env bun
/**
 * #1852 round 3 items 2 and 4 — the lens-fix fence's records are DURABLE at the
 * moments they decide something.
 *
 * Both records exist only to be read LATER, by a reader that is not this call:
 *
 *   - `lens-fix-fence-unavailable` is what the adversarial gate reads to tell
 *     "this round had no fence and that was a failure" from "an older driver
 *     wrote this state, stand down" (`lensFixFenceRecorded`). The append used to
 *     be pure and never persisted, so after a resume — or any step that re-reads
 *     the state file — the record was GONE, and the gate read silence and landed
 *     the round. Item 2: `persistFenceRecord` awaits `persistCycle` at each of
 *     the three arms that write one, the same discipline `parkLensFixReposition`
 *     has always followed at its park.
 *   - the `lens-fix-scope` cap-hit is the park the router routes to the handoff.
 *     Item 4: the gate's refusal path returned without persisting it, so a
 *     process that died on the way back left a `lens-fix` round whose log showed
 *     no cap at all.
 *
 * The assertion is on the STATE FILE, not the returned state: `appendEvent` is
 * pure, so an event the returned state carries and the disk does not is precisely
 * the bug.
 */

import { readFileSync, rmSync } from "node:fs";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import { runLensFix } from "../src/work-driver-lens-fix.ts";
import { workStateFile } from "../src/workflow-state.ts";
import {
  cleanupRepo,
  lensFixState,
  unrecordedCtx,
  unrecordedRepo,
} from "./lib/lens-fix-unrecorded-tree-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function diskBody(repoRoot: string): string {
  try {
    return readFileSync(workStateFile(repoRoot, 1852), "utf8");
  } catch {
    return "";
  }
}

console.log("# the fence's refusal reaches the STATE FILE, not just the returned state");
{
  const f = unrecordedRepo("1852-record-persisted", { treePath: "repoRoot", stray: true });
  const pushes: string[] = [];
  const ctx = unrecordedCtx(f, pushes);
  const after = await runLensFix(ctx, lensFixState(f, false), 1_500_000);
  const onDisk = diskBody(f.repoRoot);
  assert(
    after.eventLog.some((e) => e.kind === "lens-fix-fence-unavailable"),
    "the returned state carries the refusal",
  );
  assert(
    onDisk.includes("lens-fix-fence-unavailable"),
    "and so does the file on disk — this is the copy the gate reads after a resume",
  );
  assert(
    onDisk.includes("not a recorded workstream"),
    "with the reason, so the handoff can say which arm failed",
  );
  cleanupRepo(f.repoRoot);
}

console.log("# the gate's refusal persists its cap-hit before returning");
{
  const f = unrecordedRepo("1852-cap-persisted", { treePath: "repoRoot", stray: true });
  const pushes: string[] = [];
  const ctx = unrecordedCtx(f, pushes);
  const afterLensFix = await runLensFix(ctx, lensFixState(f, false), 1_500_000);
  const after = await runAdversarial(ctx, afterLensFix, 2_000_000);
  const cap = after.eventLog.find(
    (e) => e.kind === "cap-hit" && (e as { cap?: string }).cap === "lens-fix-scope",
  );
  assert(cap !== undefined, "the round parked on the scope cap");
  const onDisk = diskBody(f.repoRoot);
  assert(
    onDisk.includes("lens-fix-scope"),
    "the cap-hit is in the state file — a crash on the way back cannot lose the park",
  );
  assert(
    onDisk.includes('"handoff"') || onDisk.includes("handoff"),
    "and the file records the handoff it routes to",
  );
  cleanupRepo(f.repoRoot);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
