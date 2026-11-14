#!/usr/bin/env bun
/**
 * The fail-closed publish guard is reached through ALL THREE force-push callers.
 *
 * `assertPublishableBranch` is shared by `publish`, the review step's fix push and
 * the verified handback's rewind. Giving the guard an exec parameter proves
 * nothing on its own: two of the three callers could go on calling it with the
 * module's own executor and every guard-level case would still pass, because the
 * guard would answer its probes from a seam no case can see. So each caller is
 * driven here, and each case asserts on the recorder THAT caller's exec is — which
 * is also what R5 asks for.
 *
 * Each driver sets the premise that makes its "no push" mean something: the run's
 * branch is lean, its head is real and reachable on origin, and everything that is
 * not a probe is forwarded to the real executor. See
 * `lib/lean-guard-fail-closed-callers.ts` for what each driver builds.
 *
 *   (p1) publish: probes refuse → PublishInfraError, no push, origin's branch absent.
 *   (p2) publish: origin answers main → the run publishes (the fixture clone's
 *        `origin/HEAD` is the arm the suite relies on, and this says so).
 *   (r1) review: probes refuse → ReviewInfraError naming the refusal, NO child
 *        dispatched, no push argv, no mutating git call.
 *   (r2) review: origin answers with the run's own branch → refused by the mainline
 *        rule, nothing pushed.
 *   (h1) rewind: probes refuse → `shipped: false` naming the refusal, origin unmoved.
 *   (h2) rewind: origin answers main → the rewind lands (a legitimate rewind is not
 *        collateral damage of the fix).
 *
 * Run: cd extension && bun run smoke-tests/test-lean-guard-fail-closed-callers.ts
 */

import { unverifiedRef } from "../src/lean/handback-rewind.ts";
import { PublishInfraError } from "../src/lean/publish-deps.ts";
import { ReviewInfraError } from "../src/lean/review-errors.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  GUARD_PROBES,
  PROBE_CAUSE,
  drivePublish,
  driveReview,
  driveRewind,
} from "./lib/lean-guard-fail-closed-callers.ts";
import { BRANCH } from "./lib/lean-review-fixtures.ts";
import { BRANCH as HANDBACK_BRANCH } from "./lib/lean-verified-handback-fixture.ts";
import { originBranchSha, originRefSha } from "./lib/lean-verified-handback-repo.ts";

const { assert, failures } = makeAssert();

/** The publish driver's run branch — a real lean name, so the guard's only reason is the mainline. */
const RUN_BRANCH = "lean/issue-7";

/**
 * Did every probe the guard is allowed to make reach this seam?
 *
 * Asserted against `GUARD_PROBES` — production's own list — rather than a copy
 * written here: the tally is the evidence that a refusal came from probes that were
 * asked and answered "nothing", and a copy that drifted from the real command lines
 * would quietly make the claim vacuous.
 */
function askedAllProbes(probes: string[]): boolean {
  return GUARD_PROBES.every((p) => probes.includes(p));
}

// ── (p1) PUBLISH: nothing answers, so nothing is pushed ────────────────────
{
  const d = await drivePublish({ branch: RUN_BRANCH, arm: "dead" });
  assert(
    d.threw instanceof PublishInfraError,
    `(p1) publish refuses a branch whose mainline no probe will name (${d.threw?.name}: ${d.threw?.message})`,
  );
  assert(
    (d.threw?.message ?? "").includes(RUN_BRANCH),
    `(p1) the refusal names the branch it refused (${String(d.threw?.message)})`,
  );
  assert(
    (d.threw?.message ?? "").includes(PROBE_CAUSE),
    `(p1) the refusal quotes the probe's cause, so the handoff can say which probe failed (${String(d.threw?.message)})`,
  );
  assert(
    askedAllProbes(d.probes),
    `(p1) the guard's probes reached PUBLISH's own exec seam — not a module-level executor (${JSON.stringify(d.probes)})`,
  );
  assert(
    d.pushed.length === 0,
    `(p1) and no push argv reached the executor (${JSON.stringify(d.pushed)})`,
  );
  assert(
    d.originBranch === "",
    `(p1) origin's run branch is still absent — the refused push wrote nothing (${d.originBranch})`,
  );
}

// ── (p2) PUBLISH: origin answers, so the legitimate run publishes ──────────
//
// The fixture's clone reads its own `origin/HEAD`, so no probe is expected on the
// ordinary arm. This drives the OTHER legitimate arm — the one R2 exists for, where
// the local probes cannot answer and origin does.
{
  const d = await drivePublish({ branch: RUN_BRANCH, arm: "origin", symref: "main" });
  assert(
    d.threw === undefined,
    `(p2) a legitimate lean publish goes through when origin says its HEAD is main (${d.threw?.name}: ${d.threw?.message})`,
  );
  assert(
    d.originBranch === d.head,
    `(p2) and origin's run branch holds the head the green certified (${d.originBranch} vs ${d.head})`,
  );
  assert(
    askedAllProbes(d.probes),
    `(p2) the run was passed by an ANSWERED origin probe, not by probes nobody answered (${JSON.stringify(d.probes)})`,
  );
  assert(
    d.forgeCalls === 1,
    `(p2) and the step went on to open its PR (${String(d.forgeCalls)} prCreate calls)`,
  );
}

