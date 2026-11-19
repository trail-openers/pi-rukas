/**
 * lib/lean-ci-gl-readiness — the `ci` step's GitLab readiness cases, driven
 * through the same recorder `test-lean-ci-gl.ts` uses.
 *
 * Split out for the §12 size cap along the seam the file already had: everything
 * here asks what the step does with a COMPOSED readiness, and nothing in it is
 * about job-row grading. It is imported (not run as its own entry point) so its
 * failures join the parent suite's exit code — a separate process would let the
 * parent report green with the readiness cases red, which is the one shape a
 * gate must not have.
 *
 * The defect these cases are the regression for: the readiness table in
 * `forge-merge.ts` carried GitHub-shaped names (`can_be_merged`, `blocked_by_*`)
 * that GitLab has never emitted, so the one value a ready MR really answers with
 * — `mergeable` — fell through to the fail-closed arm and `ci` died with an
 * infrastructure throw on an MR whose pipeline was green. The assertion here is
 * therefore not "the composition returns CLEAN" (the table suite pins that
 * value-by-value) but "the step gets past `ci`": green is what `land` routes on.
 *
 * Three things the cases pin, in order:
 *   1. `mergeable` with a passing pipeline reaches the green `ci` never reached
 *      before, on glab argv only, with the tier run once;
 *   2. every value the composition calls UNKNOWN is waited on the poll's bound —
 *      not only `checking`, the one word the pre-fix retry knew — and each still
 *      runs the tier exactly once when it resolves;
 *   3. the single-MR reply, which has never carried `approvals_left`, is read as
 *      ready — requiring that key is what made every real MR fail closed at `ci`;
 *   4. a red job row outranks an UNKNOWN readiness: the rows are evidence about
 *      this commit and have already answered, while the readiness only says the
 *      forge has not finished deciding, so waiting on it would burn the `ci`
 *      budget on a build that is already red.
 */
import type { CiCase, Ran } from "./lean-ci-recorder.ts";

/** The `run` the parent suite drives the recorder with. */
type Run = (c: CiCase) => Promise<Ran>;
/** The parent's assertion runner, so these cases report through its exit code. */
type Assert = (cond: boolean, msg: string) => void;
/** The parent's GitLab job-row builder. */
type Job = (status: string, name?: string) => Record<string, unknown>;

/**
 * Run every readiness case, returning whether any failed.
 *
 * `glMrChecking(head, status)` is how a case says what the forge reports on the
 * first read, and the recorder's `mrAtReads` sequence lets the second read
 * report `mergeable` — the poll's whole point is that a status which resolves
 * becomes a green rather than an expired wait.
 */
export async function runReadinessCases(
  assert: Assert,
  run: Run,
  glMrChecking: (head: string, status?: string) => Record<string, unknown>,
  job: Job,
): Promise<boolean> {
  let failed = false;
  const want = (cond: boolean, msg: string): void => {
    if (!cond) failed = true;
    assert(cond, msg);
  };

  // (g4b) the ready MR's value, end to end through the step.
  const mr = await run({ full: "true", forge: "gitlab", mr: glMrMergeableRow });
  want(
    mr.threw === undefined,
    `(g4b) a mergeable MR with a passing pipeline is a verdict, not an infra throw (${String(mr.threw?.message)})`,
  );
  want(
    mr.outcome?.kind === "green",
    `(g4b) and ci is green on it (${JSON.stringify(mr.outcome ?? mr.threw?.message)})`,
  );
  want(mr.tierRuns === 1, `(g4b) and the full tier ran exactly once (${String(mr.tierRuns)})`);
  want(
    !mr.cmds.some((c) => c.startsWith("gh ")),
    `(g4b) and the whole step stayed on glab (${JSON.stringify(mr.cmds.filter((c) => c.startsWith("gh ")))})`,
  );

  const r = await run({
    full: "true",
    forge: "gitlab",
    mr: glMrMergeableRowNoApprovals,
  });
  want(
    r.threw === undefined,
    `(g4c) an MR reply with no approvals_left is a verdict, not an infra throw (${String(r.threw?.message)})`,
  );
  want(
    r.outcome?.kind === "green",
    `(g4c) and ci is green on it — the single-MR reply has never carried that field (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  want(r.tierRuns === 1, `(g4c) and the full tier ran exactly once (${String(r.tierRuns)})`);

  // (g4b) every UNKNOWN value is waited, not just `checking`.
  for (const status of ["unchecked", "preparing", "approvals_syncing", "ci_still_running"]) {
    const r = await run({
      full: "true",
      forge: "gitlab",
      clockMs: 0,
      waitTimeoutMs: 120_000,
      mrAtReads: (head) => [glMrChecking(head, status), undefined],
    });
    want(
      r.outcome?.kind === "green",
      `(g4b) "${status}" is waited, then green (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
    );
    want(
      r.slept.length === 1 && r.slept[0] === 60_000,
      `(g4b) "${status}" waited exactly one poll (${JSON.stringify(r.slept)})`,
    );
    want(
      r.tierRuns === 1,
      `(g4b) and "${status}" still ran the tier exactly once (${String(r.tierRuns)})`,
    );
  }

  // (g4b) a red row is a verdict the poll takes immediately.
  const red = await run({
    full: "true",
    forge: "gitlab",
    jobs: [job("success", "build"), job("failed", "test")],
    clockMs: 0,
    waitTimeoutMs: 120_000,
    mrAtReads: (head) => [glMrChecking(head, "ci_still_running"), undefined],
  });
  want(
    red.outcome?.kind === "red",
    `(g4b) a red job is red while the readiness is still UNKNOWN (${JSON.stringify(red.outcome ?? red.threw?.message)})`,
  );
  want(
    (red.outcome?.reason ?? "").includes("test"),
    `(g4b) and the red names the failed job (${red.outcome?.reason})`,
  );
  want(
    red.slept.length === 0,
    `(g4b) and it did not wait out the budget on the readiness (${JSON.stringify(red.slept)})`,
  );

  return failed;
}

/** The MR row of an MR GitLab itself calls mergeable: the value a ready MR
 *  answers with, at the head the case's repo holds. */
function glMrMergeableRow(head: string): Record<string, unknown> {
  return {
    iid: 77,
    state: "opened",
    detailed_merge_status: "mergeable",
    has_conflicts: false,
    blocking_discussions_resolved: true,
    approvals_left: 0,
    diff_refs: { head_sha: head },
    open_pipeline: { id: 5001, status: "success" },
  };
}

/** The MR row exactly as `glab mr view` answers it for a ready MR: no
 *  `approvals_left`, because the single-MR endpoint has never carried that
 *  number (it lives on `/merge_requests/:iid/approvals`). Requiring it is the
 *  defect that made every real GitLab MR fail closed at `ci`. */
function glMrMergeableRowNoApprovals(head: string): Record<string, unknown> {
  const { approvals_left: _approvals, ...rest } = glMrMergeableRow(head);
  return rest;
}
