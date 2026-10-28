#!/usr/bin/env bun
/**
 * #1871 — a holder this process cannot verify is never treated as gone.
 *
 * Three readers decide what an owner record means, and all three took a bare
 * pid before this change:
 *
 *   - `claimStaleReason` (the reader) — a false "stale" parks a cycle;
 *   - `claimDeletionReason` (the writer) — a false "stale" DELETES a live
 *     sibling container's reservation, which is the two-workstreams-one-file
 *     failure the registry exists to prevent;
 *   - `decideSweepAction` rule 3 — a false "dead owner" removes a live cycle's
 *     worktree.
 *
 * The safe direction is the same in all three: `foreign` counts as ALIVE. A
 * legacy entry (no host / boot-id) keeps today's pid-only verdict, which is
 * what stops an upgrade calling every pre-#1871 file dead.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfIdentity } from "../src/process-liveness.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import {
  checkAndRegisterClaims,
  setClaimsConflictsForTests,
} from "../src/work-driver-path-claims-gate.ts";
import {
  type PathClaimEntry,
  claimDeletionReason,
  claimStaleReason,
  validClaimEntry,
} from "../src/work-driver-path-claims-staleness.ts";
import { classifyRunningState, markDispatchStarted } from "../src/work-driver-resume.ts";
import { decideSweepAction } from "../src/work-driver-sweep-policy.ts";
import type { SweepTargetResult } from "../src/work-driver-worktree-sweep.ts";
import { type WorkEvent, initialState } from "../src/workflow-state.ts";
import type { WorkState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FOREIGN_HOST = "not-this-container";
const FOREIGN_BOOT = "00000000-1111-2222-3333-444444444444";
const NOW = 1_800_000_000_000;
/** A pid that is certainly not ours; its fate must not matter, because the
 * identity check runs first and the probe is never reached. */
const SOMEONE_ELSES_PID = 4242;
/** Older than CLAIM_STALE_MS (1 h), so the age bound WOULD delete it. */
const ANCIENT = NOW - 3 * 3_600_000;
/** A pid that cannot exist: the shape that makes "dead" provable. */
const deadPid = () => spawnSync("true").pid ?? 999_999;

const claim = (over: Partial<PathClaimEntry> = {}): PathClaimEntry => ({
  issue: 700,
  pid: process.pid,
  paths: ["src/foo.ts"],
  startedAt: NOW,
  ...over,
});

/** Throws: the reader's `stateUnreadable` branch is reached by an exception,
 * not by an absent file (an `undefined` return reads as "verified, no state"). */
const noState = async (): Promise<WorkState | undefined> => {
  throw new Error("fixture: no state file");
};
/** A readable, non-terminal claimant state: without one the reader's AGE rule
 * (pre-existing, `unverifiable-age`) fires, which is a different question from
 * the liveness verdict these cases pin. */
const runningState = async () =>
  ({
    resumable: true,
    issue: 700,
    startedAt: 0,
    updatedAt: 0,
    pipelineState: { status: "running", currentStep: "develop", inFlightJobIds: [] },
    eventLog: [],
  }) as unknown as WorkState;

// ── the reader: a foreign claim is never stale, at any age ------------------
{
  const cases: Array<[string, Partial<PathClaimEntry>]> = [
    [
      "a foreign host",
      { host: FOREIGN_HOST, bootId: selfIdentity().bootId, pid: SOMEONE_ELSES_PID },
    ],
    [
      "a foreign boot id",
      { host: selfIdentity().host, bootId: FOREIGN_BOOT, pid: SOMEONE_ELSES_PID },
    ],
    ["both foreign", { host: FOREIGN_HOST, bootId: FOREIGN_BOOT, pid: SOMEONE_ELSES_PID }],
  ];
  for (const [label, over] of cases) {
    const entry = claim({ ...over, startedAt: ANCIENT });
    // A FRESH timestamp isolates the liveness rule; the age rule below is the
    // one that reads `unverifiable-age` / `unreadable-state`.
    entry.startedAt = NOW;
    const reason = await claimStaleReason("/repo", entry, NOW, runningState);
    assert(
      reason === null,
      `the reader never calls ${label} stale, even past the age bound (got ${String(reason)})`,
    );
    // The age rule is untouched: an UNREADABLE claimant still ages out. This
    // is the half that keeps the change from being "foreign means immortal".
    entry.startedAt = ANCIENT;
    const agedOut = await claimStaleReason("/repo", entry, NOW, noState);
    assert(
      agedOut === "unreadable-state",
      `a ${label} claim whose state cannot be read still ages out (got ${String(agedOut)})`,
    );
    const agedVerified = await claimStaleReason("/repo", entry, NOW, runningState);
    assert(
      agedVerified === "unverifiable-age",
      `a ${label} claim with a readable state still ages out past the bound (got ${String(agedVerified)})`,
    );
  }
}

