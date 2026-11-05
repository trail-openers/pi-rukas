#!/usr/bin/env bun
/**
 * AC5 (#2027) — the round-cap merge rule stops refusing a PR whose only carried
 * HIGH was fixed.
 *
 * `merge-guard-round-cap.ts` scores the round-cap allowance off the lens row it
 * was handed: `nothingBlocking` reads that row's `blockingCounts`/`blockingBar`,
 * and the driver-side arm reads the findings blob through
 * `noBlockingCarriedFinding`. Both are pure functions of what the round put on
 * the row — which is exactly the seam #2027 moves a value at, because the row
 * the round records is built from the rows the memory did NOT carry.
 *
 * So this test scores the SAME entry twice: once with the carried HIGH in the
 * counts (the pre-fix round, the refusal the field report describes) and once
 * with the counts the post-fix round records, where the delta round retired the
 * HIGH and nothing at the bar is carried. The first must refuse on the round
 * condition, the second must not — and the only thing between them is whether
 * the retired HIGH still counts as blocking.
 */
import { evaluateRoundCapMerge, lensResidualsMarker } from "../src/merge-guard-round-cap.ts";
import type { LedgerEntry } from "../src/review-ledger-entry.ts";
import { noBlockingCarriedFinding } from "../src/work-driver-lens-cap.ts";
import {
  EVIDENCE,
  FIXED_FILE,
  SUBTRACTED_DELTA,
  commitFile,
  setupChangedLinesRepo,
} from "./lib/review-changed-lines-fixture.ts";

// The cap the round is scored against: below the default MAX_REVIEW_ROUNDS, so
// the round condition is the one that decides while something blocks. Saved and
// restored like every other env-reading round-cap test, so this file cannot
// leak its cap into a later test in the same process.
const PREV_CAP = process.env.PI_ENSEMBLE_LENS_ROUND_CAP;
const PREV_MERGE = process.env.PI_ENSEMBLE_LENS_ROUND_CAP_MERGE;
process.env.PI_ENSEMBLE_LENS_ROUND_CAP = "2";
process.env.PI_ENSEMBLE_LENS_ROUND_CAP_MERGE = "";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const HEAD = "f".repeat(40);

const HIGH = {
  lens: "SIMPLICITY",
  severity: "HIGH",
  path: "src/a.ts",
  line: 3,
  title: "Hand-typed json fence instead of fenceText",
  reproduction: { command: "bun test", observed: "1 failure" },
  carried: true,
} as const;
const PROBE = {
  lens: "SIMPLICITY",
  severity: "MEDIUM",
  path: "src/keep.ts",
  line: 1,
  title: "Naming drift on an untouched line",
  carried: true,
} as const;

/** The round-cap rule as the guard calls it: an ISSUES_FOUND row, no CRITICAL,
 * below the cap, with its counts and bar recorded and the disclosure posted. */
const entry = (findings: unknown[], counts: Record<string, number>): LedgerEntry =>
  ({
    branch: "feat/x",
    kind: "lens",
    patchId: "patch-2027",
    passed: false,
    at: 1,
    detail: "ISSUES_FOUND",
    hasCritical: false,
    blockingCounts: { CRITICAL: 0, HIGH: counts.HIGH ?? 0, MEDIUM: counts.MEDIUM ?? 0 },
    blockingBar: "HIGH",
    round: 1,
    headSha: HEAD,
    findings,
  }) as unknown as LedgerEntry;

const decide = (e: LedgerEntry) =>
  evaluateRoundCapMerge(
    [e],
    "feat/x",
    "patch-2027",
    [lensResidualsMarker("feat/x", "patch-2027")],
    HEAD,
  );

const restoreEnv = () => {
  if (PREV_CAP === undefined) Reflect.deleteProperty(process.env, "PI_ENSEMBLE_LENS_ROUND_CAP");
  else process.env.PI_ENSEMBLE_LENS_ROUND_CAP = PREV_CAP;
  if (PREV_MERGE === undefined)
    Reflect.deleteProperty(process.env, "PI_ENSEMBLE_LENS_ROUND_CAP_MERGE");
  else process.env.PI_ENSEMBLE_LENS_ROUND_CAP_MERGE = PREV_MERGE;
};

const before = decide(entry([HIGH, PROBE], { HIGH: 1, MEDIUM: 1 }));
assert(
  before.applies === true &&
    before.allowed === false &&
    /below the 2-round cap/.test(before.failedCondition ?? ""),
  `the round-cap rule refuses while a carried HIGH is in the blocking counts (${JSON.stringify(before.failedCondition)?.slice(0, 130)})`,
);
assert(
  noBlockingCarriedFinding(JSON.stringify([HIGH, PROBE])) === false,
  "the driver's ci route likewise refuses to route on a carried HIGH",
);

const repo = setupChangedLinesRepo();
try {
  const r1 = await repo.round({ findings: [HIGH, PROBE], review: "full", evidence: EVIDENCE });
  assert(r1.ok === true, `round 1 filed the HIGH (${r1.ok ? "ok" : r1.reason})`);
  const since = repo.git("rev-parse", "HEAD");
  commitFile(repo, "src/a.ts", FIXED_FILE, "fix: use fenceText");
  const r2 = await repo.round({
    findings: [],
    review: "delta",
    deltaDiff: SUBTRACTED_DELTA,
    deltaSince: since,
    evidence: EVIDENCE,
  });
  if (!r2.ok) {
    assert(false, `the delta round recorded (refused: ${r2.reason})`);
    process.exit(1);
  }
  // The row the post-fix round WOULD record: its own findings are the carried
  // rows it kept, and its counts are that summary's.
  const carried = r2.carried.map((f) => ({ ...f, carried: true }));
  const after = decide(
    entry(carried, {
      HIGH: carried.filter((f) => f.severity === "HIGH").length,
      MEDIUM: carried.filter((f) => f.severity === "MEDIUM").length,
    }),
  );
  assert(
    after.allowed === true,
    `the round-cap rule stops refusing once the delta round retired the HIGH (refused: ${JSON.stringify(after.failedCondition)?.slice(0, 150)})`,
  );
  assert(
    noBlockingCarriedFinding(JSON.stringify(carried)) === true,
    `and the ci route sees no blocking carried row (carried: ${carried.map((f) => f.title).join(",") || "none"})`,
  );
  process.exit(exit);
} finally {
  repo.cleanup();
  restoreEnv();
}
