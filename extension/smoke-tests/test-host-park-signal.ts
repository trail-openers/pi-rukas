#!/usr/bin/env bun
import { createHash } from "node:crypto";
/**
 * #1696 — a host-mode park arms a repeat guard even when no record covers it.
 *
 * The orchard batch behind this issue parked the same way three to nine times on
 * an unchanged issue body. `PI_ENSEMBLE_HANDOFF_CHANNEL=host` posts no comment
 * and applies no `needs-human-attention` label BY CONTRACT, so the attention
 * gate has nothing to read; and the #1743 park record exists only for the three
 * `COVERED_PARK_CAPS`, so a lens round cap or a `step-failed:<step>` left no
 * memory at all. A factory that passes `--restart` wiped the state file and the
 * cycle ran again as if for the first time.
 *
 * The fix is a second, host-only signal counted at publish time and read by the
 * pre-loop guard — NOT a label, and NOT a forge post. The stub world, the two
 * ways a park is reached and `start()` (the factory's `runHeadless({restart:
 * true})`) live in `lib/host-park-harness.ts`. What the cases below pin:
 *   1. two host cycles that publish an identical uncovered park → the third
 *      start is refused: cap `repeat-park`, `not-started`, zero dispatches;
 *   1b. the same through the driver itself, with the signal beside a state file
 *      that `--restart` then wipes;
 *   2. what clears it: an edited issue body, `PI_ENSEMBLE_REPEAT_PARK=0`; an
 *      unreadable body fails OPEN, as does a malformed or implausible row;
 *   3. an empty handoff body published nothing, so it counts nothing; two causes
 *      of one cap are two parks, and a row from another issue body arms nothing;
 *   4. the forge channel writes no signal at all — nothing changes there;
 *   5. host mode still makes zero comment/label forge calls, the decline is
 *      recorded as `labelSkipped`, and the merge path forgets the signal.
 *
 * Offline: no Pi session, no network (`PI_ENSEMBLE_FORGE=none`, both fetches
 * stubbed).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectIssue } from "../src/headless/result.ts";
import {
  HOST_PARK_MAX_ROWS,
  clearHostParkSignals,
  readHostParkSignalsImpl as readHostParkSignals,
} from "../src/work-driver-park-memory-host.ts";
import {
  CAP,
  ISSUE,
  type World,
  driverPark,
  park,
  refused,
  signalOf,
  signalPath,
  start,
  tamperSignal,
  world,
} from "./lib/host-park-harness.ts";
import { lostParkCount } from "./lib/lost-park-count.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The module is a LEAF, and that is load-bearing rather than stylistic:
 * `work-driver-state-guards.ts` imports it for its pre-loop check, so importing
 * back into the judgement half (`work-driver-park-memory.ts`) is an import cycle
 * — and under bun the cycle is not merely untidy: that module's
 * `export const REPEAT_PARK_REFUSAL_COUNT` is evaluated only after this file's
 * top level has already read it, which is a `ReferenceError` at load time, i.e.
 * every cycle dies at import. This canary fails when the shape returns, with a
 * message naming the symptom, because the fix (read the two values locally) does
 * not look like a fix for a crash you have not seen yet.
 */
{
  const src = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "work-driver-park-memory-host.ts"),
    "utf8",
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  // A value import of the judgement half is the cycle; `import type` is erased at
  // compile time, so it cannot participate in one. Checked per import statement,
  // because the type-only import and a value import could otherwise share a name.
  const valueImport = [
    ...code.matchAll(/import\s+([^;]*?)\s+from\s+["']\.\/work-driver-park-memory\.ts["']/g),
  ].some((m) => !/^type\b/.test((m[1] ?? "").trim()));
  assert(
    !valueImport,
    "the host module imports the judgement half for TYPES only — a value import is an import cycle that kills every cycle at load",
  );
}

/** Three parked cycles' worth of the same park: two publications, then a start. */
async function twice(w: World) {
  await park(w, { host: true });
  await park(w, { host: true });
}

// ── 1. Two host parks published → the third start is refused before anything
//        runs, in the same shape as the #1743 covered guard.
{
  const w = world("refused");
  try {
    await twice(w);
    const rows = signalOf(w);
    assert(rows.length === 1, "two identical parks are ONE row");
    assert(
      rows[0]?.cap === CAP && rows[0]?.deliveredCount === 2,
      `…counted twice (${rows[0]?.deliveredCount}) for a cap the records do not cover`,
    );
    assert(
      !existsSync(path.join(w.repo, ".pi", "work-state", String(ISSUE), `park-${CAP}.json`)),
      "…and no covered park record was written for it (that path is untouched)",
    );
    const before = w.dispatches;
    const run = await start(w, true);
    const r = run.results[0];
    assert(run.exitCode === 40 && r.exitCode === 40, "the third start exits EXIT.refused");
    assert(refused(run), "…with cap `repeat-park`");
    assert(r.status === "not-started", "…status not-started");
    assert(r.handoff === undefined, "…and no handoff: this start delivered nothing");
    assert(
      w.dispatches === before,
      "…and zero dispatches ran: the refused start dispatched nothing",
    );
    assert(
      /already parked 2 times/.test(r.failure?.message ?? "") &&
        (r.failure?.message ?? "").includes(CAP),
      "…the failure carries the guard's verdict, naming the uncovered cap",
    );
    assert(r.resumable === false, "…and it is not resumable");
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 1b. The whole path, through the driver: the signal is written beside the
//        state file, the one place `--restart` cannot reach.
{
  const w = world("driver-path");
  try {
    await driverPark(w);
    await driverPark(w);
    const stateFile = path.join(w.repo, ".pi", "work-state", `${ISSUE}.json`);
    assert(existsSync(stateFile), "the cycles wrote their state file, as a real cycle does");
    assert(
      existsSync(signalPath(w)),
      `…and the signal sits beside it under .pi/work-state/${ISSUE}/`,
    );
    assert(
      signalOf(w).some((r) => r.cap === CAP && r.deliveredCount === 2),
      "…counted by the driver's own handoff, not by a fixture's",
    );
    rmSync(stateFile, { force: true });
    assert(
      refused(await start(w, true)),
      "a --restart that wipes the state file still gets refused",
    );
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 2. What clears it, and what must never refuse on nothing.
{
  const w = world("edited");
  await twice(w);
  w.body = `title:\tmock #${ISSUE}\n\nREVISED: the sandbox has no network`;
  assert(
    !refused(await start(w, true)),
    "an edited issue body: the third start proceeds — the fingerprint is the comparison",
  );
  rmSync(w.repo, { recursive: true, force: true });
}
{
  const w = world("disabled");
  await twice(w);
  process.env.PI_ENSEMBLE_REPEAT_PARK = "0";
  try {
    assert(
      !refused(await start(w, true)),
      "PI_ENSEMBLE_REPEAT_PARK=0: the handoff is delivered regardless",
    );
    assert(signalOf(w)[0]?.deliveredCount === 2, "…and the signal survives the disable");
  } finally {
    delete process.env.PI_ENSEMBLE_REPEAT_PARK;
    rmSync(w.repo, { recursive: true, force: true });
  }
}
{
  const w = world("unreadable-body");
  await twice(w);
  w.bodyReadable = false;
  assert(
    !refused(await start(w, true)),
    "issue body unreadable: fails OPEN — no refusal on a comparison it could not make",
  );
  rmSync(w.repo, { recursive: true, force: true });
}
{
  const w = world("malformed-signal");
  await twice(w);
  writeFileSync(signalPath(w), "{not json", "utf8");
  assert(
    !refused(await start(w, true)),
    "a malformed signal file is ABSENT, never trusted: the start proceeds",
  );
  rmSync(w.repo, { recursive: true, force: true });
}
{
  const w = world("implausible-count");
  await twice(w);
  tamperSignal(w, (r) => {
    r.deliveredCount = "lots";
  });
  assert(
    !refused(await start(w, true)),
    "a `deliveredCount` that is not an integer arms nothing — the refusal is a hard stop",
  );
  rmSync(w.repo, { recursive: true, force: true });
}
{
  const w = world("absurd-count");
  await twice(w);
  tamperSignal(w, (r) => {
    // An integer to `Number.isInteger`, but not one any writer could produce.
    r.deliveredCount = 1e18;
  });
  assert(
    !refused(await start(w, true)),
    "a `deliveredCount` of 1e18 reads as NO protection — a safe-integer bar, so a hand-edited file cannot arm the hard stop",
  );
  rmSync(w.repo, { recursive: true, force: true });
}
{
  const w = world("expired");
  await twice(w);
  const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
  tamperSignal(w, (r) => {
    r.firstAt = old;
    r.lastAt = old;
  });
  assert(
    !refused(await start(w, true)),
    "a row past the 14-day floor the sweep deletes under arms nothing",
  );
  rmSync(w.repo, { recursive: true, force: true });
}

// ── 3. An EMPTY handoff body published nothing, so it counts nothing: the
//        threshold is a count of reports the host actually received.
{
  const w = world("empty-body");
  try {
    await park(w, { host: true, body: "" });
    await park(w, { host: true, body: "" });
    assert(
      !existsSync(signalPath(w)),
      "an empty handoff body wrote no signal — nobody received anything",
    );
    assert(!refused(await start(w, true)), "…and the third start is not refused");
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 3b. Two parks of ONE cap whose causes differ are two parks: the fingerprint
//        alone cannot tell a round cap from a verify failure, and refusing the
//        second on the count of the first would stop work nobody reported twice.
{
  const w = world("two-causes");
  try {
    await park(w, { host: true });
    await park(w, { host: true, parkReason: "already-implemented" });
    const rows = signalOf(w);
    assert(rows.length === 2, `two causes of one cap are TWO rows (${rows.length})`);
    assert(
      rows.every((r) => r.deliveredCount === 1),
      `…each counted once, so neither arms a refusal on the other's count (${rows.map((r) => r.deliveredCount).join(", ")})`,
    );
    assert(
      !refused(await start(w, true)),
      "…and the next start still runs: two causes, one report each",
    );
    // The key is (cap, reason, fingerprint), not the cap: rows counted against
    // another issue body say nothing about this one.
    const other = createHash("sha256").update("a different issue body").digest("hex");
    writeFileSync(
      signalPath(w),
      JSON.stringify(rows.map((r) => ({ ...r, fingerprint: other, deliveredCount: 5 }))),
      "utf8",
    );
    assert(
      !refused(await start(w, true)),
      "rows counted against a DIFFERENT issue body arm nothing",
    );
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 4. The forge channel is untouched: no signal written, no new refusal.
{
  const w = world("forge");
  try {
    const s = await park(w, { host: false });
    assert(
      s.eventLog.some((e) => e.kind === "handoff-emitted"),
      "forge: the handoff ran and posted",
    );
    assert(
      !existsSync(signalPath(w)),
      "forge: the host signal was NOT written — the host channel is its only producer",
    );
    await park(w, { host: false });
    await park(w, { host: false });
    assert(
      !refused(await start(w, false)),
      "forge: three identical uncovered parks still start — that channel has a comment and a label",
    );
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 5. The host channel's contract is unchanged: still zero comment/label
//        forge calls, and the merge path's clearing call forgets the signal.
{
  const w = world("no-forge");
  try {
    await twice(w);
    const writes = w.forgeCalls.filter((c) => /comment|label/i.test(c));
    assert(
      writes.length === 0,
      `host: still no forge comment or label call (saw: ${writes.join(",") || "none"})`,
    );
    assert(
      existsSync(signalPath(w)),
      "…and the memory that stands in for them is pi-rukas' own file",
    );
    // The cycle's other artifacts live in the SAME directory, and one of them is
    // a sibling issue's live covered record. A clear that took the directory
    // would destroy evidence this call does not own (the sweep owns that dir's
    // life), so the merge door is checked against a neighbour that must survive.
    const dir = path.dirname(signalPath(w));
    writeFileSync(path.join(dir, "explore-spec.md"), "## Spec\n", "utf8");
    writeFileSync(path.join(dir, "park-intent-park.json"), "{}", "utf8");
    await clearHostParkSignals(w.repo, [ISSUE]);
    assert(
      !existsSync(signalPath(w)),
      "the merge path's clear forgets it too: landed work is not a reason to refuse a later start",
    );
    assert(
      existsSync(path.join(dir, "explore-spec.md")) &&
        existsSync(path.join(dir, "park-intent-park.json")) &&
        existsSync(dir),
      "…by deleting ONLY its own file: the cached spec, the covered record and the dir survive",
    );
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 5b. The file is BOUNDED. It lives in a repository's working tree, so it
//        cannot grow with every cause and every edit an issue ever had: the
//        writer keeps the newest rows and the reader refuses to believe more
//        than the ceiling either way.
{
  const w = world("row-cap");
  try {
    const total = 60;
    // Distinct CYCLES as well as causes: the ceiling prunes on recency, and
    // 60 publishes from one cycle id are all equally new.
    for (let i = 0; i < total; i++) {
      w.cycle++;
      await park(w, { host: true, parkReason: `cause-${String(i).padStart(3, "0")}` });
    }
    const rows = signalOf(w);
    assert(
      rows.length === HOST_PARK_MAX_ROWS,
      `${total} distinct published parks leave ${HOST_PARK_MAX_ROWS} rows, not ${total}`,
    );
    const causes = new Set(rows.map((r) => r.reason));
    assert(
      causes.has("cause-059") && !causes.has("cause-000") && causes.has("cause-010"),
      "…the NEWEST rows are the kept ones (the ten oldest pruned, the newest present)",
    );
    assert(
      (await readHostParkSignals(w.repo, ISSUE, "test")).length === HOST_PARK_MAX_ROWS,
      "…and the reader reads all of them, so the ceiling is a bound and not a blindfold",
    );
    // A write on top of a full file stays at the ceiling and keeps the newest —
    // the bound is the writer's, not only a reader's filter.
    w.cycle++;
    await park(w, { host: true, parkReason: "cause-060" });
    const after = signalOf(w);
    assert(
      after.length === HOST_PARK_MAX_ROWS &&
        after.some((r) => r.reason === "cause-060") &&
        !after.some((r) => r.reason === "cause-010"),
      `…and the next write stays at ${HOST_PARK_MAX_ROWS}, admitting its own row (${after.length})`,
    );
    // The ceiling is enforced in the reader too: a file a hand edit (or an older
    // writer) left longer than the cap must not arm the guard on rows no writer
    // would have kept.
    writeFileSync(
      signalPath(w),
      JSON.stringify(
        Array.from({ length: 80 }, (_, i) => ({
          cap: CAP,
          reason: `stale-${String(i).padStart(3, "0")}`,
          // A fingerprint no issue has: this case judges the ROW COUNT, not the
          // comparison, and an unrelated one must never be the reason it passes.
          fingerprint: createHash("sha256").update(`stale body ${i}`).digest("hex"),
          deliveredCount: 9,
          firstAt: Date.now() - 1000,
          lastAt: Date.now() - 500,
          lastCycleId: 1_700_000_000_000 + i,
        })),
      ),
      "utf8",
    );
    assert(
      (await readHostParkSignals(w.repo, ISSUE, "test")).length === HOST_PARK_MAX_ROWS,
      "a hand-edited file with 80 rows is read as 50 — the ceiling is the reader's too",
    );
    // A clear deletes one file, never the directory: the sweep owns that dir's
    // life, and the same door runs for every sibling issue in the group.
    const neighbour = path.join(path.dirname(signalPath(w)), "park-intent-park.json");
    writeFileSync(neighbour, "{}", "utf8");
    await clearHostParkSignals(w.repo, [ISSUE]);
    assert(
      !existsSync(signalPath(w)) && existsSync(neighbour) && existsSync(path.dirname(neighbour)),
      "the clear took only its own file — the covered record and the dir survive",
    );
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 5c. Two writers must not lose a count, and a re-entry must not move one.
//        The case lives in `lib/lost-park-count.ts` (the §12 file-size cap) and
//        stubs the signal's reader there to hand the writer a stale reading.
await lostParkCount(assert);

// ── 6. The host channel's label state says DECLINED, not FAILED: pi-rukas
//        applies no `needs-human-attention` label there by contract, and a host
//        reading only `labelApplied: false` cannot tell a decline from an outage.
{
  const w = world("label-declined");
  try {
    const ev = (await park(w, { host: true })).eventLog.find((e) => e.kind === "handoff-emitted");
    assert(
      ev?.kind === "handoff-emitted" &&
        ev.labelApplied === false &&
        ev.labelSkipped === "host-channel",
      "host: the handoff event records the decline beside its false label",
    );
    const r = projectIssue(await park(world("re-delivered"), { host: true }), "state.json");
    assert(
      r.handoff?.channel === "host" && r.handoff.labelSkipped === "host-channel",
      "…and the result carries it, so the host can print declined rather than failed",
    );
    const forgeEv = (await park(world("forge-label"), { host: false })).eventLog.find(
      (e) => e.kind === "handoff-emitted",
    );
    assert(
      forgeEv?.kind === "handoff-emitted" && forgeEv.labelSkipped === undefined,
      "forge: nothing is claimed as skipped — a false label there stays a failure",
    );
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

process.exit(exit);
