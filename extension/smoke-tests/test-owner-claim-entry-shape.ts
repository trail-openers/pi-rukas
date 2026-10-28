#!/usr/bin/env bun
/**
 * #1871 F2 — the ENTRY-SHAPE half of the owner-identity rules: what makes a
 * claim row a claim at all, and what the two staleness predicates do with a row
 * that is not.
 *
 * Split out of `test-owner-identity-readers.ts` for the 500-line gate
 * (AGENTS.md §12) along the seam the code already has: that file judges the
 * READERS (what a holder record means to `claimStaleReason`, `claimDeletionReason`
 * and the sweep); this one judges `validClaimEntry` / `identityShapeOk`, the gate
 * every one of those runs first.
 *
 * The F1 case sits here rather than in the readers' file because it is the same
 * shape question seen from the other side: a row carrying a VERIFIED-ALIVE full
 * identity is honoured at any age, and one that merely LOOKS like an identity
 * (1 of 3, 2 of 3, a future date) is not a claim at all.
 */
import { selfIdentity } from "../src/process-liveness.ts";
import {
  claimDeletionReason,
  claimStaleReason,
  identityShapeOk,
  validClaimEntry,
} from "../src/work-driver-path-claims-staleness.ts";
import {
  ANCIENT_2X,
  FOREIGN_HOST,
  NOW,
  SOMEONE_ELSES_PID,
  claim,
  makeAssert,
  noState,
  runningState,
} from "./lib/owner-identity-fixtures.ts";

const { assert, status } = makeAssert();
const SELF_NS = selfIdentity().pidns;
/** A pid namespace inode that is not this container's. */
const FOREIGN_NS = SELF_NS === "4026532999" ? "4026532111" : "4026532999";

// ── F2: `identityShapeOk` is the exported predicate for the 1-of-3 / 2-of-3 rule
// It is exported because the malformed answer an operator sees comes from this
// one rule, and a source-text assertion would pass with the rule deleted.
{
  const full = { host: selfIdentity().host, pidns: SELF_NS, startTime: "1" };
  assert(identityShapeOk({ ...full }), "identityShapeOk accepts a full identity");
  assert(identityShapeOk({}), "identityShapeOk accepts NO identity field (a legacy row)");
  assert(
    !identityShapeOk({ host: selfIdentity().host }),
    "identityShapeOk refuses 1-of-3 (host alone) — a half identity is never probed",
  );
  assert(!identityShapeOk({ pidns: SELF_NS }), "identityShapeOk refuses 1-of-3 (pidns alone)");
  assert(!identityShapeOk({ startTime: "1" }), "identityShapeOk refuses 1-of-3 (startTime alone)");
  assert(
    !identityShapeOk({ host: selfIdentity().host, pidns: SELF_NS }),
    "identityShapeOk refuses 2-of-3 (host+pidns)",
  );
  assert(
    !identityShapeOk({ host: selfIdentity().host, startTime: "1" }),
    "identityShapeOk refuses 2-of-3 (host+startTime)",
  );
  assert(
    !identityShapeOk({ pidns: SELF_NS, startTime: "1" }),
    "identityShapeOk refuses 2-of-3 (pidns+startTime)",
  );
}

