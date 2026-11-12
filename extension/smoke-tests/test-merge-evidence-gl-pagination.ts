#!/usr/bin/env bun
/**
 * #2226 — the two ways the jobs endpoint can hand the gate a set that is not the
 * pipeline: pagination, and history.
 *
 * Sibling of `test-merge-evidence-gitlab.ts` (the §12 size cap split them along
 * this seam: verdicts there, read-completeness here). Both drive the REAL
 * gatherer through the same exec seam and the same fixture builder
 * (`merge-evidence-gl-fixtures.ts`), so a fix that quietly stopped asking the
 * forge something shows up here rather than in a unit test of a copy.
 *
 * Both defects are false REFUSALS — fail-closed, so neither can merge a red MR —
 * and both park a pilot with no re-run that can change the answer, which is the
 * class this issue exists to remove:
 *
 *   - Pagination. `per_page=100` is the largest page the API serves, so a
 *     pipeline of exactly 100 jobs answers 100 rows exactly as a 356-job one
 *     does. Refusing on `length >= page size` therefore refused every MR of that
 *     size forever. Observed on gitlab-org/gitlab MR pipelines: `x-total` 77,
 *     90, 92, 93, 116, 344, 347, 348 — both shapes are routine. The gate now
 *     reads page 2 and refuses only on a real "there is more".
 *   - History. `/pipelines/:id/jobs` keeps a retried job's superseded row at its
 *     own terminal state, so grading every row reports the failure somebody
 *     already retried away. The current attempt — highest `id` per name — is the
 *     job.
 */

import { currentJobAttempts } from "../src/forge-gl-grade.ts";
import { gatherMergeEvidence } from "../src/work-driver-merge-evidence.ts";
import { GL_JOBS, mkExec } from "./forge-fixtures.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";
import {
  HEAD,
  JOBS_CMD,
  JOBS_PAGE2_CMD,
  JOB_PAGE_SIZE,
  MR,
  OTHER_HEAD,
  PIPELINE,
  PIPELINES_CMD,
  PIPELINES_PAGE2_CMD,
  glReads,
  glReadsWithPage2,
  jobRow,
  mrRow,
  pipelineRow,
} from "./merge-evidence-gl-fixtures.ts";

/** A pipeline's worth of distinct jobs, all green, at a requested row count. */
const greenJobs = (n: number) => Array.from({ length: n }, (_, i) => jobRow(`job-${i}`, "success"));

/**
 * The jobs the pipelines-probe arms grade: green, and small enough that the
 * jobs probe never fires, so a refusal in those arms can only come from the
 * pipelines read they are about.
 */
const GL_JOBS_FOR_PROBE = GL_JOBS;

