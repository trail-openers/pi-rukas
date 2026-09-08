// test-forge-gitlab.ts — GitLab (glab) forge path, offline smoke test (epic #608 S2).
// Direct-mapper + parsePrNumberFromResponse shape tests: test-forge-mapping-shapes.ts.

import { composeGlReadiness, createForge, forgeCommands } from "../src/forge.ts";
import { GL_ISSUE, GL_JOBS, GL_MR, GL_MR_CHECKING, GL_MR_VIEW, GL_PIPELINE_DONE, GL_PIPELINE_RUNNING, GL_PROJECT, glDetection, mkExec } from "./forge-fixtures.ts";

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
  await check("labelCreateCmd uses glab api -X POST /labels", () => {
    const cmd = forgeCommands.labelCreateCmd("gitlab", "needs-human-attention", "FFAA00");
    assert(cmd.includes("-X POST"), `got ${cmd}`);
    assert(cmd.includes("/projects/:id/labels"), `path: ${cmd}`);
    assert(cmd.includes("name=needs-human-attention"), `name: ${cmd}`);
  });
  await check("issueCreateCmd passes description as @file", () => {
    const cmd = forgeCommands.issueCreateCmd("gitlab", "T", "/tmp/b");
    assert(cmd.includes("@/tmp/b"), `description=@file: ${cmd}`);
  });

  // ── Issue operations ────────────────────────────────────────────────────
  console.log("issues:");
  {
    const { fn, calls } = mkExec({
      "glab issue view 42": {
        stdout: JSON.stringify({ ...GL_ISSUE, labels: [{ name: "bug", color: "d73a4a" }] }),
      },
      "glab api -X PUT": { stdout: JSON.stringify(GL_ISSUE) },
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
      "glab issue list --search": { stdout: JSON.stringify([GL_ISSUE]) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueComment uses POST .../notes", async () => {
      const out = await forge.issueComment(42, "a comment");
      assert(out.includes("id"), `got ${out}`);
      assert(calls.some((c) => c.includes("/projects/:id/issues/42/notes")), `no notes: ${calls}`);
    });
    await check("issueSearch returns an array", async () => {
      const issues = await forge.issueSearch("bug");
      assert(issues.length === 1 && issues[0]!.number === 42, `len ${issues.length}`);
    });
  }

  {
    const { fn, calls } = mkExec({
      "glab issue create": { stdout: JSON.stringify(GL_ISSUE) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueCreate passes -t title and description=@file", async () => {
      const issue = await forge.issueCreate("A new issue", "the body");
      assert(issue.number === 42, "round-tripped");
      const cmd = calls.find((c) => c.includes("glab issue create"));
      assert(cmd !== undefined, `no create cmd: ${calls}`);
      assert(cmd!.includes("-t "), `--title: ${cmd}`);
      assert(cmd!.includes("A new issue"), `--title value: ${cmd}`);
      assert(cmd!.includes("-d @"), `description=@file: ${cmd}`);
      assert(!cmd!.includes("the body"), "body must not be inlined in the command");
    });
  }

  {
    // glab issue create (no --output json) prints a BARE URL line on stdout —
    // the same defect class this branch fixes on the GitHub path: the mapper
    // must tolerate the plain-URL shape, not only JSON.
    const { fn } = mkExec({
      "glab issue create": { stdout: "https://gitlab.com/acme/widget/-/issues/42\n" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueCreate maps a plain-URL stdout (number 42, full url)", async () => {
      const issue = await forge.issueCreate("A new issue", "the body");
      assert(issue.number === 42, `number ${issue.number}`);
      assert(issue.url === "https://gitlab.com/acme/widget/-/issues/42", `url ${issue.url}`);
    });
    // JSON tolerance: when stdout IS JSON, the mapGlIssue path must still work.
    const { fn: fnJson } = mkExec({
      "glab issue create": { stdout: JSON.stringify(GL_ISSUE) },
    });
    const forgeJson = createForge(det, { execFn: fnJson });
    await check("issueCreate still maps JSON stdout via mapGlIssue", async () => {
      const issue = await forgeJson.issueCreate("A new issue", "the body");
      assert(issue.number === 42, `number ${issue.number}`);
      assert(issue.title === "A GitLab issue", `title ${issue.title}`);
      assert(issue.state === "OPEN", `state ${issue.state}`);
      assert(issue.body === "the issue body", `body ${issue.body}`);
    });
    // A non-URL, non-JSON stdout must reject — NOT map silently to number 0.
    const { fn: fnGarbage } = mkExec({
      "glab issue create": { stdout: "some other output\n" },
    });
    const forgeGarbage = createForge(det, { execFn: fnGarbage });
    await check("issueCreate rejects (no silent number=0) on non-URL, non-JSON stdout", async () => {
      let rejected: Error | undefined;
      try {
        await forgeGarbage.issueCreate("A new issue", "the body");
      } catch (e) {
        rejected = e as Error;
      }
      assert(rejected !== undefined, "should have thrown");
      assert(
        rejected!.message.includes("could not parse"),
        `wrong error: ${rejected!.message}`,
      );
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
      "glab mr merge 17": { stdout: "Merged !17" },
      "glab mr diff 17": { stdout: "diff --git a/foo b/foo" },
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
    await check("mrMerge ALWAYS passes --auto-merge=false (SAFETY)", async () => {
      const out = await forge.prMerge(17);
      assert(out.includes("Merged"), `got ${out}`);
      const cmd = calls.find((c) => c.includes("glab mr merge"));
      assert(cmd !== undefined, `no merge cmd: ${calls}`);
      assert(cmd!.includes("--auto-merge=false"), `SAFETY: missing --auto-merge=false: ${cmd}`);
    });
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
  await readinessCase("readiness CLEAN (can_be_merged + no conflicts + approvals=0)", GL_MR, {
    ok: true,
    readiness: "CLEAN",
  });
  await readinessCase("readiness UNKNOWN (checking)", GL_MR_CHECKING, {
    ok: true,
    readiness: "UNKNOWN",
  });
  await readinessCase("readiness DIRTY (has_conflicts)", {
    ...GL_MR,
    detailed_merge_status: "has_conflicts",
    has_conflicts: true,
  }, { ok: true, readiness: "DIRTY" });
  await readinessCase("readiness fails closed (discussions unresolved + status blocked)", {
    ...GL_MR,
    detailed_merge_status: "blocked_by_discussions",
    blocking_discussions_resolved: false,
  }, { ok: false });
  await readinessCase("readiness fails closed (approvals_left missing)", (() => {
    const m = { ...GL_MR };
    delete (m as Record<string, unknown>).approvals_left;
    return m;
  })(), { ok: false, reasonIncludes: "approvals_left" });
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
        if (status === "blocked_by_discussions") {
          assert(threw!.includes("blocking_discussions_resolved"), `wrong: ${threw}`);
        }
      } else {
        assert(readiness === expected, `got ${readiness}`);
      }
    });
  }

  // ── CI watch (GitLab polling loop) ──────────────────────────────────────
  // Terminal statuses are success/failed/canceled/skipped/manual — verify a
  // non-`success` terminal is also recognized (the loop must not treat
  // `failed` as still-running).
  console.log("ci watch (GitLab):");
  {
    const { fn } = mkExec({
      "glab api /projects/:id/pipelines/901": { stdout: JSON.stringify(GL_PIPELINE_DONE) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("ciWatch returns terminal on first poll (status=success)", async () => {
      const result = await forge.ciWatch(901, { pollMs: 1, timeoutMs: 1000 });
      assert(result.ok && result.terminal && !result.timedOut, "terminal on first poll");
      assert(result.run?.status === "SUCCESS", `status ${result.run?.status}`);
      assert(result.run?.headBranch === "feature/issue-17-x", `ref ${result.run?.headBranch}`);
    });
  }
  {
    const failed = { ...GL_PIPELINE_DONE, status: "failed" };
    const { fn } = mkExec({
      "glab api /projects/:id/pipelines/901": { stdout: JSON.stringify(failed) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("ciWatch treats status=failed as terminal", async () => {
      const result = await forge.ciWatch(901, { pollMs: 1, timeoutMs: 1000 });
      assert(result.ok && result.terminal, "terminal");
      assert(result.run?.status === "FAILED", `status ${result.run?.status}`);
    });
  }
  {
    const { fn } = mkExec({
      "glab api /projects/:id/pipelines/901": { stdout: JSON.stringify(GL_PIPELINE_RUNNING) },
    });
    const forge = createForge(det, { execFn: fn });
    let nowMs = 0;
    await check("ciWatch polls with injected clock and times out", async () => {
      const result = await forge.ciWatch(901, {
        pollMs: 1000,
        timeoutMs: 2500,
        now: () => nowMs,
        sleep: async (ms: number) => {
          nowMs += ms;
        },
      });
      assert(result.ok && !result.terminal && result.timedOut, "timed out");
      assert(result.run?.status === "RUNNING", `status ${result.run?.status}`);
      assert(nowMs >= 2000, `clock advanced (got ${nowMs})`);
    });
  }

  // ── Labels ──────────────────────────────────────────────────────────────
  console.log("labels:");
  {
    const { fn, calls } = mkExec({
      "glab api -X POST": { stdout: JSON.stringify({ name: "new-label", color: "00ff00" }) },
      "glab api -X PUT": { stdout: "" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("labelCreate POSTs to /projects/:id/labels", async () => {
      const label = await forge.labelCreate("new-label", "00ff00");
      assert(label?.name === "new-label", `name ${label?.name}`);
      assert(calls.some((c) => c.includes("/projects/:id/labels")), `no POST labels: ${calls}`);
    });
    await check("labelAdd uses add_labels (auto-creates missing)", async () => {
      await forge.labelAdd("issue", 42, "new-label");
      assert(calls.some((c) => c.includes("add_labels=new-label")), `no add_labels: ${calls}`);
    });
    await check("labelRemove uses remove_labels", async () => {
      await forge.labelRemove("issue", 42, "old-label");
      assert(calls.some((c) => c.includes("remove_labels=old-label")), `no remove_labels: ${calls}`);
    });
  }

  // ── Attention-gate label lifecycle (needs-human-attention) ──────────────
  // Same lifecycle as the GitHub test: create (POST /labels) → add via
  // add_labels PUT → read back via issueView.
  console.log("attention-gate label lifecycle:");
  {
    const { fn, calls } = mkExec({
      "glab api -X POST": { stdout: "{}" },
      "glab api -X PUT": { stdout: "" },
      "glab issue view 42": {
        stdout: JSON.stringify({ ...GL_ISSUE, labels: [{ name: "needs-human-attention" }] }),
      },
    });
    const forge = createForge(det, { execFn: fn });
    // 1. Create via POST /projects/:id/labels.
    await forge.labelCreate("needs-human-attention", "FFAA00");
    // 2. Add to both the issue (attention-gate target) and the MR via PUT.
    await forge.labelAdd("issue", 42, "needs-human-attention");
    await forge.labelAdd("mr", 17, "needs-human-attention");
    await check("create, add to issue AND mr, read back on issue", async () => {
      assert(calls.some((c) => c.includes("-X POST") && c.includes("/projects/:id/labels")), `create: ${calls}`);
      assert(
        calls.some((c) => c.includes("add_labels=needs-human-attention") && c.includes("/issues/42")),
        `issue add: ${calls}`,
      );
      assert(
        calls.some(
          (c) => c.includes("add_labels=needs-human-attention") && c.includes("/merge_requests/17"),
        ),
        `mr add: ${calls}`,
      );
      // 3. Read back — the attention gate reads the issue's labels.
      const names = (await forge.issueView(42)).labels.map((l) => l.name);
      assert(names.includes("needs-human-attention"), `labels: ${names}`);
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

  // (direct mapper tests + parsePrNumberFromResponse shape/anchor cases
  //  live in test-forge-mapping-shapes.ts — split at the 500-line seam)

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
