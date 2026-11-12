#!/usr/bin/env bun
/**
 * #2226 — the merge evidence gate has a GitLab arm.
 *
 * `gatherMergeEvidence` was GitHub-only by construction: it spelled both of its
 * reads with the gh argv builders, so on a GitLab project the driver's merged
 * step, the stepback ci step, the merge guard and lean land could never present
 * passing evidence — the classic pilot run parked at `land` on an MR that was
 * green. This file drives the SAME gatherer through the exec seam with the
 * GitLab fixtures, so the arms are the gatherer's real verdicts, not a
 * parallel implementation of them.
 *
 * The binding resolutions the arms pin:
 *   - E1: the evidence keeps its shape; on GitLab `mergeStateStatus` carries
 *     the COMPOSED readiness (CLEAN / DIRTY / UNKNOWN), and the author is not
 *     an evidence field at all.
 *   - E2: readiness and the head come from ONE merge_requests/:iid read.
 *   - E3: job rows are graded by the explicit table in `forge-gl-grade.ts`.
 *   - E4: a glab exec failure is `failureKind: "tooling"`; "no checks reported"
 *     is a CI verdict ONLY when the pipelines read answered an empty list.
 *
 * GitHub argv is untouched, and the GitHub arms of this gate live in
 * test-merge-authority.ts, which is unchanged.
 */

import { gatherMergeEvidence } from "../src/work-driver-merge-evidence.ts";
import { GL_JOBS, GL_MR_CHECKING, mkExec } from "./forge-fixtures.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";
import {
  HEAD,
  JOBS_CMD,
  JOB_PAGE_SIZE,
  MR,
  OTHER_HEAD,
  PIPELINE,
  PIPELINES_CMD,
  glReads,
  mrRow,
  pipelineRow,
} from "./merge-evidence-gl-fixtures.ts";

