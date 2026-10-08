#!/usr/bin/env bun
// #1017 — live spawn test: spawns a REAL `pi` child (PONG round-trip).
// Renamed from test-spawn.ts to `*-live.ts` so the offline gate
// (verify-loop.sh) excludes it — the gate now exports
// PI_ENSEMBLE_FORBID_LIVE_SPAWN=1 for every offline test, and a live
// test globbed into the offline suite would fail on the guard (or, worse,
// burn real tokens on every gate run). The `*-live.ts` suffix is the
// established exclusion convention (test-live-suffix-convention.ts canary).
// Run from extension/ dir:  bun run smoke-tests/test-spawn-live.ts

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
