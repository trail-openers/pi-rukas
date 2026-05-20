#!/usr/bin/env bun
/**
 * Unit test for pruneOldRuns against a synthetic ensemble-runs tree.
 *
 * Creates batches with controlled mtimes (some old, some young), runs the
 * pruner with various keep-last caps, and asserts the right things survive.
 *
 * No Pi, no network.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { pruneOldRuns } from "../src/runs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

async function makeFakeRun(
  root: string,
  date: string,
  runId: string,
  roles: string[],
  ageMs: number,
): Promise<string[]> {
  const dir = path.join(root, date);
  await fs.mkdir(dir, { recursive: true });
  const created: string[] = [];
  const mtime = new Date(Date.now() - ageMs);
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    const name = roles.length > 1 ? `${runId}-${role}-${i}.json` : `${runId}-${role}.json`;
    const p = path.join(dir, name);
    await fs.writeFile(p, `{"runId":"${runId}","role":"${role}"}\n`);
    await fs.utimes(p, mtime, mtime);
    created.push(p);
  }
  return created;
}

// Set up a fake tree with 25 batches of varying ages
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-prune-"));
const today = new Date().toISOString().slice(0, 10);

for (let i = 0; i < 25; i++) {
  const runId = `bid${i.toString().padStart(3, "0")}-${Math.random().toString(36).slice(2, 8)}`;
  // Ages 1h apart so they sort cleanly by mtime. i=0 is oldest.
  const ageMs = (25 - i) * 60 * 60 * 1000;
  await makeFakeRun(root, today, runId, ["explore"], ageMs);
}
console.log("seeded 25 single-child batches in", root);

// Test 1: keep last 20 — should delete oldest 5
{
  const s = await pruneOldRuns(root, 20);
  assert(s.totalBatches === 25, "saw all 25 batches");
  assert(s.deletedBatches === 5, "deleted 5 oldest batches");
  assert(s.deletedFiles === 5, "5 files deleted (1 child each)");
  assert(s.preservedByAgeFloor === 0, "no age-floor saves (all 25 are >1h old)");
}

// Test 2: age-floor safety — young batches in the prune-candidate set are spared
// Sort by mtime desc puts newest first. With keepLast=1:
//   index 0 (newest, kept by cap)         — youngest1, 5s
//   index 1+ (candidates for prune)       — youngest2, 30s (under floor → spared)
//                                          — old, 24h (over floor → deleted)
const root2 = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-prune-"));
await makeFakeRun(root2, today, "young1-aaa", ["explore"], 5_000); // 5s — kept by cap
await makeFakeRun(root2, today, "young2-bbb", ["explore"], 30_000); // 30s — under 60s floor
await makeFakeRun(root2, today, "oldXXX-ccc", ["explore"], 24 * 60 * 60 * 1000); // 24h — deleted
{
  const s = await pruneOldRuns(root2, 1);
  assert(s.totalBatches === 3, "saw 3 batches");
  assert(
    s.deletedBatches === 1,
    `deleted 1 (only the 24h-old one; the 30s one was protected by age floor) — got ${s.deletedBatches}`,
  );
  assert(
    s.preservedByAgeFloor === 1,
    `1 young batch saved by age floor — got ${s.preservedByAgeFloor}`,
  );
}

// Test 3: keep last <= 0 → disabled, no-op
const root3 = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-prune-"));
await makeFakeRun(root3, today, "x-abc", ["explore"], 24 * 60 * 60 * 1000);
{
  const s = await pruneOldRuns(root3, 0);
  assert(s.deletedBatches === 0 && s.totalBatches === 0, "keepLast=0 → no-op (returns zeros without scanning)");
}
{
  const s = await pruneOldRuns(root3, -1);
  assert(s.deletedBatches === 0 && s.totalBatches === 0, "keepLast=-1 → no-op");
}

// Test 4: empty dir
const root4 = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-prune-"));
{
  const s = await pruneOldRuns(root4, 20);
  assert(s.totalBatches === 0, "empty dir → 0 batches");
  assert(s.deletedBatches === 0, "empty dir → nothing deleted");
}

// Cleanup
for (const r of [root, root2, root3, root4]) {
  await fs.rm(r, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
