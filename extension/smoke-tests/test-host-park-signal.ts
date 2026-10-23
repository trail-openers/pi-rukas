#!/usr/bin/env bun
/**
 * #1696 — a host-mode park arms a repeat guard even when no record covers it.
 *
 * The tehas batch behind this issue parked the same way three to nine times on
 * an unchanged issue body. `PI_ENSEMBLE_HANDOFF_CHANNEL=host` posts no comment
 * and applies no `needs-human-attention` label BY CONTRACT, so the attention
 * gate has nothing to read; and the #1743 park record exists only for the three
 * `COVERED_PARK_CAPS`, so a lens round cap or a `step-failed:<step>` left no
 * memory at all. A factory that passes `--restart` wiped the state file and the
 * cycle ran again as if for the first time.
 *
 * The fix is a second, host-only signal counted at publish time and read by the
 * pre-loop guard — NOT a label, and NOT a forge post. What the cases below pin:
 *   1. two host cycles that publish an identical uncovered park → the third
 *      `runHeadless({restart:true})` is refused: cap `repeat-park`,
 *      `not-started`, zero dispatches;
 *   2. what clears it: an edited issue body, `PI_ENSEMBLE_REPEAT_PARK=0`; an
 *      unreadable body fails OPEN, as does a malformed or expired signal;
 *   3. an empty handoff body published nothing, so it counts nothing;
 *   4. the forge channel writes no signal at all — nothing changes there;
 *   5. host mode still makes zero comment/label forge calls, and the merge path
 *      forgets the signal the way it forgets the covered records.
 *
 * Offline: no Pi session, no network (`PI_ENSEMBLE_FORGE=none`, both fetches
 * stubbed).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Forge } from "../src/forge.ts";
import { runHeadless } from "../src/headless/run.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { DriverHost } from "../src/work-driver-host.ts";
import { runHandoff } from "../src/work-driver-handoff.ts";
import {
  clearHostParkSignals,
  hostParkSignalPath,
} from "../src/work-driver-park-memory-host.ts";
import { type WorkState, appendEvent, initialState, writeState } from "../src/workflow-state.ts";
import { runWorkDriver } from "../src/work-driver.ts";

process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_FORGE = "none";
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ISSUE = 930;
/** A cap OUTSIDE COVERED_PARK_CAPS — the whole point: no park record for it. */
const CAP = "step-failed:explore";

interface World {
  repo: string;
  body: string;
  bodyReadable: boolean;
  /** The handoff body the cycle renders; "" simulates one that published nothing. */
  handoffBody: string;
  dispatches: number;
  forgeCalls: string[];
}

function world(label: string): World {
  const repo = mkdtempSync(path.join(tmpdir(), `host-park-${label}-`));
  mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  return {
    repo,
    body: `title:\tmock #${ISSUE}\n\nthe verify gate hangs on a sandbox`,
    bodyReadable: true,
    handoffBody: "The cycle stopped: the explore dispatch failed twice.",
    dispatches: 0,
    forgeCalls: [],
  };
}

/** A forge whose every write throws, so a host cycle has nothing to post anyway. */
function recordingForge(w: World): Forge {
  const base = { forge: "github", host: "github.com", owner: "o", repo: "r" } as object;
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      if (prop === "then") return undefined;
      return async (...args: unknown[]) => {
        w.forgeCalls.push(String(prop));
        if (prop === "issueComment") {
          return `https://github.com/o/r/issues/${args[0]}#issuecomment-1`;
        }
        throw new Error(`${String(prop)} unavailable`);
      };
    },
  }) as Forge;
}

function seams(w: World) {
  return {
    issueBodyFetcherFn: async () => {
      if (!w.bodyReadable) throw new Error("gh: connection reset");
      return { stdout: w.body };
    },
    dispatchFn: async (_pi: string, spec: { role: string }): Promise<DispatchResult> => {
      w.dispatches++;
      throw new Error(`${spec.role} dispatch failed (simulated)`);
    },
  };
}

let clock = 1_700_000_000_000;

/**
 * Drive the handoff step directly for a cap no step can be coaxed into on
 * command, with the body the cycle would have handed the host.
 */
