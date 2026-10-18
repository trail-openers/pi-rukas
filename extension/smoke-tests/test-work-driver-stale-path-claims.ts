#!/usr/bin/env bun
/**
 * #1454 — the stale path-claim suites: a claim whose owning cycle has exited,
 * or has reached a terminal status, must not park a later cycle; and a claim
 * whose owner is genuinely running must STILL park one.
 *
 * Split from test-work-driver-cross-group-conflicts.ts (sections 17-26) for
 * the 500-line gate. That file keeps the registry's own behaviour (atomic
 * write/release, overlap detection, the escape hatch); this one is the
 * liveness half — the bug that parked six cycles against claims nobody
 * released.
 *
 * The reproduction is scriptable offline exactly as the issue asked: import
 * `checkAndRegisterClaims`, write `.pi/work-state/path-claims.json` in a
 * mkdtempSync repoRoot, pass an overlapping `workstreams.paths`, and assert
 * the returned cap-hit plus `pipelineState.status` / `currentStep`. No git, no
 * network, no subagent.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CLAIM_STALE_MIN_FLOOR_MS,
  CLAIM_STALE_MS,
  type PathClaimEntry,
  checkAndRegisterClaims,
  claimStaleReason,
  readClaims,
  releaseClaim,
} from "../src/work-driver-path-claims.ts";
import { processAlive } from "../src/work-driver-resume.ts";
import {
  CLAIMED_PATHS,
  FIXTURE_DIR,
  OBSERVED_CLAIM_AGE_MS,
  OVERLAPPING_PATHS,
  loadFixtureClaims,
  loadFixtureState,
} from "./fixtures/work-state/loader.ts";
import {
  makeCtx,
  makeState,
  rawClaims,
  seedClaims,
  spawnLivePid,
  tmpDir,
} from "./lib/claims-test-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
// ================================================================ 17. #1454 — a dead owner's claim does not park a sibling
{
  // The reproduction the ticket asked for: no git, no network, no subagent.
  // Seed `.pi/work-state/path-claims.json` in a temp repoRoot, pass an
  // overlapping workstreams.paths, and assert the returned state.
  const dir = tmpDir();
  try {
    seedClaims(dir, [
      {
        issue: 1421,
        pid: 999999,
        paths: CLAIMED_PATHS,
        startedAt: Date.now() - OBSERVED_CLAIM_AGE_MS,
      },
    ]);
    const state = makeState(1427, dir);
    const result = await checkAndRegisterClaims(makeCtx(dir, 1427), state, {
      "task-a": { paths: OVERLAPPING_PATHS },
    });
    assert(result === state, "dead claimant: state returned UNCHANGED (no cap-hit)");
    assert(
      !result.eventLog.some((e) => e.kind === "cap-hit"),
      "dead claimant: no cap-hit event emitted",
    );
    assert(result.pipelineState.status === "running", "dead claimant: status stays running");
    const ours = rawClaims(dir).filter((c) => c.issue === 1427);
    assert(ours.length === 1, "dead claimant: our own claim was registered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 18. #1454 — a live owner's claim STILL parks (no regression)
{
  const live = await spawnLivePid();
  try {
    // A live claimant whose state file is absent AND recent: every staleness
    // rule declines, so the gate must park exactly as it did before #1454.
    const dir = tmpDir();
    try {
      seedClaims(dir, [
        { issue: 1421, pid: live.pid, paths: CLAIMED_PATHS, startedAt: Date.now() - 5_000 },
      ]);
      const state = makeState(1427, dir);
      const result = await checkAndRegisterClaims(makeCtx(dir, 1427), state, {
        "task-a": { paths: OVERLAPPING_PATHS },
      });
      const capHit = result.eventLog.find((e) => e.kind === "cap-hit");
      assert(capHit !== undefined, "live claimant: cap-hit still emitted");
      assert(capHit?.cap === "cross-group-conflict", "live claimant: cap is cross-group-conflict");
      assert(result.pipelineState.status === "handoff", "live claimant: status is handoff");
      assert(result.pipelineState.currentStep === "plan", "live claimant: currentStep is plan");
      assert(
        (capHit?.evidence ?? "").includes("claimant1421"),
        "live claimant: evidence carries the machine-readable claimant token",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await live.stop();
  }
}

// ================================================================ 19. #1454 — a live-but-TERMINAL claimant is released
{
  // The #1421 shape: the claiming pid was still in the process table (a 13h
  // pi) while the cycle had reached `handoff` and never released. Pid liveness
  // cannot see this; the claimant's own state file can.
  const dir = tmpDir();
  try {
    const live = await spawnLivePid();
    try {
      seedClaims(dir, [
        { issue: 1421, pid: live.pid, paths: CLAIMED_PATHS, startedAt: Date.now() - 5_000 },
      ]);
      const wd = path.join(dir, ".pi", "work-state");
      mkdirSync(wd, { recursive: true });
      const claimant = loadFixtureState("claimant-1421-handoff-live-owner", {
        livePid: live.pid,
        repoRoot: dir,
      });
      writeFileSync(path.join(wd, "1421.json"), JSON.stringify(claimant));
      const result = await checkAndRegisterClaims(makeCtx(dir, 1427), makeState(1427, dir), {
        "task-a": { paths: OVERLAPPING_PATHS },
      });
      assert(
        result.pipelineState.status === "running",
        "terminal claimant does not park the sibling",
      );
      assert(!rawClaims(dir).some((c) => c.issue === 1421), "terminal claimant's entry is pruned");
    } finally {
      await live.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 20. #1454 — stale entries are PRUNED, not merely ignored
{
  // The read path used to filter without writing, so the file kept the
  // zombie forever and only a `registerClaim` from some other cycle cleaned
  // it. Assert the raw JSON on disk loses the dead entry — and keeps an
  // unrelated live sibling's entry that shares nothing but the file.
  const live = await spawnLivePid();
  const dir = tmpDir();
  try {
    seedClaims(dir, [
      { issue: 1428, pid: live.pid, paths: ["src/keep.ts"], startedAt: Date.now() },
      { issue: 1427, pid: 999999, paths: ["src/drop.ts"], startedAt: Date.now() },
    ]);
    const before = rawClaims(dir);
    assert(before.length === 2, "both entries seeded");
    const honoured = await readClaims(dir);
    assert(honoured.length === 1 && honoured[0].issue === 1428, "only the live entry is honoured");
    const after = rawClaims(dir);
    assert(
      after.length === 1 && after[0].issue === 1428,
      "dead entry pruned from the file on read",
    );
  } finally {
    await live.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 21. #1454 — releaseClaim cannot erase an unrelated sibling
{
  // releaseClaim rebuilt the file from readClaims() — a liveness-FILTERED
  // read — so releasing #1427 silently deleted a live #1428's ownership. A
  // release now removes exactly one issue's claim.
  const live = await spawnLivePid();
  const dir = tmpDir();
  try {
    seedClaims(dir, [
      { issue: 1428, pid: live.pid, paths: ["src/keep.ts"], startedAt: Date.now() },
      { issue: 1427, pid: 999999, paths: ["src/drop.ts"], startedAt: Date.now() },
    ]);
    await releaseClaim(dir, 1427);
    const after = rawClaims(dir);
    assert(after.length === 1 && after[0].issue === 1428, "release removes only the named issue");
  } finally {
    await live.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 22. #1454 — a grouped cycle's claims clear as a SET
{
  // work-driver-registry.claimCycle claims EVERY issue in a group, so a
  // grouped cycle registers one entry per issue. Clearing only the primary
  // leaves a sibling entry to park the next cycle.
  const dir = tmpDir();
  try {
    seedClaims(dir, [
      { issue: 1421, pid: 999999, paths: ["src/a.ts"], startedAt: Date.now() },
      { issue: 1422, pid: 999999, paths: ["src/b.ts"], startedAt: Date.now() },
      { issue: 1430, pid: process.pid, paths: ["src/c.ts"], startedAt: Date.now() },
    ]);
    const remaining = await releaseClaim(dir, [1421, 1422]);
    assert(
      remaining.length === 1 && remaining[0].issue === 1430,
      "whole group cleared, sibling kept",
    );
    const state = makeState(1423, dir);
    const result = await checkAndRegisterClaims(makeCtx(dir, 1423), state, {
      "task-a": { paths: ["src/a.ts", "src/b.ts"] },
    });
    assert(
      result.pipelineState.status === "running",
      "grouped cycle releases BOTH entries on clear",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 23. #1454 — releaseClaim works for a dead owner
{
  // Every existing release path was self-release by the live owner, so
  // nothing proved a corpse's claim could be cleared — a dead process can
  // never call releaseClaim itself.
  const dir = tmpDir();
  try {
    seedClaims(dir, [
      { issue: 1421, pid: 999999, paths: ["src/a.ts"], startedAt: Date.now() - 7_200_000 },
    ]);
    const remaining = await releaseClaim(dir, 1421);
    assert(remaining.length === 0, "a dead owner's claim is releasable");
    assert(rawClaims(dir).length === 0, "file on disk is empty after releasing a dead owner");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 24. #1454 — the age bound is applied, and named
{
  // `_STALE_MS` was declared and read nowhere. The bound is now real, lives
  // under its own name, and applies ONLY when the claimant's state file
  // cannot be read — an unreadable claimant must not park cycles forever.
  assert(CLAIM_STALE_MS === 3_600_000, "CLAIM_STALE_MS defaults to the documented 1 hour");
  const dir = tmpDir();
  const now = 1_800_000_000_000;
  try {
    const fresh: PathClaimEntry = {
      issue: 1500,
      pid: process.pid,
      paths: ["src/a.ts"],
      startedAt: now - 60_000,
    };
    const aged: PathClaimEntry = { ...fresh, issue: 1501, startedAt: now - CLAIM_STALE_MS - 1 };
    const noState = async () => undefined;
    assert(
      (await claimStaleReason(dir, fresh, now, noState)) === null,
      "fresh claim with an unreadable claimant stays honoured",
    );
    assert(
      (await claimStaleReason(dir, aged, now, noState)) === "unverifiable-age",
      "a claim older than CLAIM_STALE_MS with an unreadable claimant goes stale",
    );
    assert(
      (await claimStaleReason(dir, fresh, now, async () => {
        throw new Error("unreadable");
      })) === null,
      "an unreadable claimant's state file falls through to the age bound, not a park-forever",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 24b. #1454 r2 — a CORRUPT claimant state expires, not parks forever
{
  // `readState` returns undefined for ENOENT and THROWS for corrupt JSON or a
  // schemaVersion mismatch. If a throw were swallowed into "claimant is
  // undefined but I have no reason to say so", the entry would look verified
  // and hold its paths indefinitely. The throw must land in the same branch as
  // "no state file": the age bound decides.
  const dir = tmpDir();
  const now = 1_800_000_000_000;
  try {
    const fresh: PathClaimEntry = {
      issue: 1502,
      pid: process.pid,
      paths: ["src/a.ts"],
      startedAt: now - 60_000,
    };
    const aged: PathClaimEntry = { ...fresh, issue: 1503, startedAt: now - CLAIM_STALE_MS - 1 };
    const throws = async () => {
      throw new Error("work-state: .../1502.json is not valid JSON");
    };
    assert(
      (await claimStaleReason(dir, fresh, now, throws)) === null,
      "a corrupt claimant state under the bound still reserves its paths (no premature prune)",
    );
    assert(
      (await claimStaleReason(dir, aged, now, throws)) === "unreadable-state",
      "a corrupt claimant state past the bound goes stale — it does NOT hold forever",
    );
    // The distinguishing case: ENOENT (undefined) and a throw must reach the
    // SAME verdict shape, differing only in the reason string the trace shows.
    assert(
      (await claimStaleReason(dir, aged, now, async () => undefined)) === "unverifiable-age",
      "the missing-state path keeps its own reason, distinct from the corrupt one",
    );

    // End-to-end through the gate: a live owner whose state file is corrupt
    // must stop parking siblings once the bound has passed. Without the fix
    // this is the six-cycle park: pid alive, state unreadable, no reason.
    const wd = path.join(dir, ".pi", "work-state");
    mkdirSync(wd, { recursive: true });
    writeFileSync(path.join(wd, "1504.json"), "{ this is not json");
    seedClaims(dir, [
      { issue: 1504, pid: process.pid, paths: CLAIMED_PATHS, startedAt: now - CLAIM_STALE_MS - 1 },
    ]);
    const parked = await checkAndRegisterClaims(
      makeCtx(dir, 1505),
      makeState(1505, dir),
      { "task-a": { paths: OVERLAPPING_PATHS } },
      now,
    );
    assert(
      parked.pipelineState.status === "running",
      "a corrupt-claimant claim past the bound does NOT park the sibling",
    );
    assert(
      !rawClaims(dir).some((c) => c.issue === 1504),
      "the corrupt-claimant entry is pruned from the registry",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 24c. #1454 r2 — the age bound is floored, not trusted
{
  // `PI_ENSEMBLE_CLAIM_STALE_MS=1` would expire every claim the instant it
  // was written, which is the "two cycles, one file" false-positive the
  // registry exists to prevent. The value is clamped, not believed.
  const src = readFileSync(
    path.join(import.meta.dirname, "..", "src", "work-driver-path-claims.ts"),
    "utf8",
  );
  assert(
    /Math\.max\(value,\s*CLAIM_STALE_MIN_FLOOR_MS\)/.test(src),
    "CLAIM_STALE_MS is clamped to the floor rather than returned verbatim",
  );
  assert(
    CLAIM_STALE_MIN_FLOOR_MS === 300_000,
    "the floor is the documented 5 minutes (below it, no claim survives a write)",
  );
  assert(
    CLAIM_STALE_MS >= CLAIM_STALE_MIN_FLOOR_MS,
    "the exported bound never sits below the floor",
  );
}

// ================================================================ 25. #1454 — fixtures are the repro's shape, and stay in sync
{
  // The three inline JSON.stringify writes this suite used to build its own
  // fixtures from are gone; the golden files are the source of truth. They
  // are committed, so this asserts they still parse into the shapes the gate
  // reads — a fixture that silently drifted would stop testing anything.
  assert(
    existsSync(path.join(FIXTURE_DIR, "claimant-1421-handoff-live-owner.json")),
    "state fixtures are committed",
  );
  for (const name of [
    "live-pid",
    "dead-pid",
    "dead-pid-with-matching-state-file",
    "dead-pid-grouped",
    "live-pid-terminal-state-file",
    "observed-1421-1427",
  ]) {
    const claims = loadFixtureClaims(name, { now: 1_800_000_000_000 });
    assert(claims.length > 0, `claims fixture ${name} loads and is non-empty`);
    assert(
      claims.every(
        (c) => Number.isFinite(c.startedAt) && Array.isArray(c.paths) && c.paths.length > 0,
      ),
      `claims fixture ${name} carries a resolved startedAt and non-empty paths`,
    );
  }
  const observed = loadFixtureClaims("observed-1421-1427", { now: 1_800_000_000_000 });
  const observedClaim = observed[0];
  assert(
    observedClaim !== undefined &&
      1_800_000_000_000 - observedClaim.startedAt === OBSERVED_CLAIM_AGE_MS,
    "the observed fixture really carries the ~87-minute age from the field",
  );
  const liveFixture = loadFixtureClaims("live-pid", { livePid: process.pid });
  assert(
    liveFixture[0]?.pid === process.pid,
    "the live-pid fixture resolves its sentinel to a live pid",
  );
  const deadFixture = loadFixtureClaims("dead-pid");
  assert(deadFixture[0]?.pid === 0, "the dead-pid fixture keeps its never-valid pid");
}

// ================================================================ 26. #1454 — canary: one liveness predicate, no local copy
{
  // A second kill(pid,0) in this harness is how the two helpers came to
  // disagree about pid 1 and pid 0 in the first place. Pin the single seam.
  const src = readFileSync(
    path.join(import.meta.dirname, "..", "src", "work-driver-path-claims.ts"),
    "utf8",
  );
  const code = src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("/*"))
    .join("\n");
  assert(!code.includes("isProcessAlive"), "path-claims no longer defines its own isProcessAlive");
  assert(!code.includes("process.kill"), "path-claims contains no module-local kill(pid,0)");
  assert(
    /import \{[^}]*processAlive[^}]*\} from "\.\/work-driver-resume\.ts"/.test(src),
    "path-claims imports processAlive from work-driver-resume.ts",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
