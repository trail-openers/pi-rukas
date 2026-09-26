#!/usr/bin/env bun
/**
 * Unit test for age-based transcript retention (pruneOldRuns +
 * transcriptRetentionDays) against a synthetic ensemble-runs tree.
 *
 * The rule (replacing the old keep-last-N count cap): delete batches whose
 * NEWEST child file is older than the retention window (default 5 days,
 * PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS; 0 disables). A 60 s min-age floor
 * always protects in-progress batches.
 *
 * No Pi, no network.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { pruneOldRuns, transcriptRetentionDays } from "../src/runs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const DAY = 86_400_000;

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

const today = new Date().toISOString().slice(0, 10);

// Test 1: age-based default window — a 6-day-old batch is pruned, a
// 4-day-old one is kept (the old count-cap "delete oldest 5 of 25" case is
// replaced: retention no longer depends on batch count at all).
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-prune-"));
{
  const runId = `bid001-${Math.random().toString(36).slice(2, 8)}`;
  await makeFakeRun(root, today, runId, ["explore"], 6 * DAY); // pruned
  await makeFakeRun(root, today, `${runId}b`, ["explore"], 4 * DAY); // kept
  const s = await pruneOldRuns(root);
  assert(s.totalBatches === 2, "saw both batches");
  assert(s.deletedBatches === 1, "deleted only the 6-day-old batch");
  assert(s.deletedFiles === 1, "1 file deleted");
  assert(s.preservedByAgeFloor === 0, "no age-floor saves (both batches are days old)");
  const remaining = await fs.readdir(path.join(root, today));
  assert(remaining.length === 1, "4-day-old batch survives on disk");
}

// Test 2: mixed-mtime batch — a batch survives when ANY child (the newest)
// is inside the window, even if an older sibling was written days ago.
const root2 = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-prune-"));
{
  const runId = `bid002-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(root2, today);
  await fs.mkdir(dir, { recursive: true });
  const oldMtime = new Date(Date.now() - 6 * DAY);
  const newMtime = new Date(Date.now() - 2 * DAY);
  const mtimes = [oldMtime, newMtime];
  for (let i = 0; i < mtimes.length; i++) {
    const mtime = mtimes[i];
    if (!mtime) continue;
    const p = path.join(dir, `${runId}-explore-${i}.json`);
    await fs.writeFile(p, `{"runId":"${runId}","role":"explore"}\n`);
    await fs.utimes(p, mtime, mtime);
  }
  const s = await pruneOldRuns(root2);
  assert(s.totalBatches === 1, "multi-child files grouped into one batch");
  assert(
    s.deletedBatches === 0,
    "mixed-mtime batch kept (newest child 2 days old is inside the window)",
  );
  assert(s.deletedFiles === 0, "no files deleted");
}

// Test 3: age floor — with a sub-second-day window, an old batch is deleted
// but a 30 s-old batch that would otherwise be a candidate is preserved and
// counted by preservedByAgeFloor.
const root3 = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-prune-"));
{
  const r = `bid003-${Math.random().toString(36).slice(2, 8)}`;
  await makeFakeRun(root3, today, r, ["explore"], 24 * 60 * 60 * 1000); // 24h — deleted
  await makeFakeRun(root3, today, `${r}b`, ["explore"], 30_000); // 30s — under 60s floor
  const s = await pruneOldRuns(root3, 0.5 / DAY); // window: 0.5 s in days
  assert(s.deletedBatches === 1, "old batch deleted under a 0.5s window");
  assert(
    s.preservedByAgeFloor === 1,
    "30s batch saved by the 60s age floor (preservedByAgeFloor===1)",
  );
  const remaining = await fs.readdir(path.join(root3, today));
  assert(remaining.length === 1, "30s batch survives on disk");
}

// Test 4: retentionDays 0 → no-op (matches the old "0 disables" semantics)
const root4 = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-prune-"));
await makeFakeRun(root4, today, `bid004-${Math.random().toString(36).slice(2, 8)}`, [
  "explore",
], 30 * DAY);
{
  const s = await pruneOldRuns(root4, 0);
  assert(s.deletedBatches === 0 && s.totalBatches === 0, "retentionDays=0 → no-op (returns zeros without scanning)");
}

// Test 5: empty dir
const root5 = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-prune-"));
{
  const s = await pruneOldRuns(root5);
  assert(s.totalBatches === 0, "empty dir → 0 batches");
  assert(s.deletedBatches === 0, "empty dir → nothing deleted");
}

// Test 6: transcriptRetentionDays parser — reads the env at call time.
// (The old IIFE parsed PI_ENSEMBLE_RUNS_KEEP_LAST once at module load; the
// parser is exported so these cases can drive it directly.)
{
  const saved = process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS;
  delete process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS;
  assert(transcriptRetentionDays() === 5, "unset → 5");
  process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS = "";
  assert(transcriptRetentionDays() === 5, '"" (empty) → 5');
  process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS = "abc";
  assert(transcriptRetentionDays() === 5, '"abc" → 5');
  process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS = "-3";
  assert(transcriptRetentionDays() === 5, '"-3" → 5');
  process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS = "0";
  assert(transcriptRetentionDays() === 0, '"0" → 0 (disabled)');
  process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS = "1.5";
  assert(transcriptRetentionDays() === 1.5, '"1.5" → 1.5 (fractional honoured)');
  if (saved === undefined) delete process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS;
  else process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS = saved;
}

// Test 7: transcriptsSummary reflects the age rule — no longer "keep last N".
const root7 = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ensemble-prune-"));
await makeFakeRun(root7, today, `bid007-${Math.random().toString(36).slice(2, 8)}`, ["explore"], 2 * DAY);
{
  const saved = process.env.PI_ENSEMBLE_RUNS_DIR;
  const savedDays = process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS;
  try {
    process.env.PI_ENSEMBLE_RUNS_DIR = root7;
    delete process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS;
    const { transcriptsSummary } = await import("../src/runs.ts");
    const line = await transcriptsSummary(root7);
    assert(line.includes("retention 5 days"), `summary says "retention 5 days" — got: ${line}`);
    assert(!line.includes("keep last"), 'summary no longer says "keep last"');
  } finally {
    if (saved === undefined) delete process.env.PI_ENSEMBLE_RUNS_DIR;
    else process.env.PI_ENSEMBLE_RUNS_DIR = saved;
    if (savedDays === undefined) delete process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS;
    else process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS = savedDays;
  }
}

// Test 8: "(retention off)" when disabled
{
  const saved = process.env.PI_ENSEMBLE_RUNS_DIR;
  const savedDays = process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS;
  try {
    process.env.PI_ENSEMBLE_RUNS_DIR = root7;
    process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS = "0";
    const { transcriptsSummary } = await import("../src/runs.ts");
    const line = await transcriptsSummary(root7);
    assert(line.includes("retention off"), `summary says "retention off" when disabled — got: ${line}`);
  } finally {
    if (saved === undefined) delete process.env.PI_ENSEMBLE_RUNS_DIR;
    else process.env.PI_ENSEMBLE_RUNS_DIR = saved;
    if (savedDays === undefined) delete process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS;
    else process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS = savedDays;
  }
}

// Cleanup
for (const r of [root, root2, root3, root4, root5, root7]) {
  await fs.rm(r, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
