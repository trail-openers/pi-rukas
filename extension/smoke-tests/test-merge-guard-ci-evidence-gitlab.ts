#!/usr/bin/env bun
/**
 * #2226 — the merge guard's GitLab arm: a glab merge now answers to the same CI
 * gate a gh merge does.
 *
 * `refuseUnlessCiGreen` used to open with `if (forge !== "github") return
 * undefined`, so a `glab mr merge` cleared every ledger gate and reached `glab`
 * without a single check read: an MR whose pipeline had concluded `failed`
 * merged. The driver's in-process path already refused it; the `tool_call` hook
 * did not, which is the same hole #2106 closed on GitHub, on the other forge.
 *
 * So the arms here are the GitHub matrix's mirror, driven through the REAL
 * `registerMergeGuard` hook (`hookDecision`), with the gatherer's GitLab reads
 * answered by the harness. Two things each arm pins: the VERDICT (a red MR is
 * refused, a green one is allowed), and that the guard ASKED — the argv canary
 * at the bottom, without which every verdict arm could be satisfied by a guard
 * that refused for a reason it invented.
 */

import {
  mergeEvidenceGlJobsCmd,
  mergeEvidenceGlJobsPage2Cmd,
  mergeEvidenceGlMrCmd,
  mergeEvidenceGlPipelinesCmd,
} from "../src/forge-commands-gl-evidence.ts";
import { widenOid } from "./merge-guard-forge-fixture.ts";
import {
  assert,
  GOOD_ENTRIES,
  TARGET,
  exit,
  hookDecision,
  setupLedgerPath,
  teardownLedger,
} from "./merge-guard-helpers.ts";

await setupLedgerPath();

/** The GitLab twin of the shared GitHub `TARGET`. */
const GL_TARGET = { ...TARGET, forge: "gitlab" as const };

/** The head the guard fetches, widens, and pins the verdict to. */
const VERIFIED = widenOid("abc123");

/** One job row, the shape `glab api …/jobs` gives (`allow_failure` is on every row). */
const job = (name: string, status: string, allowFailure = false) => ({
  name,
  status,
  allow_failure: allowFailure,
});
const jobs = (...rows: Array<{ name: string; status: string; allow_failure: boolean }>) =>
  JSON.stringify(rows);

const MR_COMMAND = "glab mr merge 12 --auto-merge=false";

// ---------------------------------------------------------------- a red MR
{
  // The regression this issue exists for: the ledger rows pass, the pipeline
  // did not. Red on main, where the guard answered `undefined` for any forge
  // that was not GitHub and never asked glab anything at all.
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: jobs(job("build", "success"), job("test", "failed")),
  });
  assert(r.block === true, `#2226: a passing ledger with a failed job is refused (${r.reason})`);
  assert(/test/.test(r.reason ?? ""), `…naming the job that failed (${r.reason})`);
  assert(/failing/i.test(r.reason ?? ""), "…naming its state, not just its name");
}

// ---------------------------------------------------------------- pending
{
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: jobs(job("build", "running")),
  });
  assert(r.block === true, "#2226: a still-running job is refused (no merging behind a queue)");
  assert(/running/i.test(r.reason ?? ""), `…quoting the gatherer's own sentence (${r.reason})`);
}

// ------------------------------------------------ skipped / manual are not green
for (const status of ["skipped", "manual"]) {
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: jobs(job("release", status)),
  });
  assert(
    r.block === true,
    `#2226: a job reported \`${status}\` is refused (GitLab does not count it against the pipeline; this guard does not count it as passing)`,
  );
  assert(/release/.test(r.reason ?? ""), `…naming the \`${status}\` job (${r.reason})`);
}

// ------------------------------ an allow-failure job is not a refusal (finding 1)
{
  // The pilot-parking shape this gate exists to remove: gitlab-org/gitlab
  // !270470's successful pipeline carries a `manual` `benchmark-markdown` with
  // `allow_failure: true`. GitLab's own commit-status machine counts that job as
  // terminal-and-non-failing, so an MR GitLab calls green merged — and a guard
  // that refused it reintroduced the very pilot stall #2226 was opened for.
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: jobs(
      job("build", "success"),
      job("benchmark-markdown", "manual", true),
      job("deploy-production", "skipped", true),
    ),
  });
  assert(
    r.block === false,
    `#2226: an allow_failure manual/skipped job does not refuse a green MR (${r.reason})`,
  );
}
for (const status of ["skipped", "manual"]) {
  for (const [label, row] of [
    ["false", { name: "release", status, allow_failure: false }],
    // A row that did not answer the question is not a row that answered
    // "allowed", so an absent field keeps the refusal.
    ["absent", { name: "release", status }],
  ] as const) {
    const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
      target: GL_TARGET,
      glJobs: JSON.stringify([{ name: "build", status: "success" }, row]),
    });
    assert(
      r.block === true && new RegExp(status).test(r.reason ?? ""),
      `#2226: a \`${status}\` job with allow_failure ${label} still refuses (${r.reason})`,
    );
  }
}
{
  // The exemption is `allow_failure`, not "manual is fine": a job that actually
  // ran and failed said something negative about the code.
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: jobs(job("build", "success"), job("e2e", "failed", true)),
  });
  assert(
    r.block === true && /e2e/.test(r.reason ?? ""),
    `#2226: an allow_failure \`failed\` job still refuses, naming the job (${r.reason})`,
  );
}

