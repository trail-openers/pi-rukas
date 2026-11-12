#!/usr/bin/env bun
/**
 * #2226 — three ways the GitLab evidence gate could grade a verdict it was not
 * entitled to.
 *
 * Sibling of `test-merge-evidence-gl-pagination.ts` (read completeness) and
 * `test-merge-evidence-gitlab.ts` (the verdicts); this file is the ATTRIBUTION
 * seam — which rows the gate is allowed to draw a verdict from, and whether the
 * set it drew from said anything at all.
 *
 *   - The head pipeline's `sha`. The gate matches the pipelines row against
 *     `head_pipeline.id`, which is a foreign key, not an identity: GitLab keeps
 *     the id stable across a re-run, so a pipeline row naming ANOTHER commit
 *     still matches, and the gate grades CI that never ran on this head. The
 *     whole reason `pickPipelineForHead` exists is the sentence in its own
 *     header — jobs read for a commit that is not the head "is not a verdict
 *     about this merge" — so the id branch has to honour it too.
 *   - The nameless row. `currentJobAttempts` files rows it cannot name under one
 *     shared key, so a `manual`/`allow_failure` row (which the grade table reads
 *     as `pass`) displaces a `failed` row with the same missing name, and a red
 *     job disappears. The same "dedup must not drop an inconvenient row" property
 *     the retry rule already pins, for the rows the retry rule never named.
 *   - The all-never-ran pipeline. `allow_failure` exempts `manual`/`skipped`, so
 *     a pipeline of nothing but such jobs reached `ok: true` with no job having
 *     executed. That is the same absence the empty-jobs refusal already answers,
 *     and GitHub's own empty-checks refusal is the precedent: zero executed jobs
 *     is "no checks reported", not a pass.
 */

import { currentJobAttempts, gradeGlJobRow } from "../src/forge-gl-grade.ts";
import { gatherMergeEvidence } from "../src/work-driver-merge-evidence.ts";
import { mkExec } from "./forge-fixtures.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";
import {
  HEAD,
  JOBS_CMD,
  MR,
  PIPELINE,
  glReads,
  jobRow,
  mrRow,
  pipelineRow,
} from "./merge-evidence-gl-fixtures.ts";

/** The status of each surviving row, in the order the map yields them. */
const statuses = (rows: unknown[]) =>
  rows.map((r) => (r as { status?: unknown })?.status ?? "(no status)");

