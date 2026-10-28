#!/usr/bin/env bun
/**
 * #1871 — the owner-identity helper in process-liveness.ts.
 *
 * A spawn slot / path claim / state-file owner used to be identified by
 * `<hostname> <pid>` alone, so two containers sharing a `--hostname` called
 * each other's LIVE owners corpses and reaped them. The identity is now
 * `<host> <pidns> <pid> <starttime>` and the pid probe is consulted only when
 * BOTH host and pid namespace match this process; everything else is
 * `foreign` and never reaped.
 *
 * Why not the boot id: `/proc/sys/kernel/random/boot_id` is IDENTICAL on the
 * host and in every container on it (one shared kernel), so it separated
 * nothing. The pid-namespace inode does — and because the kernel recycles that
 * inode, the process start time (field 22 of `/proc/<pid>/stat`) is what tells
 * a recycled pid apart from the original.
 *
 * `judgeOwner(holder, self, startTimeOf)` takes the holder, the judge and the
 * start-time reader as arguments, which is the whole test seam: no env var, no
 * two-process namespace injection, no production test hook.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  NO_ID_FIELD,
  type OwnerIdentity,
  formatIdentity,
  judgeOwner,
  parseIdentity,
  processAlive,
  selfIdentity,
  validHost,
} from "../src/process-liveness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const HOST = "container-a";
const NS = "4026532101";
const OTHER_NS = "4026532404";
const START = "1234567";
const SELF: OwnerIdentity = { host: HOST, pidns: NS, pid: 4242, startTime: START };
const ME: OwnerIdentity = selfIdentity();

const id = (over: Partial<OwnerIdentity> = {}): OwnerIdentity => ({ ...SELF, ...over });
/** A reader that always reports `value` for the holder's start time. */
const startsWith = (value: string) => (_pid: number) => value;

// ── the verdict table -------------------------------------------------------
{
  const live = spawn("sleep", ["5"]);
  const livePid = live.pid ?? 999_998;
  try {
    assert(processAlive(livePid), "the sleep child is live for the probe cases");
    const dead = spawnSync("true").pid ?? 999_999;

    assert(
      judgeOwner(id({ pid: livePid }), SELF, startsWith(START)) === "alive",
      "same host + same pidns + live pid + same start time is alive",
    );
    assert(
      judgeOwner(id({ pid: livePid }), SELF, startsWith("7654321")) === "dead",
      "same host + same pidns + a live pid whose START TIME DIFFERS is dead (a recycled pid)",
    );
    assert(
      judgeOwner(id({ pid: livePid, startTime: NO_ID_FIELD }), SELF, () => {
        throw new Error("an unreadable start time must not be read from /proc");
      }) === "alive",
      "a holder whose /proc start time is unavailable (\"-\") is kept alive, not called dead on a failed read",
    );
    assert(
      judgeOwner(id({ pid: dead }), SELF, startsWith(START)) === "dead",
      "same host + same pidns + a dead pid is dead",
    );
    assert(
      judgeOwner(id({ pid: livePid, pidns: OTHER_NS }), SELF, startsWith(START)) === "foreign",
      "same host + a DIFFERENT pid namespace is foreign (a sibling container), even with a live pid",
    );
    assert(
      judgeOwner(id({ pid: dead, pidns: OTHER_NS }), SELF, startsWith(START)) === "foreign",
      "a different namespace is foreign even when the pid is certainly gone — the probe is never reached",
    );
    assert(
      judgeOwner(id({ pid: livePid, host: "container-b" }), SELF, startsWith(START)) === "foreign",
      "a DIFFERENT host is foreign whatever else matches",
    );
    assert(
      // This process IS the holder: the judge is `selfIdentity()` and the holder
      // is a copy of it, so the pid probe reaches `/proc` for a pid that is
      // certainly alive. The point of the case is the OUTCOME, not an exemption:
      // our own slot is never mistaken for a corpse, and there is no code path
      // in `judgeOwner` that exempts `self.pid` from the probe (see the next
      // two cases, which prove the probe runs for a pid that merely LOOKS like
      // ours). Passing a reader that throws would fail for the right reason and
      // the wrong cause, so the real reader is used.
      judgeOwner({ ...ME }, ME) === "alive",
      "our own identity is alive — our own slot is never mistaken for a corpse",
    );
    assert(
      // A DIFFERENT process judging a body that names its own pid: the
      // four-field form is written from `/proc/self/stat`, so this is a pid the
      // kernel handed out again and the start time is the only thing that can
      // tell the two holders apart — the reader IS consulted. `livePid` is a
      // child this test spawned, so `processAlive` cannot be what answers here.
      judgeOwner({ ...SELF, pid: livePid }, { ...SELF, pid: livePid }, startsWith(START)) ===
        "alive",
      "a holder naming our pid is alive when /proc confirms its recorded start time",
    );
    assert(
      judgeOwner({ ...SELF, pid: livePid }, { ...SELF, pid: livePid }, startsWith("99999")) ===
        "dead",
      "a holder naming our pid whose start time /proc disagrees with is RECYCLED and dead",
    );
    assert(
      judgeOwner(undefined, SELF, startsWith(START)) === "foreign",
      "an unreadable body is foreign, never a corpse",
    );
  } finally {
    try {
      live.kill();
    } catch {
      /* already gone */
    }
  }
}

