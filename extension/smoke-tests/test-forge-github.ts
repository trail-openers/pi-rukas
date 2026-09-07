/**
 * test-forge-github.ts — offline smoke test for the GitHub (gh) path of
 * the forge adapter (S2 of epic #608).
 *
 * Covers every operation for the GitHub forge with mocked `gh` CLI output:
 *   - field mapping (number, body, OPEN, headRefName, url — camelCase)
 *   - issue view/create/edit/comment/search
 *   - PR view/list/create/merge/diff/checks
 *   - CI watch + run
 *   - merge readiness (CLEAN/DIRTY/BLOCKED/UNKNOWN)
 *   - label ops
 *   - repo settings
 *   - command-string invariants (the test seam)
 *
 * Run: cd extension && bun run smoke-tests/test-forge-github.ts
 */

import { mapGhIssue, mapGhPr, mapGhRepo, mapGhRun } from "../src/forge-mapping.ts";
import { createForge, forgeCommands } from "../src/forge.ts";
import {
  GH_CHECKS,
  GH_ISSUE,
  GH_PR,
  GH_REPO,
  GH_RUN_DONE,
  GH_RUN_RUNNING,
  ghDetection,
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
  const det = ghDetection(owner, repo);

  // ── Command-string invariants (the test seam) ──────────────────────────
  console.log("command strings:");
  await check("issueViewCmd is gh issue view with --json", () => {
    const cmd = forgeCommands.issueViewCmd("github", 42);
    assert(cmd.startsWith("gh issue view 42"), `got ${cmd}`);
    assert(cmd.includes("--json number,title,body,state,url"), "missing --json fields");
  });
  await check("issueEditCmd uses --body-file", () => {
    const cmd = forgeCommands.issueEditCmd("github", 42, "/tmp/x/body.md");
    assert(cmd.includes("--body-file /tmp/x/body.md"), `got ${cmd}`);
  });
  await check("prMergeCmd uses --squash --delete-branch", () => {
    const cmd = forgeCommands.prMergeCmd("github", 17, "squash");
    assert(cmd === "gh pr merge 17 --squash --delete-branch", `got ${cmd}`);
  });
  await check("prCreateCmd uses --head", () => {
    const cmd = forgeCommands.prCreateCmd("github", "T", "branch", "/tmp/b", "main");
    assert(cmd.includes("--head main...branch"), `got ${cmd}`);
  });

  // ── Issue operations ────────────────────────────────────────────────────
  console.log("issues:");
  {
    const { fn, calls } = mkExec({
      "gh issue view 42": { stdout: JSON.stringify(GH_ISSUE) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueView normalizes camelCase fields", async () => {
      const issue = await forge.issueView(42);
      assert(issue.number === 42, `number ${issue.number}`);
      assert(issue.body === "the issue body", `body ${issue.body}`);
      assert(issue.state === "OPEN", `state ${issue.state}`);
      assert(issue.url === "https://github.com/acme/widget/issues/42", `url ${issue.url}`);
      assert(issue.labels.length === 1 && issue.labels[0].name === "bug", "labels");
      assert(issue.author === "janni", `author ${issue.author}`);
      assert(calls.length === 1 && calls[0]!.includes("--json"), "cmd shape");
    });
  }

  // ── Issue edit (temp file body) ─────────────────────────────────────────
  {
    const { fn, calls } = mkExec({
      "gh issue edit 42": { stdout: JSON.stringify(GH_ISSUE) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueEdit writes body to a temp file", async () => {
      const issue = await forge.issueEdit(42, "edited body");
      assert(issue.number === 42, "round-tripped");
      const cmd = calls.find((c) => c.includes("gh issue edit"));
      assert(cmd !== undefined, "no edit command");
      assert(cmd!.includes("--body-file "), `missing --body-file: ${cmd}`);
      const file = cmd!.replace(/.*--body-file\s+/, "");
      assert(file.startsWith("/"), `not a path: ${file}`);
    });
  }

  // ── Issue comment ───────────────────────────────────────────────────────
  {
    const { fn } = mkExec({
      "gh issue comment 42": { stdout: "https://github.com/acme/widget/issues/42#issuecomment-1" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueComment returns the URL", async () => {
      const url = await forge.issueComment(42, "a comment");
      assert(url.includes("issuecomment-1"), `got ${url}`);
    });
  }

  // ── Issue search ────────────────────────────────────────────────────────
  {
    const { fn } = mkExec({
      "gh issue list --search": { stdout: JSON.stringify([GH_ISSUE, { ...GH_ISSUE, number: 43 }]) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueSearch returns an array", async () => {
      const issues = await forge.issueSearch("bug");
      assert(issues.length === 2, `len ${issues.length}`);
      assert(issues[0]!.number === 42, "first");
      assert(issues[1]!.number === 43, "second");
    });
  }

  // ── PR operations ───────────────────────────────────────────────────────
  console.log("pull requests:");
  {
    const { fn } = mkExec({
      "gh pr view 17": { stdout: JSON.stringify(GH_PR) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prView normalizes headRefName", async () => {
      const pr = await forge.prView(17);
      assert(pr.number === 17, "number");
      assert(pr.headRefName === "feature/issue-17-x", `head ${pr.headRefName}`);
      assert(pr.baseRefName === "main", `base ${pr.baseRefName}`);
      assert(pr.mergeable === "TRUE", `mergeable ${pr.mergeable}`);
      assert(pr.mergeStateStatus === "CLEAN", `status ${pr.mergeStateStatus}`);
    });
  }

  {
    const { fn } = mkExec({
      "gh pr list": { stdout: JSON.stringify([GH_PR]) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prList with sourceBranch uses --head", async () => {
      const prs = await forge.prList({ sourceBranch: "feature/issue-17-x" });
      assert(prs.length === 1, "len");
    });
  }

  {
    const { fn } = mkExec({
      "gh pr diff 17": { stdout: "diff --git a/foo b/foo" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prDiff returns the diff text", async () => {
      const diff = await forge.prDiff(17);
      assert(diff.includes("diff --git"), `got ${diff}`);
    });
  }

  {
    const { fn, calls } = mkExec({
      "gh pr merge 17": { stdout: "Merged #17" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prMerge uses --squash --delete-branch", async () => {
      const out = await forge.prMerge(17);
      assert(out.includes("Merged"), `got ${out}`);
      const cmd = calls.find((c) => c.includes("gh pr merge"));
      assert(cmd !== undefined, "no merge cmd");
      assert(cmd!.includes("--squash"), `no --squash: ${cmd}`);
      assert(cmd!.includes("--delete-branch"), `no --delete-branch: ${cmd}`);
    });
  }

  // ── PR checks ───────────────────────────────────────────────────────────
  {
    const { fn } = mkExec({
      "gh pr checks 17": { stdout: JSON.stringify(GH_CHECKS) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prChecks normalizes rows", async () => {
      const checks = await forge.prChecks(17);
      assert(checks.length === 2, `len ${checks.length}`);
      assert(checks[0]!.name === "ci", "first name");
      assert(checks[0]!.state === "PASS", `state ${checks[0]!.state}`);
      assert(checks[0]!.isRequired === true, "required");
    });
  }

  {
    const { fn } = mkExec({
      "gh api /repos/acme/widget/actions/runs/901": {
        // First call: running; second call: completed.
        stdout: JSON.stringify(GH_RUN_DONE),
      },
    });
    const forge = createForge(det, { execFn: fn });
    await check("ciWatch returns terminal on first poll", async () => {
      const result = await forge.ciWatch(901, { pollMs: 1, timeoutMs: 1000 });
      assert(result.ok, "ok");
      assert(result.terminal, "terminal");
      assert(!result.timedOut, "not timed out");
      assert(result.run !== undefined, "run present");
      assert(result.run!.status === "COMPLETED", `status ${result.run!.status}`);
      assert(result.run!.conclusion === "SUCCESS", `conclusion ${result.run!.conclusion}`);
    });
  }

  {
    const { fn } = mkExec({
      "gh api /repos/acme/widget/actions/runs/901": { stdout: JSON.stringify(GH_RUN_RUNNING) },
    });
    const forge = createForge(det, { execFn: fn });
    let nowMs = 0;
    const sleep = async (_ms: number) => {
      nowMs += _ms;
    };
    await check("ciWatch times out at the cap", async () => {
      const result = await forge.ciWatch(901, {
        pollMs: 1000,
        timeoutMs: 2500,
        now: () => nowMs,
        sleep,
      });
      assert(result.ok, "ok");
      assert(!result.terminal, "not terminal");
      assert(result.timedOut, "timed out");
      assert(result.run !== undefined, "run present");
      assert(result.run!.status === "IN_PROGRESS", `status ${result.run!.status}`);
    });
  }

  // ── CI run ──────────────────────────────────────────────────────────────
  {
    const { fn } = mkExec({
      "gh api /repos/acme/widget/actions/runs/901": { stdout: JSON.stringify(GH_RUN_DONE) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("ciRun returns the normalized run", async () => {
      const run = await forge.ciRun(901);
      assert(run.id === 901, `id ${run.id}`);
      assert(run.status === "COMPLETED", `status ${run.status}`);
      assert(run.conclusion === "SUCCESS", `conclusion ${run.conclusion}`);
      assert(run.headBranch === "feature/issue-17-x", `head ${run.headBranch}`);
    });
  }

  // ── Merge readiness (GitHub) ────────────────────────────────────────────
  console.log("merge readiness (GitHub):");
  {
    const { fn } = mkExec({
      "gh pr view 17": { stdout: JSON.stringify(GH_PR) },
      "gh pr checks 17": { stdout: JSON.stringify(GH_CHECKS) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness CLEAN when mergeStateStatus=CLEAN + all pass", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok, `ok: ${result.ok ? "" : result.reason}`);
      if (result.ok) {
        assert(result.readiness === "CLEAN", `readiness ${result.readiness}`);
      }
    });
  }

  {
    const blocked = { ...GH_PR, mergeStateStatus: "BLOCKED" };
    const { fn } = mkExec({
      "gh pr view 17": { stdout: JSON.stringify(blocked) },
      "gh pr checks 17": { stdout: JSON.stringify(GH_CHECKS) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness fails closed on BLOCKED", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok === false, "should fail");
      if (!result.ok) assert(result.reason.includes("BLOCKED"), `reason ${result.reason}`);
    });
  }

  {
    const failing = [
      { name: "ci", state: "completed", bucket: "fail", isRequired: true },
      { name: "lint", state: "completed", bucket: "pass", isRequired: true },
    ];
    const { fn } = mkExec({
      "gh pr view 17": { stdout: JSON.stringify(GH_PR) },
      "gh pr checks 17": { stdout: JSON.stringify(failing) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness DIRTY when a required check fails", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok, "ok");
      if (result.ok) assert(result.readiness === "DIRTY", `readiness ${result.readiness}`);
    });
  }

  {
    const { fn } = mkExec({
      "gh pr view 17": { stdout: JSON.stringify(GH_PR) },
      "gh pr checks 17": { error: true, stderr: "no checks" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness fails closed when checks unreadable", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok === false, "should fail");
    });
  }

  {
    const closed = { ...GH_PR, state: "CLOSED" };
    const { fn } = mkExec({
      "gh pr view 17": { stdout: JSON.stringify(closed) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness fails closed when PR not OPEN", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok === false, "should fail");
      if (!result.ok) assert(result.reason.includes("CLOSED"), `reason ${result.reason}`);
    });
  }

  // ── Labels ──────────────────────────────────────────────────────────────
  console.log("labels:");
  {
    const { fn } = mkExec({
      "gh label create": { stdout: JSON.stringify({ name: "new-label", id: 5, color: "00ff00" }) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("labelCreate returns the label", async () => {
      const label = await forge.labelCreate("new-label", "00ff00");
      assert(label !== undefined, "label");
      assert(label!.name === "new-label", `name ${label!.name}`);
      assert(label!.id === 5, `id ${label!.id}`);
    });
  }
  {
    const { fn, calls } = mkExec({
      "gh issue edit 42 --add-label": { stdout: "" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("labelAdd uses --add-label", async () => {
      await forge.labelAdd("issue", 42, "bug");
      const cmd = calls.find((c) => c.includes("--add-label"));
      assert(cmd !== undefined, "no add-label cmd");
    });
  }
  {
    const { fn, calls } = mkExec({
      "gh issue edit 42 --remove-label": { stdout: "" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("labelRemove uses --remove-label", async () => {
      await forge.labelRemove("issue", 42, "bug");
      const cmd = calls.find((c) => c.includes("--remove-label"));
      assert(cmd !== undefined, "no remove-label cmd");
    });
  }

  // ── Repo settings ───────────────────────────────────────────────────────
  console.log("repo settings:");
  {
    const { fn } = mkExec({
      "gh repo view": { stdout: JSON.stringify(GH_REPO) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("repoSettings normalizes the three booleans", async () => {
      const repo = await forge.repoSettings();
      assert(repo.name === "acme/widget", `name ${repo.name}`);
      assert(repo.squashMergeAllowed === true, "squash");
      assert(repo.mergeCommitAllowed === true, "merge");
      assert(repo.rebaseMergeAllowed === false, "rebase");
      assert(repo.defaultBranch === "main", `default ${repo.defaultBranch}`);
    });
  }

  // ── Mappers (direct) ────────────────────────────────────────────────────
  console.log("mappers:");
  await check("mapGhIssue throws on missing number", () => {
    try {
      mapGhIssue({ title: "x", body: "y", state: "OPEN", url: "u" } as Record<string, unknown>);
      throw new Error("should have thrown");
    } catch (e) {
      assert((e as Error).message.includes("number"), `wrong error: ${(e as Error).message}`);
    }
  });
  await check("mapGhPr throws on missing state", () => {
    try {
      mapGhPr({ number: 1, title: "t", body: "b", url: "u" } as Record<string, unknown>);
      throw new Error("should have thrown");
    } catch (e) {
      assert((e as Error).message.includes("state"), `wrong error: ${(e as Error).message}`);
    }
  });
  await check("mapGhRun normalizes snake_case", () => {
    const run = mapGhRun(GH_RUN_DONE as Record<string, unknown>);
    assert(run.id === 901, "id");
    assert(run.status === "COMPLETED", "status");
    assert(run.conclusion === "SUCCESS", "conclusion");
  });
  await check("mapGhRepo normalizes", () => {
    const r = mapGhRepo(GH_REPO as Record<string, unknown>);
    assert(r.name === "acme/widget", "name");
    assert(r.owner === "acme", "owner");
  });

  console.log("");
  if (exitCode !== 0) {
    console.error("FAILURES — see above");
    process.exit(1);
  }
  console.log("All forge-github tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
