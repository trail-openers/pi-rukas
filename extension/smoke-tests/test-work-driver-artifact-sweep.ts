#!/usr/bin/env bun
/**
 * Test for work-driver-artifact-sweep module (#657).
 *
 * Fixture under an mkdtemp dir: a `.pi/work-state/` with
 *   (a) a numeric dir + sibling <N>.json  → must survive
 *   (b) a numeric dir, no sibling, OLD mtime → must be removed
 *   (c) a numeric dir, no sibling, fresh mtime → must survive
 *   (d) a non-numeric dir → must survive
 *   (e) queue-summary.json (a file) → untouched
 */

import assert from "node:assert";
import { mkdirSync, utimesSync, existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runArtifactSweep } from "../src/work-driver-artifact-sweep.ts";

let exitCode = 0;
function assertTrue(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}

function backdate(p: string, days: number): void {
  const t = Date.now() - days * 24 * 60 * 60 * 1000;
  const dt = new Date(t);
  utimesSync(p, dt, dt);
}

async function runTests() {
  const root = await mkdtemp(join(tmpdir(), "artifact-sweep-"));
  try {
    const ws = join(root, ".pi", "work-state");
    mkdirSync(ws, { recursive: true });

    // (a) numeric dir with live sibling state file → survives
    const aDir = join(ws, "100");
    mkdirSync(aDir, { recursive: true });
    const aState = join(ws, "100.json");
    writeFileSync(aState, "{}");
    backdate(aDir, 30);

    // (b) numeric dir, no sibling, OLD mtime → removed
    const bDir = join(ws, "200");
    mkdirSync(bDir, { recursive: true });
    backdate(bDir, 30);

    // (c) numeric dir, no sibling, FRESH mtime → survives
    const cDir = join(ws, "300");
    mkdirSync(cDir, { recursive: true });

    // (d) non-numeric dir → survives (any age)
    const dDir = join(ws, "issue-553-notes");
    mkdirSync(dDir, { recursive: true });
    backdate(dDir, 60);

    // (e) queue-summary.json — a file → untouched
    const eFile = join(ws, "queue-summary.json");
    writeFileSync(eFile, "{}");

    // (f) #1743 — an OLD orphan dir holding a LIVE park record → untouched.
    // The record is the evidence behind a refusal the operator was told about.
    const fDir = join(ws, "500");
    mkdirSync(fDir, { recursive: true });
    writeFileSync(
      join(fDir, "park-intent-park.json"),
      JSON.stringify({
        cap: "intent-park",
        reason: "contradicted-by-code",
        fingerprint: "f".repeat(64),
        count: 2,
        deliveredCount: 2,
        firstAt: Date.now() - 3600_000,
        lastAt: Date.now() - 1800_000,
        lastMarker: "<!-- pi-rukas:handoff issue=500 cap=intent-park -->",
        lastCycleId: 1,
      }),
    );
    backdate(fDir, 30);

    // (g) an OLD orphan dir whose park record is itself past the 14-day life →
    // swept. The guard ignores an expired record, so exempting the directory
    // would keep dead state alive in exchange for nothing.
    const gDir = join(ws, "600");
    mkdirSync(gDir, { recursive: true });
    const ancient = Date.now() - 30 * 24 * 60 * 60 * 1000;
    writeFileSync(
      join(gDir, "park-intent-park.json"),
      JSON.stringify({
        cap: "intent-park",
        reason: "contradicted-by-code",
        fingerprint: "e".repeat(64),
        count: 2,
        deliveredCount: 2,
        firstAt: ancient,
        lastAt: ancient,
        lastMarker: "<!-- pi-rukas:handoff issue=600 cap=intent-park -->",
        lastCycleId: 1,
      }),
    );
    backdate(gDir, 30);

    const sweptNames: string[] = [];
    const execFn = async (cmd: string) => {
      sweptNames.push(cmd);
      return { stdout: "" };
    };

    const res = await runArtifactSweep({ repoRoot: root, execFn });

    assertTrue(res.ran, "sweep ran");
    assertTrue(
      res.swept.length === 2 && res.swept.includes("200") && res.swept.includes("600"),
      `only "200" and the expired-record "600" swept, got [${res.swept}]`,
    );
    assertTrue(
      res.checked === 6,
      `checked 6 dirs (100, 200, 300, 500, 600, issue-553-notes), got ${res.checked}`,
    );
    assertTrue(sweptNames.length === 2, `two rm's issued, got ${sweptNames.length}`);
    assertTrue(
      sweptNames[0]?.includes(JSON.stringify(bDir)) === true,
      `rm targeted the orphan path: ${sweptNames[0]}`,
    );

    assertTrue(existsSync(aDir), "(a) numeric dir with sibling .json survives");
    assertTrue(existsSync(aState), "(a) sibling state file untouched");
    assertTrue(
      existsSync(bDir),
      "(b) rm routed through the injected seam (dir itself intact — seam is a spy)",
    );
    assertTrue(existsSync(cDir), "(c) fresh orphan dir survives");
    assertTrue(existsSync(dDir), "(d) non-numeric dir survives");
    assertTrue(existsSync(eFile), "(e) queue-summary.json file untouched");
    assertTrue(
      existsSync(fDir),
      "(f) an old orphan dir holding a LIVE park record survives — it is the evidence behind a refusal the operator was given",
    );
    assertTrue(
      res.skipped.some((s) => s.name === "500" && s.reason === "park-record-held"),
      "…and the skip names the park record as the reason",
    );

    const skippedNames = res.skipped.map((s) => s.name).sort();
    assert.deepStrictEqual(
      skippedNames,
      ["100", "300", "500", "issue-553-notes"],
      "skipped = {100 live-state-file, 300 recent, 500 park-record-held, issue-553-notes non-numeric}",
    );
    assertTrue(true, "skip reasons recorded for every survivor");

    // Best-effort: a failing removal is swallowed, not thrown.
    const ws2 = join(root, "pi2", ".pi", "work-state");
    mkdirSync(ws2, { recursive: true });
    const b2 = join(ws2, "400");
    mkdirSync(b2, { recursive: true });
    backdate(b2, 30);
    const res2 = await runArtifactSweep({
      repoRoot: join(root, "pi2"),
      execFn: async () => {
        throw new Error("rm: permission denied");
      },
    });
    assertTrue(res2.swept.length === 0, "failed removal not reported as swept");
    assertTrue(
      res2.skipped.some((s) => s.name === "400" && s.reason.startsWith("remove-failed")),
      "failed removal recorded in skipped with reason",
    );
    assertTrue(existsSync(b2), "failed-removal dir still on disk");

    // Missing .pi/work-state dir → clean no-op, never throws.
    const res3 = await runArtifactSweep({ repoRoot: join(root, "empty") });
    assertTrue(res3.ran && res3.checked === 0, "missing work-state dir is a clean no-op");

    // Disabled flag → no work.
    const res4 = await runArtifactSweep({ repoRoot: root, enabled: false });
    assertTrue(res4.ran === false, "enabled:false short-circuits");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

runTests().then(
  () => process.exit(exitCode),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
