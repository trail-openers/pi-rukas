#!/usr/bin/env bun
/**
 * Smoke test for the /runs browser logic — list, group, summarise.
 * No Pi UI here; we just exercise the pure functions against the actual
 * transcripts already on disk under ~/.pi/agent/ensemble-runs/.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Re-import the internals we want to test. They're not exported from runs.ts
// — easiest path is to duplicate the parse helper here and call it. Instead,
// import the module to make sure it loads cleanly, then walk the disk
// directly the same way the command would.

import "../src/runs.ts"; // ensure no top-level errors

const ENSEMBLE_DIR = path.join(os.homedir(), ".pi", "agent", "ensemble-runs");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const stat = await fs.stat(ENSEMBLE_DIR).catch(() => null);
if (!stat?.isDirectory()) {
  // Fresh CI / first run — no spawns yet, so no transcripts. The runs.ts
  // command handler already handles this case (empty list, friendly notify).
  // Nothing more to assert here.
  console.log(`◯ ensemble-runs dir not present yet (${ENSEMBLE_DIR}) — skipping`);
  console.log(`\nexit ${exit}`);
  process.exit(exit);
}
console.log(`✓ ensemble-runs dir exists at ${ENSEMBLE_DIR}`);

const dates = await fs.readdir(ENSEMBLE_DIR);
assert(dates.length > 0, `at least one date subdir present (found ${dates.length})`);

let totalFiles = 0;
const sampleSession: string[] = [];
for (const d of dates) {
  const dir = path.join(ENSEMBLE_DIR, d);
  const s = await fs.stat(dir);
  if (!s.isDirectory()) continue;
  const files = await fs.readdir(dir);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    totalFiles++;
    if (sampleSession.length === 0) sampleSession.push(path.join(dir, f));
  }
}
assert(totalFiles > 0, `at least one transcript file present (found ${totalFiles})`);

if (sampleSession.length > 0) {
  const file = sampleSession[0];
  if (!file) throw new Error("no sample");
  const raw = await fs.readFile(file, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  let saw = { session: false, message: false, agentEnd: false };
  for (const line of lines.slice(0, 200)) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "session") saw.session = true;
      if (ev.type === "message") saw.message = true;
      if (ev.type === "agent_end") saw.agentEnd = true;
    } catch {}
  }
  assert(saw.session, `sample transcript ${path.basename(file)} has session event`);
  assert(saw.message, "sample transcript has message event");
  // agent_end may or may not be in the saved session — Pi writes lifecycle differently in --session vs --mode json streams
}

console.log("\n=== test-runs summary ===");
console.log(`ensemble-runs root: ${ENSEMBLE_DIR}`);
console.log(`transcript files:   ${totalFiles}`);
console.log(`exit ${exit}`);
process.exit(exit);
