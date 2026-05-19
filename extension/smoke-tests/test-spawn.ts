#!/usr/bin/env bun
// Direct smoke test of spawnSpecialist — bypasses parent Pi.
// Run from extension/ dir:  bun run smoke-tests/test-spawn.ts

import { spawnSpecialist } from "../src/spawn.ts";

const start = Date.now();
console.log("[test] spawning explore specialist...");

const r = await spawnSpecialist(
  {
    role: "explore",
    prompt:
      "Respond with exactly the four ASCII letters PONG and nothing else. Do not invoke any tool. Do not write any files. Do not store anything in vipune.",
  },
  { timeoutMs: 180_000 },
);

console.log("[test] result:");
console.log({
  role: r.role,
  ok: r.ok,
  exitCode: r.exitCode,
  ms: r.ms,
  model: r.model ?? "(none)",
  modelSource: r.modelSource ?? "(unset)",
  toolUses: r.toolUses.length,
  textPreview: r.text.slice(0, 200),
  transcript: r.transcriptPath,
});
console.log(`[test] total wall: ${Date.now() - start}ms`);