async function park(
  w: World,
  opts: { host: boolean; body?: string; parkReason?: string },
): Promise<WorkState> {
  const ctx = {
    host: { sendUserMessage: () => undefined } as unknown as DriverHost,
    repoRoot: w.repo,
    issue: ISSUE,
    issues: [ISSUE],
    forge: recordingForge(w),
    ...seams(w),
  } as unknown as DriverContext;
  const state = appendEvent(initialState(ISSUE, ++clock), {
    kind: "cap-hit",
    at: Date.now(),
    cap: CAP,
    reviewRound: 0,
    nextStep: "handoff",
    ...(opts.parkReason ? { parkReason: opts.parkReason } : {}),
  } as never);
  const body = opts.body === undefined ? w.handoffBody : opts.body;
  // The one rule the signal counts: a park is published when a NON-EMPTY body
  // reached the host. With no body there is no handoff at all to count.
  if (!body) return state;
  if (opts.host) process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  else delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
  try {
    return await runHandoff(ctx, state, Date.now());
  } finally {
    if (!opts.host) delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
  }
}

const signalOf = (w: World) =>
  JSON.parse(readFileSync(hostParkSignalPath(w.repo, ISSUE), "utf8")) as Array<{
    cap: string;
    reason: string;
    deliveredCount: number;
  }>;

/** The factory's own call: a fresh cycle for the issue, `--restart` and all. */
async function start(w: World, host: boolean) {
  if (host) process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  else delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
  try {
    return await runHeadless({
      repoRoot: w.repo,
      issues: [ISSUE],
      restart: true,
      driverSeams: seams(w) as never,
      write: () => {},
    });
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
  }
}

const refused = (run: Awaited<ReturnType<typeof start>>) => run.results[0].cap === "repeat-park";

/**
 * Publish one park through the DRIVER itself (`runWorkDriver`) rather than the
 * handoff step alone: the state file is written first, so every step a real
 * cycle takes runs, and the signal is left beside a state file the next
 * `--restart` wipes — the shape the factory leaves behind.
 */
async function driverPark(w: World): Promise<void> {
  const ctx = {
    host: { sendUserMessage: () => undefined } as unknown as DriverHost,
    repoRoot: w.repo,
    issue: ISSUE,
    issues: [ISSUE],
    restart: true,
    ...seams(w),
  } as unknown as DriverContext;
  await writeState(
    w.repo,
    appendEvent(initialState(ISSUE, ++clock), {
      kind: "cap-hit",
      at: Date.now(),
      cap: CAP,
      reviewRound: 0,
      nextStep: "handoff",
    } as never),
  );
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  try {
    await runWorkDriver(ctx);
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
  }
}

