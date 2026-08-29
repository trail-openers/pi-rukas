#!/usr/bin/env bun
/**
 * Cross-group path-claim conflict detection.
 *
 * Verifies the path-claim registry (work-driver-path-claims.ts):
 *  1. Atomic write and release of claims
 *  2. Liveness checking via PID
 *  3. Overlap detection using normaliseDeclaredPath
 *  4. Escape hatch PI_ENSEMBLE_CROSS_GROUP_CONFLICTS=0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkAndRegisterClaims,
  checkCrossGroupClaimsSync,
  crossGroupConflictsEnabled,
  readClaims,
  registerClaim,
  releaseClaim,
} from "../src/work-driver-path-claims.ts";
import { initialState } from "../src/workflow-state-update.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-claims-test-"));
}

// Helper: build a minimal workstate.
function makeState(issue: number, repoRoot: string): WorkState {
  return {
    ...initialState(issue, repoRoot),
    pipelineState: {
      ...initialState(issue, repoRoot).pipelineState,
      workstreams: {},
    },
  };
}

// ================================================================ 1. Atomic write/release
{
  const dir = tmpDir();
  try {
    const claims = await readClaims(dir);
    assert(claims.length === 0, "empty registry returns []");
    const registered = await registerClaim(dir, 42, ["src/a.ts"]);
    assert(registered.length === 1, "register adds one claim");
    assert(registered[0].issue === 42, "claim carries correct issue");
    assert(registered[0].pid === process.pid, "claim carries our PID");
    assert(registered[0].paths.length === 1, "claim carries normalised path");
    const remaining = await releaseClaim(dir, 42);
    assert(remaining.length === 0, "release removes the claim");
    const after = await readClaims(dir);
    assert(after.length === 0, "read after release returns empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 2. PID liveness
{
  const dir = tmpDir();
  try {
    // Register with a non-existent PID (0 always fails kill).
    const wd = path.join(dir, ".pi", "work-state");
    mkdirSync(wd, { recursive: true });
    writeFileSync(
      path.join(wd, "path-claims.json"),
      JSON.stringify([{ issue: 99, pid: 999999, paths: ["src/x.ts"], startedAt: Date.now() }]),
    );
    const claims = await readClaims(dir);
    assert(claims.length === 0, "stale PID (0) is filtered out");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 3. Overlap detection — exact match
{
  const claims = [{ issue: 101, pid: process.pid, paths: ["src/utils.ts"], startedAt: Date.now() }];
  const result = checkCrossGroupClaimsSync(202, { "task-a": { paths: ["src/utils.ts"] } }, claims);
  assert(result.length === 1, "exact path overlap is detected");
  assert(result[0].issue === 101, "conflict carries sibling issue");
  assert(
    checkCrossGroupClaimsSync(203, { "task-a": { paths: ["src/other.ts"] } }, claims).length === 0,
    "disjoint paths don't conflict",
  );
}

// ================================================================ 4. normaliseDeclaredPath
{
  const claims = [{ issue: 301, pid: process.pid, paths: ["src/foo.ts"], startedAt: Date.now() }];
  assert(
    checkCrossGroupClaimsSync(302, { "task-a": { paths: ["src/foo.ts (new)"] } }, claims).length ===
      1,
    "normalised path (new) annotation still overlaps",
  );
  assert(
    checkCrossGroupClaimsSync(303, { "task-a": { paths: ["  src/foo.ts  "] } }, claims).length ===
      1,
    "whitespace trimming still overlaps",
  );
  const result3 = checkCrossGroupClaimsSync(
    304,
    { "task-a": { paths: ["src/foo.ts", "docs/readme.md"] } },
    claims,
  );
  assert(result3.length === 1, "partial overlap in multi-path workstream is detected");
}

// ================================================================ 5. Multi-path workstream overlap
{
  const claims = [
    { issue: 401, pid: process.pid, paths: ["src/a.ts", "src/b.ts"], startedAt: Date.now() },
  ];
  const result = checkCrossGroupClaimsSync(
    402,
    { "task-x": { paths: ["src/b.ts", "src/c.ts"] } },
    claims,
  );
  assert(result.length === 1, "one sibling conflict even when multiple paths overlap");
  assert(
    result[0].paths.includes("src/b.ts"),
    "overlapping path is visible in the sibling's paths",
  );
}

// ================================================================ 6. Same issue is not a conflict
{
  const claims = [{ issue: 501, pid: process.pid, paths: ["src/a.ts"], startedAt: Date.now() }];
  const result = checkCrossGroupClaimsSync(501, { default: { paths: ["src/a.ts"] } }, claims);
  assert(result.length === 0, "same issue is not a cross-group conflict");
}

// ================================================================ 7. Empty paths return no conflicts
{
  const claims = [{ issue: 601, pid: process.pid, paths: ["src/a.ts"], startedAt: Date.now() }];
  assert(
    checkCrossGroupClaimsSync(602, { default: { paths: [] } }, claims).length === 0,
    "empty paths list returns no conflicts",
  );
  assert(
    checkCrossGroupClaimsSync(603, {}, claims).length === 0,
    "no workstreams returns no conflicts",
  );
}

// ================================================================ 8. Escape hatch
{
  const orig = process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS;
  try {
    process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";
    assert(!crossGroupConflictsEnabled(), "PI_ENSEMBLE_CROSS_GROUP_CONFLICTS=0 disables the check");
    process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "false";
    assert(
      !crossGroupConflictsEnabled(),
      "PI_ENSEMBLE_CROSS_GROUP_CONFLICTS=false disables the check",
    );
  } finally {
    process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = orig ?? "";
  }
  assert(crossGroupConflictsEnabled(), "unset or other values enable the check");
}

// ================================================================ 9. checkAndRegisterClaims — no conflict registers
{
  const dir = tmpDir();
  try {
    const state = makeState(701, dir);
    const workstreams = { "task-a": { paths: ["src/feature.ts"] } };
    const ctx = { repoRoot: dir, issue: 701 } satisfies Partial<
      import("../src/work-driver-context.ts").DriverContext
    > as import("../src/work-driver-context.ts").DriverContext;
    const result = await checkAndRegisterClaims(ctx, state, workstreams);
    assert(result.pipelineState.status === "running", "no conflict → state unchanged");
    const claims = await readClaims(dir);
    assert(claims.length === 1, "claim was registered");
    assert(claims[0].paths.includes("src/feature.ts"), "registered path is normalised");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 10. checkAndRegisterClaims — conflict parks
{
  const dir = tmpDir();
  try {
    await registerClaim(dir, 801, ["src/shared.ts"]);
    const state = makeState(802, dir);
    const workstreams = { "task-b": { paths: ["src/shared.ts"] } };
    const ctx = { repoRoot: dir, issue: 802 } satisfies Partial<
      import("../src/work-driver-context.ts").DriverContext
    > as import("../src/work-driver-context.ts").DriverContext;
    const result = await checkAndRegisterClaims(ctx, state, workstreams);
    const capHit = result.eventLog.find((e) => e.kind === "cap-hit");
    assert(capHit !== undefined, "cap-hit event emitted on conflict");
    assert(capHit?.cap === "cross-group-conflict", "cap type is cross-group-conflict");
    assert(result.pipelineState.status === "handoff", "status set to handoff");
    assert(result.pipelineState.currentStep === "plan", "currentStep stays plan");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 11. Multiple sibling claims
{
  const dir = tmpDir();
  try {
    await registerClaim(dir, 901, ["src/a.ts"]);
    await registerClaim(dir, 902, ["src/b.ts"]);
    const claims = await readClaims(dir);
    assert(claims.length === 2, "two sibling claims coexist");
    const issues = claims.map((c) => c.issue).sort();
    assert(issues[0] === 901 && issues[1] === 902, "both sibling issues present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 12. Self-claim cleanup on re-register
{
  const dir = tmpDir();
  try {
    await registerClaim(dir, 1001, ["src/a.ts"]);
    await registerClaim(dir, 1001, ["src/b.ts"]);
    const claims = await readClaims(dir);
    const ourClaims = claims.filter((c) => c.issue === 1001);
    assert(ourClaims.length === 1, "re-registering same issue replaces old claim");
    assert(ourClaims[0].paths.length === 1, "only the new path is kept");
    assert(ourClaims[0].paths.includes("src/b.ts"), "new path is the correct one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 13. back-compat: invalid JSON in claims file
{
  const dir = tmpDir();
  try {
    const wd = path.join(dir, ".pi", "work-state");
    mkdirSync(wd, { recursive: true });
    writeFileSync(path.join(wd, "path-claims.json"), "not-json!");
    const claims = await readClaims(dir);
    assert(claims.length === 0, "invalid JSON returns [] without throwing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 14. back-compat: non-array claims file
{
  const dir = tmpDir();
  try {
    const wd = path.join(dir, ".pi", "work-state");
    mkdirSync(wd, { recursive: true });
    writeFileSync(path.join(wd, "path-claims.json"), JSON.stringify({ issue: 1, pid: 1 }));
    const claims = await readClaims(dir);
    assert(claims.length === 0, "non-array claims file returns []");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 15. back-compat: missing claims file
{
  const dir = tmpDir();
  try {
    const claims = await readClaims(dir);
    assert(claims.length === 0, "missing claims file returns []");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 16. releaseClaim on non-existent issue is safe
{
  const dir = tmpDir();
  try {
    await registerClaim(dir, 1601, ["src/z.ts"]);
    await releaseClaim(dir, 9999); // issue that never claimed
    const claims = await readClaims(dir);
    assert(claims.length === 1, "releasing a non-existent issue is safe");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