// ── F2: the shape rules that need the clock --------------------------------
// Every row below is a claim WITHOUT `now` and malformed WITH it: a rule that
// only ever runs when the caller forgets to pass the clock judges nothing.
{
  const FUTURE = NOW + 10 * 60_000;
  assert(
    validClaimEntry(claim({ startedAt: FUTURE })),
    "a future startedAt is a claim when the caller supplies no clock (the shape checks are pure)",
  );
  assert(
    !validClaimEntry(claim({ startedAt: FUTURE }), NOW),
    "a startedAt more than 5 min in the future is malformed — it can never age out",
  );
  assert(
    validClaimEntry(claim({ startedAt: NOW + 60_000 }), NOW),
    "a minute of clock skew between containers is tolerated, not malformed",
  );
  assert(
    !validClaimEntry({ ...claim(), pidns: SELF_NS, startTime: "1" }, NOW),
    "2 of 3 identity fields are malformed with a clock too (the group rule is not clock-dependent)",
  );
  assert(
    validClaimEntry(claim({ startedAt: NOW + 4 * 60_000 }), NOW + 6 * 60_000),
    "the 5-minute allowance is measured from the clock passed in, not the wall time",
  );
  // The staleness predicates pass `now`, so the malformed answer reaches the
  // reader and the writer rather than sitting in the file forever.
  const futureEntry = claim({ startedAt: FUTURE });
  assert(
    (await claimStaleReason("/repo", futureEntry, NOW, runningState)) === "malformed-entry",
    "the reader calls a future-dated entry malformed rather than forever fresh",
  );
  assert(
    (await claimDeletionReason("/repo", futureEntry, NOW, noState)) === "malformed-entry",
    "the writer deletes a future-dated entry as malformed",
  );
}

// ── F1: a VERIFIED-ALIVE full identity is never stale, at any age ----------
// The age bound exists to stop an UNVERIFIABLE claim parking cycles forever.
// Once the identity probe has answered `alive`, the clock is judging a holder
// it just proved is running, and the age answer is simply wrong: a develop round
// that legitimately runs past the bound would lose its own reservation.
{
  const me = { host: selfIdentity().host, pidns: SELF_NS };
  const own = claim({
    ...me,
    startTime: selfIdentity().startTime,
    pid: process.pid,
    startedAt: ANCIENT_2X,
  });
  const ownAncient = await claimStaleReason("/repo", own, NOW, noState);
  assert(
    ownAncient === null,
    `this process's OWN verified identity is honoured at 2× the stale bound (got ${String(ownAncient)})`,
  );
  // Same row with a readable state file: the probe, not the state, is what
  // decides, so the exemption must not depend on which side of the read we are.
  const ownAncientRead = await claimStaleReason("/repo", own, NOW, runningState);
  assert(
    ownAncientRead === null,
    "a verified-alive identity with a readable state is honoured past the bound too",
  );
  // The other half of F1: a FOREIGN entry gets no such exemption. It is not
  // verified alive, so the age rules still decide, and past the bound the reader
  // stops honouring it — which is what keeps this from being "identity means
  // immortal".
  const foreignAncient = await claimStaleReason(
    "/repo",
    claim({
      host: FOREIGN_HOST,
      pidns: FOREIGN_NS,
      startTime: "1",
      pid: SOMEONE_ELSES_PID,
      startedAt: ANCIENT_2X,
    }),
    NOW,
    runningState,
  );
  assert(
    foreignAncient === "unverifiable-age",
    `a foreign entry aged 2× the bound is stale to the reader (got ${String(foreignAncient)})`,
  );
  // And a legacy row (no identity at all) keeps today's rule even when its pid
  // is ours and alive: F1 is an identity exemption, not a pid exemption.
  const legacyOwnAncient = await claimStaleReason(
    "/repo",
    claim({ pid: process.pid, startedAt: ANCIENT_2X }),
    NOW,
    noState,
  );
  assert(
    legacyOwnAncient === "unreadable-state",
    `a legacy (identity-less) row with our live pid still ages out (got ${String(legacyOwnAncient)})`,
  );
  // The exemption is not a rubber stamp: our own host, our own namespace and a
  // pid the probe can call dead is stale at ANY age, exactly as before.
  const ownDeadAncient = await claimStaleReason(
    "/repo",
    claim({ ...me, startTime: "99999999999", pid: 999_999, startedAt: ANCIENT_2X }),
    NOW,
    noState,
  );
  assert(
    ownDeadAncient === "owner-exited",
    `a full identity the probe calls dead is stale even at 2× the bound (got ${String(ownDeadAncient)})`,
  );
}

console.log(`\nexit ${status()}`);
process.exit(status());
