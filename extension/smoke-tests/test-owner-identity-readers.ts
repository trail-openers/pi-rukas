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
 * legacy entry (no identity fields at all) keeps that release's pid-only
 * verdict, which is what stops an upgrade calling every pre-#1871 file dead.
 *
 * The entry-shape half (`validClaimEntry` / `identityShapeOk`, the future-date
 * and 1-of-3 rules, and F1's verified-alive exemption) is in
 * `test-owner-claim-entry-shape.ts`; what the park MESSAGE says is in
 * `test-owner-claim-park-message.ts`. All three share
 * `lib/owner-identity-fixtures.ts` so one fixture cannot drift from the other.
 */
import { spawnSync } from "node:child_process";
import { selfIdentity } from "../src/process-liveness.ts";
import type { PathClaimEntry } from "../src/work-driver-path-claims-staleness.ts";
import {
  claimDeletionReason,
  claimStaleReason,
  validClaimEntry,
} from "../src/work-driver-path-claims-staleness.ts";
import { classifyRunningState, markDispatchStarted } from "../src/work-driver-resume.ts";
import { decideSweepAction } from "../src/work-driver-sweep-policy.ts";
import type { SweepTargetResult } from "../src/work-driver-worktree-sweep.ts";
import type { WorkState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";
import {
  ANCIENT,
  FOREIGN_HOST,
  NOW,
  SOMEONE_ELSES_PID,
  claim,
  deadPid,
  makeAssert,
  noState,
  runningState,
} from "./lib/owner-identity-fixtures.ts";

const { assert, status } = makeAssert();
const SELF_NS = selfIdentity().pidns;
/** A pid namespace inode that is not this container's. */
const FOREIGN_NS = SELF_NS === "4026532999" ? "4026532111" : "4026532999";

// ── the reader: a foreign claim is never stale, at any age ------------------
{
  const cases: Array<[string, Partial<PathClaimEntry>]> = [
    [
      "a foreign host",
      { host: FOREIGN_HOST, pidns: SELF_NS, startTime: "1", pid: SOMEONE_ELSES_PID },
    ],
    [
      "a foreign pid namespace",
      { host: selfIdentity().host, pidns: FOREIGN_NS, startTime: "1", pid: SOMEONE_ELSES_PID },
    ],
    [
      "both foreign",
      { host: FOREIGN_HOST, pidns: FOREIGN_NS, startTime: "1", pid: SOMEONE_ELSES_PID },
    ],
    [
      "a half identity (host only)",
      // Not a claim at all — `validClaimEntry` refuses it and the reader calls
      // it stale, which is what stops a half-written row being read as "no
      // identity" and judged by the bare pid.
      { host: selfIdentity().host, pid: SOMEONE_ELSES_PID } as Partial<PathClaimEntry>,
    ],
  ];
  for (const [label, over] of cases) {
    // A half identity is not a claim at all — `validClaimEntry` refuses it, and
    // that refusal IS the D4 answer (never routed to the pid probe). Assert it
    // directly and skip the age-rule loop, which is about entries that ARE
    // claims; asserting "not stale" for a malformed row would be asserting the
    // opposite of the rule.
    if (!validClaimEntry(claim({ ...over }))) {
      assert(
        (await claimStaleReason("/repo", claim({ ...over, startedAt: NOW }), NOW, runningState)) ===
          "malformed-entry",
        `${label} is refused as a claim rather than judged by its bare pid`,
      );
      continue;
    }
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

// ── the writer: a foreign claim is never deleted before the foreign bound ---
{
  const entry = claim({
    host: FOREIGN_HOST,
    pidns: FOREIGN_NS,
    startTime: "1",
    // An impossible pid AND ancient: only a pid-only judgement would delete
    // this. The identity check must answer first.
    pid: 999_999,
    startedAt: ANCIENT,
  });
  const reason = await claimDeletionReason("/repo", entry, NOW, noState);
  assert(
    reason === null,
    `the writer never deletes a foreign holder on the ordinary bound, whatever its pid says (got ${String(reason)})`,
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
  // The identity half of the legacy rule: a record naming SOME but not all of
  // host/pidns/startTime is not a claim at all, so it cannot smuggle a foreign
  // holder into the pid-only branch.
  assert(
    !validClaimEntry({ ...claim({ host: "h" }) }),
    "an entry with host but no pidns/startTime is malformed, not identity-less",
  );
  assert(
    !validClaimEntry({ ...claim({ host: selfIdentity().host, pidns: SELF_NS }) }),
    "an entry with host+pidns but no startTime is malformed (a half identity is never probed)",
  );
  assert(
    !validClaimEntry({ ...claim({ host: "bad host!", pidns: SELF_NS, startTime: "1" }) }),
    "an entry whose host fails validation is malformed, so an invalid host never reaches a renderer",
  );
  assert(
    !validClaimEntry({ ...claim({ host: selfIdentity().host, pidns: "0x10", startTime: "1" }) }),
    "a non-decimal pidns is malformed",
  );
  assert(
    validClaimEntry({
      ...claim({ host: selfIdentity().host, pidns: SELF_NS, startTime: "1" }),
    }),
    "a full three-field identity is a valid claim",
  );
}

// ── our OWN identity still answers the probe (no rubber stamp) --------------
{
  const me = { host: selfIdentity().host, pidns: SELF_NS };
  const gone = await claimStaleReason(
    "/repo",
    claim({ ...me, startTime: "99999999999", pid: deadPid(), startedAt: NOW }),
    NOW,
    noState,
  );
  assert(
    gone === "owner-exited",
    "a claim with OUR host, OUR pidns and a dead pid still reads stale",
  );
  // A live pid carrying a start time that is not its own is a recycled pid:
  // stale too. A pid probe alone cannot see this.
  const recycled = await claimStaleReason(
    "/repo",
    claim({ ...me, startTime: "99999999999", pid: process.pid, startedAt: NOW }),
    NOW,
    noState,
  );
  assert(
    recycled === "owner-exited",
    "a claim naming OUR OWN live pid with the wrong start time reads stale (a recycled pid)",
  );
  const live = await claimStaleReason(
    "/repo",
    claim({ ...me, startTime: selfIdentity().startTime, pid: process.pid, startedAt: NOW }),
    NOW,
    noState,
  );
  assert(live === null, "a claim with our exact full identity is fresh");

  // ── F1: a VERIFIED-ALIVE full identity is never stale, at any age --------
  // The age bound exists to stop an UNVERIFIABLE claim parking cycles forever.
  // Once the identity probe has answered `alive`, the clock is judging a holder
  // it just proved is running, and the age answer is simply wrong: a develop
  // round that legitimately runs past the bound would lose its own reservation.
  const ANCIENT_OWN = NOW - 2 * 3_600_000;
  const ownAncient = await claimStaleReason(
    "/repo",
    claim({
      ...me,
      startTime: selfIdentity().startTime,
      pid: process.pid,
      startedAt: ANCIENT_OWN,
    }),
    NOW,
    noState,
  );
  assert(
    ownAncient === null,
    `this process's OWN verified identity is honoured at 2× the stale bound (got ${String(ownAncient)})`,
  );
  // A verified-alive holder whose state file also cannot be read: the probe, not
  // the missing state, is what decides.
  const ownAncientNoState = await claimStaleReason(
    "/repo",
    claim({
      ...me,
      startTime: selfIdentity().startTime,
      pid: process.pid,
      startedAt: ANCIENT_OWN,
    }),
    NOW,
    runningState,
  );
  assert(
    ownAncientNoState === null,
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
      startedAt: ANCIENT_OWN,
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
    claim({ pid: process.pid, startedAt: ANCIENT_OWN }),
    NOW,
    noState,
  );
  assert(
    legacyOwnAncient === "unreadable-state",
    `a legacy (identity-less) row with our live pid still ages out (got ${String(legacyOwnAncient)})`,
  );
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
  // D4 — a HALF identity is never routed to the pid probe: it is foreign, and
  // foreign is alive. The pid below is one this process can certainly call dead,
  // so a judge that probed would sweep the worktree and this line would go red.
  // It must be a pid that CANNOT exist, not merely one that usually does not: a
  // CI runner with a low `pid_max` routinely holds pid 999 alive, and a live 999
  // makes every case below "live-owner" for the wrong reason.
  const dead = deadPid();
  const foreignHost = await decideWith({
    pid: dead,
    at: 0,
    host: FOREIGN_HOST,
    pidns: SELF_NS,
    startTime: "1",
  });
  assert(
    foreignHost === `live-owner pid=${dead}`,
    `a state owner on another host is not swept (got ${foreignHost})`,
  );
  const foreignNs = await decideWith({
    pid: dead,
    at: 0,
    host: selfIdentity().host,
    pidns: FOREIGN_NS,
    startTime: "1",
  });
  assert(
    foreignNs === `live-owner pid=${dead}`,
    `a state owner in another pid namespace is not swept (got ${foreignNs})`,
  );
  const half = await decideWith({ pid: dead, at: 0, host: selfIdentity().host });
  assert(
    half === `live-owner pid=${dead}`,
    `a HALF identity (host only) is foreign, never probed, so it is not swept (got ${half})`,
  );
  const legacyDead = await decideWith({ pid: dead, at: 0 });
  assert(
    legacyDead !== `live-owner pid=${dead}` && !/^live-owner/.test(legacyDead),
    `a legacy {pid, at} owner with an impossible pid is still judged by pid (got ${legacyDead})`,
  );
  const oursLive = await decideWith({ pid: process.pid, at: 0 });
  assert(/^live-owner pid=\d+$/.test(oursLive), "our own live pid still skips the sweep");
  // Our own namespace and pid, but a start time that is not ours: the owner is
  // a DIFFERENT process that happens to hold our pid, so the sweep may run.
  const recycled = await decideWith({
    pid: process.pid,
    at: 0,
    host: selfIdentity().host,
    pidns: SELF_NS,
    startTime: "99999999999",
  });
  assert(
    !/^live-owner/.test(recycled),
    `a full identity whose start time does not match /proc is a recycled pid and IS swept (got ${recycled})`,
  );
}

// ── resume: a foreign owner refuses with a named owner; legacy unchanged ----
{
  // Same rule as above: the pid whose fate must not matter is one that cannot
  // exist, never a low number a CI runner may have handed to a real process.
  const dead = deadPid();
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
    inFlight({ pid: dead, at: 0, host: FOREIGN_HOST, pidns: FOREIGN_NS, startTime: "1" }),
    999_999,
  );
  assert(
    foreign.action === "refuse" && foreign.ownerPid === dead,
    "a foreign owner is REFUSED: resume will not join a driver it cannot verify",
  );
  const half = classifyRunningState(
    inFlight({ pid: dead, at: 0, host: selfIdentity().host }),
    999_999,
  );
  assert(
    half.action === "refuse",
    "a HALF identity is foreign and REFUSED — resume never probes a pid it cannot verify",
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
  const me = selfIdentity();
  assert(
    next.owner?.host === me.host &&
      next.owner?.pidns === me.pidns &&
      next.owner?.startTime === me.startTime,
    "the write-ahead records the full identity — host, pidns AND start time",
  );
  assert(
    next.owner?.startTime !== undefined && next.owner?.startTime !== "",
    "the stamped start time is present, so a later reader can spot a recycled pid",
  );
}

console.log(`\nexit ${status()}`);
process.exit(status());
