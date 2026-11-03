#!/usr/bin/env bun
/**
 * lean/engine — a review that fixed its head is re-verified before it may land.
 *
 * The defect is a run that could not finish. A review round dispatches a fixer,
 * and `integrate` in `review-git.ts` moves the run's branch onto the fixer's
 * commits and PUSHES them. The table then routed `review + done` straight to
 * `ci`, whose whole contract is that the newest decided `verify`'s `verifiedHead`
 * is the head it observes (`ci.ts`'s `verifiedHead` read and
 * `assertDiskAtVerifiedHead`, both of which throw on any other HEAD). So every
 * run with a review fix round died at exit 10 over a head its own gate had never
 * read, and the pushed fix commits were never verified at all.
 *
 * The fix is one new kind on the step — `fixed`, beside `done` — and one route:
 * `review + fixed` goes to `verify` on a plain move that spends no build attempt.
 * These cases drive the REAL engine over the REAL table, because the claim is about
 * a walk — verify → publish → review → verify → publish → ci → land — and a table
 * test can only assert one arrow at a time.
 *
 * The kind is asserted on the durable record too, not just on the route: the log is
 * what `fixedFromLog` reads, so a run that resumes a crashed review takes the same
 * edge its crashed self would have.
 */

import { runLean } from "../src/lean/engine.ts";
import type { LeanState, Outcome } from "../src/lean/state.ts";
import { loadRun } from "../src/lean/state.ts";
import {
  FIXTURE_BASE_SHA,
  HAPPY,
  makeAssert,
  scripted,
  tempDir,
  ticking,
} from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/** A fresh queue per drive: `scripted` drains the arrays it was given. */
function plan(over: Partial<Record<LeanState, Outcome[]>> = {}): Partial<
  Record<LeanState, Outcome[]>
> {
  return { ...structuredClone(HAPPY), ...structuredClone(over) };
}

/** Drive one issue with `plan`, and hand back the run plus what each handler cost. */
async function drive(issue: number, over: Partial<Record<LeanState, Outcome[]>> = {}) {
  const { dir, cleanup } = tempDir();
  const { handlers, calls } = scripted(plan(over));
  const result = await runLean({
    repoRoot: dir,
    issue,
    handlers,
    now: ticking().now,
    seed: { version: "test", baseSha: FIXTURE_BASE_SHA, branch: `feature/issue-${issue}` },
  });
  const stored = loadRun(dir, issue);
  cleanup();
  return { result, calls, stored };
}

// ── (a) a review that fixed its head re-verifies, and still lands ───────────
{
  const { result, calls, stored } = await drive(40, {
    // Two verifies: the one before the review, and the one the moved head earns.
    verify: [{ kind: "green" }, { kind: "green" }],
    // Two publishes: the moved head's re-verify has to reach the forge again, and
    // the SECOND one must go to `ci` rather than back through the six lenses.
    publish: [{ kind: "ok" }, { kind: "ok" }],
    // The step's own report: a fix round integrated and pushed.
    review: [{ kind: "fixed" }],
  });
  assert(
    result.code === 0 && result.state === "landed",
    `(a) a run whose review fixed its head still lands (${result.state}, exit ${String(result.code)})`,
  );
  assert(
    calls.verify === 2,
    `(a) and it was VERIFIED twice — once before the review and once after the fix moved the head, which is what ci needs to observe (got ${String(calls.verify)})`,
  );
  assert(
    calls.publish === 2,
    `(a) and it published twice, the second time onto the head the re-verify certified (got ${String(calls.publish)})`,
  );
  assert(
    calls.review === 1,
    `(a) and it was reviewed exactly ONCE — the second publish goes to ci, so the run cannot loop review (got ${String(calls.review)})`,
  );
  assert(
    calls.ci === 1 && calls.land === 1,
    `(a) with one ci and one land after the re-verification (ci ${String(calls.ci)}, land ${String(calls.land)})`,
  );
  // The re-verification is not a build round, and the run must not be charged for
  // one: a route that went `viaBuild` would spend the attempts a later red verify
  // needs and could publish a draft out of a run that had every right to land.
  assert(
    stored?.counters.buildAttempts === 1,
    `(a) and the re-verify cost NO build attempt of its own: the single attempt on the record is the challenge round from before the review — an edge that went viaBuild would leave TWO (got ${String(stored?.counters.buildAttempts)})`,
  );
  const log = (stored?.steps ?? []).map((s) => `${s.state}:${s.outcome?.kind ?? "pending"}`);
  const reviewAt = log.indexOf("review:fixed");
  assert(
    reviewAt >= 0 && log.slice(reviewAt + 1).indexOf("verify:green") >= 0,
    `(a) and the LOG says it: a green verify follows the review that moved the head (${log.join(" → ")})`,
  );
  assert(
    stored?.counters.reviewDone === true,
    `(a) and the review round stays spent on the durable record (reviewDone=${String(stored?.counters.reviewDone)})`,
  );
}

