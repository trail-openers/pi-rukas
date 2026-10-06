#!/usr/bin/env bun
// #827 fixture: a failing test whose output carries TWO `✗` assertion
// lines (one after the other), for the multi-failure multi-assertion case.
console.error("fixture-multi: running compound checks");
console.error("✗ fixture-multi: first assertion: expected 'alpha', got 'beta'");
console.error("  at checkAlpha (fixture-multi.ts:12:7)");
console.error("✗ fixture-multi: second assertion: expected 0 failures, got 2");
process.exit(1);
