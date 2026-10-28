#!/usr/bin/env bun
/**
 * #1871 F8 — the park message an operator actually reads when a claim from
 * another container blocks their cycle.
 *
 * Split out of `test-owner-identity-readers.ts` for the 500-line gate
 * (AGENTS.md §12): that file judges what a holder record MEANS to the three
 * readers; this one judges the two sentences the driver renders from it, which
 * is a different contract and a different file to change.
 *
 * Driven through the real gate with the accepted `setClaimsConflictsForTests`
 * seam (the shape `test-work-driver-claims-gate-parks.ts` uses): what an
 * operator READS is the contract, and a renderer no caller reaches is not one.
 * The evidence string is produced by the gate itself, so the two halves are
 * pinned together — a renderer that stops matching the evidence the writer
 * emits goes red here rather than shipping a message that never fires.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfIdentity } from "../src/process-liveness.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { explainCrossGroupConflict } from "../src/work-driver-explain-claims.ts";
import {
  checkAndRegisterClaims,
  setClaimsConflictsForTests,
} from "../src/work-driver-path-claims-gate.ts";
import type { PathClaimEntry } from "../src/work-driver-path-claims-staleness.ts";
import { initialState } from "../src/workflow-state.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import { FOREIGN_HOST, NOW, claim, makeAssert } from "./lib/owner-identity-fixtures.ts";

const { assert, status } = makeAssert();
const SELF_NS = selfIdentity().pidns;
const SELF_HOST = selfIdentity().host;
/** A pid namespace inode that is not this container's. */
const FOREIGN_NS = SELF_NS === "4026532999" ? "4026532111" : "4026532999";

const dir = mkdtempSync(join(tmpdir(), "owner-identity-park-"));
mkdirSync(join(dir, ".git"), { recursive: true });
const ctx = { repoRoot: dir, issue: 701, emitSink: () => {} } as unknown as CycleContext;

async function parkOn(entry: PathClaimEntry): Promise<string> {
  setClaimsConflictsForTests([entry]);
  try {
    const outcome = await checkAndRegisterClaims(
      ctx,
      initialState(701, 0),
      { default: { paths: ["src/foo.ts"], outOfScope: [] } },
      NOW,
    );
    assert(outcome.parked, "the overlapping claim parks the cycle at plan");
    const hits = outcome.state.eventLog.filter(
      (e): e is Extract<WorkEvent, { kind: "cap-hit" }> => e.kind === "cap-hit",
    );
    return hits.at(-1)?.evidence ?? "";
  } finally {
    setClaimsConflictsForTests(undefined);
  }
}

/** The operator sentence `explainCap` renders for that park evidence. */
function explain(evidence: string): string {
  return explainCrossGroupConflict({
    ...initialState(701, 0),
    eventLog: [
      {
        kind: "cap-hit",
        at: NOW,
        cap: "cross-group-conflict",
        evidence,
        reviewRound: 0,
        nextStep: "handoff",
      },
    ],
  });
}

try {
  const foreign = await parkOn(
    claim({ issue: 702, host: FOREIGN_HOST, pidns: FOREIGN_NS, startTime: "1", pid: 4242 }),
  );
  assert(
    foreign.includes(`holder: ${FOREIGN_HOST} ${FOREIGN_NS} 4242 1`),
    "the park evidence names the foreign holder's full identity",
  );
  assert(
    /claim file: .*path-claims\.json/.test(foreign),
    "and the claim file an operator has to clear",
  );

  // ── F8: a FULL identity must not send the operator to the pid table ------
  const prose = explain(foreign);
  assert(
    !/check the pid/i.test(prose),
    "a full-identity park never tells the operator to check the pid",
  );
  assert(
    /another pid namespace|other pid namespace|another host/i.test(prose),
    "and says the holder lives in another pid namespace or host",
  );
  assert(
    /stops counting|stop counting/i.test(prose) &&
      /PI_ENSEMBLE_CLAIM_STALE_MS/.test(prose) &&
      /24 ×/.test(prose),
    "it names both bounds: stale after the claim stale bound, deleted after 24 × it",
  );
  assert(
    /troubleshooting\.md/.test(prose),
    "and points at the troubleshooting entry for clearing a claim by hand",
  );

  // ── the legacy wording is UNCHANGED — its pid IS on this host ------------
  const legacy = await parkOn(claim({ issue: 703, pid: 4242 }));
  assert(
    /identity unknown/.test(legacy),
    "a pre-#1871 holder is rendered as identity-unknown, not as a bare pid",
  );
  const legacyProse = explain(legacy);
  assert(
    /check the pid/.test(legacyProse) &&
      /\.pi\/work-state\/703\.json/.test(legacyProse) &&
      !/another pid namespace/i.test(legacyProse),
    "a legacy park keeps the check-the-pid-and-the-state-file sentence, untouched",
  );

  // ── F8 on a host with no /proc: a "-" pidns is NOT "another namespace" ----
  // `selfIdentity()` writes NO_ID_FIELD for pidns on macOS and under a hidepid
  // procfs. The regex used to require a decimal pidns there, so those parks got
  // the legacy wording — and `judgeOwner` calls two "-" namespaces a MATCH, so
  // there the pid really is this host's and really is checkable. Two cases, one
  // per host, because the wording follows the host and not the sentinel.
  const sentinel = await parkOn(
    claim({ issue: 704, host: SELF_HOST, pidns: "-", startTime: "-", pid: 4242 }),
  );
  assert(
    sentinel.includes(`holder: ${SELF_HOST} - 4242 -`),
    "a no-/proc holder renders its identity with the '-' sentinel in both id fields",
  );
  const sentinelProse = explain(sentinel);
  assert(
    /check the pid/.test(sentinelProse) &&
      /\.pi\/work-state\/704\.json/.test(sentinelProse) &&
      !/another pid namespace/i.test(sentinelProse),
    "on THIS host a '-' pidns keeps the check-the-pid wording — the probe works there (two '-' namespaces match)",
  );
  const sentinelForeign = await parkOn(
    claim({ issue: 705, host: FOREIGN_HOST, pidns: "-", startTime: "-", pid: 4242 }),
  );
  const sentinelForeignProse = explain(sentinelForeign);
  assert(
    !/check the pid/i.test(sentinelForeignProse) &&
      /another pid namespace|other pid namespace|another host/i.test(sentinelForeignProse),
    "on ANOTHER host a '-' pidns gets the full-identity wording — there is nothing on this host to check",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nexit ${status()}`);
process.exit(status());
