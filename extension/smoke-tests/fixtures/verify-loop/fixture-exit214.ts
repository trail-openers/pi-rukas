#!/usr/bin/env bun
// #1365 fix round — a test that exits 214 of its own accord, mirroring
// fixture-exit124.ts. The verify-loop watchdog used to signal "the bound
// fired" by RETURNING 214 from run_test_with_timeout, and the caller keyed the
// per-test "(timed out after <N>s)" suffix and the prepended `✗ timed out`
// line on `rc -eq 214`. That is the same collision the #1014 round-1 review
// found for 124, just moved one code along: any test whose own tooling exits
// 214 was reported as a timeout that never happened.
//
// The loop must report this as a plain `FAILED: <file>` carrying its real
// exit code, with NO timeout text anywhere. The disambiguation is now the
// marker file ($RUN_DIR/<n>.timeout), which only the watchdog and the pool's
// outer per-job bound write — a file name cannot collide with an exit code.

console.error("fixture-exit214: intentional self-exit-214 (not a timeout)");
process.exit(214);
