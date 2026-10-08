#!/usr/bin/env bun
// #1017 — canary fixture for the verify-loop.sh spawn-guard export.
//
// Prints the live-spawn guard as the child process sees it. Under
// verify-loop.sh (which exports PI_ENSEMBLE_FORBID_LIVE_SPAWN=1) it prints
// "1"; when invoked directly by bun (no gate) it prints "(unset)". The
// canary case in test-verify-loop.ts asserts both directions, so a removal
// of the export from verify-loop.sh turns the offline suite red.
console.log(`GUARD=${process.env.PI_ENSEMBLE_FORBID_LIVE_SPAWN ?? "(unset)"}`);
console.log(`ALLOW=${process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN ?? "(unset)"}`);
