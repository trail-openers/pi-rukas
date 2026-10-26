#!/usr/bin/env bun
/**
 * #1832 — the automatic delta stands down when the branch still holds an open,
 * line-bearing CRITICAL row (or the findings store cannot be read to rule one
 * out), because `rowFate` retires a CRITICAL row ONLY on a complete full
 * review. Without this veto a delta-only follow-up could never retire a fixed
 * CRITICAL, and one such row would hold every later verdict — and the merge
 * guard — blocked.
 *
 * Asserted at the RESOLVER seam (`resolveReviewDiff`), for both caller shapes:
 *   - the `dispatch_lens_review` tool path and the /work lens step both reach the
 *     decision through `runLensReview` with an AUTOMATIC delta (no `since`, no
 *     `full`), which is the arm the veto governs;
 *   - an explicit `since` is an operator instruction and still wins — the probe
 *     is not even consulted for it.
 *
 * Isolation: the ledger fixture pins `PI_ENSEMBLE_REVIEW_LEDGER_FILE`, which also
 * pins the findings file beside it (review-findings-read.ts's fallback spelling),
 * so the probe reads exactly this fixture's store. Fixtures are sequential and
 * each cleans up before the next — two live fixtures would share the process env
 * var and the first's writes would resolve against the second clone.
 *
 * The probe's own behaviour (read-only, three answers, the shared row predicate)
 * is `test-review-findings-critical-probe.ts`; what lives here is the DECISION the
 * probe feeds, including the `forcedFullDetail` that reaches the `Mode:` line.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Finding } from "../src/lens-review-types.ts";
import { recordFindingRunOutcome } from "../src/review-findings-store.ts";
import { cleanup, execp, mkRepo, writeLedger } from "./lib/auto-delta-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const { resolveReviewDiff } = await import("../src/lens-review-diff.ts");
const { forcedFullText } = await import("../src/lens-review-delta-disclose.ts");
import type { ForcedFullReason } from "../src/lens-review-delta-disclose.ts";
const { renderSummary } = await import("../src/lens-review-render.ts");

const branch = "feature/work";

/** A lens ledger entry saying the last recorded run reviewed `headSha`. */
function seededLedger(headSha: string) {
  return [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "CRITICAL_ISSUES_FOUND",
      hasCritical: true,
      headSha,
      round: 1,
    },
  ];
}

/** The findings store path the ledger override pins the store to. */
function findingsFile(ledgerFile: string): string {
  return path.join(path.dirname(ledgerFile), "review-findings.json");
}

const criticalFinding: Finding = {
  lens: "SECURITY",
  severity: "CRITICAL",
  path: "second.txt",
  line: 1,
  title: "Secret committed to the repository",
};

/** Record one round so the store holds a real row (with both hashes). */
async function seedRow(dir: string, head: string, findings: Finding[]) {
  const out = await recordFindingRunOutcome({
    cwd: dir,
    branch,
    headSha: head,
    findings,
    review: "full",
  });
  if (!out.ok) throw new Error(`seed round failed: ${out.reason}`);
}

const opts = (dir: string) => ({ base: "main", head: "feature/work", branch, cwd: dir });

