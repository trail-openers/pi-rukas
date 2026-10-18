#!/usr/bin/env bun
/**
 * #1454 — generator for the path-claims fixtures under
 * `smoke-tests/fixtures/work-state/`.
 *
 * The fixtures are committed (a test reading a freshly generated file is not a
 * fixture — the committed bytes are what the suite is asserted against) and
 * this generator is how they are authored, so the shapes are reviewable as
 * data rather than as TypeScript object literals scattered through the suite.
 *
 * It is an AUTHORING tool, not a golden check: nothing in the suite re-runs it
 * or compares its output to the committed files. Regenerating is therefore a
 * deliberate act, not a verification step — the committed fixtures are the
 * contract, and `smoke-tests/fixtures/work-state/loader.ts` reads those.
 *
 * Two consequences of that, both deliberate:
 *   - Regenerating reformats. This file emits every array expanded across
 *     lines; the committed fixtures keep short arrays (`"inFlightJobIds":
 *     ["plan:1"]`) on one line, which `JSON.stringify` will not produce. So a
 *     plain re-run shows whitespace-only diffs on files whose contents did not
 *     change. Do not commit those — regenerate, diff, and keep only the
 *     semantic change.
 *   - Editing a fixture by hand and regenerating are two different operations.
 *     Hand edits survive only until someone runs this script.
 *
 * Re-run after editing this file:
 *
 *   bun extension/scripts/gen-claims-fixtures.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "smoke-tests", "fixtures", "work-state");
const CLAIMS_DIR = join(FIXTURE_DIR, "path-claims");

/** Sentinel pid meaning "the test substitutes a pid that is definitely alive". */
const LIVE = -1;
/** A pid that is never a valid owner: kill(0,0) signals the caller's own group. */
const DEAD = 0;

const CLAIMED_PATHS = [
  "extension/src/worktree-provision.ts",
  "extension/src/work-driver-verify-develop-helpers.ts",
];
const OVERLAPPING_PATHS = ["extension/src/work-driver-verify-develop-helpers.ts"];

function claim(issue: number, pid: number, paths: string[], ageMs: number) {
  return { issue, pid, paths, startedAt: `@AGE(-${ageMs})` };
}

/** A minimal, schema-valid WorkState in the shape the claims gate reads. */
function state(opts: {
  issue: number;
  issues?: number[];
  status: "running" | "merged" | "handoff" | "aborted" | "interrupted";
  ownerPid: number;
  ownerAgeMs: number;
  inFlightJobIds?: string[];
  worktrees?: Record<string, string>;
  branchName?: string;
}) {
  return {
    schemaVersion: 1,
    resumable: opts.inFlightJobIds !== undefined,
    owner: { pid: opts.ownerPid, at: `@AGE(-${opts.ownerAgeMs})` },
    issue: opts.issue,
    ...(opts.issues ? { issues: opts.issues } : {}),
    startedAt: `@AGE(-${opts.ownerAgeMs + 60000})`,
    updatedAt: `@AGE(-${opts.ownerAgeMs})`,
    pipelineState: {
      currentStep: "develop",
      inFlightJobIds: opts.inFlightJobIds ?? [],
      ...(opts.branchName ? { branchName: opts.branchName } : {}),
      worktrees: opts.worktrees ?? {},
      reviewRound: 0,
      ciRetryCount: 0,
      plumbReports: [],
      status: opts.status,
    },
    eventLog: [],
  };
}

