#!/usr/bin/env bun
/**
 * Every review seat — the adversarial reviewer and the lenses, on both passes — reads the project-test
 * roster summary off the newest green verify, and a run with no roster reads an explicit "not run" line.
 *
 *  (s) the summary: tests run at head and base, base-failing and newly failing names capped at 50
 *      beside the record's count;
 *  (w) the step's wiring: both seats get it with and without an acceptance table, and on the fix
 *      wave's second pass once a CRITICAL lens round sends a fixer.
 *
 * Real temp repo, stubbed models, no child spawned, no token spent.
 */
import { PROJECT_TESTS_NOT_RUN, projectTestsSection } from "../src/lean/review-roster.ts";
import { type ProjectRosterRecord, ROSTER_NAMES_CAP } from "../src/lean/state-outcome-maps.ts";
import type { Step } from "../src/lean/state.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { ISSUE_BODY, logFor, realFrozen } from "./lib/lean-review-acceptance-fixtures.ts";
import {
  BRANCH,
  blockingFinding,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  lensRoundFor,
  lensRoundWith,
  makeRepo,
  result,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

const { assert, failures } = makeAssert();
isolateLedger();

const baseFailed = Array.from({ length: 60 }, (_, i) => `t::old${String(i)}`);
const ROSTER: ProjectRosterRecord = {
  baseSha: "b".repeat(40),
  files: ["tests/t.py"],
  passed: ["t::a"],
  failed: [...baseFailed, "t::new"],
  baseFailed,
  total: 70,
  baseTotal: 69,
};
const greenWith = (roster?: ProjectRosterRecord): Step[] => [
  {
    key: "1:verify:0",
    state: "verify",
    startedAt: 0,
    outcome: { kind: "green", ...(roster === undefined ? {} : { projectRoster: roster }) },
  },
];

// ── (s) the summary ───────────────────────────────────────────────────────
{
  const s = projectTestsSection(greenWith(ROSTER));
  assert(
    s.includes("Project tests: 70 run at head; 69 at the base commit `bbbbbbbbbbbb`."),
    `(s) the counts are the record's (${s.slice(0, 300)})`,
  );
  assert(
    s.includes("Base-failing (fail at the base too, not charged to this run): 60 — `t::old0`") &&
      s.includes("`t::old49` (+10 more)") &&
      !s.includes("`t::old50`"),
    "(s) base-failing names stop at 50, beside the true count",
  );
  assert(
    s.includes("Newly failing (fail at head, not at the base): 1 — `t::new`"),
    "(s) a head failure the base did not fail is named as newly failing",
  );
  // A full base list cannot say a head failure is new: the name may sit past the record's cut.
  const full = Array.from({ length: ROSTER_NAMES_CAP }, (_, i) => `t::old${String(i)}`);
  const capped = projectTestsSection(
    greenWith({ ...ROSTER, failed: [...full], baseFailed: full, total: 201, baseTotal: 201 }),
  );
  assert(
    capped.includes("Base-failing (fail at the base too, not charged to this run): 200 or more") &&
      capped.includes("Newly failing (fail at head, not at the base): not determinable"),
    `(s) at the record cap the base count is a floor and the comparison is not made (${capped.slice(-200)})`,
  );
  assert(
    projectTestsSection(greenWith()).endsWith(PROJECT_TESTS_NOT_RUN) &&
      projectTestsSection([]).endsWith(PROJECT_TESTS_NOT_RUN),
    "(s) no roster, or no green verify, is an explicit not-run line",
  );
}

// ── (w) both seats, with and without the acceptance table ─────────────────
for (const [label, issueBody, roster, fix] of [
  ["table + roster", ISSUE_BODY, ROSTER, false],
  ["no table, no roster", "", undefined, false],
  ["fix wave", "", ROSTER, true],
] as const) {
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const ctx = ctxFor(repoRoot, baseSha, BRANCH);
  const log = logFor(head, realFrozen(repoRoot, head));
  const verify = log.find((s) => s.state === "verify");
  if (verify?.outcome !== undefined && roster !== undefined) verify.outcome.projectRoster = roster;
  ctx.steps.push(...log);
  const expected = projectTestsSection(ctx.steps);
  const seen: (string | undefined)[] = [];
  const fixSeats: string[] = [];
  const { threw } = await runStep(
    ctx,
    depsWith({
      fetchIssueBody: async () => issueBody,
      prComment: async () => undefined,
      lens: async (a) => {
        seen.push(a.context);
        if (a.wave === "fix" && a.context.includes(expected)) fixSeats.push("lens");
        return fix && a.wave !== "fix"
          ? lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding({ severity: "CRITICAL" })])
          : lensRoundFor({ wave: a.wave, since: a.since, head: a.head }, "APPROVED", []);
      },
      adversarial: async (a) => {
        seen.push(a.acceptanceTable);
        if (a.wave === "fix" && a.acceptanceTable?.includes(expected)) fixSeats.push("adversarial");
        return result({ loopOutcome: "approved" });
      },
      ...(fix ? { dispatch: fixerThatCommits("seats") } : {}),
    }),
  );
  assert(threw === undefined, `(w) ${label}: the step passed (${threw?.message ?? ""})`);
  assert(
    expected.includes(roster === undefined ? PROJECT_TESTS_NOT_RUN : "70 run at head") &&
      seen.length >= 2 &&
      seen.every((t) => t?.includes(expected)),
    `(w) ${label}: every seat reads the roster summary (${String(seen.length)} seats)`,
  );
  if (fix)
    assert(
      fixSeats.includes("lens") && fixSeats.includes("adversarial"),
      `(w) ${label}: the second pass's lens and adversarial seats read it too (${fixSeats.join(",")})`,
    );
}

cleanupRoots();
if (failures() > 0) process.exit(1);
console.log("\nAll lean review roster-seat checks passed.");