async function main() {
  console.log("merge evidence (GitLab) — pipeline attribution and executed jobs:");

  // ── The head pipeline row must BE the head's. ───────────────────────────
  await check(
    "a head_pipeline row whose sha is not the MR head refuses (the id is a foreign key, not an identity)",
    async () => {
      // The MR head is fixed at HEAD; the pipelines list answers the id the MR
      // names, but the row's own `sha` is a different commit — the shape a
      // re-run of a stable pipeline id, or a stale pipelines cache, produces.
      // Matching on `id` alone grades CI that never ran on this head.
      const stale = { id: PIPELINE, sha: "c".repeat(40), status: "success" };
      const { fn } = mkExec(glReads(mrRow(), [stale], [jobRow("build", "success")]));
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(
        ev.ok === false,
        `a pipeline for another commit is no verdict (${JSON.stringify(ev)})`,
      );
      assert(
        /could not be identified/.test(ev.reason ?? ""),
        `same refusal shape as the missing-row arm: ${ev.reason}`,
      );
      assert(
        /sha/.test(ev.reason ?? "") && /c{10,}/.test(ev.reason ?? ""),
        `the refusal names the sha it refused: ${ev.reason}`,
      );
      assert(
        ev.failureKind === undefined,
        `a forge row that disagrees is a CI verdict, not tooling (${ev.failureKind})`,
      );
      assert(ev.headOid === HEAD, `the head it saw is still reported: ${ev.headOid}`);
    },
  );

  // ── A nameless row must never displace a named or nameless verdict. ─────
  await check(
    "a nameless allow-failure manual row does not displace a nameless failed row",
    async () => {
      // Neither row has a name, so the one shared nameless key is where both
      // land; `manual` + `allow_failure: true` grades `pass`, so a highest-id /
      // pass-wins rule lets the manual row eat the failure and the gate reports
      // the pipeline green.
      const rows = [
        { status: "failed", allow_failure: false, id: 1 },
        { status: "manual", allow_failure: true, id: 2 },
      ];
      const kept = currentJobAttempts(rows);
      assert(
        kept.length === 2,
        `each row that cannot be named gets its own seat: ${JSON.stringify(statuses(kept))}`,
      );
      assert(
        kept.some((r) => gradeGlJobRow(r as Record<string, unknown>) === "fail"),
        `the failed row survives: ${JSON.stringify(statuses(kept))}`,
      );
      const { fn } = mkExec(glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], rows));
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(ev.ok === false, `a red nameless row still refuses (${JSON.stringify(ev)})`);
      assert(ev.failing.length === 1, `failing: ${JSON.stringify(ev.failing)}`);
    },
  );

  await check(
    "a nameless pass row never displaces the failed row of the key it shares",
    async () => {
      // The general rule behind the arm above, in the pass direction and with
      // ids that would make a newest-wins rule choose the pass: for ANY key, a
      // row may not replace a failed row of that key with one that grades pass.
      const kept = currentJobAttempts([
        { status: "failed", allow_failure: false, id: 1 },
        { status: "success", allow_failure: false, id: 9 },
      ]);
      assert(
        kept.length === 2 &&
          kept.some((r) => gradeGlJobRow(r as Record<string, unknown>) === "fail"),
        `a failed row is never dropped for a pass: ${JSON.stringify(statuses(kept))}`,
      );
      // Two nameless rows of the SAME grade still collapse to one seat each, so
      // the rule is about the failed row, not about keeping everything.
      assert(
        currentJobAttempts([
          { status: "success", id: 1 },
          { status: "success", id: 2 },
        ]).length === 2,
        "nameless rows are kept individually rather than folded into one entry",
      );
    },
  );

  // ── A pipeline in which nothing executed says nothing. ──────────────────
  await check(
    "a pipeline whose every job is allow-failure manual/skipped refuses with no checks reported",
    async () => {
      // `allow_failure` exempts `manual` and `skipped` from the refusal, so a
      // pipeline of nothing but such jobs graded `ok: true` while no job ever
      // ran. Zero executed jobs is the same absence of evidence as the empty
      // jobs list, and gets the same words.
      const { fn } = mkExec(
        glReads(
          mrRow(),
          [pipelineRow(PIPELINE, HEAD)],
          [jobRow("deploy-staging", "skipped", true), jobRow("deploy-production", "manual", true)],
        ),
      );
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(ev.ok === false, `nothing executed, so nothing vouched (${JSON.stringify(ev)})`);
      assert(/no checks reported/.test(ev.reason ?? ""), `reason: ${ev.reason}`);
      assert(
        ev.failureKind === undefined,
        `the forge answered — this is a CI verdict, not tooling (${ev.failureKind})`,
      );
    },
  );

  await check(
    "one executed job among the allow-failure ones is a pass (the pilot shape still lands)",
    async () => {
      // The shape the pilot's MR actually answers: `build` green plus a manual
      // `allow_failure: true` deploy. The refusal above must not reach this one.
      const { fn, calls } = mkExec(
        glReads(
          mrRow(),
          [pipelineRow(PIPELINE, HEAD)],
          [jobRow("build", "success"), jobRow("deploy-production", "manual", true)],
        ),
      );
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(ev.ok === true, `a job ran and passed (${JSON.stringify(ev)})`);
      assert(
        calls.filter((c) => c === JOBS_CMD).length === 1,
        `the jobs read was issued exactly once (${JSON.stringify(calls)})`,
      );
    },
  );

  await check(
    "a row the endpoint left as null is refused as unrecognised, never thrown",
    async () => {
      // `currentJobAttempts` keeps a non-object row on purpose — dropping it
      // would turn "the endpoint answered something odd" into "this pipeline has
      // no jobs", the refusal for a pipeline that DID answer. So the row reaches
      // the grade table, and a table that read `.status` off a `null` threw out
      // of the gatherer: the caller got an exception where it expected a verdict,
      // and an exception is not a refusal any caller can render.
      const { fn } = mkExec(glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], [null]));
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(ev.ok === false, `a null row is no verdict (${JSON.stringify(ev)})`);
      assert(ev.unrecognised?.length === 1, `unrecognised: ${JSON.stringify(ev.unrecognised)}`);
      assert(
        ev.failureKind === undefined,
        `the forge answered, so this is a CI verdict not tooling (${ev.failureKind})`,
      );
      // And a null row must not hide beside a real green job: the one row that
      // did run passing is not evidence when a row nobody graded is also present.
      const { fn: fn2 } = mkExec(
        glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], [jobRow("build", "success"), null]),
      );
      const ev2 = await gatherMergeEvidence(fn2, "/x", MR, "gitlab");
      assert(
        ev2.ok === false,
        `a green job beside a junk row still refuses (${JSON.stringify(ev2)})`,
      );
    },
  );

  forgeExitCode("All GitLab attribution/executed-job tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