// ------------------- the jobs graded are the HEAD pipeline's, not the newest's
{
  // The gatherer follows the MR row's `head_pipeline`. On a real MR the
  // pipelines list can lead with a train/auto-deploy pipeline for another
  // commit, and grading that one's rows is a verdict about a different commit.
  // The harness derives both the MR row and the pipelines row from the fetched
  // head, so the green answer here is the join holding.
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: jobs(job("build", "success")),
  });
  assert(r.block === false, `#2226: the head pipeline's jobs are readable and green (${r.reason})`);
}
{
  // Its mirror: an MR whose pipelines list does not contain the head pipeline
  // the MR row names is two server rows disagreeing, and the guard refuses
  // rather than grade whichever row happens to sort first.
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glPipelines: JSON.stringify([{ id: 9999, sha: "c".repeat(40), status: "success" }]),
    glJobs: jobs(job("train", "success")),
  });
  assert(
    r.block === true && /could not be identified/.test(r.reason ?? ""),
    `#2226: a head pipeline the pipelines list does not contain refuses (${r.reason})`,
  );
}

// -------------------- a full page of jobs is a subset only if page 2 exists
{
  // GitLab paginates the jobs endpoint (20 by default, 100 the largest page the
  // API serves), so a response that fills the requested page says nothing on its
  // own. The gate asks the one question that settles it — is there a second
  // page? — and refuses on a real "yes", not on a row count.
  const many = Array.from({ length: 100 }, (_, i) => job(`job-${i}`, "success"));
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: JSON.stringify(many),
    glJobsPage2: JSON.stringify([job("more", "success")]),
  });
  assert(
    r.block === true && /partial check list/.test(r.reason ?? ""),
    `#2226: a full page WITH a second page refuses as a partial check list (${r.reason})`,
  );
}
{
  // The permanent-refusal regression (finding 1): a pipeline of EXACTLY 100 jobs
  // answers a full page too, and no re-run changes that. Routine sizes on
  // gitlab-org/gitlab MR pipelines are 77 / 90 / 92 / 93 / 116 / 344-348, so an
  // exact page is a real pipeline, not a boundary curiosity.
  const exactly = Array.from({ length: 100 }, (_, i) => job(`job-${i}`, "success"));
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: JSON.stringify(exactly),
    glJobsPage2: "[]",
  });
  assert(
    r.block === false,
    `#2226: a pipeline of exactly one page, with no second page, is green (${r.reason})`,
  );
}
{
  // A retried job is one job to GitLab and two rows on this endpoint. Grading
  // the history refused MRs the forge calls green, naming a failure somebody had
  // already retried away.
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: JSON.stringify([
      job("build", "success"),
      { name: "test", status: "failed", allow_failure: false, id: 41 },
      { name: "test", status: "success", allow_failure: false, id: 42 },
    ]),
  });
  assert(
    r.block === false,
    `#2226: a retried job whose current attempt passed does not refuse (${r.reason})`,
  );
}
{
  // Its mirror — the dedup keeps the CURRENT row, so a retry that went red still
  // blocks. Without this arm the previous one could be satisfied by a gatherer
  // that simply ignored duplicate rows it disliked.
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: JSON.stringify([
      { name: "test", status: "success", allow_failure: false, id: 51 },
      { name: "test", status: "failed", allow_failure: false, id: 52 },
    ]),
  });
  assert(
    r.block === true && /test/.test(r.reason ?? ""),
    `#2226: a retried job whose current attempt failed still refuses (${r.reason})`,
  );
}

// -------------------------------------------------- readiness is the verdict
for (const status of ["has_conflicts", "checking"]) {
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glMrStatus: status,
    // The jobs are green here: the composed readiness alone must refuse, so
    // nothing above the MR read can be doing the work.
    glJobs: jobs(job("build", "success")),
  });
  assert(r.block === true, `#2226: detailed_merge_status ${status} is refused (${r.reason})`);
  const expected = status === "has_conflicts" ? "DIRTY" : "UNKNOWN";
  assert(
    new RegExp(expected).test(r.reason ?? ""),
    `…naming the composed readiness ${expected} in the refusal (${r.reason})`,
  );
}

