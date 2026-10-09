#!/usr/bin/env bun
// #1028 fixture: a FAILING test whose output contains NO `✗` line at all —
// an uncaught exception terminates the process (non-zero exit, stack trace
// on stderr, no assertion marker). The --digest mode must still attribute
// the failure by the `FAILED: <file>` marker, not only by ✗-anchoring.
console.error("fixture-throw: about to dereference nothing");
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const value = (undefined as unknown as { x: number }).x;
// (unreachable) — the throw above terminates the process before this runs
process.exit(1);
