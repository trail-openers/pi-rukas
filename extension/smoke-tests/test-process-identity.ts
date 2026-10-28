#!/usr/bin/env bun
/**
 * #1871 — the owner-identity helper in process-liveness.ts.
 *
 * A spawn slot / path claim / state-file owner used to be identified by
 * `<hostname> <pid>` alone, so two containers sharing a `--hostname` called
 * each other's LIVE owners corpses and reaped them. The identity is now
 * `<hostname> <boot-id> <pid>` and the pid probe is consulted only when BOTH
 * host and boot id match this process; everything else is `foreign` and never
 * reaped.
 *
 * `judgeOwner(holder, self)` takes both identities explicitly, which is the
 * whole test seam: no env var, no two-process boot-id injection.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  NO_BOOT_ID,
  type OwnerIdentity,
  formatIdentity,
  judgeOwner,
  parseIdentity,
  processAlive,
  selfIdentity,
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
const BOOT = "11111111-2222-3333-4444-555555555555";
const OTHER_BOOT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SELF: OwnerIdentity = { host: HOST, bootId: BOOT, pid: 4242 };

const id = (over: Partial<OwnerIdentity> = {}): OwnerIdentity => ({ ...SELF, ...over });

// ── the full matrix of host / boot-id / pid combinations --------------------
{
  const live = spawn("sleep", ["5"]);
  const livePid = live.pid ?? 999_998;
  try {
    assert(processAlive(livePid), "the sleep child is live for the probe cases");

    assert(
      judgeOwner(id({ pid: livePid }), SELF) === "alive",
      "same host + same boot-id + a live pid is alive",
    );
    // A reaped `true` leaves a pid that is not this process's and is gone.
    const dead = spawnSync("true").pid ?? 999_999;
    assert(
      judgeOwner(id({ pid: dead }), SELF) === "dead",
      "same host + same boot-id + a dead pid is dead",
    );
    assert(
      judgeOwner(id({ pid: livePid, bootId: OTHER_BOOT }), SELF) === "foreign",
      "same host + a DIFFERENT boot-id is foreign (a rebooted host, never reaped)",
    );
    assert(
      judgeOwner(id({ pid: livePid, host: "container-b" }), SELF) === "foreign",
      "a DIFFERENT host + the same boot-id is foreign (today's protected case)",
    );
    assert(
      judgeOwner({ host: HOST, bootId: BOOT, pid: SELF.pid }, SELF) === "alive",
      "our own pid is alive and never a reap candidate",
    );
    assert(
      judgeOwner(undefined, SELF) === "foreign",
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

// ── the "-" boot id on both sides keeps the pid probe working (no /proc) ----
{
  const live = spawn("sleep", ["5"]);
  const livePid = live.pid ?? 999_998;
  try {
    assert(
      judgeOwner(id({ pid: livePid, bootId: NO_BOOT_ID }), { ...SELF, bootId: NO_BOOT_ID }) ===
        "alive",
      "two \"-\" boot-ids on one host match and the pid probe answers (alive)",
    );
    const dead = spawnSync("true").pid ?? 999_999;
    assert(
      judgeOwner(id({ pid: dead, bootId: NO_BOOT_ID }), { ...SELF, bootId: NO_BOOT_ID }) ===
        "dead",
      "two \"-\" boot-ids on one host match and the pid probe answers (dead)",
    );
    assert(
      judgeOwner(id({ pid: livePid, bootId: NO_BOOT_ID }), SELF) === "foreign",
      "\"-\" against a real boot-id on the same host is foreign",
    );
    assert(
      judgeOwner(id({ pid: livePid }), { ...SELF, bootId: NO_BOOT_ID }) === "foreign",
      "a real boot-id against \"-\" is foreign the other way too",
    );
  } finally {
    try {
      live.kill();
    } catch {
      /* already gone */
    }
  }
}

// ── malformed holders are never judged dead ---------------------------------
{
  for (const body of ["", "   ", "only-one-field", "a b c d", "host not-a-pid 9", "host x 0"]) {
    assert(
      judgeOwner(parseIdentity(body), SELF) === "foreign",
      `a malformed body ${JSON.stringify(body)} is foreign`,
    );
  }
  assert(parseIdentity(undefined) === undefined, "an absent body parses to undefined");
}

// ── the two-field (legacy) body reads as foreign ---------------------------
{
  const live = spawn("sleep", ["5"]);
  const livePid = live.pid ?? 999_998;
  try {
    const legacy = parseIdentity(`${HOST} ${livePid}`);
    assert(legacy !== undefined, "a two-field body parses (it is the pre-#1871 format)");
    assert(
      legacy?.bootId === NO_BOOT_ID && legacy.pid === livePid && legacy.host === HOST,
      "a two-field body carries NO boot id, our host and its pid",
    );
    assert(
      judgeOwner(legacy, SELF) === "foreign",
      "an old two-field body is foreign: never reaped, whatever its pid says",
    );
    assert(
      judgeOwner(parseIdentity(`${HOST} ${BOOT} ${livePid}`), SELF) === "alive",
      "the same holder with a boot id DOES answer the probe (so the rule is the body, not the pid)",
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
  for (const candidate of [SELF, id({ bootId: NO_BOOT_ID }), id({ host: "h", pid: 1 })]) {
    assert(
      JSON.stringify(parseIdentity(formatIdentity(candidate))) === JSON.stringify(candidate),
      `formatIdentity/parseIdentity round-trip ${formatIdentity(candidate)}`,
    );
  }
}

// ── boot-id validation ------------------------------------------------------
{
  // selfIdentity reads /proc/sys/kernel/random/boot_id and must be shape-safe
  // whatever the filesystem returns: trimmed, matching the hex-uuid pattern,
  // or the "-" sentinel. Never empty, never whitespace, never a space (which
  // would break the space-separated body).
  const self = selfIdentity();
  assert(self.host === undefined || typeof self.host === "string", "selfIdentity has a host");
  assert(typeof self.bootId === "string" && self.bootId.length > 0, "self boot-id is a string");
  assert(
    self.bootId === NO_BOOT_ID || /^[0-9A-Fa-f-]{8,64}$/.test(self.bootId),
    `self boot-id is either "-" or matches the boot-id pattern (got "${self.bootId}")`,
  );
  assert(
    !/\s/.test(self.bootId),
    "self boot-id carries no whitespace, so it cannot break the space-separated body",
  );
  assert(self.pid === process.pid, "selfIdentity names this pid");
  assert(
    selfIdentity() === self,
    "selfIdentity is computed once and cached (the same object on the second call)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