// ------------------------------------------------- no pipeline is a CI verdict
for (const [label, mr] of [
  // E4: the pipelines read ANSWERED and returned an empty list. That is the
  // absence of evidence, and this merge is irreversible — and the reading must
  // not hinge on whether the MR row happened to name a head pipeline, so both
  // shapes of the MR row are driven.
  ["naming no head pipeline", undefined],
  [
    "naming one its list omits",
    JSON.stringify({
      iid: 12,
      state: "opened",
      detailed_merge_status: "can_be_merged",
      has_conflicts: false,
      blocking_discussions_resolved: true,
      approvals_left: 0,
      sha: VERIFIED,
      diff_refs: { head_sha: VERIFIED },
      head_pipeline: { id: 5001 },
    }),
  ],
] as const) {
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glPipelines: "[]",
    glMr: mr,
  });
  assert(r.block === true, `#2226: an MR with no pipeline is refused (${label})`);
  assert(
    /no checks reported/.test(r.reason ?? ""),
    `…as 'no checks reported' (${label}: ${r.reason})`,
  );
  assert(
    !/tooling/.test(r.reason ?? ""),
    `…and NOT as a tooling failure — the CLI answered (${label}: ${r.reason})`,
  );
}

// ------------------------------------------------- a failed read is tooling
{
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    failEvidence: true,
  });
  assert(r.block === true, "#2226: an unreadable MR read refuses (fail closed)");
  assert(
    /tooling/.test(r.reason ?? ""),
    `…carrying failureKind "tooling" so a broken glab is not read as red CI (${r.reason})`,
  );
}
{
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    failChecks: true,
  });
  assert(
    r.block === true && /tooling/.test(r.reason ?? ""),
    `#2226: a pipelines/jobs read that throws refuses as a tooling failure, not a verdict (${r.reason})`,
  );
}

// ---------------------------------------------------------------- all green
{
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: jobs(job("build", "success"), job("test", "success")),
  });
  assert(r.block === false, `#2226: a passing ledger with a green MR is allowed (${r.reason})`);
}

// ---------------------------------- an ungraded job state refuses on the guard
{
  // The gatherer refuses on an unrecognised state on its own; the guard also
  // refuses on `evidence.unrecognised`, so an MR whose jobs nobody graded is
  // refused twice rather than merged on a CLEAN readiness alone.
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: jobs(job("mystery", "brand_new_state")),
  });
  assert(r.block === true, `#2226: a job state outside the table is refused (${r.reason})`);
}

// ------------------------------------------- the head pin applies on GitLab too
{
  // The verdict must belong to the commit the guard verified. The harness
  // derives the MR row's head from the fetched OID by default; naming a
  // different one is the arm that proves the pin is forge-agnostic.
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    // #2107 — the pipelines row must agree with the MR row's head, or the
    // gatherer refuses on its two forge rows contradicting each other before the
    // head pin is ever consulted. This arm's subject is the PIN, so the list is
    // pinned to the same head the MR row names (the OTHER commit) and the refusal
    // can only come from the pin.
    glPipelines: JSON.stringify([{ id: 5001, sha: "b".repeat(40), status: "success" }]),
    glMr: JSON.stringify({
      iid: 12,
      state: "opened",
      detailed_merge_status: "can_be_merged",
      has_conflicts: false,
      blocking_discussions_resolved: true,
      approvals_left: 0,
      sha: "b".repeat(40),
      diff_refs: { head_sha: "b".repeat(40) },
      head_pipeline: { id: 5001, sha: "b".repeat(40), status: "success" },
    }),
  });
  assert(
    r.block === true && /not read at the head/.test(r.reason ?? ""),
    `#2226: a green MR board for another commit is refused by the head pin (${r.reason})`,
  );
}

// ---------------------------------------- the reads are bounded by the budget
{
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: jobs(job("build", "success")),
  });
  assert(
    // `?.` because the fake only allocates the array once an exec carries a
    // timeout: `undefined` here means the guard issued a forge read with no bound,
    // which is exactly the condition this arm refuses — collapsing it to a truthy
    // default would turn the assertion green on the failure it exists to catch.
    (r.timeouts?.length ?? 0) > 0 &&
      (r.timeouts ?? []).every((t) => typeof t === "number" && t > 0),
    `#2226: every forge read the guard issued carried its timeout (${JSON.stringify(r.timeouts)})`,
  );
}
{
  // #2107's bound, on the forge that just gained the gate: a glab that never
  // settles must come back as a tooling refusal, not as the hook held open
  // forever. Three sequential reads make this arm worth having on its own — a
  // gate that bounded only the gh path would hang here.
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    hangChecks: true,
  });
  assert(
    r.block === true && /tooling|timed out|timeout/i.test(r.reason ?? ""),
    `#2226: a hanging glab read refuses as a tooling failure rather than hanging the hook (${r.reason})`,
  );
}