// ── the writer: a foreign claim is never deleted, at any age ----------------
{
  const entry = claim({
    host: FOREIGN_HOST,
    bootId: FOREIGN_BOOT,
    // An impossible pid AND ancient: only a pid-only judgement would delete
    // this. The identity check must answer first.
    pid: 999_999,
    startedAt: ANCIENT,
  });
  const reason = await claimDeletionReason("/repo", entry, NOW, noState);
  assert(
    reason === null,
    `the writer never deletes a foreign holder, even an ancient one with an impossible pid (got ${String(reason)})`,
  );
}

// ── a legacy claim behaves exactly as today --------------------------------
{
  const dead = await claimStaleReason(
    "/repo",
    claim({ pid: deadPid(), startedAt: NOW }),
    NOW,
    noState,
  );
  assert(dead === "owner-exited", "a legacy {pid}-only claim with a dead pid reads stale (today)");
  const del = await claimDeletionReason(
    "/repo",
    claim({ pid: deadPid(), startedAt: ANCIENT }),
    NOW,
    noState,
  );
  assert(
    del === "owner-exited",
    "a legacy claim with a dead pid past the age bound is deleted (today)",
  );
  const young = await claimDeletionReason(
    "/repo",
    claim({ pid: deadPid(), startedAt: NOW }),
    NOW,
    noState,
  );
  assert(young === null, "a legacy claim with a dead YOUNG pid is kept (the #1454 r2 asymmetry)");
  const ours = await claimStaleReason("/repo", claim({ startedAt: NOW }), NOW, noState);
  assert(ours === null, "a legacy claim with our own live pid is fresh");
  // The identity half of the legacy rule: a record naming host without bootId
  // is not a claim at all, so it cannot smuggle a foreign holder into the
  // pid-only branch.
  assert(
    !validClaimEntry({ ...claim({ host: "h" }) }),
    "an entry with host but no bootId is malformed, not identity-less",
  );
}

// ── our OWN identity still answers the probe (no rubber stamp) --------------
{
  const me = { host: selfIdentity().host, bootId: selfIdentity().bootId };
  const gone = await claimStaleReason(
    "/repo",
    claim({ ...me, pid: deadPid(), startedAt: NOW }),
    NOW,
    noState,
  );
  assert(
    gone === "owner-exited",
    "a claim with OUR host and OUR boot id and a dead pid still reads stale",
  );
}