// ── "-" on both sides keeps the pid probe working (macOS has no /proc) ------
{
  const live = spawn("sleep", ["5"]);
  const livePid = live.pid ?? 999_998;
  try {
    const bare = { ...SELF, pidns: NO_ID_FIELD, startTime: NO_ID_FIELD };
    assert(
      judgeOwner(id({ pid: livePid, pidns: NO_ID_FIELD, startTime: NO_ID_FIELD }), bare) ===
        "alive",
      "two \"-\" pidns values on one host count as equal and the probe answers (alive)",
    );
    const dead = spawnSync("true").pid ?? 999_999;
    assert(
      judgeOwner(id({ pid: dead, pidns: NO_ID_FIELD, startTime: START }), bare) === "dead",
      "two \"-\" pidns values still let the probe call a dead pid dead",
    );
    assert(
      judgeOwner(id({ pid: livePid, pidns: NO_ID_FIELD, startTime: NO_ID_FIELD }), SELF) ===
        "foreign",
      "\"-\" against a real pidns on the same host is foreign (an unknown never certifies a match)",
    );
    assert(
      judgeOwner(id({ pid: livePid }), { ...SELF, pidns: NO_ID_FIELD }) === "foreign",
      "a real pidns against \"-\" is foreign the other way too",
    );
  } finally {
    try {
      live.kill();
    } catch {
      /* already gone */
    }
  }
}

// ── the legacy two-field body keeps the released verdict (D3) ---------------
{
  const live = spawn("sleep", ["5"]);
  const livePid = live.pid ?? 999_998;
  try {
    const legacy = parseIdentity(`${HOST} ${livePid}`);
    assert(legacy !== undefined, "a two-field body parses (it is the released pre-#1871 format)");
    assert(
      legacy?.pidns === NO_ID_FIELD && legacy.startTime === "" && legacy.pid === livePid,
      "a two-field body carries NO pidns and NO start time (both absent, not read-and-failed)",
    );
    assert(
      judgeOwner(legacy, SELF) === "alive",
      "a legacy body on OUR host with a LIVE pid is alive (the released verdict)",
    );
    const dead = spawnSync("true").pid ?? 999_999;
    assert(
      judgeOwner(parseIdentity(`${HOST} ${dead}`), SELF) === "dead",
      "a legacy body on OUR host with a DEAD pid is dead (the released verdict)",
    );
    assert(
      judgeOwner(parseIdentity(`other-host ${dead}`), SELF) === "foreign",
      "a legacy body on ANOTHER host is foreign, whatever its pid says",
    );
    assert(
      judgeOwner(legacy, SELF, () => {
        throw new Error("a legacy body must not be start-time probed");
      }) === "alive",
      "a legacy body is judged by pid alone — no start-time read is attempted",
    );
    assert(
      judgeOwner(parseIdentity(`${HOST} ${NS} ${livePid} ${START}`), SELF, startsWith("9")) ===
        "dead",
      "the same holder WITH an identity does get the start-time check (so the rule is the body, not the pid)",
    );
  } finally {
    try {
      live.kill();
    } catch {
      /* already gone */
    }
  }
}

