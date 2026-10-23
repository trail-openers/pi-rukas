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
 *   (f/g) #1743 — a dir holding a LIVE / expired park record
 *   (h/i/j/k/l) #1696 — the HOST park signal: a live row holds the dir, an
 *        expired or unparseable one does not, the sweep path never asks the
 *        forge for an issue body, and a file that exists but cannot be read is
 *        answered by the reader (ENOENT-shaped miss = not held, any other read
 *        error = held on doubt)
 */

import assert from "node:assert";
import { mkdirSync, utimesSync, existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_PARK_SIGNAL_FILE } from "../src/work-driver-park-memory-host.ts";
import { holdsLiveHostParkSignal } from "../src/work-driver-park-memory-host.ts";
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

    // ── (h/i/j) #1696 — the HOST channel's park signal lives in this same
    //        directory and arms the same kind of refusal, so the covered
    //        record's rules apply to it: a live row holds the directory, an
    //        expired row and unparseable content do not. Each dir is its own
    //        orphan (no sibling state file) and backdated past the 14-day floor,
    //        so the ONLY thing deciding its fate is the signal inside it.
    const hostRow = (over: Record<string, unknown>) => ({
      cap: "step-failed:explore",
      reason: "explore dispatch failed twice",
      fingerprint: "a".repeat(64),
      deliveredCount: 2,
      firstAt: Date.now() - 3600_000,
      lastAt: Date.now() - 1800_000,
      lastCycleId: 1,
      ...over,
    });

    // (h) a LIVE host row → the directory is held.
    const hDir = join(ws, "700");
    mkdirSync(hDir, { recursive: true });
    writeFileSync(join(hDir, HOST_PARK_SIGNAL_FILE), JSON.stringify([hostRow({})]));
    backdate(hDir, 30);

    // (i) an EXPIRED host row → swept. Past the age the guard itself ignores,
    // keeping the directory alive preserves dead state for nothing.
    const iDir = join(ws, "800");
    mkdirSync(iDir, { recursive: true });
    const stale = Date.now() - 30 * 24 * 60 * 60 * 1000;
    writeFileSync(
      join(iDir, HOST_PARK_SIGNAL_FILE),
      JSON.stringify([hostRow({ firstAt: stale, lastAt: stale })]),
    );
    backdate(iDir, 30);

    // (j) content that parses to NO believable row → swept. `not-a-cap` is not a
    // cap the driver can emit (`isKnownCap`), so no writer produced this file and
    // no reader would refuse on it; an unreadable FILE holds the dir, unreadable
    // CONTENT does not.
    const jDir = join(ws, "900");
    mkdirSync(jDir, { recursive: true });
    writeFileSync(
      join(jDir, HOST_PARK_SIGNAL_FILE),
      JSON.stringify([hostRow({ cap: "not-a-cap" })]),
    );
    backdate(jDir, 30);

    const hostSweep = await runArtifactSweep({
      repoRoot: root,
      execFn: async () => ({ stdout: "" }),
    });
    assertTrue(
      hostSweep.swept.includes("800"),
      `(i) an old orphan whose host park row is past the 14-day life is swept, got [${hostSweep.swept}]`,
    );
    assertTrue(
      hostSweep.swept.includes("900"),
      `(j) an old orphan whose host signal parses to no believable row is swept, got [${hostSweep.swept}]`,
    );
    assertTrue(
      existsSync(hDir) &&
        hostSweep.skipped.some((s) => s.name === "700" && s.reason === "park-record-held"),
      "(h) an old orphan holding a LIVE host park signal survives, and the skip names it",
    );

    // ── (k) #1696 — THE EXPENSIVE ONE. The sweep runs at every cycle start and
    //        is chartered to cost nothing, but a host park row's identity
    //        includes a fingerprint of the issue text and a fingerprint is a
    //        `gh issue view`. Resolving one per orphan directory would make the
    //        sweep subprocess-bound (~4 subprocesses per dir, measured). So the
    //        sweep's answer must come from a read-only row parse, and this
    //        asserts it: the fetcher a cycle would use is injected as one that
    //        COUNTS, while the directory being judged holds a fully-formed
    //        ARMED host signal — an armed row is exactly what a guard would want
    //        a fingerprint for, so a leak would be exercised, not skipped.
    const ws3 = join(root, "pi3", ".pi", "work-state");
    mkdirSync(ws3, { recursive: true });
    const kDir = join(ws3, "1200");
    mkdirSync(kDir, { recursive: true });
    writeFileSync(
      join(kDir, HOST_PARK_SIGNAL_FILE),
      JSON.stringify([hostRow({ deliveredCount: 9, lastAt: Date.now() })]),
    );
    backdate(kDir, 30);
    let bodyFetches = 0;
    await runArtifactSweep({
      repoRoot: join(root, "pi3"),
      execFn: async () => ({ stdout: "" }),
      issueBodyFetcherFn: async () => {
        bodyFetches++;
        return { stdout: "title:\tmock #1200\n\nbody nobody should have fetched" };
      },
    });
    assertTrue(
      bodyFetches === 0,
      `(k) the sweep resolved a fingerprint ${bodyFetches} time(s) — it must answer from the rows alone and never fetch an issue body`,
    );
    assertTrue(existsSync(kDir), "(k) …and the armed row still held the directory while it did");

    // (l) #1696 — the ANSWER the sweep gets, not only the cost of getting it.
    // "The file exists but I could not read it" is a question the sweep used to
    // answer by reading the file a SECOND time. That read is folded into the
    // reader now, and the rule is a three-way one the sweep must not restate:
    // an ENOENT-shaped miss is "not held", any OTHER read error is HELD (keep
    // on doubt — a stale row costs bytes, a wrong delete costs the evidence a
    // refusal quotes), and content with no believable row is "not held".
    const ws4 = join(root, "pi4", ".pi", "work-state");
    mkdirSync(ws4, { recursive: true });
    const realDir = join(ws4, "1500");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(
      join(realDir, HOST_PARK_SIGNAL_FILE),
      JSON.stringify([hostRow({ deliveredCount: 9 })]),
      "utf8",
    );
    assertTrue(
      await holdsLiveHostParkSignal(join(root, "pi4"), 1500, Date.now()),
      "(l) a believable row holds the signal",
    );
    assertTrue(
      (await holdsLiveHostParkSignal(join(root, "pi4"), 1501, Date.now())) === false,
      "(l) no signal file at all is NOT held — the sweep's own age rule decides",
    );
    // Something non-directory where the issue's directory should be: the read
    // fails ENOTDIR, which is the absent case, not the doubt case.
    writeFileSync(join(ws4, "1502"), "not a directory", "utf8");
    assertTrue(
      (await holdsLiveHostParkSignal(join(root, "pi4"), 1502, Date.now())) === false,
      "(l) ENOTDIR reads as ABSENT, not as doubt — an ENOENT-shaped miss is no reason to keep a directory",
    );
    writeFileSync(join(realDir, HOST_PARK_SIGNAL_FILE), "   ", "utf8");
    assertTrue(
      (await holdsLiveHostParkSignal(join(root, "pi4"), 1500, Date.now())) === false,
      "(l) whitespace-only content parses to no believable row, so it is not held either",
    );
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
