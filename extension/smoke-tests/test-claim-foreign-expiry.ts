#!/usr/bin/env bun
/**
 * #1871 D7 — a foreign path claim has a bounded lifetime.
 *
 * Split from `test-owner-identity-readers.ts` for the 500-line gate (AGENTS.md
 * §12). The seam is the one the module already has: the READER's rule and the
 * writer's conservative rule live in
 * `work-driver-path-claims-staleness.ts`, and the writer's foreign-expiry bound
 * is a decision of its own (`claimDeletionReason`, `FOREIGN_CLAIM_DELETE_FACTOR`)
 * rather than a variation on the liveness verdicts the sibling file pins.
 *
 * Why the bound exists: a foreign holder is proof of NOTHING — its pid lives in
 * a namespace this process cannot see into, so neither the probe nor the
 * claimant's state file can disprove it. Without an expiry the registry only
 * ever grows, one immortal row per container that dies mid-cycle. The reader
 * already ignores a foreign entry past `CLAIM_STALE_MS`, so an aged foreign row
 * reserves nothing; deleting it at 24 × that bound makes the file match what the
 * reader already does, with a day of slack for a container that is merely slow
 * or briefly unreachable.
 */
import { selfIdentity } from "../src/process-liveness.ts";
import {
  CLAIM_STALE_MS,
  FOREIGN_CLAIM_DELETE_FACTOR,
  type PathClaimEntry,
  claimDeletionReason,
} from "../src/work-driver-path-claims-staleness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const NOW = 1_800_000_000_000;
const FOREIGN_HOST = "not-this-container";
const SELF = selfIdentity();
/** A pid-namespace inode that is not this container's. */
const FOREIGN_NS = SELF.pidns === "4026532999" ? "4026532111" : "4026532999";
/** The 24 × bound as a number, so the two cases sit on either side of it. */
const FOREIGN_BOUND_MS = CLAIM_STALE_MS * FOREIGN_CLAIM_DELETE_FACTOR;

const claim = (over: Partial<PathClaimEntry> = {}): PathClaimEntry => ({
  issue: 700,
  pid: process.pid,
  paths: ["src/foo.ts"],
  startedAt: NOW,
  ...over,
});

/** Throws: an unreadable claimant state, which is NOT evidence anyone is dead. */
const noState = async (): Promise<never> => {
  throw new Error("fixture: no state file");
};

const foreign = (startedAt: number): PathClaimEntry =>
  claim({ host: FOREIGN_HOST, pidns: FOREIGN_NS, startTime: "1", pid: 999_999, startedAt });

// ── the bound is the one the module declares, not a literal in this file ----
{
  assert(FOREIGN_CLAIM_DELETE_FACTOR === 24, "the foreign bound is 24 × CLAIM_STALE_MS (D7)");
  assert(
    CLAIM_STALE_MS === 3_600_000,
    `CLAIM_STALE_MS is the documented hour, so the foreign bound is a day (got ${CLAIM_STALE_MS})`,
  );
}

// ── just under the bound: kept ---------------------------------------------
{
  const reason = await claimDeletionReason("/repo", foreign(NOW - FOREIGN_BOUND_MS + 60_000), NOW, noState);
  assert(reason === null, `a foreign claim just UNDER the bound is kept (got ${String(reason)})`);
}

// ── past the bound: deleted by the WRITER, with a named reason -------------
{
  const reason = await claimDeletionReason("/repo", foreign(NOW - FOREIGN_BOUND_MS - 60_000), NOW, noState);
  assert(
    reason === "foreign-expired",
    `a foreign claim past the bound is deleted by the writer, so the registry stops growing (got ${String(reason)})`,
  );
}

// ── the expiry is FOREIGN's rule, not a general age rule -------------------
{
  // A LIVE claim carrying our own identity, aged past the foreign bound: the
  // pid answers for it, so nothing is deleted. If the bound were read as "old
  // entry", this would be the case that caught it.
  const oursOld = await claimDeletionReason(
    "/repo",
    claim({
      host: SELF.host,
      pidns: SELF.pidns,
      startTime: SELF.startTime,
      pid: process.pid,
      startedAt: NOW - FOREIGN_BOUND_MS - 60_000,
    }),
    NOW,
    noState,
  );
  assert(
    oursOld === null,
    `a LIVE claim with our own identity is kept even past the foreign bound (got ${String(oursOld)})`,
  );

  // A legacy {pid}-only entry past the same age is deleted as `owner-exited`,
  // never as `foreign-expired`: D3's branch, D3's reason.
  const legacy = await claimDeletionReason(
    "/repo",
    claim({ pid: 999_999, startedAt: NOW - FOREIGN_BOUND_MS - 60_000 }),
    NOW,
    noState,
  );
  assert(
    legacy === "owner-exited",
    `a legacy dead-pid entry past the bound is deleted as owner-exited, not foreign-expired (got ${String(legacy)})`,
  );

  // A half identity is foreign (D4) and therefore ages on the foreign bound,
  // never on the dead-owner bound.
  const half = await claimDeletionReason(
    "/repo",
    claim({ host: SELF.host, startedAt: NOW - CLAIM_STALE_MS - 60_000 }),
    NOW,
    noState,
  );
  assert(
    half === "malformed-entry",
    `a half identity is refused as a claim outright, not aged quietly (got ${String(half)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
