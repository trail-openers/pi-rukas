#!/usr/bin/env bun
// #1028 fixture: a FAILING test whose output is noise that LOOKS like
// failure — several `✓` pass lines, one of which contains the substring
// "error" (the un-anchored filter's exact false-positive), plus a real
// failure at the end. In --digest mode:
//   * no ✓ line may survive (the keep-filter is anchored on line start);
//   * the `✓ ... error ...` line specifically must be absent even though
//     it contains "error";
//   * the real failure line (a `✗` line) must be present.
console.error("fixture-check-noise: running a mixed check");
console.error("✓ happy path: request returns 200");
console.error("✓ no error handling: assertion passed"); // ← the trap line
console.error("✓ edge case: empty input returns empty output");
console.error("✗ fixture-check-noise: real failure at the end: expected 1, got 0");
process.exit(1);
