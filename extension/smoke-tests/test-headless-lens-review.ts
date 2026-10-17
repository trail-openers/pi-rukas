#!/usr/bin/env bun
/**
 * Headless S6 (#1021) — `pi-rukas-headless lens-review` maps the review's
 * verdict to the exit code, with the round budget and the review stubbed (no
 * lens child, no ledger write):
 *
 *   APPROVED → 0 · ISSUES_FOUND → 10 · CRITICAL_ISSUES_FOUND → 20
 *   REVIEW_INCOMPLETE → 30 · an empty delta (noReview) → 0 with "noReview": true
 *   a refused round (ROUND_CAP_REACHED) → 40, the review never ran
 *   bad arguments → 40
 *
 * Also pinned: the review runs in the repo root on the headless host with the
 * --base/--head range, and an admitted round is released.
 */

import type { LensReviewSummary, Verdict } from "../src/lens-review-format.ts";
import { type LensReviewSeams, runLensReviewVerb } from "../src/headless/lens-review.ts";
import { makeAssert, runVerb } from "./headless-verb-harness.ts";

const { assert, state } = makeAssert();
const REPO = "/tmp/headless-lens-review-repo";

function summary(verdict: Verdict, extra: Partial<LensReviewSummary> = {}): LensReviewSummary {
  const findings =
    verdict === "ISSUES_FOUND"
      ? [{ lens: "correctness", severity: "MEDIUM", title: "off by one", path: "a.ts", line: 3 }]
      : [];
  return {
    verdict,
    totalFindings: findings.length,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: findings.length, LOW: 0 },
    lenses: [],
    findings: findings as never,
    ...extra,
  };
}

let next: LensReviewSummary = summary("APPROVED");
let ran: Record<string, unknown>[] = [];
let released = 0;
let admitted = true;
const seams: LensReviewSeams = {
  admit: (async () =>
    admitted
      ? {
          admitted: true,
          overrideCap: false,
          key: "branch:feature/x",
          release: async () => {
            released++;
            return undefined;
          },
        }
      : { admitted: false, refusal: summary("ROUND_CAP_REACHED") }) as never,
  run: (async (opts: Record<string, unknown>) => {
    ran.push(opts);
    return next;
  }) as never,
};
const lens = (argv: readonly string[], ctx: Parameters<typeof runLensReviewVerb>[1]) =>
  runLensReviewVerb(argv, ctx, seams);

const cases: [string, LensReviewSummary, number][] = [
  ["APPROVED", summary("APPROVED"), 0],
  ["ISSUES_FOUND", summary("ISSUES_FOUND"), 10],
  ["CRITICAL_ISSUES_FOUND", summary("CRITICAL_ISSUES_FOUND"), 20],
  ["REVIEW_INCOMPLETE", summary("REVIEW_INCOMPLETE"), 30],
];
for (const [name, s, code] of cases) {
  next = s;
  ran = [];
  released = 0;
  const r = await runVerb(
    "lens-review",
    ["--base", "main", "--head", "feature/x", "--json"],
    REPO,
    lens,
  );
  assert(r.violations.length === 0, `${name}: output contract (${r.violations.join("; ")})`);
  assert(r.code === code, `${name} exits ${code} (got ${r.code})`);
  assert(r.doc.verdict === name && r.doc.noReview === false, `${name}: verdict in the JSON`);
  assert(released === 1, `${name}: the admitted round was released`);
}
{
  const opts = ran[0] ?? {};
  assert(
    opts.cwd === REPO && opts.base === "main" && opts.head === "feature/x",
    "review range and cwd",
  );
  assert(
    typeof (opts.pi as { sendUserMessage?: unknown })?.sendUserMessage === "function",
    "review runs on the headless host",
  );
}

{
  next = summary("ISSUES_FOUND");
  const r = await runVerb("lens-review", [], REPO, lens);
  const f = r.doc.findings as { title: string }[];
  assert(
    r.doc.totalFindings === 1 && f[0]?.title === "off by one",
    "ISSUES_FOUND: findings carried",
  );
}

{
  next = summary("APPROVED", { noReview: true, deltaReview: { since: "abc", head: "def" } });
  const r = await runVerb("lens-review", [], REPO, lens);
  assert(r.violations.length === 0, `no review: output contract (${r.violations.join("; ")})`);
  assert(
    r.code === 0 && r.doc.noReview === true,
    `an empty delta exits 0 with noReview (got ${r.code})`,
  );
}

{
  admitted = false;
  ran = [];
  const r = await runVerb("lens-review", [], REPO, lens);
  assert(r.code === 40 && r.doc.verdict === "ROUND_CAP_REACHED", "a refused round exits 40");
  assert(ran.length === 0, "a refused round never runs the review");
  admitted = true;
}

for (const argv of [["--base", "main"], ["--pr", "x"], ["extra"], ["--merge"]]) {
  ran = [];
  const r = await runVerb("lens-review", argv, REPO, lens);
  assert(
    r.code === 40 &&
      (r.doc.error as { code?: string })?.code === "bad-arguments" &&
      ran.length === 0,
    `bad arguments [${argv.join(" ")}] → 40, nothing reviewed`,
  );
}

process.exit(state.exit);
