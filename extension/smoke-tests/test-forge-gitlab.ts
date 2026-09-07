/**
 * test-forge-gitlab.ts — offline smoke test for the GitLab (glab) path of
 * the forge adapter (S2 of epic #608).
 *
 * Covers every operation for the GitLab forge with mocked `glab` CLI output:
 *   - field mapping (iid, description, opened, source_branch, web_url — snake_case)
 *   - issue view/create/edit/comment/search
 *   - MR view/list/create/merge/diff/checks
 *   - merge readiness (detailed_merge_status composition + fail-closed)
 *   - label ops (add_labels/remove_labels on PUT)
 *   - repo settings (merge_method + squash_option enum derivation)
 *   - command-string invariants (SAFETY-CRITICAL: --auto-merge=false)
 *
 * Run: cd extension && bun run smoke-tests/test-forge-gitlab.ts
 */

import {
  composeGlReadiness,
  createForge,
  forgeCommands,
  mapGlIssue,
  mapGlMr,
  mapGlPipelineJobs,
  mapGlRepo,
} from "../src/forge.ts";
import {
  GL_ISSUE,
  GL_JOBS,
  GL_MR,
  GL_MR_CHECKING,
  GL_MR_VIEW,
  GL_PROJECT,
  glDetection,
  mkExec,
} from "./forge-fixtures.ts";

