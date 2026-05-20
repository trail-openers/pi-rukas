#!/usr/bin/env bun
/**
 * Live test: spawn an explore child with a real prompt and verify that
 * onProgress fires per turn with sensible content.
 *
 * Costs a few cents on whatever model is configured for explore.
 */

import { renderSingle } from "../src/progress.ts";
import { spawnSpecialist } from "../src/spawn.ts";

console.log("[test] firing explore child with progress callback...");
const start = Date.now();
let eventCount = 0;

const r = await spawnSpecialist(
  {
    role: "explore",
    prompt:
      "Reply with the word ALPHA, then in a second turn reply with the word BRAVO. No tools, no vipune, no other commentary.",
  },
  {
    timeoutMs: 120_000,
    onProgress: (state) => {
      eventCount++;
      const status = state.done ? (state.ok ? "✓ DONE" : "✗ FAILED") : `· event #${eventCount}`;
      console.log(`  ${status}  ${renderSingle(state)}`);
    },
  },
);

console.log(`\n[test] total wall: ${Date.now() - start}ms`);
console.log(`[test] progress events received: ${eventCount}`);
console.log(`[test] final text: "${r.text}"`);
console.log(`[test] exit code: ${r.exitCode}, ok: ${r.ok}`);

// Sanity assertions
if (eventCount < 2) {
  console.error(`✗ expected ≥2 progress events (one per turn + final done), got ${eventCount}`);
  process.exit(1);
}
if (!r.ok) {
  console.error(`✗ child did not exit cleanly`);
  process.exit(1);
}
console.log("✓ live progress test passed");