// (1) Automatic delta available, NO open CRITICAL row → the delta applies.
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, seededLedger(r.c1));
  try {
    await seedRow(r.dir, r.c2, [{ ...criticalFinding, severity: "HIGH", title: "Naming" }]);
    const d = await resolveReviewDiff(opts(r.dir));
    assert(
      d.kind === "ok" && d.delta?.since === r.c1 && d.forcedFull === undefined,
      "no open CRITICAL row → the automatic delta still applies (unchanged behaviour)",
    );
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (2) Automatic delta available and an open line-bearing CRITICAL row → the
// delta is vetoed and the round is a full review carrying the marker.
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, seededLedger(r.c1));
  try {
    await seedRow(r.dir, r.c2, [criticalFinding]);
    const file = findingsFile(r.ledgerFile);
    assert(existsSync(file), "fixture: the findings file sits beside the pinned ledger");
    const rows = JSON.parse(readFileSync(file, "utf8")) as {
      rows: Array<{ severity: string; line?: number; lineHash?: string; status: string }>;
    };
    assert(
      rows.rows.length === 1 &&
        rows.rows[0]?.severity === "CRITICAL" &&
        rows.rows[0]?.line !== undefined &&
        rows.rows[0]?.lineHash !== undefined &&
        rows.rows[0]?.status === "open",
      "fixture: the seeded row is open, line-bearing and carries a lineHash",
    );
    const d = await resolveReviewDiff(opts(r.dir));
    assert(
      d.kind === "ok" && d.delta === undefined && d.forcedFull?.kind === "open-critical",
      "an open line-bearing CRITICAL → no delta; a full review marked forced: open-critical",
    );
    if (d.kind === "ok") {
      // The full range, not the delta: the whole-branch diff is what retires the
      // row, so the veto must produce real full coverage rather than a delta
      // wearing a marker.
      const full = (await execp("git diff main...feature/work", { cwd: r.dir })).stdout;
      assert(d.diff === full, "the forced round reviews the whole branch range");
    }
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (3) An unreadable findings store forces a full round too, with its own reason
// AND the cause the probe read, so the operator knows which repair to make.
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, seededLedger(r.c1));
  try {
    await seedRow(r.dir, r.c2, [criticalFinding]);
    writeFileSync(findingsFile(r.ledgerFile), "{ not json");
    const d = await resolveReviewDiff(opts(r.dir));
    assert(
      d.kind === "ok" && d.delta === undefined && d.forcedFull?.kind === "findings-unreadable",
      "an unparseable findings store → forced full (findings-unreadable), never read as absent",
    );
    assert(
      d.kind === "ok" && (d.forcedFullDetail ?? "").includes("JSON"),
      `the forced reason carries WHY the read failed (got ${JSON.stringify(d.kind === "ok" ? d.forcedFullDetail : undefined)})`,
    );
    assert(
      d.kind === "ok" && forcedFullText(d.forcedFull as ForcedFullReason).includes("JSON"),
      "and the Mode: wording includes that cause rather than a generic warning",
    );
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (4) An EXPLICIT `since` is an operator instruction: the veto does not apply,
// even with an open CRITICAL row on the branch.
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, seededLedger(r.c1));
  try {
    await seedRow(r.dir, r.c2, [criticalFinding]);
    const d = await resolveReviewDiff({ ...opts(r.dir), since: r.c1 });
    assert(
      d.kind === "ok" && d.delta?.since === r.c1 && d.forcedFull === undefined,
      "an explicit `since` still wins over the CRITICAL veto (operator instruction)",
    );
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (5) `full: true` is unchanged: no marker, no probe, and no automatic delta was
// in play to veto.
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, seededLedger(r.c1));
  try {
    await seedRow(r.dir, r.c2, [criticalFinding]);
    const d = await resolveReviewDiff({ ...opts(r.dir), full: true });
    assert(
      d.kind === "ok" && d.delta === undefined && d.forcedFull === undefined,
      "explicit `full: true` → an ordinary full review with no forced marker",
    );
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (6) The Mode: line renders both reasons distinctly from an ordinary full
// review and from a delta — reading the summary's OWN `forcedFull` field, not a
// `deltaReview` carrying empty sentinels (#1832 round 1).
{
  const base = {
    verdict: "APPROVED" as const,
    totalFindings: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    lenses: [],
    findings: [],
    usage: undefined,
  };
  const line = (forcedFull?: ForcedFullReason) =>
    renderSummary({ ...base, ...(forcedFull ? { forcedFull } : {}) }, 3)
      .split("\n")
      .find((l) => l.startsWith("Mode:")) ?? "";
  assert(
    line({ kind: "open-critical" }) ===
      `Mode: full review (${forcedFullText({ kind: "open-critical" })})`,
    "Mode: line names the pending-CRITICAL reason verbatim",
  );
  assert(
    line({ kind: "findings-unreadable" }) ===
      `Mode: full review (${forcedFullText({ kind: "findings-unreadable" })})`,
    "Mode: line names the unreadable-store reason verbatim",
  );
  assert(
    line({ kind: "findings-unreadable", detail: "not valid JSON" }) ===
      "Mode: full review (forced: the findings memory could not be read (not valid JSON))",
    "Mode: line includes the read failure's cause when the probe had one",
  );
  assert(line() === "Mode: full review (the whole branch diff)", "ordinary full review unchanged");
  // A delta's Mode: line never mentions a forced full review, and a summary that
  // carries BOTH (never produced today) renders the delta — the range is the
  // load-bearing disclosure.
  const delta =
    renderSummary({ ...base, deltaReview: { since: "a".repeat(40), head: "b".repeat(40) } }, 3)
      .split("\n")
      .find((l) => l.startsWith("Mode:")) ?? "";
  assert(
    delta.startsWith("Mode: delta review since") && !delta.includes("forced"),
    "a delta review still renders its own Mode: line, with no forced-full text",
  );
  assert(
    !renderSummary(
      {
        ...base,
        deltaReview: { since: "a".repeat(40), head: "b".repeat(40) },
        forcedFull: { kind: "open-critical" },
      },
      3,
    )
      .split("\n")
      .some((l) => l.startsWith("Mode:") && l.includes("forced")),
    "a delta outcome never renders the forced reason beside its own range",
  );
}

process.exit(exit);