// ------------------------------------------------ the argv canary: it ASKED
{
  // The counterweight to every arm above: a guard that read nothing and
  // invented a refusal would pass them all. These are the three argv strings
  // the gatherer's GitLab arm is allowed to issue, taken from the builders
  // themselves (test-gh-argv.ts pins those builders; #745 is why nothing here
  // invents a field list of its own).
  const wantMr = mergeEvidenceGlMrCmd(12);
  const wantPipelines = mergeEvidenceGlPipelinesCmd(12);
  const wantJobs = mergeEvidenceGlJobsCmd(5001);
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    glJobs: jobs(job("build", "success")),
  });
  assert(
    r.calls.some((c) => c === wantMr),
    `canary: the guard issued the pinned MR-state argv (${wantMr}); got ${JSON.stringify(r.calls)}`,
  );
  assert(
    r.calls.some((c) => c === wantPipelines),
    `canary: the guard issued the pinned pipelines argv (${wantPipelines})`,
  );
  assert(
    r.calls.some((c) => c === wantJobs),
    `canary: the guard issued the pinned jobs argv (${wantJobs})`,
  );
  assert(
    !r.calls.some((c) => c.startsWith("gh ")),
    `…with no gh read on the GitLab arm (${JSON.stringify(r.calls.filter((c) => c.startsWith("gh ")))})`,
  );
  // The page-2 probe is NOT issued here: the jobs answer is one short row, so
  // its completeness is settled by the row count alone. An unconditional probe
  // would read a fourth endpoint on every green MR for nothing.
  assert(
    !r.calls.some((c) => c === mergeEvidenceGlJobsPage2Cmd(5001)),
    `…and no second-page probe issued for a page it knew was short (${JSON.stringify(r.calls)})`,
  );
  // The arm's own precondition, visible: the guard DOES resolve the forge from the
  // clone's remote, and this answer is one the classifier can use. Without it the
  // matrix could pass on a guard that never consulted the remote at all — a
  // different fact from "consulting it cannot change the verdict", which the
  // unreadable-remote arm below supplies.
  assert(
    r.calls.some((c) => c.includes("git config --get remote.origin.url")),
    `canary: the guard resolved the forge from the clone's remote (${JSON.stringify(r.calls.filter((c) => c.includes("remote")))})`,
  );
  assert(r.block === false, "…and on that answer it allowed the merge");
}

// ------------------------------------ the remote cannot decide this merge's verdict
{
  // #2226 — the threading witness. The guard hands the gatherer the forge its own
  // target carries instead of letting it re-detect one; without that, an unreadable
  // origin surfaced as THIS merge's tooling refusal and the operator was sent to
  // fix a remote while the CI verdict went unread. The driver's caller has this
  // coverage in test-headless-evidence-gate.ts §3b; the guard had none.
  //
  // The knobs are load-bearing, not incidental: with the harness's
  // PI_ENSEMBLE_FORGE pin in place, detection answers whatever the target already
  // carries, so a regression that dropped the threaded argument could not change
  // an outcome. failRemoteUrl + unsetForgeEnv (see MergeGateEnv) take that shortcut
  // away from the GATHERER only; the guard's own target read keeps its forge.
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    failRemoteUrl: true,
    unsetForgeEnv: true,
    glJobs: jobs(job("build", "success")),
  });
  assert(
    r.block === false,
    `#2226: an unreadable remote does not refuse the merge — the guard named the forge (${r.reason})`,
  );
  assert(
    r.calls.some((c) => c === mergeEvidenceGlMrCmd(12)),
    `…and the forge's own verdict was reached despite it (${JSON.stringify(r.calls.filter((c) => c.startsWith("glab ")))})`,
  );
}

// --------------------------------------------------- the -R scoping carries over
{
  // #2107's rule, on the forge that just gained the gate: every read must be
  // scoped to the project the merge names, or it answers about another MR.
  const r = await hookDecision(MR_COMMAND, GOOD_ENTRIES, {
    target: GL_TARGET,
    repoFlag: " -R group/sub/repo",
    targetRepo: "group/sub/repo",
    glJobs: jobs(job("build", "success")),
  });
  const forgeReads = r.calls.filter((c) => c.startsWith("glab "));
  assert(
    forgeReads.length > 0 && forgeReads.every((c) => c.endsWith(" -R group/sub/repo")),
    `#2226: every glab read was scoped to the command's repo (${JSON.stringify(forgeReads)})`,
  );
  assert(r.block === false, `…and the merge was still allowed (${r.reason})`);
}

teardownLedger();
console.log(`\nexit ${exit}`);
process.exit(exit);
