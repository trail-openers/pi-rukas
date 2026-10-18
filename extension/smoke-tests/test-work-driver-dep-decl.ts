#!/usr/bin/env bun
/**
 * #679 — CASE 2a: a `report_workstream` call's `dependsOn` and `integrationTest`
 * fields reach the workstream map intact.
 *
 * #1652 — the markdown spelling variants (`depends_on:`, `Depends on:`,
 * `integration_test:`) are gone with the markdown block: a call has one key per
 * field, and the schema refuses anything else. The variant tests are therefore
 * superseded by the schema refusal asserted at the end of this file.
 */

import { workstreamCallsOf } from "../src/work-driver-plan-calls.ts";
import {
  type WorkstreamArgs,
  planResultFromCalls,
  planResultFromRawCalls,
  workstreamsOfCalls,
} from "./lib/plan-workstream-calls.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const BASE: WorkstreamArgs = {
  id: "task-a",
  scope: "base work",
  paths: ["src/a.ts"],
  outOfScope: [],
};

// --------------------------------------------------- depends-on

{
  const parsed = workstreamsOfCalls([
    BASE,
    {
      id: "task-b",
      scope: "depends on a",
      paths: ["src/b.ts"],
      outOfScope: [],
      dependsOn: ["task-a"],
    },
  ]);
  assert(
    parsed["task-b"]?.dependsOn?.length === 1 && parsed["task-b"]?.dependsOn?.[0] === "task-a",
    "dependsOn: a single dep is kept as a one-element array",
  );
  assert(
    parsed["task-a"]?.dependsOn === undefined,
    "workstream without dependsOn has dependsOn undefined",
  );
}

{
  // Multi-dep: each id is its own array element (no comma splitting).
  const parsed = workstreamsOfCalls([
    BASE,
    { id: "task-b", scope: "base 2", paths: ["src/b.ts"], outOfScope: [] },
    {
      id: "task-c",
      scope: "depends on both",
      paths: ["src/c.ts"],
      outOfScope: [],
      dependsOn: ["task-a", "task-b"],
    },
  ]);
  assert(
    parsed["task-c"]?.dependsOn?.length === 2 &&
      parsed["task-c"]?.dependsOn?.includes("task-a") &&
      parsed["task-c"]?.dependsOn?.includes("task-b"),
    "dependsOn: both deps are present in the array",
  );
}

// --------------------------------------------------- integration-test

{
  const parsed = workstreamsOfCalls([
    BASE,
    {
      id: "task-b",
      scope: "has integration test",
      paths: ["src/b.ts"],
      outOfScope: [],
      dependsOn: ["task-a"],
      integrationTest: "smoke-tests/test-integration.ts",
    },
  ]);
  assert(
    parsed["task-b"]?.integrationTest === "smoke-tests/test-integration.ts",
    "integrationTest: the path is kept in the integrationTest field",
  );
}

{
  const parsed = workstreamsOfCalls([
    BASE,
    {
      id: "task-b",
      scope: "no integration test",
      paths: ["src/b.ts"],
      outOfScope: [],
      dependsOn: ["task-a"],
    },
  ]);
  assert(
    parsed["task-b"]?.integrationTest === undefined,
    "integrationTest: absent field → undefined",
  );
}

// --------------------------------------------------- N=1 default path unaffected

{
  const parsed = workstreamsOfCalls([
    { id: "default", scope: "everything", paths: ["src/a.ts"], outOfScope: [] },
  ]);
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
    const parsed = workstreamsOfCalls([
      { id: "a", scope: "one", paths: ["src/a.ts"], outOfScope: [] },
      { id: "b", scope: "two", paths: ["src/b.ts"], outOfScope: [] },
      {
        id: "c",
        scope: "three (folded)",
        paths: ["src/c.ts"],
        outOfScope: [],
        dependsOn: ["a"],
      },
    ]);
    const ids = Object.keys(parsed);
    assert(ids.length === 2, "fold: 3 workstreams folded to ceiling of 2");
    // The folded workstream's depends-on IS preserved by the shared fold
    // (workstream-fold.ts: union of dependsOn minus the two merged ids).
    // c depends on a; c is folded into b; the merged workstream (b) keeps
    // the depends-on edge to a (a is not the merged id, so the edge survives).
    const last = parsed[ids[1] ?? ""];
    assert(
      last?.dependsOn?.includes("a") === true,
      `fold: depends-on of folded workstream IS preserved by the shared fold (got: ${JSON.stringify(last?.dependsOn)})`,
    );
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_MAX_WORKSTREAMS;
    else process.env.PI_ENSEMBLE_MAX_WORKSTREAMS = prev;
  }
}

// --------------------------------------------------- schema refusal (replaces the spelling variants)

{
  // A bare string where the schema wants an array is refused by the companion,
  // so the call adds nothing and the workstream is absent from the map.
  const transcript = planResultFromRawCalls([
    { id: "task-a", args: { ...BASE } },
    {
      id: "task-b",
      args: {
        id: "task-b",
        scope: "bad dep",
        paths: ["src/b.ts"],
        outOfScope: [],
        dependsOn: "task-a",
      },
    },
  ]);
  const refusal = transcript.toolResults[1];
  assert(refusal?.isError === true, "schema: a string dependsOn is refused by the companion");
  assert(
    Object.keys(workstreamCallsOf(transcript).workstreams).join(",") === "task-a",
    "schema: the refused call adds nothing to the workstream map",
  );
  assert(
    Object.keys(workstreamCallsOf(planResultFromCalls([BASE])).workstreams).join(",") === "task-a",
    "schema: a valid call on its own is read",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