const claimsFixtures: Record<string, { comment: string; claims: unknown[] }> = {
  "live-pid": {
    comment:
      "A claim whose owner pid is alive and whose age is recent. The gate MUST honour it — this is the concurrency protection #444 exists to provide, and the case the liveness swap must not regress.",
    claims: [claim(1421, LIVE, CLAIMED_PATHS, 60_000)],
  },
  "dead-pid": {
    comment:
      "A claim whose owner pid is dead (0 is never a valid owner: kill(0,0) signals the caller's own process group). The gate must not park a sibling, and the entry must be pruned by the next writer. No state file accompanies it — a dead pid alone is sufficient.",
    claims: [claim(1421, DEAD, CLAIMED_PATHS, 60_000)],
  },
  "dead-pid-with-matching-state-file": {
    comment:
      "The stale-repro PAIR the bug report names: a dead-pid claim plus the claimant's own .pi/work-state/<issue>.json carrying owner.pid and updatedAt. A dead pid ALONE already releases it; the pair is what the operator's on-disk state actually looks like, and what the sweep resolves through.",
    claims: [claim(1421, DEAD, CLAIMED_PATHS, 5_220_000)],
  },
  "dead-pid-grouped": {
    comment:
      "A grouped cycle (/work 1421 1422) claims EVERY issue in its group, so a stale group is a set of entries, not one. Clearing only the primary leaves #1422's claim behind to park the next cycle — the same zombie one issue short.",
    claims: [
      claim(1421, DEAD, CLAIMED_PATHS, 120_000),
      claim(1422, DEAD, ["extension/src/worktree-provision.ts"], 120_000),
    ],
  },
  "live-pid-terminal-state-file": {
    comment:
      "The #1421 shape the ticket's motivating diagnosis got wrong: the claimant's pid was STILL RUNNING (a 13h pi process) while its cycle had reached status handoff and never released its claim. Pid liveness alone cannot see this — the terminal status of the claimant's state file is what releases it.",
    claims: [claim(1421, LIVE, CLAIMED_PATHS, 5_220_000)],
  },
  "observed-1421-1427": {
    comment:
      "Verbatim shape of the park that opened #1454: 19 paths claimed by #1421 (abbreviated to the two that overlapped), claimed ~87 minutes before #1427 parked at plan. Evidence in .pi/work-state/1392.json and 1402.json (the claimant-naming parks), not 1427.json.",
    claims: [claim(1421, DEAD, CLAIMED_PATHS, 5_220_000)],
  },
};

const stateFixtures: Record<string, unknown> = {
  "claimant-1421-running-live": state({
    issue: 1421,
    status: "running",
    ownerPid: LIVE,
    ownerAgeMs: 60_000,
    inFlightJobIds: ["plan:1"],
    branchName: "feature/issue-1421-x",
    worktrees: { "task-a": "@WORKTREE(issue-1421-task-a)" },
  }),
  "claimant-1421-running-dead": state({
    issue: 1421,
    status: "running",
    ownerPid: DEAD,
    ownerAgeMs: 5_220_000,
    inFlightJobIds: ["develop:1"],
    branchName: "feature/issue-1421-x",
    // The multi-workstream shape: the directory is `issue-<N>-task-a` while
    // the state file is `<N>.json` — the mismatch that made every such tree
    // read "state-unreadable" and froze the sweep.
    worktrees: {
      "task-a": "@WORKTREE(issue-1421-task-a)",
      "task-b": "@WORKTREE(issue-1421-task-b)",
    },
  }),
  "claimant-1421-handoff-live-owner": state({
    issue: 1421,
    status: "handoff",
    ownerPid: LIVE,
    ownerAgeMs: 5_220_000,
    // The live-but-terminal owner: this is the state file whose claim a pid
    // probe still honours, which is why a status rule sits beside it.
    worktrees: { "task-a": "@WORKTREE(issue-1421-task-a)" },
  }),
  "claimant-1421-grouped-dead": state({
    issue: 1421,
    issues: [1421, 1422],
    status: "running",
    ownerPid: DEAD,
    ownerAgeMs: 120_000,
    worktrees: {
      "task-a": "@WORKTREE(issue-1421-task-a)",
      "task-b": "@WORKTREE(issue-1421-task-b)",
    },
  }),
};

function emit(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  console.log(`wrote ${file}`);
}

mkdirSync(CLAIMS_DIR, { recursive: true });
for (const [name, fixture] of Object.entries(claimsFixtures)) {
  emit(join(CLAIMS_DIR, `${name}.json`), { $comment: fixture.comment, claims: fixture.claims });
}
for (const [name, fixture] of Object.entries(stateFixtures)) {
  emit(join(FIXTURE_DIR, `${name}.json`), fixture);
}
