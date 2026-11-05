#!/usr/bin/env bun
import type { LensReviewSummary } from "../src/lens-review-format.ts";
/**
 * AC1 (#2027) — a carried row whose cited line a commit of the reviewed delta
 * REWROTE, and which no lens re-reported, resolves with a reason of its own
 * (`code-changed-not-reported`) instead of staying "carried — still open".
 *
 * The observed shape is the automatic delta: the follow-up round reviews
 * `since..head`, whose hunk list `subtractReviewedHunks` built by removing
 * every hunk identical to one the previous round reviewed. The fix commit's own
 * hunk is in that list — so the delta's changed-line ranges do NOT contain the
 * line the row cites, while head shows the cited line rewritten. Step 9's "the
 * round reviewed that line" test then refuses, the row carries forever, and the
 * merge guard keeps refusing a PR whose HIGH was fixed.
 *
 * The union of `git diff since..head` is the evidence the hunk list cannot
 * contradict: it is the range the round reviewed, independent of subtraction.
 * With it the row resolves and stops being carried — while a row the delta left
 * alone is still carried, which is what stops the arm being a blanket resolve.
 */
import { renderSummary } from "../src/lens-review-render.ts";
import { type Finding, isCarried } from "../src/lens-review-types.ts";
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
  // #2040 — a HIGH must carry the reproduction ITS child ran, or the
  // unproven-HIGH cap moves the row to MEDIUM and the carry is not a HIGH.
  reproduction: { command: "bun test", observed: "1 failure" },
} as const;
/** A second, unreported row, so the same round still carries SOMETHING. */
const PROBE = {
  lens: "SIMPLICITY",
  severity: "MEDIUM",
  path: "src/keep.ts",
  line: 1,
  title: "Naming drift on an untouched line",
} as const;

const repo = setupChangedLinesRepo();
try {
  const r1 = await repo.round({ findings: [HIGH, PROBE], review: "full", evidence: EVIDENCE });
  assert(r1.ok === true, `round 1 filed both rows (${r1.ok ? "ok" : r1.reason})`);

  const since = repo.git("rev-parse", "HEAD");
  commitFile(repo, "src/a.ts", FIXED_FILE, "fix: use fenceText");
  assert(
    repo.git("diff", since, "HEAD", "--", "src/a.ts").includes("-export const b = 2;"),
    "a commit of the reviewed delta rewrote the row's cited line",
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
  const carried = r2.carried.map((f) => f.title);
  assert(
    !carried.includes(HIGH.title),
    `the round does not report the row as carried/still open (carried: ${carried.join(",") || "none"})`,
  );
  const notice = r2.resolved.find((n) => n.title === HIGH.title);
  assert(
    notice?.reason === "code-changed-not-reported",
    `the row resolves with its OWN reason (got ${JSON.stringify(notice?.reason)})`,
  );
  assert(
    carried.includes(PROBE.title) && r2.carried.some((f) => isCarried(f as Finding)),
    `the untouched row is still carried — not a blanket resolve (carried: ${carried.join(",") || "none"})`,
  );
  assert(
    (await readBranchRows(repo.dir, "feat/x")).find((r) => r.title === HIGH.title)?.status ===
      "resolved",
    "the row is resolved on disk",
  );

  const summary: LensReviewSummary = {
    verdict: "ISSUES_FOUND",
    lenses: [],
    findings: r2.carried as Finding[],
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0 },
    totalFindings: r2.carried.length,
    resolved: r2.resolved,
  };
  const rendered = renderSummary(summary, 1);
  assert(
    rendered.includes("code-changed-not-reported"),
    "the new reason reaches the operator-facing disclosure verbatim",
  );
  // Cut at the next heading: a title listed under "Resolved" must not satisfy
  // this by being absent from the carried block for the wrong reason.
  const carriedBlock =
    (rendered.split("Carried from earlier rounds")[1] ?? "").split(
      "Resolved since last round",
    )[0] ?? "";
  assert(
    rendered.includes("Carried from earlier rounds (1)") && !carriedBlock.includes(HIGH.title),
    `exactly one row is disclosed as carried, and it is not the retired HIGH (${JSON.stringify(carriedBlock.slice(0, 90))})`,
  );
  process.exit(exit);
} finally {
  repo.cleanup();
}