// ── the park message names the holder's identity and the claim file --------
// Driven through the real gate with the accepted `setClaimsConflictsForTests`
// seam (the shape `test-work-driver-claims-gate-parks.ts` uses): what an
// operator READS is the contract, and a renderer no caller reaches is not one.
{
  const dir = mkdtempSync(join(tmpdir(), "owner-identity-park-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  const ctx = { repoRoot: dir, issue: 701, emitSink: () => {} } as unknown as CycleContext;
  const parkOn = async (entry: PathClaimEntry): Promise<string> => {
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
  };
  try {
    const foreign = await parkOn(
      claim({ issue: 702, host: FOREIGN_HOST, bootId: FOREIGN_BOOT, pid: 4242 }),
    );
    assert(
      /holder: not-this-container 00000000-1111-2222-3333-444444444444 4242/.test(foreign),
      "the park evidence names the foreign holder's full identity",
    );
    assert(
      /claim file: .*path-claims\.json/.test(foreign),
      "and the claim file an operator has to clear",
    );
    const legacy = await parkOn(claim({ issue: 703, pid: 4242 }));
    assert(
      /identity unknown/.test(legacy),
      "a pre-#1871 holder is rendered as identity-unknown, not as a bare pid",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the sweep: a foreign owner is not swept; a legacy one behaves as today --
const noop: ExecFn = async () => ({ stdout: "", stderr: "" });
// The name must NOT parse to the state's own issue: `groupClaimedByState`
// (rule 3's predecessor) would skip first and the owner rule would never run.
const target = {
  ok: true,
  realPath: "/fake/path",
  name: "issue-99-default",
} as SweepTargetResult;

async function decideWith(owner: WorkState["owner"]): Promise<string> {
  const state = {
    ...({
      resumable: true,
      owner,
      issue: 9,
      startedAt: 0,
      updatedAt: 0,
      pipelineState: { status: "running", currentStep: "develop", inFlightJobIds: [] },
      eventLog: [],
    } as unknown as WorkState),
  };
  const action = await decideSweepAction({
    state,
    target,
    selfPid: 999_999,
    liveCycles: new Set<number>(),
    launchingCycleIssue: 2,
    execFn: noop,
  });
  return action.type === "skip" ? action.reason : action.type;
}

{
  const foreignHost = await decideWith({
    pid: 999,
    at: 0,
    host: FOREIGN_HOST,
    bootId: selfIdentity().bootId,
  });
  assert(
    /^live-owner pid=999$/.test(foreignHost),
    `a state owner on another host is not swept (got ${foreignHost})`,
  );
  const foreignBoot = await decideWith({
    pid: 999,
    at: 0,
    host: selfIdentity().host,
    bootId: FOREIGN_BOOT,
  });
  assert(
    /^live-owner pid=999$/.test(foreignBoot),
    `a state owner from another boot is not swept (got ${foreignBoot})`,
  );
  const legacyDead = await decideWith({ pid: 999, at: 0 });
  assert(
    legacyDead !== "live-owner pid=999" && !/^live-owner/.test(legacyDead),
    `a legacy {pid, at} owner with an impossible pid is still judged by pid (got ${legacyDead})`,
  );
  const oursLive = await decideWith({ pid: process.pid, at: 0 });
  assert(/^live-owner pid=\d+$/.test(oursLive), "our own live pid still skips the sweep");
}

// ── resume: a foreign owner refuses with a named owner; legacy unchanged ----
{
  const inFlight = (owner: WorkState["owner"]): WorkState =>
    ({
      resumable: true,
      owner,
      issue: 770,
      startedAt: 0,
      updatedAt: 0,
      pipelineState: { status: "running", currentStep: "develop", inFlightJobIds: ["develop:x"] },
      eventLog: [
        {
          kind: "dispatch-started",
          step: "develop",
          role: "r",
          label: "l",
          jobId: "develop:x",
          at: 0,
        },
      ],
    }) as unknown as WorkState;

  const foreign = classifyRunningState(
    inFlight({ pid: 999, at: 0, host: FOREIGN_HOST, bootId: FOREIGN_BOOT }),
    999_999,
  );
  assert(
    foreign.action === "refuse" && foreign.ownerPid === 999,
    "a foreign owner is REFUSED: resume will not join a driver it cannot verify",
  );
  const legacyDead = classifyRunningState(inFlight({ pid: 999_999, at: 0 }), 999_998);
  assert(
    legacyDead.action === "resume",
    "a legacy owner with a dead pid still resumes (the pid-only verdict is unchanged)",
  );
  const legacyLive = classifyRunningState(inFlight({ pid: process.pid, at: 0 }), 999_998);
  assert(legacyLive.action === "refuse", "a legacy owner with a live pid still refuses");
}

// ── markDispatchStarted stamps the identity --------------------------------
{
  const state = {
    resumable: false,
    issue: 1,
    startedAt: 0,
    updatedAt: 0,
    pipelineState: { status: "running", currentStep: "develop", inFlightJobIds: [] },
    eventLog: [],
  } as unknown as WorkState;
  const next = markDispatchStarted(state, "develop", "developer", "l", "job-1", 5);
  assert(
    next.owner?.host === selfIdentity().host && next.owner?.bootId === selfIdentity().bootId,
    "the write-ahead records the full identity, not just a pid",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
