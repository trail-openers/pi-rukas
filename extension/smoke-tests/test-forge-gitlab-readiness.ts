/**
 * test-forge-gitlab-readiness.ts — whether a GitLab MR may merge, and on what.
 *
 * Split out of `test-forge-gitlab.ts` (§12 size cap). The seam is the question
 * these cases ask: the adapter's other operations report what the forge SAID,
 * and a wrong answer there fails loudly later. Merge readiness reports what the
 * forge ALLOWS, so a wrong answer is a merge that should not have happened —
 * which is why the composition is pinned twice here, once through the adapter
 * with the payload as the variable and once direct and table-driven. Both
 * halves are kept: the adapter path proves the fields are read, the table
 * proves the rules combine, and neither proves the other.
 *
 * Run: cd extension && bun run smoke-tests/test-forge-gitlab-readiness.ts
 */

import { composeGlReadiness, createForge } from "../src/forge.ts";
import { GL_JOBS, GL_MR, GL_MR_CHECKING, glDetection, mkExec } from "./forge-fixtures.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

async function main() {
  const owner = "acme";
  const repo = "widget";
  const det = glDetection(owner, repo);


  // ── Merge readiness (GitLab composition) ────────────────────────────────
  // Each case gets its own exec fake; the MR payload is the variable.
  console.log("merge readiness (GitLab):");
  const readinessCase = async (
    label: string,
    mrPayload: Record<string, unknown> | { error: true; stderr: string },
    expect: { ok: boolean; readiness?: string; reasonIncludes?: string },
  ) => {
    const { fn } = mkExec({
      "glab api /projects/:id/merge_requests/17": {
        ...("error" in mrPayload ? { error: true, stderr: mrPayload.stderr } : { stdout: JSON.stringify(mrPayload) }),
      },
      "glab api /projects/:id/pipelines/5001/jobs": { stdout: JSON.stringify(GL_JOBS) },
    });
    const forge = createForge(det, { execFn: fn });
    await check(label, async () => {
      const result = await forge.mergeReadiness(17);
      if (expect.ok === false) {
        assert(result.ok === false, `should fail: ${JSON.stringify(result)}`);
        if (expect.reasonIncludes && !result.ok) {
          assert(result.reason.includes(expect.reasonIncludes), `reason ${result.reason}`);
        }
      } else {
        assert(result.ok, `ok: ${result.ok ? "" : result.reason}`);
        if (result.ok && expect.readiness) {
          assert(result.readiness === expect.readiness, `readiness ${result.readiness}`);
        }
      }
    });
  };
  // The statuses below are GitLab's OWN documented values. This suite once
  // pinned GitHub-shaped names (`can_be_merged`, `blocked_by_*`) that the API has
  // never emitted, so every case passed over a table that matched no real reply
  // while a ready MR — whose value is `mergeable` — failed closed in production.
  // The exhaustive per-value table is `test-forge-gl-detailed-status.ts`; what
  // stays here is the adapter path: that the fields are read from the REST reply.
  await readinessCase("readiness CLEAN (mergeable + no conflicts + approvals=0)", GL_MR, {
    ok: true,
    readiness: "CLEAN",
  });
  await readinessCase("readiness UNKNOWN (checking)", GL_MR_CHECKING, {
    ok: true,
    readiness: "UNKNOWN",
  });
  await readinessCase("readiness DIRTY (conflict)", {
    ...GL_MR,
    detailed_merge_status: "conflict",
    has_conflicts: true,
  }, { ok: true, readiness: "DIRTY" });
  await readinessCase("readiness fails closed (discussions unresolved + status says so)", {
    ...GL_MR,
    detailed_merge_status: "discussions_not_resolved",
    blocking_discussions_resolved: false,
  }, { ok: false });
  // The single-MR reply has never carried `approvals_left` (that number lives on
  // `/merge_requests/:iid/approvals`), so its absence is the NORMAL reply, not a
  // malformed one — the case this line replaced demanded the key and therefore
  // failed every real MR closed. Its absence is CLEAN; a value that is present
  // but not a number is still refused naming the field.
  await readinessCase("readiness CLEAN (mergeable, no approvals_left in the reply)", (() => {
    const m = { ...GL_MR };
    delete (m as Record<string, unknown>).approvals_left;
    return m;
  })(), { ok: true, readiness: "CLEAN" });
  await readinessCase("readiness fails closed (approvals_left present but not a number)", {
    ...GL_MR,
    approvals_left: "0",
  }, { ok: false, reasonIncludes: "approvals_left" });
  await readinessCase("readiness fails closed (unmapped detailed_merge_status)", {
    ...GL_MR,
    detailed_merge_status: "brand_new_state",
  }, { ok: false, reasonIncludes: "brand_new_state" });
  await readinessCase("readiness fails closed (API error)", { error: true, stderr: "404 Not Found" }, {
    ok: false,
  });

  // ── composeGlReadiness (direct, table-driven) ───────────────────────────
  console.log("composeGlReadiness table:");
  const cases: Array<[string, boolean, boolean, number, string]> = [
    ["mergeable", false, true, 0, "CLEAN"],
    ["conflict", true, true, 0, "DIRTY"],
    ["discussions_not_resolved", false, false, 0, "FAIL"],
    ["ci_must_pass", false, true, 0, "DIRTY"],
    ["checking", false, true, 0, "UNKNOWN"],
    ["unknown_state", false, true, 0, "FAIL"],
  ];
  for (const [status, conflicts, discussions, approvals, expected] of cases) {
    await check(`  ${status} → ${expected}`, () => {
      let threw: string | undefined;
      let readiness: string | undefined;
      try {
        readiness = composeGlReadiness({
          detailed_merge_status: status,
          has_conflicts: conflicts,
          blocking_discussions_resolved: discussions,
          approvals_left: approvals,
          state: "opened",
        }).readiness;
      } catch (e) {
        threw = (e as Error).message;
      }
      if (expected === "FAIL") {
        assert(threw !== undefined, "should have thrown");
        if (status === "unknown_state") assert(threw!.includes("unmapped"), `wrong: ${threw}`);
        if (status === "discussions_not_resolved") {
          assert(threw!.includes("blocking_discussions_resolved"), `wrong: ${threw}`);
        }
      } else {
        assert(readiness === expected, `got ${readiness}`);
      }
    });
  }

  forgeExitCode("All forge-gitlab readiness tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