// ── (b) a clean review keeps its direct edge to ci ───────────────────────────
{
  const { result, calls } = await drive(41);
  assert(
    result.code === 0 && result.state === "landed",
    `(b) a run whose review fixed nothing still lands (${result.state}, exit ${String(result.code)})`,
  );
  assert(
    calls.verify === 1 && calls.publish === 1,
    `(b) and it did NOT pay for a re-verification it did not need (verify ${String(calls.verify)}, publish ${String(calls.publish)})`,
  );
  assert(
    calls.ci === 1 && calls.land === 1,
    `(b) with the ordinary one review → one ci → one land (ci ${String(calls.ci)}, land ${String(calls.land)})`,
  );
}

// ── (c) the flag survives the durable record, so a resume takes the same edge ─
//
// The engine drives from the step log, and `state.ts` is explicit that the
// snapshot counters are a cache. So the fact that decides this route has to live
// on the step's outcome and come back through the loader's validator — a field
// the loader silently dropped would resume a crashed review straight into `ci`.
{
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = scripted(
      plan({ review: [{ kind: "fixed", reason: "fixed and pushed" }] }),
    );
    await runLean({
      repoRoot: dir,
      issue: 42,
      handlers,
      now: ticking().now,
      seed: { version: "test", baseSha: FIXTURE_BASE_SHA, branch: "feature/issue-42" },
    });
    const stored = loadRun(dir, 42);
    const review = (stored?.steps ?? []).find((s) => s.state === "review");
    assert(
      review?.outcome?.kind === "fixed",
      `(c) the kind is on the PERSISTED review outcome, which is what a resume reads its own verdict from (got ${String(review?.outcome?.kind)})`,
    );
    assert(
      stored?.steps.some((s) => s.state === "verify") === true &&
        stored?.steps.filter((s) => s.state === "verify").length === 2,
      `(c) and the loaded log holds the two verifies the route produced (${String(stored?.steps.filter((s) => s.state === "verify").length)})`,
    );
  } finally {
    cleanup();
  }
}

// ── (d) a re-verify that comes back red is still bounded ────────────────────
//
// The moved head routes to `verify`, and a red there must not open a loop. The
// table's red arm is what it always was — one more build round, then handback —
// and the run must not spin between review and verify buying a fixer each pass.
{
  const { result, calls } = await drive(43, {
    verify: [{ kind: "green" }, { kind: "red" }, { kind: "red" }, { kind: "red" }],
    build: [{ kind: "ok" }, { kind: "ok" }, { kind: "ok" }, { kind: "ok" }],
    challenge: [{ kind: "none" }, { kind: "none" }, { kind: "none" }],
    publish: [{ kind: "ok" }, { kind: "ok" }, { kind: "ok" }],
    review: [{ kind: "fixed" }],
  });
  assert(
    result.state === "handed-back",
    `(d) a run whose re-verify turns red ends handed-back rather than looping (${result.state}, exit ${String(result.code)})`,
  );
  assert(
    calls.review === 1,
    `(d) and the six lenses were bought once, whatever the re-verification said (got ${String(calls.review)})`,
  );
}

process.exit(failures());
