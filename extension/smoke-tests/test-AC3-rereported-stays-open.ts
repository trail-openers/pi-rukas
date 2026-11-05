#!/usr/bin/env bun
/**
 * AC3 (#2027) — a carried row that a lens RE-REPORTS in the current round stays
 * open. The re-report is the lenses saying the problem is still there, so the
 * new changed-lines arm must never retire a row the round matched — even when a
 * commit of the delta rewrote the very lines the row cites.
 *
 * The matching itself is the store's (`pickMatch`/`sameIdentity`: path + anchor
 * + title) and is not re-implemented here; what this file pins is the
 * consequence: the round's decision is `matched`, nothing resolves, the row is
 * not carried, and its status on disk is still `open`.
 */
import {
  type FindingRun,
  readBranchRows,
  recordFindingRunOutcome,
} from "../src/review-findings-store.ts";
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

const ROW = {
  lens: "SIMPLICITY",
  severity: "HIGH",
  path: "src/a.ts",
  line: 3,
  title: "Hand-typed json fence instead of fenceText",
  reproduction: { command: "bun test", observed: "1 failure" },
} as const;

const repo = setupChangedLinesRepo();
const round = (o: Omit<FindingRun, "cwd" | "branch" | "headSha">) => repo.round(o);
try {
  const r1 = await round({ findings: [ROW], review: "full", evidence: EVIDENCE });
  assert(r1.ok === true, `round 1 filed the row (${r1.ok ? "ok" : r1.reason})`);

  // A commit of the delta rewrites the cited line, so the new arm's evidence IS
  // present for this row — which is what makes the re-report the thing that has
  // to keep it open.
  const since = repo.git("rev-parse", "HEAD");
  commitFile(repo, "src/a.ts", FIXED_FILE, "fix attempt");
  assert(
    repo.git("diff", since, "HEAD", "--", "src/a.ts").includes("-export const b = 2;"),
    "a commit of the delta rewrote the row's cited line",
  );

  const r2 = await round({
    findings: [ROW],
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
    (r2.decisions ?? []).some((d) => d.action === "matched"),
    `the re-report MATCHES the stored row (${JSON.stringify(r2.decisions ?? [])})`,
  );
  assert(
    (r2.resolved ?? []).length === 0,
    `a re-reported row is not resolved by the changed-lines arm (resolved ${
      (r2.resolved ?? []).map((n) => `${n.title}/${n.reason}`).join(",") || "none"
    })`,
  );
  assert(
    (r2.carried ?? []).length === 0,
    `a re-reported row is this round's own finding, not a carried one (carried ${
      (r2.carried ?? []).map((f) => f.title).join(",") || "none"
    })`,
  );
  const row = (await readBranchRows(repo.dir, "feat/x")).find((r) => r.title === ROW.title);
  assert(row?.status === "open", `the re-reported row stays open (status ${row?.status})`);
  process.exit(exit);
} finally {
  repo.cleanup();
}