// ── (r1) REVIEW: nothing answers, and the step pays nobody ─────────────────
{
  const d = await driveReview({ branch: BRANCH, arm: "dead" });
  assert(
    d.threw instanceof ReviewInfraError,
    `(r1) review refuses at its entry gate when no probe answers (${d.threw?.name}: ${d.threw?.message})`,
  );
  assert(
    (d.threw?.message ?? "").includes(PROBE_CAUSE),
    `(r1) the review's re-wrapped refusal still carries the probe's cause (${String(d.threw?.message)})`,
  );
  assert(
    askedAllProbes(d.probes),
    `(r1) the guard's probes reached REVIEW's own exec seam, through assertReviewEntry (${JSON.stringify(d.probes)})`,
  );
  assert(
    d.pushed.length === 0,
    `(r1) and no push argv reached the executor (${JSON.stringify(d.pushed)})`,
  );
  // The placement, observed rather than asserted: the entry gate sits ahead of the
  // gates and the fixer, so a refused run buys no child and touches no tree.
  assert(
    d.dispatches === 0,
    `(r1) and no child was dispatched — the refusal is before the step pays for anything (${String(d.dispatches)})`,
  );
}

// ── (r2) REVIEW: origin's HEAD IS the run's branch ─────────────────────────
//
// The run branch here is not the fixture's default: `main` is the one name the
// step's own branches can never take, so this drives the case where the guard's
// probe answers with the very branch the step is about to force-push. The premise
// is read back off origin, not asserted blind: if the head were not reachable the
// step could not have pushed it and the case would be watching nothing.
{
  const RUN = "lean/issue-7";
  const d = await driveReview({
    branch: RUN,
    arm: "origin",
    symref: "lean/issue-7",
    originHead: RUN,
  });
  assert(
    d.head !== "",
    `(r2) premise — the run has a real head to push, so a guard that passed had a write to make (${d.head})`,
  );
  assert(
    d.threw instanceof ReviewInfraError,
    `(r2) review refuses a run whose branch is what origin calls HEAD (${d.threw?.name}: ${d.threw?.message})`,
  );
  assert(
    /mainline/.test(d.threw?.message ?? ""),
    `(r2) and the cause is the mainline rule's own sentence (${String(d.threw?.message)})`,
  );
  assert(
    d.threw instanceof PublishInfraError || !/no change/.test(d.threw?.message ?? ""),
    `(r2) the refusal is the GUARD's, not a downstream symptom of a step that ran on (${String(d.threw?.message)})`,
  );
  assert(
    d.pushed.length === 0,
    `(r2) and no push argv reached the executor (${JSON.stringify(d.pushed)})`,
  );
  assert(d.dispatches === 0, `(r2) with nobody dispatched (${String(d.dispatches)})`);
  assert(
    d.probes.includes(GUARD_PROBES[2]),
    `(r2) the origin probe was asked, so the refusal rests on an ANSWER, not on probes nobody answered (${JSON.stringify(d.probes)})`,
  );
}

// ── (h1) REWIND: nothing answers, so nothing moves ─────────────────────────
{
  const d = await driveRewind({ arm: "dead" });
  assert(
    d.rewind.shipped === false,
    `(h1) a rewind whose mainline no probe will name ships nothing (${JSON.stringify([d.rewind.shipped, d.rewind.reason])})`,
  );
  assert(
    (d.rewind.reason ?? "").includes(PROBE_CAUSE),
    `(h1) and the record carries the probe's cause into the handback comment (${String(d.rewind.reason)})`,
  );
  assert(
    askedAllProbes(d.probes),
    `(h1) the guard's probes reached the REWIND's own exec seam (${JSON.stringify(d.probes)})`,
  );
  assert(
    d.pushed.length === 0,
    `(h1) and the rewind attempted no push (${JSON.stringify(d.pushed)})`,
  );
  // Origin is read twice over the same drive: once by the rig itself (which refuses
  // to hand back a repo whose branch does not hold the fix head) and once here,
  // AFTER the refusal. Both readings are `ls-remote` against the same bare repo, so
  // "the refusal moved nothing" is the comparison of two observations and not a
  // reading of one. `d.head` is the head the rig pushed and `d.verifiedHead` the one
  // a rewind that had passed would have moved the branch to.
  assert(
    d.originHeldBefore === d.head &&
      d.originBranch === d.head &&
      d.head !== "" &&
      d.head !== d.verifiedHead,
    `(h1) origin's branch holds the head the run pushed both before and after — the refused rewind moved nothing (before=${String(d.originHeldBefore)} after=${d.originBranch} head=${d.head} verified=${d.verifiedHead})`,
  );
  // A refused rewind writes no keeping-ref either: a record that says nothing moved
  // while origin carries a `refs/lean/unverified/…` row is the partial-failure shape
  // the rewind's own atomic push exists to forbid.
  assert(
    originRefSha(d.origin, unverifiedRef(2242)) === undefined,
    `(h1) and a refused rewind wrote no keeping-ref (${String(originRefSha(d.origin, unverifiedRef(2242)))})`,
  );
}

// ── (h2) REWIND: origin answers main, so the legitimate rewind lands ───────
{
  const d = await driveRewind({ arm: "origin", symref: "main" });
  assert(
    d.rewind.shipped === true && d.head !== "",
    `(h2) a legitimate rewind still ships when origin answers the symref probe (${JSON.stringify([d.rewind.shipped, d.rewind.reason])})`,
  );
  assert(
    d.originBranch === d.verifiedHead,
    `(h2) and origin's branch now holds the verified head (${d.originBranch} vs ${d.verifiedHead})`,
  );
  assert(
    askedAllProbes(d.probes),
    `(h2) the rewind landed on an ANSWERED origin probe rather than on a probe nobody answered (${JSON.stringify(d.probes)})`,
  );
}

console.log(
  `\n${failures() === 0 ? "callers green" : "callers RED"} (${String(failures())} failing)`,
);
process.exit(failures());