let exitCode = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok: ${name}`))
    .catch((e) => {
      console.error(`  FAIL: ${name} — ${e?.message ?? e}`);
      exitCode = 1;
    });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const owner = "acme";
  const repo = "widget";
  const det = glDetection(owner, repo);

  // ── Command-string invariants (the test seam) ──────────────────────────
  console.log("command strings:");
  await check("SAFETY: prMergeCmd ALWAYS passes --auto-merge=false on GitLab", () => {
    for (const method of ["squash", "merge", "rebase"] as const) {
      const cmd = forgeCommands.prMergeCmd("gitlab", 17, method);
      assert(cmd.includes("--auto-merge=false"), `${method}: missing --auto-merge=false: ${cmd}`);
      assert(cmd.includes(`--${method}`), `${method}: missing --${method}: ${cmd}`);
    }
  });
  await check("prCreateCmd uses --target-branch (no --head flag)", () => {
    const cmd = forgeCommands.prCreateCmd("gitlab", "T", "branch", "/tmp/b", "main");
    assert(cmd.includes("--target-branch main"), `got ${cmd}`);
    assert(!cmd.includes("--head"), `should not have --head: ${cmd}`);
    assert(cmd.includes("glab mr create branch"), `positional source branch: ${cmd}`);
  });
  await check("issueEditCmd uses glab api -X PUT with description=@file", () => {
    const cmd = forgeCommands.issueEditCmd("gitlab", 42, "/tmp/x/body.md");
    assert(cmd.includes("-X PUT"), `got ${cmd}`);
    assert(cmd.includes("description=@/tmp/x/body.md"), `description=@file: ${cmd}`);
    assert(cmd.includes("/projects/:id/issues/42"), `path: ${cmd}`);
  });
  await check("issueCommentCmd uses POST .../notes", () => {
    const cmd = forgeCommands.issueCommentCmd("gitlab", 42, "/tmp/c");
    assert(cmd.includes("--method POST"), `got ${cmd}`);
    assert(cmd.includes("/projects/:id/issues/42/notes"), `path: ${cmd}`);
  });
  await check("prListCmd uses --source-branch for GitLab", () => {
    const cmd = forgeCommands.prListCmd("gitlab", { sourceBranch: "feature/x" });
    assert(cmd.includes("--source-branch feature/x"), `got ${cmd}`);
  });
  await check("labelAddCmd uses add_labels on issue PUT", () => {
    const cmd = forgeCommands.labelAddCmd("gitlab", "issue", 42, "bug");
    assert(cmd.includes("-X PUT"), `got ${cmd}`);
    assert(cmd.includes("add_labels=bug"), `add_labels: ${cmd}`);
    assert(cmd.includes("/projects/:id/issues/42"), `path: ${cmd}`);
  });
  await check("labelRemoveCmd uses remove_labels on issue PUT", () => {
    const cmd = forgeCommands.labelRemoveCmd("gitlab", "issue", 42, "bug");
    assert(cmd.includes("-X PUT"), `got ${cmd}`);
    assert(cmd.includes("remove_labels=bug"), `remove_labels: ${cmd}`);
  });

  // ── Issue operations ────────────────────────────────────────────────────
  console.log("issues:");
  {
    const { fn } = mkExec({
      "glab issue view 42": {
        stdout: JSON.stringify({
          ...GL_ISSUE,
          labels: [{ name: "bug", color: "d73a4a" }],
        }),
      },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueView normalizes iid→number, description→body, opened→OPEN", async () => {
      const issue = await forge.issueView(42);
      assert(issue.number === 42, `number ${issue.number}`);
      assert(issue.body === "the issue body", `body ${issue.body}`);
      assert(issue.state === "OPEN", `state ${issue.state}`);
      assert(issue.url === "https://gitlab.com/acme/widget/-/issues/42", `url ${issue.url}`);
      assert(issue.labels[0]!.name === "bug", `labels ${issue.labels[0]!.name}`);
      assert(issue.author === "janni", `author ${issue.author}`);
    });
  }

  {
    const { fn, calls } = mkExec({
      "glab api -X PUT": { stdout: JSON.stringify(GL_ISSUE) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueEdit uses glab api -X PUT with description=@file", async () => {
      const issue = await forge.issueEdit(42, "edited");
      assert(issue.number === 42, "round-tripped");
      const cmd = calls.find((c) => c.includes("glab api -X PUT"));
      assert(cmd !== undefined, `no PUT cmd: ${calls}`);
      assert(cmd!.includes("description=@"), `description=@file: ${cmd}`);
    });
  }

  {
    const { fn, calls } = mkExec({
      "glab api --method POST": {
        stdout: JSON.stringify({ id: 99, body: "a comment", created_at: "2026-09-03T00:00:00Z" }),
      },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueComment uses POST .../notes", async () => {
      const out = await forge.issueComment(42, "a comment");
      assert(out.includes("id"), `got ${out}`);
      const cmd = calls.find((c) => c.includes("/projects/:id/issues/42/notes"));
      assert(cmd !== undefined, `no notes cmd: ${calls}`);
    });
  }

  {
    const { fn } = mkExec({
      "glab issue list --search": { stdout: JSON.stringify([GL_ISSUE]) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueSearch returns an array", async () => {
      const issues = await forge.issueSearch("bug");
      assert(issues.length === 1, `len ${issues.length}`);
      assert(issues[0]!.number === 42, "first");
    });
  }

  // ── MR operations ───────────────────────────────────────────────────────
  console.log("merge requests:");
  {
    const { fn } = mkExec({
      "glab mr view 17": { stdout: JSON.stringify(GL_MR_VIEW) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("mrView normalizes source_branch→headRefName, web_url→url", async () => {
      const mr = await forge.prView(17);
      assert(mr.number === 17, "number");
      assert(mr.headRefName === "feature/issue-17-x", `head ${mr.headRefName}`);
      assert(mr.baseRefName === "main", `base ${mr.baseRefName}`);
      assert(mr.state === "OPEN", `state ${mr.state}`);
      assert(mr.url.includes("gitlab.com"), `url ${mr.url}`);
    });
  }

  {
    const { fn, calls } = mkExec({
      "glab mr create branch": { stdout: JSON.stringify(GL_MR) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("mrCreate uses positional source + --target-branch", async () => {
      const mr = await forge.prCreate("T", "branch", "body", "main");
      assert(mr.number === 17, "round-tripped");
      const cmd = calls.find((c) => c.includes("glab mr create"));
      assert(cmd !== undefined, `no create cmd: ${calls}`);
      assert(cmd!.includes("--target-branch main"), `--target-branch: ${cmd}`);
      assert(cmd!.includes("--description-file"), `--description-file: ${cmd}`);
    });
  }

  {
    const { fn, calls } = mkExec({
      "glab mr merge 17": { stdout: "Merged !17" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("mrMerge ALWAYS passes --auto-merge=false (SAFETY)", async () => {
      const out = await forge.prMerge(17);
      assert(out.includes("Merged"), `got ${out}`);
      const cmd = calls.find((c) => c.includes("glab mr merge"));
      assert(cmd !== undefined, `no merge cmd: ${calls}`);
      assert(cmd!.includes("--auto-merge=false"), `SAFETY: missing --auto-merge=false: ${cmd}`);
    });
  }

  {
    const { fn } = mkExec({
      "glab mr diff 17": { stdout: "diff --git a/foo b/foo" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("mrDiff returns the diff text", async () => {
      const diff = await forge.prDiff(17);
      assert(diff.includes("diff --git"), `got ${diff}`);
    });
  }

  {
    const { fn } = mkExec({
      "glab api /projects/:id/merge_requests/17/pipelines": {
        stdout: JSON.stringify([{ id: 5001, status: "running" }]),
      },
      "glab api /projects/:id/pipelines/5001/jobs": { stdout: JSON.stringify(GL_JOBS) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prChecks lists the open pipeline's jobs", async () => {
      const checks = await forge.prChecks(17);
      assert(checks.length === 2, `len ${checks.length}`);
      assert(checks[0]!.name === "build", "first name");
      assert(checks[0]!.state === "SUCCESS", `state ${checks[0]!.state}`);
    });
  }

  // ── Merge readiness (GitLab composition) ────────────────────────────────
  console.log("merge readiness (GitLab):");
  {
    const { fn } = mkExec({
      "glab api /projects/:id/merge_requests/17": { stdout: JSON.stringify(GL_MR) },
      "glab api /projects/:id/pipelines/5001/jobs": { stdout: JSON.stringify(GL_JOBS) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness CLEAN when can_be_merged + no conflicts + approvals=0", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok, `ok: ${result.ok ? "" : result.reason}`);
      if (result.ok) {
        assert(result.readiness === "CLEAN", `readiness ${result.readiness}`);
        assert(result.detail.includes("can_be_merged"), `detail ${result.detail}`);
      }
    });
  }

  {
    const { fn } = mkExec({
      "glab api /projects/:id/merge_requests/17": { stdout: JSON.stringify(GL_MR_CHECKING) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness UNKNOWN when detailed_merge_status=checking", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok, `ok: ${result.ok ? "" : result.reason}`);
      if (result.ok) {
        assert(result.readiness === "UNKNOWN", `readiness ${result.readiness}`);
      }
    });
  }

  {
    const conflicted = { ...GL_MR, detailed_merge_status: "has_conflicts", has_conflicts: true };
    const { fn } = mkExec({
      "glab api /projects/:id/merge_requests/17": { stdout: JSON.stringify(conflicted) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness DIRTY when has_conflicts", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok, `ok: ${result.ok ? "" : result.reason}`);
      if (result.ok) assert(result.readiness === "DIRTY", `readiness ${result.readiness}`);
    });
  }

  {
    const blocked = {
      ...GL_MR,
      detailed_merge_status: "blocked_by_discussions",
      blocking_discussions_resolved: false,
    };
    const { fn } = mkExec({
      "glab api /projects/:id/merge_requests/17": { stdout: JSON.stringify(blocked) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness fails closed when discussions unresolved + status blocked", async () => {
      const result = await forge.mergeReadiness(17);
      // blocked_by_discussions → DIRTY, but blocking_discussions_resolved=false
      // contradicts it → fail closed.
      assert(result.ok === false, `should fail: ${JSON.stringify(result)}`);
    });
  }

  {
    const missingField = { ...GL_MR };
    delete (missingField as Record<string, unknown>).approvals_left;
    const { fn } = mkExec({
      "glab api /projects/:id/merge_requests/17": { stdout: JSON.stringify(missingField) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness fails closed when approvals_left missing", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok === false, `should fail: ${JSON.stringify(result)}`);
      if (!result.ok) assert(result.reason.includes("approvals_left"), `reason ${result.reason}`);
    });
  }

  {
    const unknownStatus = { ...GL_MR, detailed_merge_status: "brand_new_state" };
    const { fn } = mkExec({
      "glab api /projects/:id/merge_requests/17": { stdout: JSON.stringify(unknownStatus) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness fails closed on unmapped detailed_merge_status", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok === false, `should fail: ${JSON.stringify(result)}`);
      if (!result.ok) assert(result.reason.includes("brand_new_state"), `reason ${result.reason}`);
    });
  }

  {
    const { fn } = mkExec({
      "glab api /projects/:id/merge_requests/17": { error: true, stderr: "404 Not Found" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness fails closed on API error", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok === false, "should fail");
    });
  }

  // ── composeGlReadiness (direct, table-driven) ───────────────────────────
  console.log("composeGlReadiness table:");
  const cases: Array<[string, boolean, boolean, number, string]> = [
    ["can_be_merged", false, true, 0, "CLEAN"],
    ["succeeding", false, true, 0, "CLEAN"],
    ["has_conflicts", true, true, 0, "DIRTY"],
    ["blocked_by_discussions", false, false, 0, "FAIL"],
    ["blocked_by_pipeline_status", false, true, 0, "DIRTY"],
    ["checking", false, true, 0, "UNKNOWN"],
    ["unknown_state", false, true, 0, "FAIL"],
  ];
  for (const [status, conflicts, discussions, approvals, expected] of cases) {
    await check(`  ${status} → ${expected}`, () => {
      try {
        const result = composeGlReadiness({
          detailed_merge_status: status,
          has_conflicts: conflicts,
          blocking_discussions_resolved: discussions,
          approvals_left: approvals,
          state: "opened",
        });
        if (expected === "FAIL") {
          // composeGlReadiness throws on contradiction/unknown
          throw new Error("should have thrown");
        }
        assert(result.readiness === expected, `got ${result.readiness}`);
      } catch (e) {
        if (expected === "FAIL") {
          // Expected to throw — verify the error message is reasonable
          const msg = (e as Error).message;
          if (status === "unknown_state") {
            assert(msg.includes("unmapped"), `wrong error: ${msg}`);
          } else if (status === "blocked_by_discussions") {
            assert(msg.includes("blocking_discussions_resolved"), `wrong error: ${msg}`);
          }
        } else {
          throw e;
        }
      }
    });
  }

  // ── Labels ──────────────────────────────────────────────────────────────
  console.log("labels:");
  {
    const { fn, calls } = mkExec({
      "glab api -X PUT": { stdout: "" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("labelAdd uses add_labels (auto-creates missing)", async () => {
      await forge.labelAdd("issue", 42, "new-label");
      const cmd = calls.find((c) => c.includes("add_labels=new-label"));
      assert(cmd !== undefined, `no add_labels: ${calls}`);
    });
  }
  {
    const { fn, calls } = mkExec({
      "glab api -X PUT": { stdout: "" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("labelRemove uses remove_labels", async () => {
      await forge.labelRemove("issue", 42, "old-label");
      const cmd = calls.find((c) => c.includes("remove_labels=old-label"));
      assert(cmd !== undefined, `no remove_labels: ${calls}`);
    });
  }

  // ── Repo settings ───────────────────────────────────────────────────────
  console.log("repo settings:");
  {
    const { fn } = mkExec({
      "glab api /projects/:id": { stdout: JSON.stringify(GL_PROJECT) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("repoSettings derives booleans from merge_method + squash_option", async () => {
      const repo = await forge.repoSettings();
      assert(repo.name === "acme/widget", `name ${repo.name}`);
      assert(repo.squashMergeAllowed === true, "squash");
      assert(repo.mergeCommitAllowed === false, "merge (method=squash)");
      assert(repo.rebaseMergeAllowed === false, "rebase (not on GL)");
      assert(repo.mergeMethod === "squash", `method ${repo.mergeMethod}`);
      assert(repo.squashOption === "squash_and_commit", `option ${repo.squashOption}`);
    });
  }

  // ── Mappers (direct) ────────────────────────────────────────────────────
  console.log("mappers:");
  await check("mapGlIssue throws on missing iid", () => {
    try {
      mapGlIssue({ title: "x", description: "y", state: "opened", web_url: "u" } as Record<
        string,
        unknown
      >);
      throw new Error("should have thrown");
    } catch (e) {
      assert((e as Error).message.includes("iid"), `wrong error: ${(e as Error).message}`);
    }
  });
  await check("mapGlMr normalizes", () => {
    const mr = mapGlMr(GL_MR as Record<string, unknown>);
    assert(mr.number === 17, "number");
    assert(mr.headRefName === "feature/issue-17-x", "head");
    assert(mr.baseRefName === "main", "base");
    assert(mr.state === "OPEN", "state");
  });
  await check("mapGlPipelineJobs uppercases status", () => {
    const jobs = mapGlPipelineJobs(GL_JOBS as unknown);
    assert(jobs[0]!.state === "SUCCESS", `state ${jobs[0]!.state}`);
  });
  await check("mapGlRepo derives squash from method", () => {
    const r = mapGlRepo(GL_PROJECT as Record<string, unknown>);
    assert(r.squashMergeAllowed === true, "squash");
    assert(r.mergeCommitAllowed === false, "merge");
  });

  console.log("");
  if (exitCode !== 0) {
    console.error("FAILURES — see above");
    process.exit(1);
  }
  console.log("All forge-gitlab tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