// ── malformed / hostile bodies are never judged dead ------------------------
{
  for (const body of [
    "",
    "   ",
    "only-one-field",
    "a b c",
    "host not-a-pid 9 1",
    "host x 0 -",
    `${HOST} ${NS} ${START} ${NS} extra`,
    "-leading-dash 1 1 1",
    `${HOST} 0x10 ${1} ${1}`,
    `${HOST} ${NS} ${1} not-a-number`,
  ]) {
    assert(
      judgeOwner(parseIdentity(body), SELF) === "foreign",
      `a malformed body ${JSON.stringify(body)} is foreign`,
    );
  }
  assert(parseIdentity(undefined) === undefined, "an absent body parses to undefined");
}

// ── host validation: an invalid host makes the parse undefined --------------
// This is what keeps handoff markdown rendering only identities that were
// parsed and validated, never raw file content.
{
  assert(validHost("a") && validHost("host.example.internal") && validHost("h_1"), "valid hosts");
  assert(
    !validHost("") || !validHost(" leading") || !validHost("a".repeat(254)),
    "empty, leading-space and over-long hosts are invalid",
  );
  for (const body of ["#cmt 1 1 1", "a b 9 9", "host\nname 1 1 1", "[host] 1 1 1"]) {
    assert(
      parseIdentity(body) === undefined,
      `a body with an invalid host ${JSON.stringify(body)} does not parse at all`,
    );
  }
  // A host carrying a markdown/HTML payload must never reach a renderer.
  assert(
    parseIdentity(`**bold** ${NS} 1 ${START}`) === undefined,
    "a host with markdown metacharacters is refused at the parse",
  );
}

// ── the half identity is never probed (D4) ----------------------------------
{
  const live = spawn("sleep", ["5"]);
  const livePid = live.pid ?? 999_998;
  try {
    const half = `${HOST} ${NS} ${livePid}`; // three fields: some, not all
    assert(parseIdentity(half) === undefined, `a three-field body ${JSON.stringify(half)} is not an identity`);
    assert(
      judgeOwner(parseIdentity(half), SELF) === "foreign",
      "a half identity is foreign, never routed to the pid probe",
    );
    assert(
      judgeOwner(
        { ...SELF, pid: livePid, startTime: NO_ID_FIELD },
        { ...SELF, pid: livePid },
        () => {
          throw new Error("a \"-\" start time must not be read from /proc");
        },
      ) === "alive",
      "an identity whose start time is \"-\" is kept alive without a start-time read",
    );
  } finally {
    try {
      live.kill();
    } catch {
      /* already gone */
    }
  }
}

// ── format round trip -------------------------------------------------------
{
  for (const candidate of [
    SELF,
    id({ pidns: NO_ID_FIELD, startTime: NO_ID_FIELD }),
    id({ host: "h", pid: 1 }),
  ]) {
    assert(
      JSON.stringify(parseIdentity(formatIdentity(candidate))) === JSON.stringify(candidate),
      `formatIdentity/parseIdentity round-trip ${formatIdentity(candidate)}`,
    );
  }
  assert(
    formatIdentity(SELF).split(" ").length === 4,
    "the wire form is exactly four space-separated fields",
  );
}

// ── selfIdentity is shape-safe whatever /proc says --------------------------
{
  const self = selfIdentity();
  assert(typeof self.host === "string" && validHost(self.host), `self host is valid ("${self.host}")`);
  assert(
    self.pidns === NO_ID_FIELD || /^\d+$/.test(self.pidns),
    `self pidns is "-" or a decimal inode (got "${self.pidns}")`,
  );
  assert(
    self.startTime === NO_ID_FIELD || /^\d+$/.test(self.startTime),
    `self start time is "-" or decimal ticks (got "${self.startTime}")`,
  );
  assert(
    !/\s/.test(`${self.host}${self.pidns}${self.startTime}`),
    "no identity field carries whitespace, so none can break the space-separated body",
  );
  assert(self.pid === process.pid, "selfIdentity names this pid");
  assert(selfIdentity() === self, "selfIdentity is computed once and cached (same object)");
  // On Linux the real reads must actually work — a silent "-" for both would
  // make every assertion above pass while the identity separated nothing.
  if (process.platform === "linux") {
    assert(
      self.pidns !== NO_ID_FIELD && self.startTime !== NO_ID_FIELD,
      "on Linux both the pidns inode and the start time are really read (not silently \"-\")",
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