async function main() {
  console.log("merge evidence (GitLab):");

  await check("a green MR passes the evidence gate", async () => {
    const { fn, calls } = mkExec(glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], GL_JOBS));
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.ok === true, `ok: ${JSON.stringify(ev)}`);
    assert(ev.mergeStateStatus === "CLEAN", `readiness: ${ev.mergeStateStatus}`);
    assert(ev.headOid === HEAD, `head from the one MR read: ${ev.headOid}`);
    assert(ev.headOidError === undefined, `head error: ${ev.headOidError}`);
    assert(ev.failing.length === 0 && ev.inconclusive.length === 0, JSON.stringify(ev));
    assert(ev.unrecognised === undefined, `unrecognised: ${JSON.stringify(ev.unrecognised)}`);
    assert(ev.failureKind === undefined, `failureKind: ${ev.failureKind}`);
    assert(
      calls.some((c) => c === "glab api /projects/:id/merge_requests/17"),
      `the readiness+head read was issued (${JSON.stringify(calls)})`,
    );
    assert(
      calls.some((c) => c === PIPELINES_CMD),
      `the pipelines read was issued (${JSON.stringify(calls)})`,
    );
    assert(
      calls.some((c) => c === JOBS_CMD),
      `the jobs read was issued (${JSON.stringify(calls)})`,
    );
    assert(
      !calls.some((c) => c.startsWith("gh ")),
      `no gh argv on the GitLab arm (${JSON.stringify(calls)})`,
    );
  });

  await check("a failed job refuses as a CI verdict", async () => {
    // `can_be_merged` is the fixture a real GitLab instance does answer with
    // while a pipeline is red (the required-checks rules are per-project), so
    // the job rows are the ONLY thing that stops this merge — the same shape
    // the GitHub `failing` fixture in the headless suite uses, and for the same
    // reason: a DIRTY answer would let the readiness blocklist do the work and
    // the checks branch would pass with the failing-checks code deleted.
    const { fn } = mkExec(
      glReads(
        mrRow(),
        [pipelineRow(PIPELINE, HEAD)],
        [
          { name: "build", status: "success", allow_failure: false },
          { name: "test", status: "failed", allow_failure: false },
        ],
      ),
    );
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.ok === false, `refused: ${JSON.stringify(ev)}`);
    assert(
      ev.failureKind === undefined,
      `a red pipeline is a verdict, not tooling (${ev.failureKind})`,
    );
    assert(ev.failing.join(",") === "test", `failing: ${JSON.stringify(ev.failing)}`);
    assert(/failing/i.test(ev.reason ?? ""), `reason: ${ev.reason}`);
  });

  await check(
    "an MR whose pipelines read answered an EMPTY list refuses with no checks reported",
    async () => {
      const { fn } = mkExec(glReads(mrRow({ head_pipeline: null }), [], GL_JOBS));
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(ev.ok === false, `refused: ${JSON.stringify(ev)}`);
      assert(
        ev.failureKind === undefined,
        `an empty list is a CI verdict, not tooling (${ev.failureKind})`,
      );
      assert(/no checks reported/.test(ev.reason ?? ""), `reason: ${ev.reason}`);
    },
  );

  await check("a glab exec failure refuses as tooling", async () => {
    // Only the MR-state read fails; the other two answer normally, so the
    // refusal can only come from the read that threw.
    const { fn } = mkExec({
      ...glReads(mrRow(), [], GL_JOBS),
      "glab api /projects/:id/merge_requests/17": {
        error: true,
        stderr: "glab: 401 Unauthorized",
      },
    });
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.ok === false, `refused: ${JSON.stringify(ev)}`);
    assert(ev.failureKind === "tooling", `failureKind: ${ev.failureKind}`);
    assert(/401/.test(ev.reason ?? ""), `reason names the failed read: ${ev.reason}`);
  });

  await check("`checking` readiness is inconclusive, not a pass", async () => {
    const { fn } = mkExec(
      glReads(
        mrRow({
          ...GL_MR_CHECKING,
          sha: HEAD,
          diff_refs: { head_sha: HEAD },
          head_pipeline: { id: PIPELINE, sha: HEAD },
        }),
        [pipelineRow(PIPELINE, HEAD)],
        GL_JOBS,
      ),
    );
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.ok === false, `refused: ${JSON.stringify(ev)}`);
    assert(ev.mergeStateStatus === "UNKNOWN", `composed readiness: ${ev.mergeStateStatus}`);
    assert(ev.failureKind === undefined, `a verdict, not tooling (${ev.failureKind})`);
  });

  await check("DIRTY readiness refuses", async () => {
    const { fn } = mkExec(
      glReads(
        mrRow({ detailed_merge_status: "has_conflicts", has_conflicts: true }),
        [pipelineRow(PIPELINE, HEAD)],
        GL_JOBS,
      ),
    );
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.ok === false && ev.mergeStateStatus === "DIRTY", JSON.stringify(ev));
  });

  await check("a missing head on the one MR read sets headOidError", async () => {
    const noHead = mrRow();
    Reflect.deleteProperty(noHead, "sha");
    Reflect.deleteProperty(noHead, "diff_refs");
    const { fn } = mkExec(glReads(noHead, [pipelineRow(PIPELINE, HEAD)], GL_JOBS));
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.headOid === undefined, `head: ${ev.headOid}`);
    assert(/head/.test(ev.headOidError ?? ""), `headOidError: ${ev.headOidError}`);
  });

  await check("a non-40-hex head is named, not silently trusted", async () => {
    const { fn } = mkExec(
      glReads(
        mrRow({ sha: OTHER_HEAD.slice(0, 8), diff_refs: { head_sha: OTHER_HEAD.slice(0, 8) } }),
        [pipelineRow(PIPELINE, HEAD)],
        GL_JOBS,
      ),
    );
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.headOid === undefined, `head: ${ev.headOid}`);
    assert(
      /not a full 40-char SHA/.test(ev.headOidError ?? ""),
      `headOidError: ${ev.headOidError}`,
    );
  });

  await check("a bad `sha` still yields to a valid `diff_refs.head_sha`", async () => {
    // The two head fields come from one read and usually agree; when the first
    // is malformed the second is still the forge's answer, and abandoning the
    // fallback on the first bad candidate loses a valid OID.
    const { fn } = mkExec(
      glReads(mrRow({ sha: "not-a-sha" }), [pipelineRow(PIPELINE, HEAD)], GL_JOBS),
    );
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.headOid === HEAD, `head from the fallback field: ${ev.headOid}`);
  });

  // ── (a) the pipeline under test is the MR's HEAD pipeline, not "the newest
  // row of a list whose ordering the API does not promise". ───────────────
  await check("the jobs of the MR's head pipeline are graded, not the newest row's", async () => {
    // A train pipeline for another commit sits at the front of the list (this
    // is the real shape on gitlab-org/gitlab !270470: three pipelines, newest
    // one on refs/merge-requests/N/train). Grading row [0] would read the
    // wrong pipeline's rows.
    const rows = [pipelineRow(6001, OTHER_HEAD), pipelineRow(PIPELINE, HEAD)];
    const failingHead = JSON.stringify([{ name: "test", status: "failed" }]);
    const { fn, calls } = mkExec({
      ...glReads(mrRow(), rows, []),
      [JOBS_CMD]: { stdout: failingHead },
    });
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(
      ev.ok === false && ev.failing.join(",") === "test",
      `the HEAD pipeline's rows decided (${JSON.stringify(ev)})`,
    );
    assert(
      calls.some((c) => c === JOBS_CMD),
      `the head pipeline's jobs were read, and only those (${JSON.stringify(calls)})`,
    );
    assert(
      !calls.some((c) => c.includes("/pipelines/6001/jobs")),
      `the other pipeline's rows were never read (${JSON.stringify(calls)})`,
    );
  });

  await check("a head_pipeline the pipelines list does not contain refuses", async () => {
    // Two rows of the same MR disagreeing is not a verdict to pick a side of.
    const { fn } = mkExec(
      glReads(mrRow({ head_pipeline: { id: 7777 } }), [pipelineRow(PIPELINE, HEAD)], GL_JOBS),
    );
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.ok === false, `refused: ${JSON.stringify(ev)}`);
    assert(/could not be identified/.test(ev.reason ?? ""), `reason: ${ev.reason}`);
    assert(
      ev.failureKind === undefined,
      `a server-side disagreement is not tooling (${ev.failureKind})`,
    );
  });

  await check(
    "the pipelines read pins its page size, so a train MR's head pipeline is not missed",
    async () => {
      // (finding 3 / #2226) The pipelines read exists to prove the MR's head
      // pipeline belongs to this MR, and the endpoint's own default is 20 rows.
      // A merge-train MR or a force-pushed MR on a busy project accumulates more
      // than that — on gitlab-org/gitlab a single MR answered 9 pipeline rows for
      // one `sha` shape and 3 for another — so with the default the row that
      // proves the attribution can sit beyond what was read, and the gate would
      // report the forge contradicting itself about a contradiction it invented.
      //
      // The row count here is deliberately OVER the page size, not at it: the
      // count is what decides whether the probe is issued, so a fixture sitting
      // AT 100 exercised the probe branch while appearing to test only the pin.
      // GitLab never answers more than `per_page` rows on one page — the arms in
      // test-merge-evidence-gl-pagination.ts put exactly 100 on page 1 and the
      // head row on page 2 — so this arm's job is the argv pin, answered from
      // the calls the gate actually issued.
      const manyPipelines = Array.from({ length: JOB_PAGE_SIZE + 1 }, (_, i) =>
        pipelineRow(7000 + i, OTHER_HEAD),
      ).concat([pipelineRow(PIPELINE, HEAD)]);
      const { fn, calls } = mkExec(
        glReads(mrRow({ head_pipeline: { id: PIPELINE } }), manyPipelines, GL_JOBS),
      );
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(
        calls.some((c) => c.includes("pipelines?per_page=100")),
        `the pipelines read pinned the page size rather than taking the 20-row default (${JSON.stringify(calls)})`,
      );
      assert(
        ev.ok === true,
        `a head pipeline past the default page is still attributed (${JSON.stringify(ev)})`,
      );
    },
  );

  await check("with no head_pipeline, a pipeline for another commit is not graded", async () => {
    const { fn } = mkExec(
      glReads(mrRow({ head_pipeline: null }), [pipelineRow(6001, OTHER_HEAD)], GL_JOBS),
    );
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.ok === false, `refused: ${JSON.stringify(ev)}`);
    assert(/none of the 1 pipeline/.test(ev.reason ?? ""), `reason: ${ev.reason}`);
  });

  await check("with no head_pipeline, two pipelines claiming one head refuses", async () => {
    const { fn } = mkExec(
      glReads(
        mrRow({ head_pipeline: null }),
        [pipelineRow(6001, HEAD), pipelineRow(PIPELINE, HEAD)],
        GL_JOBS,
      ),
    );
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.ok === false, `refused: ${JSON.stringify(ev)}`);
    assert(/2 pipelines/.test(ev.reason ?? ""), `reason: ${ev.reason}`);
  });

  // ── (finding 1 / (b)) an allow-failure job is not a refusal. ───────────
  await check(
    "a `manual` job the pipeline may fail does NOT refuse (gitlab-org/gitlab !270470 shape)",
    async () => {
      const { fn } = mkExec(
        glReads(
          mrRow(),
          [pipelineRow(PIPELINE, HEAD)],
          [
            { name: "build", status: "success", allow_failure: false },
            { name: "benchmark-markdown", status: "manual", allow_failure: true },
            { name: "deploy-production", status: "skipped", allow_failure: true },
          ],
        ),
      );
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(
        ev.ok === true,
        `an allow-failure job is green to GitLab and to this gate (${JSON.stringify(ev)})`,
      );
      assert(ev.inconclusive.length === 0, `inconclusive: ${JSON.stringify(ev.inconclusive)}`);
    },
  );

  for (const status of ["failed", "canceled"]) {
    await check(`an allow_failure ${status} job still refuses`, async () => {
      // GitLab can flip allow_failure after a retry, and a job that actually
      // ran and failed said something negative about the code — that is not
      // exempted by a field that means "the pipeline may still merge".
      const { fn } = mkExec(
        glReads(
          mrRow(),
          [pipelineRow(PIPELINE, HEAD)],
          [
            { name: "smoke", status: "success", allow_failure: false },
            { name: "e2e", status, allow_failure: true },
          ],
        ),
      );
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      assert(ev.ok === false && ev.failing.join(",") === "e2e", `${status}: ${JSON.stringify(ev)}`);
    });
  }

  for (const status of ["manual", "skipped"]) {
    for (const [label, allowFailure] of [
      ["absent", undefined],
      ["false", false],
    ] as const) {
      await check(`a \`${status}\` job with allow_failure ${label} refuses`, async () => {
        const row: Record<string, unknown> = { name: "release", status };
        if (allowFailure !== undefined) row.allow_failure = allowFailure;
        const { fn } = mkExec(glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], [row]));
        const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
        assert(
          ev.ok === false && ev.inconclusive.join(",") === "release",
          `${status}/allow_failure=${label}: ${JSON.stringify(ev)}`,
        );
      });
    }
  }

  await check("every GitLab job state is graded by the one table", async () => {
    const cases: Array<[string, "pass" | "fail" | "pending" | "not-green" | "unknown"]> = [
      ["success", "pass"],
      ["failed", "fail"],
      ["canceled", "fail"],
      ["running", "pending"],
      ["pending", "pending"],
      ["created", "pending"],
      ["waiting_for_resource", "pending"],
      ["waiting_for_callback", "pending"],
      ["canceling", "pending"],
      ["preparing", "pending"],
      ["scheduled", "pending"],
      ["skipped", "not-green"],
      ["manual", "not-green"],
      ["brand_new_state", "unknown"],
    ];
    for (const [status, grade] of cases) {
      const { fn } = mkExec(
        glReads(
          mrRow(),
          [pipelineRow(PIPELINE, HEAD)],
          [{ name: "job", status, allow_failure: false }],
        ),
      );
      const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
      switch (grade) {
        case "pass":
          assert(ev.ok === true, `${status}: ${JSON.stringify(ev)}`);
          break;
        case "fail":
          assert(
            ev.ok === false && ev.failing.join(",") === "job",
            `${status}: ${JSON.stringify(ev)}`,
          );
          assert(ev.failureKind === undefined, `${status} is a verdict (${ev.failureKind})`);
          break;
        case "pending":
          assert(
            ev.ok === false && /running/i.test(ev.reason ?? "") && ev.failing.length === 0,
            `${status}: ${JSON.stringify(ev)}`,
          );
          break;
        case "not-green":
          assert(
            ev.ok === false && ev.inconclusive.join(",") === "job",
            `${status}: ${JSON.stringify(ev)}`,
          );
          assert(ev.failureKind === undefined, `${status} is a verdict (${ev.failureKind})`);
          break;
        case "unknown":
          assert(
            ev.unrecognised?.join(",") === "job" && ev.ok === false,
            `${status}: ${JSON.stringify(ev)}`,
          );
          break;
      }
    }
  });

  await check("a job read that throws refuses as tooling, never as a CI verdict", async () => {
    const { fn } = mkExec({
      ...glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], []),
      [JOBS_CMD]: { error: true, stderr: "glab: connection reset" },
    });
    const ev = await gatherMergeEvidence(fn, "/x", MR, "gitlab");
    assert(ev.ok === false, `refused: ${JSON.stringify(ev)}`);
    assert(ev.failureKind === "tooling", `failureKind: ${ev.failureKind}`);
  });

  forgeExitCode("All GitLab merge-evidence tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
