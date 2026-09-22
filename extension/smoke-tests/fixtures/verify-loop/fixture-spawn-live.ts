#!/usr/bin/env bun
// Canary fixture: matches the *-live.ts exclusion pattern.
// If verify-loop.sh ever executes this, the sentinel file below appears and
// the process exits non-zero — making the lost skip unmistakable.
import { writeFileSync } from "node:fs";

// The canary reads the sentinel path from this env var (unset in production
// runs — only test-verify-loop.ts sets it), so a real accidental execution of
// this file cannot overwrite an unrelated path.
const path = process.env.FIXTURE_LIVE_SENTINEL;
if (path) writeFileSync(path, "live fixture was executed");
console.error("fixture-spawn-live: MUST BE SKIPPED by verify-loop.sh (this ran)");
process.exit(1);
