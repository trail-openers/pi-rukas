#!/usr/bin/env bun
// Direct parallel-spawn smoke test — confirms Promise.all over multiple
// concurrent pi children works post-refactor.

import { spawnSpecialist } from "../src/spawn.ts";

const start = Date.now();
console.log("[test] firing 3 explore specialists in parallel...");

const specs = [
  { role: "explore", prompt: "Reply ONLY with the single letter A. No tools." },
  { role: "explore", prompt: "Reply ONLY with the single letter B. No tools." },
  { role: "explore", prompt: "Reply ONLY with the single letter C. No tools." },
];

// Pass a shared runId so children sort together on disk, just like dispatch_parallel does.
const { makeRunId } = await import("../src/spawn.ts");
const runId = makeRunId();
const results = await Promise.all(
  specs.map((s, i) => spawnSpecialist(s, { timeoutMs: 90_000, runId, seq: i })),
);

for (const r of results) {
  console.log(
    `  ${r.role}: ok=${r.ok} text="${r.text.slice(0, 40)}" ms=${r.ms} cost=${r.usage?.cost.toFixed(4) ?? "n/a"}`,
  );
  if (r.transcriptPath) console.log(`    transcript: ${r.transcriptPath}`);
}
const total = Date.now() - start;
const maxMs = Math.max(...results.map((r) => r.ms));
console.log(`[test] wall: ${total}ms, max child: ${maxMs}ms, overhead: ${total - maxMs}ms`);
console.log(`[test] ${total < maxMs * 1.5 ? "PARALLEL ✓" : "SEQUENTIAL ✗"}`);
