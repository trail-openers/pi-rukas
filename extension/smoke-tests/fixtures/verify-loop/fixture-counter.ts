#!/usr/bin/env bun
// Fixture: counter — appends to a counter file on each invocation.
// Used to verify single-execution semantics (DECISION 3).
import { appendFileSync } from "node:fs";
const counterFile = process.env.FIXTURE_COUNTER_FILE ?? "/tmp/verify-loop-counter";
appendFileSync(counterFile, "1\n");
console.error("fixture-counter: assertion failed");
process.exit(1);