async function main() {
  console.log("merge evidence (GitLab) — pagination and retries:");

  // ── Pagination: a full page is a subset only if a second page follows. ──
  for (const hidden of [false, true]) {
    await check(
      `a full jobs page WITH a second page refuses rather than passes (hidden failing row: ${hidden})`,
      async () => {
        const many = greenJobs(JOB_PAGE_SIZE);
        if (hidden) many[7] = jobRow("hidden", "failed");
        const { fn, calls } = mkExec(
          glReadsWithPage2(mrRow(), [pipelineRow(PIPELINE, HEAD)], many, {
            stdout: JSON.stringify([jobRow("more", "success")]),
          }),
        );
        const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
        assert(
          ev.ok === false,
          `a subset of the pipeline is not a verdict (${JSON.stringify(ev)})`,
        );
        assert(/partial check list/.test(ev.reason ?? ""), `reason: ${ev.reason}`);
        assert(
          ev.failing.length === 0 && ev.inconclusive.length === 0,
          `a truncated page grades nothing, so it names nothing: ${JSON.stringify(ev)}`,
        );
        // Both reads must carry the page pin, or this arm asserts a bound the
        // builders never asked for; and the probe must have been ISSUED, or the
        // refusal was invented without asking the forge.
        assert(
          calls.some((c) => c === JOBS_CMD),
          `the jobs read pinned per_page=${JOB_PAGE_SIZE} (${JSON.stringify(calls)})`,
        );
        assert(
          calls.some((c) => c === JOBS_PAGE2_CMD),
          `the full page was answered by the page-2 probe, not by assumption (${JSON.stringify(calls)})`,
        );
      },
    );
  }

  await check(
    "a pipeline of EXACTLY a page (100 jobs) is the whole pipeline and passes",
    async () => {
      // The permanent-refusal regression this arm exists for: `>= page size` made
      // this MR unmergeable no matter how often the driver re-ran.
      const { fn, calls } = mkExec(
        glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], greenJobs(JOB_PAGE_SIZE)),
      );
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(
        ev.ok === true,
        `an exact page with no second page is the whole pipeline (${JSON.stringify(ev)})`,
      );
      assert(
        calls.some((c) => c === JOBS_PAGE2_CMD),
        `the exact-page answer came from the probe, not from the row count (${JSON.stringify(calls)})`,
      );
    },
  );

  await check("a full page whose second-page probe cannot be read refuses as tooling", async () => {
    // An unread follow-up leaves "are there more jobs?" open, so it is not a
    // pass — and it is not a CI verdict either, because nothing about the
    // pipeline was observed. `failureKind` is what tells those apart.
    const { fn } = mkExec(
      glReadsWithPage2(mrRow(), [pipelineRow(PIPELINE, HEAD)], greenJobs(JOB_PAGE_SIZE), {
        error: true,
        stderr: "glab: connection reset",
      }),
    );
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.ok === false, `refused: ${JSON.stringify(ev)}`);
    assert(ev.failureKind === "tooling", `failureKind: ${ev.failureKind}`);
    assert(/second page/.test(ev.reason ?? ""), `reason names the read that failed: ${ev.reason}`);
  });

  await check("a page of 99 jobs is the whole pipeline and passes", async () => {
    // The complement of the arms above: the bound is about a FULL page, not about
    // any long list. And a short page is known-complete from its own row count,
    // so the gate must not spend a read asking whether it is complete.
    const { fn, calls } = mkExec(
      glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], greenJobs(JOB_PAGE_SIZE - 1)),
    );
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.ok === true, `a short page is the whole list (${JSON.stringify(ev)})`);
    assert(
      !calls.some((c) => c === JOBS_PAGE2_CMD),
      `no probe was needed for a short page (${JSON.stringify(calls)})`,
    );
  });

  // ── The same rule on the pipelines read. A truncated pipelines list is
  // refused, because the row that PROVES the head pipeline belongs to this MR
  // may be one of the rows never read — and unlike the jobs list, the gate has
  // no way to attribute a pipeline it never saw. What the probe exists for is
  // the case it clears: a list of EXACTLY a page, which `>= page size` used to
  // refuse forever. ──────────────────────────────────────────────────────
  await check(
    "a pipelines list of EXACTLY a page, with a head pipeline named by the MR row, is the whole list and passes",
    async () => {
      // The permanent-refusal regression on the pipelines read, and the reason
      // the probe is issued at all: 100 pipelines answered 100 rows exactly as
      // 344 do, and the old gate refused both.
      const page100 = Array.from({ length: JOB_PAGE_SIZE }, (_, i) =>
        pipelineRow(7000 + i, OTHER_HEAD),
      ).concat([pipelineRow(PIPELINE, HEAD)]);
      const { fn, calls } = mkExec(
        glReads(mrRow({ head_pipeline: { id: PIPELINE } }), page100, GL_JOBS_FOR_PROBE),
      );
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(
        calls.some((c) => c === PIPELINES_PAGE2_CMD),
        `the exact-page answer came from the probe, not the row count (${JSON.stringify(calls)})`,
      );
      assert(
        ev.ok === true,
        `an exact page with no second page is the whole list (${JSON.stringify(ev)})`,
      );
    },
  );

  await check(
    "a full pipelines page with a non-empty second page refuses, naming the truncation",
    async () => {
      // More rows followed, so the list the gate read is a subset and the row
      // that proves the attribution may be among the rows it never received.
      // Distinct words from the jobs truncation: the operator has to be able to
      // tell which read was cut short.
      const page1 = Array.from({ length: JOB_PAGE_SIZE }, (_, i) =>
        pipelineRow(7000 + i, OTHER_HEAD),
      );
      const { fn } = mkExec({
        ...glReads(mrRow(), page1, GL_JOBS_FOR_PROBE),
        [PIPELINES_PAGE2_CMD]: { stdout: JSON.stringify([pipelineRow(PIPELINE, OTHER_HEAD)]) },
      });
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(
        ev.ok === false,
        `a subset of the pipelines list is no verdict (${JSON.stringify(ev)})`,
      );
      assert(
        /pipelines list of MR 17/.test(ev.reason ?? "") && /truncated/.test(ev.reason ?? ""),
        `reason names the read that was cut short: ${ev.reason}`,
      );
      assert(
        !/partial check list/.test(ev.reason ?? ""),
        `distinct from the jobs truncation: ${ev.reason}`,
      );
      assert(
        ev.failureKind === undefined,
        `a truncated list the forge answered fully is a CI verdict, not tooling (${ev.failureKind})`,
      );
      assert(
        ev.failing.length === 0 && ev.inconclusive.length === 0,
        `a truncated read grades nothing, so it names nothing: ${JSON.stringify(ev)}`,
      );
    },
  );

  await check("a full pipelines page whose probe cannot be read refuses as tooling", async () => {
    // An unread follow-up leaves "is there another pipeline?" open, which is
    // not a pass and not a CI verdict either — nothing about the list beyond
    // page 1 was observed. `failureKind` is what tells those apart.
    const page1 = Array.from({ length: JOB_PAGE_SIZE }, (_, i) =>
      pipelineRow(7000 + i, OTHER_HEAD),
    );
    const { fn } = mkExec({
      ...glReads(mrRow({ head_pipeline: { id: PIPELINE } }), page1, GL_JOBS_FOR_PROBE),
      [PIPELINES_PAGE2_CMD]: { error: true, stderr: "glab: connection reset" },
    });
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.ok === false, `refused: ${JSON.stringify(ev)}`);
    assert(ev.failureKind === "tooling", `failureKind: ${ev.failureKind}`);
    assert(/second page/.test(ev.reason ?? ""), `reason names the read that failed: ${ev.reason}`);
  });

  await check(
    "a pipelines page of 99 rows is the whole list and spends no probe read",
    async () => {
      // The bound is about a FULL page, not about a long list; a short page is
      // known-complete from its own row count.
      // 99 rows in total — one short of the page, which is the count that proves
      // completeness on its own.
      const page99 = Array.from({ length: JOB_PAGE_SIZE - 1 }, (_, i) =>
        pipelineRow(7000 + i, OTHER_HEAD),
      )
        .slice(0, JOB_PAGE_SIZE - 2)
        .concat([pipelineRow(PIPELINE, HEAD)]);
      const { fn, calls } = mkExec(
        glReads(mrRow({ head_pipeline: { id: PIPELINE } }), page99, GL_JOBS_FOR_PROBE),
      );
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(ev.ok === true, `a short page is the whole list (${JSON.stringify(ev)})`);
      assert(
        !calls.some((c) => c === PIPELINES_PAGE2_CMD),
        `no probe was needed for a short page (${JSON.stringify(calls)})`,
      );
    },
  );

  // ── History: a retried job is one job to GitLab and two rows here. ──────
  await check(
    "a retried job whose latest attempt passed does NOT refuse (the false-refusal shape)",
    async () => {
      // The endpoint keeps the superseded row at its own terminal state, so
      // grading the raw rows reports `required checks failing: test` on a
      // pipeline the forge itself calls green.
      const { fn } = mkExec(
        glReads(
          mrRow(),
          [pipelineRow(PIPELINE, HEAD)],
          [
            jobRow("build", "success", false, 10),
            jobRow("test", "failed", false, 11),
            jobRow("test", "success", false, 12),
          ],
        ),
      );
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(
        ev.ok === true,
        `the retried job's current attempt is green, so the pipeline is green (${JSON.stringify(ev)})`,
      );
      assert(ev.failing.length === 0, `failing: ${JSON.stringify(ev.failing)}`);
    },
  );

  await check(
    "a retried job whose latest attempt FAILED still refuses (no false green)",
    async () => {
      // The dedup must not become a way to drop an inconvenient row: the row that
      // survives is the CURRENT one, whichever verdict it carries. Without this
      // arm the one above could be satisfied by a gatherer that simply ignored
      // duplicate rows it disliked.
      const { fn } = mkExec(
        glReads(
          mrRow(),
          [pipelineRow(PIPELINE, HEAD)],
          [jobRow("test", "success", false, 21), jobRow("test", "failed", false, 22)],
        ),
      );
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(
        ev.ok === false && ev.failing.join(",") === "test",
        `the latest attempt is red, so the refusal stands (${JSON.stringify(ev)})`,
      );
    },
  );

  await check(
    "a retried job whose latest attempt is still RUNNING refuses as pending",
    async () => {
      // The third shape: the old attempt is terminal-green and the new one has
      // not reported. Merging behind it is merging on a job in flight.
      const { fn } = mkExec(
        glReads(
          mrRow(),
          [pipelineRow(PIPELINE, HEAD)],
          [jobRow("e2e", "success", false, 31), jobRow("e2e", "running", false, 32)],
        ),
      );
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(
        ev.ok === false && /running/i.test(ev.reason ?? "") && ev.failing.length === 0,
        `the current attempt is in flight (${JSON.stringify(ev)})`,
      );
    },
  );

  await check(
    "the current-attempt rule keeps id-less rows and files unnameable rows as unknown",
    async () => {
      // Dropping an id-less row would leave a name with nothing to grade, and a
      // set emptied that way reads as "no checks reported" — a refusal that
      // invents an absence. A row that is not an object has no name to file it
      // under, so it folds into the one nameless entry and reaches the grade
      // table as `unknown`, which the gatherer refuses on: it can never read as
      // a pass.
      assert(
        currentJobAttempts([jobRow("a", "success"), jobRow("b", "failed")]).length === 2,
        "id-less rows are evidence and are kept",
      );
      assert(
        currentJobAttempts(["junk", null, jobRow("a", "success")]).length === 3,
        `every row the endpoint did not name keeps its own seat, so a nameless row can never be filed as one job: ${JSON.stringify(
          currentJobAttempts(["junk", null, jobRow("a", "success")]),
        )}`,
      );
      // And a nameless row that grades `pass` must not swallow a nameless
      // failure — the false-green direction the seats exist to block.
      assert(
        currentJobAttempts([
          { status: "failed", allow_failure: false, id: 1 },
          { status: "manual", allow_failure: true, id: 2 },
        ]).length === 2,
        "a nameless allow-failure row never displaces a nameless failed row",
      );
      // When one name has both kinds of row, the id-bearing one is current.
      const mixed = currentJobAttempts([
        jobRow("a", "failed", false, 5),
        { name: "a", status: "success" },
      ]);
      assert(
        (mixed[0] as { status: string }).status === "failed",
        `the id-bearing row wins: ${JSON.stringify(mixed)}`,
      );
      // The head the arms pin their fixtures to is a full OID; the dedup must not
      // be the place that silently reorders two DIFFERENT jobs.
      assert(
        currentJobAttempts([jobRow("x", "success"), jobRow("y", "failed")]).length === 2 &&
          HEAD.length === 40,
        "distinct names are never merged",
      );
    },
  );

  forgeExitCode("All GitLab pagination/retry tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
