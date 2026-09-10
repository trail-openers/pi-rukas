#!/usr/bin/env bun
/**
 * #679 — CASE 2a: `parseWorkstreams` must parse `- depends-on: <id>` lines
 * (tolerant of `depends_on:` / `Depends on:` variants, comma-separated multi-dep)
 * into `dependsOn?: string[]`, and `- integration-test: <path>` into
 * `integrationTest?: string`.
 *
 * Mirrors the test-workstream-path-normalise.ts canary pattern with variant fixtures.
 */

import { parseWorkstreams } from "../src/work-driver-plan.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --------------------------------------------------- depends-on parsing

{
  const block = [
    "## Workstreams",
    "",
    "### task-a — base work",
    "- paths: src/a.ts",
    "",
    "### task-b — depends on a",
    "- paths: src/b.ts",
    "- depends-on: task-a",
  ].join("\n");
  const parsed = parseWorkstreams(block);
  assert(
    parsed["task-b"]?.dependsOn?.length === 1 && parsed["task-b"]?.dependsOn?.[0] === "task-a",
    "depends-on: single dep parsed into dependsOn array",
  );
  assert(
    parsed["task-a"]?.dependsOn === undefined,
    "workstream without depends-on line has dependsOn undefined",
  );
}

{
  // Comma-separated multi-dep
  const block = [
    "## Workstreams",
    "",
    "### task-a — base 1",
    "- paths: src/a.ts",
    "",
    "### task-b — base 2",
    "- paths: src/b.ts",
    "",
    "### task-c — depends on both",
    "- paths: src/c.ts",
    "- depends-on: task-a, task-b",
  ].join("\n");
  const parsed = parseWorkstreams(block);
  assert(
    parsed["task-c"]?.dependsOn?.length === 2,
    "depends-on: comma-separated multi-dep parsed into 2-element array",
  );
  assert(
    parsed["task-c"]?.dependsOn?.includes("task-a") && parsed["task-c"]?.dependsOn?.includes("task-b"),
    "depends-on: both deps present in the array",
  );
}

{
  // Alternative key spelling: depends_on (underscore)
  const block = [
    "## Workstreams",
    "",
    "### task-a — base",
    "- paths: src/a.ts",
    "",
    "### task-b — depends_on variant",
    "- paths: src/b.ts",
    "- depends_on: task-a",
  ].join("\n");
  const parsed = parseWorkstreams(block);
  assert(
    parsed["task-b"]?.dependsOn?.[0] === "task-a",
    "depends_on: underscore variant parsed correctly",
  );
}

{
  // Alternative key spelling: "Depends on:" (prose variant with space)
  const block = [
    "## Workstreams",
    "",
    "### task-a — base",
    "- paths: src/a.ts",
    "",
    "### task-b — prose variant",
    "- paths: src/b.ts",
    "- Depends on: task-a",
  ].join("\n");
  const parsed = parseWorkstreams(block);
  assert(
    parsed["task-b"]?.dependsOn?.[0] === "task-a",
    "Depends on: prose variant (space) parsed correctly",
  );
}

// --------------------------------------------------- integration-test parsing

{
  const block = [
    "## Workstreams",
    "",
    "### task-a — base",
    "- paths: src/a.ts",
    "",
    "### task-b — has integration test",
    "- paths: src/b.ts",
    "- depends-on: task-a",
    "- integration-test: smoke-tests/test-integration.ts",
  ].join("\n");
  const parsed = parseWorkstreams(block);
  assert(
    parsed["task-b"]?.integrationTest === "smoke-tests/test-integration.ts",
    "integration-test: single path parsed into integrationTest field",
  );
}

{
  // Alternative key spelling: integration_test
  const block = [
    "## Workstreams",
    "",
    "### task-a — base",
    "- paths: src/a.ts",
    "",
    "### task-b — underscore variant",
    "- paths: src/b.ts",
    "- depends-on: task-a",
    "- integration_test: smoke-tests/test-int.ts",
  ].join("\n");
  const parsed = parseWorkstreams(block);
  assert(
    parsed["task-b"]?.integrationTest === "smoke-tests/test-int.ts",
    "integration_test: underscore variant parsed correctly",
  );
}

{
  // No integration-test line → undefined
  const block = [
    "## Workstreams",
    "",
    "### task-a — base",
    "- paths: src/a.ts",
    "",
    "### task-b — no integration test",
    "- paths: src/b.ts",
    "- depends-on: task-a",
  ].join("\n");
  const parsed = parseWorkstreams(block);
  assert(
    parsed["task-b"]?.integrationTest === undefined,
    "integration-test: absent line → undefined",
  );
}

// --------------------------------------------------- N=1 default path unaffected

{
  const block = ["## Workstreams", "", "### default — everything", "- paths: src/a.ts"].join("\n");
  const parsed = parseWorkstreams(block);
  assert(
    Object.keys(parsed).length === 1 && parsed.default?.dependsOn === undefined,
    "N=1 default workstream: no dependsOn field (byte-identical path)",
  );
}

// --------------------------------------------------- fold interaction

{
  // When workstreams are folded (exceed MAX_WORKSTREAMS), the depends-on
  // of the folded workstream should be dropped (the target id no longer exists).
  const prev = process.env.PI_ENSEMBLE_MAX_WORKSTREAMS;
  process.env.PI_ENSEMBLE_MAX_WORKSTREAMS = "2";
  try {
    const block = [
      "## Workstreams",
      "",
      "### a — one",
      "- paths: src/a.ts",
      "",
      "### b — two",
      "- paths: src/b.ts",
      "",
      "### c — three (folded)",
      "- paths: src/c.ts",
      "- depends-on: a",
    ].join("\n");
    const parsed = parseWorkstreams(block);
    const ids = Object.keys(parsed);
    assert(
      ids.length === 2,
      "fold: 3 workstreams folded to ceiling of 2",
    );
    // The folded workstream's depends-on is not preserved (it's dropped during fold)
    const last = parsed[ids[1] ?? ""];
    assert(
      last?.dependsOn === undefined || last?.dependsOn?.length === 0,
      "fold: depends-on of folded workstream is not silently preserved",
    );
  } finally {
    if (prev === undefined) process.env.PI_ENSEMBLE_MAX_WORKSTREAMS = undefined;
    else process.env.PI_ENSEMBLE_MAX_WORKSTREAMS = prev;
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
