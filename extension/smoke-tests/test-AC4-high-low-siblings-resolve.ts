#!/usr/bin/env bun
/**
 * AC4 (#2027) — the observed case, offline: round 1 files a HIGH and a LOW at
 * the SAME location; a fix commit rewrites exactly those lines; the follow-up
 * round reviews a delta whose changed-line ranges the fix hunk was subtracted
 * out of (what `subtractReviewedHunks` produces) and reports NEITHER row. Both
 * must resolve, and the round must report nothing as carried.
 *
 * The mutant witness: with the arm narrowed back to the pre-fix rule (or to
 * CRITICAL alone) only the LOW retires and the HIGH comes back carried — the
 * exact asymmetry the field report describes — so the named-HIGH assertion is
 * what reddens this file under that mutant.
 */
import { readBranchRows } from "../src/review-findings-store.ts";
import {
  EVIDENCE,
  FIXED_FILE,
  SUBTRACTED_DELTA,
  commitFile,
  setupChangedLinesRepo,
} from "./lib/review-changed-lines-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const HIGH = {
  lens: "SIMPLICITY",
  severity: "HIGH",
  path: "src/a.ts",
  line: 3,
  title: "Hand-typed json fence instead of fenceText",
  reproduction: { command: "bun test", observed: "1 failure" },
} as const;
const LOW = {
  lens: "SIMPLICITY",
  severity: "LOW",
  path: "src/a.ts",
  line: 3,
  title: "Naming drift on the same line",
} as const;

const repo = setupChangedLinesRepo();
try {
  const r1 = await repo.round({ findings: [HIGH, LOW], review: "full", evidence: EVIDENCE });
  if (!r1.ok) {
    assert(false, `round 1 filed both siblings (refused: ${r1.reason})`);
    process.exit(1);
  }
  assert(r1.decisions.length === 2, `one row per sibling (${JSON.stringify(r1.decisions)})`);

  const since = repo.git("rev-parse", "HEAD");
  commitFile(repo, "src/a.ts", FIXED_FILE, "fix: replace the hand-typed fence with fenceText");
  assert(
    repo.git("diff", since, "HEAD", "--", "src/a.ts").includes("-export const b = 2;"),
    "the fix commit rewrote the cited lines",
  );

  const r2 = await repo.round({
    findings: [],
    review: "delta",
    deltaDiff: SUBTRACTED_DELTA,
    deltaSince: since,
    evidence: EVIDENCE,
  });
  if (!r2.ok) {
    assert(false, `round 2 recorded (refused: ${r2.reason})`);
    process.exit(1);
  }
  assert(
    r2.carried.length === 0,
    `the round carries NOTHING (carried: ${r2.carried.map((f) => f.title).join(",") || "none"})`,
  );
  const resolvedTitles = r2.resolved
    .map((n) => n.title)
    .sort()
    .join("|");
  assert(
    resolvedTitles === [HIGH.title, LOW.title].sort().join("|"),
    `BOTH siblings resolve (resolved: ${resolvedTitles || "none"})`,
  );
  // The mutant witness, stated by name so an arm narrowed to the sub-blocking
  // sibling — the observed bug — cannot pass by resolving only the LOW.
  assert(
    r2.resolved.some((n) => n.title === HIGH.title),
    "the HIGH sibling is among the resolved rows (an arm narrowed to CRITICAL reddens here)",
  );
  const rows = await readBranchRows(repo.dir, "feat/x");
  assert(
    rows.length === 2 && rows.every((r) => r.status === "resolved"),
    `both rows are resolved on disk (${rows.map((r) => r.status).join(",")})`,
  );
  process.exit(exit);
} finally {
  repo.cleanup();
}
