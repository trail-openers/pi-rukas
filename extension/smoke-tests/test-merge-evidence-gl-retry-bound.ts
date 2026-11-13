#!/usr/bin/env bun
/**
 * #2226 — the three ways the GitLab evidence gate could report a verdict it
 * never earned, plus the two ways it could hang or fall through.
 *
 * Sibling of `test-merge-evidence-gl-pagination.ts` (read completeness) and
 * `test-merge-evidence-gl-pipeline-sha.ts` (attribution). This file is the
 * RETRY-REPLACEMENT, READ-BOUND and FORGE-DISPATCH seam.
 *
 *   - The unrun retry. `currentJobAttempts` collapses a job's history to one
 *     row per NAME by highest id, and the id rule is GitLab's own statement that
 *     the newer row is the retry of the older one. It is only that statement for
 *     a row that RAN: a `manual`/`skipped` row (which `allow_failure: true`
 *     grades `pass`) has never executed, so it cannot be the retry that retires
 *     a `failed` attempt — and the collapse let it take the seat, reporting a red
 *     pipeline green. A genuine retry (failed, then a newer success) stays green.
 *   - The unbounded reads. `readGlList`, `probeSecondPage` and the MR read all
 *     passed `maxBuffer` alone, so a `glab` that never returned held the caller
 *     open forever; only the merge guard bounded the whole gather from outside.
 *     Every read now carries the shared forge-exec bound, and a read that times
 *     out is a tooling refusal, never a verdict.
 *   - The unresolved forge. `gatherMergeEvidence` branched on `"gitlab"` and
 *     fell through to the gh path for everything else, `unknown` included — so a
 *     repo whose remote does not resolve ran `gh` against a GitLab project and
 *     reported whatever came back. The branch is now positive in both directions.
 *   - The dead spread. The `ok: true` return spread `unrecognised` conditionally
 *     after the refusal above already returned on a non-empty list, so the arm
 *     could never add the field.
 */

import { mergeEvidenceGlMrCmd } from "../src/forge-commands-gl-evidence.ts";
import { FORGE_EXEC_TIMEOUT_MS } from "../src/forge-detect.ts";
import { currentJobAttempts, gradeGlJobRow } from "../src/forge-gl-grade.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { gatherMergeEvidence } from "../src/work-driver-merge-evidence.ts";
import { mkExec } from "./forge-fixtures.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";
import {
  HEAD,
  JOBS_PAGE2_CMD,
  PIPELINE,
  glReads,
  jobRow,
  mrRow,
  pipelineRow,
} from "./merge-evidence-gl-fixtures.ts";

const statuses = (rows: unknown[]) =>
  rows.map((r) => (r as { status?: unknown })?.status ?? "(no status)");

/** A row the pipeline carried but never ran, marked non-blocking. */
const unrunRow = (name: string, id: number, status = "manual") => ({
  name,
  status,
  allow_failure: true,
  id,
});

