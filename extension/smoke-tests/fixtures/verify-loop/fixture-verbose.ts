#!/usr/bin/env bun
// Fixture: verbose failure — produces >800 chars of output to test
// extractAttributedTail truncation. Fails with a long stack trace.
const noise = "  at Object.<anonymous> (fixture-verbose.ts:42:11)\n";
console.error("fixture-verbose: assertion failed: expected 200, got 404");
console.error("  stack trace follows:");
for (let i = 0; i < 50; i++) {
  console.error(noise);
}
process.exit(1);
