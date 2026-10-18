#!/usr/bin/env bun
/**
 * #1454 r2 — claim-entry validation and the age bound.
 *
 * Split from test-work-driver-stale-path-claims.ts for the 500-line gate
 * (AGENTS.md §12). That file keeps the liveness half — who still holds a claim;
 * this one pins the SHAPE a claim must have and the BOUND an unverifiable one
 * lives under, both of which the r2 review asked to be pinned by CALLING the
 * rule rather than by pattern-matching this project's source.
 *
 * Three things, one section each:
 *   - `resolveClaimStaleMs` is pure, so its clamp / default / garbage handling
 *     is asserted by calling it. A source-text assertion ("the file contains
 *     Math.max(...)") passes when the rule is deleted and the test renamed.
 *   - `validClaimEntry` gates everything below the read, which dereferences
 *     `entry.pid`, `entry.startedAt` and `entry.paths` unguarded. Each rejected
 *     shape is asserted both as a predicate verdict and end-to-end, and must be
 *     PRUNED — an entry that is merely skipped sits in the file forever.
 *   - the reader's rule and the writer's rule are two functions. `registerClaim`
 *     once used the reader's and lost seven of eight concurrent claims; section
 *     24e is that regression, and it cannot pass if the two are merged again.
 */

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  CLAIM_STALE_MIN_FLOOR_MS,
  CLAIM_STALE_MS,
  type PathClaimEntry,
  claimStaleReason,
  readClaims,
  registerClaim,
  resolveClaimStaleMs,
  validClaimEntry,
} from "../src/work-driver-path-claims.ts";
import { rawClaims, seedClaims, tmpDir } from "./lib/claims-test-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ================================================================ 24c. #1454 r2 — the age bound is floored, not trusted
{
  // `PI_ENSEMBLE_CLAIM_STALE_MS=1` would expire every claim the instant it
  // was written, which is the "two cycles, one file" false-positive the
  // registry exists to prevent. The value is clamped, not believed.
  //
  // r2 — the rule is pinned BEHAVIOURALLY, by calling the pure resolver, not
  // by matching a file's source text. A source-text assertion passes when the
  // rule is deleted and the test is renamed; these calls cannot.
  assert(
    resolveClaimStaleMs(undefined) === 3_600_000,
    "unset resolves to the documented 1 hour",
  );
  assert(resolveClaimStaleMs("") === 3_600_000, "an empty value is treated as unset");
  assert(
    resolveClaimStaleMs("1") === CLAIM_STALE_MIN_FLOOR_MS,
    "a sub-floor value is clamped UP to the floor, not honoured",
  );
  assert(
    resolveClaimStaleMs("0") === 3_600_000,
    "zero falls back to the default rather than expiring every claim instantly",
  );
  assert(resolveClaimStaleMs("-5") === 3_600_000, "a negative value falls back to the default");
  assert(
    resolveClaimStaleMs("not-a-number") === 3_600_000,
    "garbage falls back to the default rather than NaN disabling the bound",
  );
  assert(
    resolveClaimStaleMs("7200000") === 7_200_000,
    "a sane value above the floor is honoured verbatim",
  );
  assert(
    resolveClaimStaleMs("1000") >= CLAIM_STALE_MIN_FLOOR_MS,
    "no input ever yields a bound below the floor",
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

// ================================================================ 24d. #1454 r2 — malformed entries are stale at the read boundary
{
  // The registry is plain JSON an operator edits, and everything below the read
  // dereferences `entry.pid`, `entry.startedAt` and `entry.paths` unguarded. A
  // half-written entry that survives is a TypeError in someone else's plan step.
  // Each shape below is asserted BOTH as a predicate verdict and end-to-end:
  // seeded into the file, it must not be honoured and must be pruned.
  const dir = tmpDir();
  const now = 1_800_000_000_000;
  const good: PathClaimEntry = {
    issue: 1510,
    pid: process.pid,
    paths: ["src/a.ts"],
    startedAt: now - 60_000,
  };
  try {
    const cases: [string, unknown][] = [
      ["null", null],
      ["a bare number", 42],
      ["pid 0 (signal the process group)", { ...good, pid: 0 }],
      ["a negative pid (a process group)", { ...good, pid: -1 }],
      ["a non-integer pid", { ...good, pid: 1.5 }],
      ["a string pid", { ...good, pid: "123" }],
      ["a missing pid", { issue: 1510, paths: ["src/a.ts"], startedAt: now - 60_000 }],
      ["a non-finite startedAt", { ...good, startedAt: Number.NaN }],
      ["an infinite startedAt", { ...good, startedAt: Number.POSITIVE_INFINITY }],
      ["a missing startedAt", { issue: 1510, pid: process.pid, paths: ["src/a.ts"] }],
      ["a non-integer issue", { ...good, issue: 1.5 }],
      ["paths as a string", { ...good, paths: "src/a.ts" }],
      ["paths with a non-string member", { ...good, paths: ["src/a.ts", 7] }],
      ["a missing paths array", { issue: 1510, pid: process.pid, startedAt: now - 60_000 }],
    ];
    for (const [label, entry] of cases) {
      assert(!validClaimEntry(entry), `validClaimEntry rejects ${label}`);
      assert(
        (await claimStaleReason(dir, entry as PathClaimEntry, now, async () => undefined)) ===
          "malformed-entry",
        `a claim with ${label} is stale, not honoured`,
      );
    }
    assert(validClaimEntry(good), "validClaimEntry accepts a well-formed claim");
    // pid 1 is the case validation must NOT reject: the canonical predicate
    // `processAlive` treats EPERM as alive, and an entry whose owner is another
    // user's pid is a real claim. Refusing it would put the registry and that
    // predicate out of agreement — the divergence #1454 removed.
    assert(
      validClaimEntry({ ...good, pid: 1 }),
      "pid 1 is shape-valid — EPERM means alive, per the canonical predicate",
    );

    // End-to-end: a malformed entry is neither honoured nor left on disk.
    seedClaims(dir, [
      { issue: 1511, pid: 0, paths: ["src/bad.ts"], startedAt: now },
      { issue: 1512, pid: process.pid, paths: "src/bad2.ts", startedAt: now },
      good,
    ]);
    const honoured = await readClaims(dir, now);
    assert(
      honoured.length === 1 && honoured[0]?.issue === 1510,
      "only the well-formed entry is honoured",
    );
    const after = rawClaims(dir);
    assert(
      after.length === 1 && after[0]?.issue === 1510,
      "malformed entries are PRUNED from the file, not merely skipped",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 24e. #1454 r2 — a writer may not delete an unverifiable claim
{
  // The reader's rule and the writer's rule used to be ONE function, and
  // `registerClaim` used the reader's. Eight concurrent claim writers lost
  // seven of their claims: each peer had written its claim and its process was
  // gone by the time a sibling read the file, and the reader's rule treats an
  // unverifiable owner as stale. For a park that is safe; for a DELETE it
  // collides two workstreams on one file.
  //
  // The assertion below is the regression: a dead-owner entry YOUNGER than the
  // age bound must SURVIVE a write, and the same entry PAST the bound must go.
  const dir = tmpDir();
  try {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const now = Date.now();
    const youngDead: PathClaimEntry = {
      issue: 1520,
      pid: 999_999,
      paths: ["src/peer-young.ts"],
      startedAt: now - 1_000,
    };
    const agedDead: PathClaimEntry = {
      issue: 1521,
      pid: 999_998,
      paths: ["src/peer-aged.ts"],
      startedAt: now - CLAIM_STALE_MS - 60_000,
    };
    seedClaims(dir, [youngDead, agedDead]);
    const written = await registerClaim(dir, 1522, ["src/ours.ts"]);
    const survivors = written.map((c) => c.issue);
    assert(
      survivors.includes(1520),
      "a dead-owner claim YOUNGER than the bound is NOT deleted by a writer (the 7-of-8 loss)",
    );
    assert(
      !survivors.includes(1521),
      "a dead-owner claim PAST the bound IS deleted — the bound still ages corpses out",
    );
    assert(survivors.includes(1522), "our own claim is present after the write");
    // And the reader still refuses to park anyone on the young corpse: keeping
    // it in the file costs a cycle nothing.
    const honoured = await readClaims(dir, now);
    assert(
      !honoured.some((c) => c.issue === 1520),
      "the kept entry is still not honoured by the READER — keeping it parks nobody",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
