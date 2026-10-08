#!/usr/bin/env bun
// #1014 — a test that exits 124 of its own accord (the conventional "timed
// out" sentinel), but WITHOUT the `✗ timed out after <N>s` line that only
// the verify-loop watchdog prepends. The loop must report this as a plain
// `FAILED: <file>` (no "(timed out after <N>s)" suffix) — exit-124
// disambiguation is done by the watchdog's own marker, not by the raw exit
// code. This pins the cosmetic attribution bug from the #1014 round-1
// adversarial review: previously the marker was emitted purely from
// `rc -eq 124`, so a legitimate self-exit-124 test was misreported as a
// timeout.

console.error("fixture-exit124: intentional self-exit-124 (not a timeout)");
process.exit(124);