async function main() {
  console.log("merge evidence (GitLab) — unrun retries, bounded reads, forge dispatch:");

  // ── 1. An unrun newer row may not retire an older failure. ──────────────
  await check(
    "a newer allow-failure manual row does not hide the older failed attempt of the same name",
    async () => {
      // Both rows carry the name, so the id rule alone hands the seat to id 2.
      // But id 2 never executed: `manual` + `allow_failure: true` grades `pass`
      // without a job having run, and a job nobody pressed play on is not the
      // retry that retires a red run. Before the rule the gate read the pass and
      // reported the pipeline green.
      const rows = [jobRow("test", "failed", false, 10), unrunRow("test", 11)];
      const kept = currentJobAttempts(rows);
      assert(
        kept.some((r) => gradeGlJobRow(r as Record<string, unknown>) === "fail"),
        `the failed attempt survives the collapse: ${JSON.stringify(statuses(kept))}`,
      );
      const { fn } = mkExec(glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], rows));
      const ev = await gatherMergeEvidence(fn, "/x", 17, "gitlab");
      assert(ev.ok === false, `an unrun retry is not a green pipeline (${JSON.stringify(ev)})`);
      assert(
        ev.failing.join(",") === "test",
        `the refusal names the failed job: ${JSON.stringify(ev.failing)}`,
      );
    },
  );

  await check(
    "a newer allow-failure skipped row does not hide the older failed attempt either",
    async () => {
      // `skipped` is the other never-ran state the exemption covers, so the
      // hole is the same shape through a different spelling.
      const rows = [jobRow("lint", "failed", false, 20), unrunRow("lint", 21, "skipped")];
      const { fn } = mkExec(glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], rows));
      const ev = await gatherMergeEvidence(fn, "/x", 17, "gitlab");
      assert(
        ev.ok === false && ev.failing.join(",") === "lint",
        `skipped is not a retry: ${JSON.stringify(ev)}`,
      );
    },
  );

  await check(
    "a genuine retry — a newer success after a failed attempt — still passes",
    async () => {
      // The reason the collapse exists at all. GitLab's higher id IS its
      // statement that this job ran again and passed, so the failure is retired
      // and the pilot's green MR lands.
      const rows = [jobRow("test", "failed", false, 10), jobRow("test", "success", false, 11)];
      const kept = currentJobAttempts(rows);
      assert(
        kept.length === 1 &&
          kept.every((r) => gradeGlJobRow(r as Record<string, unknown>) === "pass"),
        `the retry takes the seat: ${JSON.stringify(statuses(kept))}`,
      );
      const { fn } = mkExec(glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], rows));
      const ev = await gatherMergeEvidence(fn, "/x", 17, "gitlab");
      assert(ev.ok === true, `a retried-away failure is green (${JSON.stringify(ev)})`);
    },
  );

  await check(
    "a newer CANCELED attempt does not hide the older failure (it ran, and said no)",
    async () => {
      // `canceled` is a state that executed — the rule is about running, not
      // about who ended the run — so it keeps the seat and stays a refusal.
      const rows = [jobRow("build", "failed", false, 30), jobRow("build", "canceled", false, 31)];
      const kept = currentJobAttempts(rows);
      assert(
        kept.length === 1 &&
          kept.every((r) => gradeGlJobRow(r as Record<string, unknown>) === "fail"),
        `the cancel is the current attempt: ${JSON.stringify(statuses(kept))}`,
      );
      const { fn } = mkExec(glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], rows));
      const ev = await gatherMergeEvidence(fn, "/x", 17, "gitlab");
      assert(
        ev.ok === false && ev.failing.join(",") === "build",
        `a canceled current attempt refuses: ${JSON.stringify(ev)}`,
      );
    },
  );

  await check(
    "a newer PENDING attempt does not hide the older failure (unreported is not a verdict)",
    async () => {
      // A retry still queued has said nothing yet, so the last thing this job
      // said was "failed". The current attempt is the queued one, which the
      // gatherer refuses on as pending rather than grading the retired failure.
      const rows = [jobRow("e2e", "failed", false, 40), jobRow("e2e", "pending", false, 41)];
      const kept = currentJobAttempts(rows);
      assert(
        kept.length === 1 &&
          kept.every((r) => gradeGlJobRow(r as Record<string, unknown>) === "pending"),
        `the queued retry is the current attempt: ${JSON.stringify(statuses(kept))}`,
      );
      const { fn } = mkExec(glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], rows));
      const ev = await gatherMergeEvidence(fn, "/x", 17, "gitlab");
      assert(ev.ok === false, `an unreported retry is no verdict (${JSON.stringify(ev)})`);
    },
  );

  await check(
    "a failed job beside an unrelated manual job still refuses (the collapse is per name)",
    async () => {
      // The narrowness guard: the rule must not start keeping every row of every
      // name. `deploy` never ran, `test` failed; the gate names the failure and
      // never claims the manual row as a retry of it.
      const rows = [jobRow("test", "failed", false, 50), unrunRow("deploy", 51)];
      const kept = currentJobAttempts(rows);
      assert(kept.length === 2, `two names, two seats: ${JSON.stringify(statuses(kept))}`);
      const { fn } = mkExec(glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], rows));
      const ev = await gatherMergeEvidence(fn, "/x", 17, "gitlab");
      assert(
        ev.ok === false && ev.failing.join(",") === "test",
        `the failing name is still named: ${JSON.stringify(ev)}`,
      );
    },
  );

  // ── 2. Every read carries the shared bound, and a timeout is tooling. ───
  await check("every GitLab read carries the shared forge-exec timeout", async () => {
    // `maxBuffer` alone bounds the ANSWER, never the wait: a glab that hangs
    // held the caller open forever (only the merge guard bounded the gather
    // from outside, and lean land / the merged step have no such wrapper).
    const { fn, opts } = mkExec(
      glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], [jobRow("a", "success")]),
    );
    await gatherMergeEvidence(fn, "/x", 17, "gitlab");
    assert(opts.length >= 3, `the gatherer issued ${opts.length} reads`);
    const unbounded = opts.filter((o) => o?.timeout !== FORGE_EXEC_TIMEOUT_MS);
    assert(
      unbounded.length === 0,
      `every read carries timeout=${FORGE_EXEC_TIMEOUT_MS} (${JSON.stringify(opts)})`,
    );
  });

  await check("a page-2 probe that times out is a tooling refusal, not a CI verdict", async () => {
    // The probe is the read whose failure the gate must not read as "there are
    // more jobs" (a CI verdict) nor as "the page was the whole list" (a pass).
    const jobs = Array.from({ length: 100 }, (_unused, i) => jobRow(`job-${i}`, "success"));
    const reads = glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], jobs);
    const exec: VerifyExecFn = async (cmd) => {
      if (cmd === JOBS_PAGE2_CMD) {
        const e = new Error("timeout of 30000ms exceeded") as Error & { killed?: boolean };
        e.killed = true;
        throw e;
      }
      const hit = Object.entries(reads).find(([k]) => cmd.includes(k));
      return { stdout: hit?.[1]?.stdout ?? "" };
    };
    const ev = await gatherMergeEvidence(exec, "/x", 17, "gitlab");
    assert(ev.ok === false, `a hung probe refuses (${JSON.stringify(ev)})`);
    assert(
      ev.failureKind === "tooling",
      `an unreadable follow-up is tooling, not a verdict (${ev.failureKind}: ${ev.reason})`,
    );
    assert(/second page/.test(ev.reason ?? ""), `names the probe it lost: ${ev.reason}`);
  });

  await check("an MR-state read that times out is a tooling refusal", async () => {
    // The full argv, not a substring: `glab api /projects/:id/merge_requests/17`
    // is also the prefix of the pipelines endpoint, and a substring matcher
    // would let the MR row answer the pipelines read too.
    const exec: VerifyExecFn = async (cmd) => {
      if (cmd === mergeEvidenceGlMrCmd(17)) {
        const e = new Error("timeout of 30000ms exceeded") as Error & { killed?: boolean };
        e.killed = true;
        throw e;
      }
      return { stdout: "[]" };
    };
    const ev = await gatherMergeEvidence(exec, "/x", 17, "gitlab");
    assert(
      ev.ok === false && ev.failureKind === "tooling",
      `a hung MR read refuses as tooling (${JSON.stringify(ev)})`,
    );
    assert(/MR state/.test(ev.reason ?? ""), `names the read it lost: ${ev.reason}`);
    assert(/timed out/.test(ev.reason ?? ""), `names the timeout: ${ev.reason}`);
  });

  // ── 3. An unresolved forge is a refusal, never the gh path. ─────────────
  await check("an unresolved forge refuses as tooling and issues no read at all", async () => {
    // `unknown` used to fall through to the GitHub branch, so on a repo whose
    // remote does not resolve the gate ran `gh` against whatever CLI was
    // installed and reported its answer as this merge's CI verdict.
    const { fn, calls } = mkExec({});
    const ev = await gatherMergeEvidence(fn, "/x", 17, "unknown");
    assert(ev.ok === false, `an unresolved forge is not mergeable (${JSON.stringify(ev)})`);
    assert(
      ev.failureKind === "tooling",
      `it is a tooling refusal, not a CI verdict (${ev.failureKind})`,
    );
    assert(/forge/i.test(ev.reason ?? ""), `names the unresolved forge: ${ev.reason}`);
    assert(
      calls.length === 0,
      `no read was issued against an unknown forge: ${JSON.stringify(calls)}`,
    );
  });

  await check("the branches stay positive: github reads gh, gitlab reads glab", async () => {
    // The regression guard on the dispatch itself — narrowing the fall-through
    // must not have narrowed one of the real arms with it.
    const gh = mkExec({
      "gh pr view": {
        stdout: JSON.stringify({
          mergeStateStatus: "CLEAN",
          state: "OPEN",
          headRefOid: HEAD,
        }),
      },
      "gh pr checks": { stdout: JSON.stringify([{ name: "a", bucket: "pass" }]) },
    });
    const gEv = await gatherMergeEvidence(gh.fn, "/x", 17, "github");
    assert(gEv.ok === true, `the gh arm still answers (${JSON.stringify(gEv)})`);
    assert(
      gh.calls.every((c) => c.startsWith("gh ")),
      `the github arm issued only gh reads: ${JSON.stringify(gh.calls)}`,
    );
    const gl = mkExec(
      glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], [jobRow("build", "success")]),
    );
    const lEv = await gatherMergeEvidence(gl.fn, "/x", 17, "gitlab");
    assert(lEv.ok === true, `the glab arm still answers (${JSON.stringify(lEv)})`);
    assert(
      gl.calls.every((c) => c.startsWith("glab ")),
      `the gitlab arm issued only glab reads: ${JSON.stringify(gl.calls)}`,
    );
  });

  // ── 5. The ok:true return reports no unrecognised rows, because it has none. ─
  await check(
    "a green GitLab verdict carries no unrecognised field (the arm above already refused)",
    async () => {
      const { fn } = mkExec(
        glReads(mrRow(), [pipelineRow(PIPELINE, HEAD)], [jobRow("build", "success")]),
      );
      const ev = await gatherMergeEvidence(fn, "/x", 17, "gitlab");
      assert(ev.ok === true, `green (${JSON.stringify(ev)})`);
      assert(
        ev.unrecognised === undefined,
        `an ok verdict has no ungraded rows to report: ${JSON.stringify(ev.unrecognised)}`,
      );
    },
  );

  forgeExitCode("All GitLab retry/bound/forge-dispatch tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