// ── 1. Two host parks published → the third start is refused before anything
//        runs, in the same shape as the #1743 covered guard.
{
  const w = world("refused");
  try {
    await park(w, { host: true });
    await park(w, { host: true });
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
      existsSync(hostParkSignalPath(w.repo, ISSUE)),
      `…and the signal sits beside it under .pi/work-state/${ISSUE}/`,
    );
    assert(
      signalOf(w).some((r) => r.cap === CAP && r.deliveredCount === 2),
      "…counted by the driver's own handoff, not by a fixture's",
    );
    rmSync(stateFile, { force: true });
    const run = await start(w, true);
    assert(refused(run), "a --restart that wipes the state file still gets refused");
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 2. What clears it, and what must never refuse on nothing.
{
  const w = world("edited");
  await park(w, { host: true });
  await park(w, { host: true });
  w.body = `title:\tmock #${ISSUE}\n\nREVISED: the sandbox has no network`;
  const run = await start(w, true);
  assert(!refused(run), "an edited issue body: the third start proceeds — the fingerprint is the comparison");
  rmSync(w.repo, { recursive: true, force: true });
}
{
  const w = world("disabled");
  await park(w, { host: true });
  await park(w, { host: true });
  process.env.PI_ENSEMBLE_REPEAT_PARK = "0";
  try {
    const run = await start(w, true);
    assert(!refused(run), "PI_ENSEMBLE_REPEAT_PARK=0: the handoff is delivered regardless");
    assert(signalOf(w)[0]?.deliveredCount === 2, "…and the signal survives the disable");
  } finally {
    delete process.env.PI_ENSEMBLE_REPEAT_PARK;
    rmSync(w.repo, { recursive: true, force: true });
  }
}
{
  const w = world("unreadable-body");
  await park(w, { host: true });
  await park(w, { host: true });
  w.bodyReadable = false;
  const run = await start(w, true);
  assert(!refused(run), "issue body unreadable: fails OPEN — no refusal on a comparison it could not make");
  rmSync(w.repo, { recursive: true, force: true });
}
{
  const w = world("malformed-signal");
  await park(w, { host: true });
  await park(w, { host: true });
  writeFileSync(hostParkSignalPath(w.repo, ISSUE), "{not json", "utf8");
  const run = await start(w, true);
  assert(!refused(run), "a malformed signal file is ABSENT, never trusted: the start proceeds");
  rmSync(w.repo, { recursive: true, force: true });
}
{
  const w = world("implausible-count");
  await park(w, { host: true });
  await park(w, { host: true });
  const file = hostParkSignalPath(w.repo, ISSUE);
  const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  rows[0].deliveredCount = "lots";
  writeFileSync(file, JSON.stringify(rows), "utf8");
  const run = await start(w, true);
  assert(!refused(run), "a `deliveredCount` that is not an integer arms nothing — the refusal is a hard stop");
  rmSync(w.repo, { recursive: true, force: true });
}
{
  const w = world("expired");
  await park(w, { host: true });
  await park(w, { host: true });
  const file = hostParkSignalPath(w.repo, ISSUE);
  const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
  for (const r of rows) {
    r.firstAt = old;
    r.lastAt = old;
  }
  writeFileSync(file, JSON.stringify(rows), "utf8");
  const run = await start(w, true);
  assert(!refused(run), "a row past the 14-day floor the sweep deletes under arms nothing");
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
      !existsSync(hostParkSignalPath(w.repo, ISSUE)),
      "an empty handoff body wrote no signal — nobody received anything",
    );
    const run = await start(w, true);
    assert(!refused(run), "…and the third start is not refused");
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

// ── 3b. Two parks of ONE cap whose causes differ are two parks: the fingerprint
//        alone cannot tell a round cap at round 3 from a verify failure, and
//        refusing the second on the count of the first would stop work nobody
//        ever reported the same way twice.
{
  const w = world("two-causes");
  try {
    await park(w, { host: true });
    // The same cap, a different stated cause: the cause is part of the key.
    await park(w, { host: true, parkReason: "already-implemented" });
    const rows = signalOf(w);
    assert(rows.length === 2, `two causes of one cap are TWO rows (${rows.length})`);
    assert(
      rows.every((r) => r.deliveredCount === 1),
      `…each counted once, so neither arms a refusal on the other's count (${rows.map((r) => r.deliveredCount).join(", ")})`,
    );
    const run0 = await start(w, true);
    assert(!refused(run0), "…and the next start still runs: two causes, one report each");
    // And a park whose fingerprint is a different body is a different row: the
    // key is (cap, reason, fingerprint), not the cap.
    const other = createHash("sha256").update("a different issue body").digest("hex");
    writeFileSync(
      hostParkSignalPath(w.repo, ISSUE),
      JSON.stringify(rows.map((r) => ({ ...r, fingerprint: other, deliveredCount: 5 }))),
      "utf8",
    );
    const run = await start(w, true);
    assert(
      !refused(run),
      "rows counted against a DIFFERENT issue body arm nothing for this one",
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
      !existsSync(hostParkSignalPath(w.repo, ISSUE)),
      "forge: the host signal was NOT written — the host channel is its only producer",
    );
    await park(w, { host: false });
    await park(w, { host: false });
    const run = await start(w, false);
    assert(
      !refused(run),
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
    await park(w, { host: true });
    await park(w, { host: true });
    const writes = w.forgeCalls.filter((c) => /comment|label/i.test(c));
    assert(
      writes.length === 0,
      `host: still no forge comment or label call (saw: ${writes.join(",") || "none"})`,
    );
    assert(
      existsSync(hostParkSignalPath(w.repo, ISSUE)),
      "…and the memory that stands in for them is pi-rukas' own file",
    );
    await clearHostParkSignals(w.repo, [ISSUE]);
    assert(
      !existsSync(hostParkSignalPath(w.repo, ISSUE)),
      "the merge path's clear forgets it too: landed work is not a reason to refuse a later start",
    );
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}

process.exit(exit);
